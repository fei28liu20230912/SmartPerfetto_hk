// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { Router, type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import path from 'path';
import { createWriteStream } from 'fs';
import fs from 'fs/promises';
import net from 'net';
import { Readable, Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { uuidv4 } from '../utils/uuid';
import { resolveFeatureConfig } from '../config';
import { attachRequestContext, requireRequestContext, type RequestContext } from '../middleware/auth';
import { getTraceProcessorService } from '../services/traceProcessorService';
import { getPortPool } from '../services/portPool';
import { TraceProcessorFactory, type TraceProcessorRuntimeStats } from '../services/workingTraceProcessor';
import { openEnterpriseDb } from '../services/enterpriseDb';
import {
  recordEnterpriseAuditEvent,
  recordEnterpriseAuditEventForContext,
} from '../services/enterpriseAuditService';
import {
  getTraceProcessorLeaseStore,
  type TraceProcessorLeaseRecord,
  type TraceProcessorLeaseState,
  type TraceProcessorHolderType,
} from '../services/traceProcessorLeaseStore';
import {
  buildTraceProcessorLeaseModeDecision,
  sharedQueueLengthForTrace,
  type TraceProcessorLeaseModeDecision,
} from '../services/traceProcessorLeaseModeDecision';
import {
  evaluateTraceUploadQuota,
  type EnterpriseQuotaDecision,
} from '../services/enterpriseQuotaPolicyService';
import {
  evaluateTenantMutationPolicy,
  sendTenantMutationDeniedPayload,
} from '../services/enterpriseTenantLifecycleService';
import {
 buildTraceOwnerMetadata,
 deleteTraceMetadataForContext,
 getTraceFilePath,
 getWritableTraceDirForContext,
 listTraceMetadataForContext,
 readTraceMetadata,
 readTraceMetadataForContext,
 type TraceMetadata,
 writeTraceMetadata,
 isSafeTraceId,
} from '../services/traceMetadataStore';
import { parseBugreportFile, formatDeviceProfileForPrompt, inferVoiceAssistantFromTrace, type DeviceProfile } from '../services/bugreportParser';
import { isPrivilegedRequestContext, sendResourceNotFound } from '../services/resourceOwnership';
import {
  canDeleteTraceResource,
  canDownloadTraceResource,
  hasRbacPermission,
  sendForbidden,
  sharesWorkspaceWithContext,
} from '../services/rbac';
import { resolveTraceUploadLimitBytes } from '../services/traceUploadLimit';

const router = Router();
const URL_UPLOAD_TIMEOUT_MS = 300000;
const TEMP_UPLOAD_SUFFIX = '.uploading';
const CLEANUP_TERMINAL_LEASE_STATES = new Set<TraceProcessorLeaseState>(['released', 'failed']);
const DELETE_BLOCKING_RUN_STATUSES = new Set(['pending', 'running', 'awaiting_user']);
// 2x covers the in-flight upload plus the .uploading temp file written alongside the final trace.
const DISK_SAFETY_MULTIPLIER = 2;

class TraceUploadTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`Trace file too large. Maximum allowed size is ${maxBytes} bytes`);
    this.name = 'TraceUploadTooLargeError';
  }
}

async function getAvailableDiskBytes(targetPath: string): Promise<number | null> {
  let candidate = targetPath;
  for (let i = 0; i < 8; i++) {
    try {
      const stats = await fs.statfs(candidate);
      return stats.bavail * stats.bsize;
    } catch (error: any) {
      if (error?.code === 'ENOENT') {
        const parent = path.dirname(candidate);
        if (parent === candidate) return null;
        candidate = parent;
        continue;
      }
      console.warn(`[Traces] statfs precheck failed (${error?.code ?? 'unknown'}) for ${candidate}; allowing upload to proceed`);
      return null;
    }
  }
  return null;
}

function checkUploadDiskSpace(req: Request, res: Response, next: NextFunction): void {
  const contentLength = Number.parseInt(req.headers['content-length'] ?? '', 10);
  if (!Number.isFinite(contentLength) || contentLength <= 0) {
    next();
    return;
  }

  let tracesDir: string;
  try {
    tracesDir = getWritableTraceDirForContext(requireRequestContext(req));
  } catch {
    next();
    return;
  }

  getAvailableDiskBytes(tracesDir)
    .then((available) => {
      if (available === null) {
        next();
        return;
      }
      const required = contentLength * DISK_SAFETY_MULTIPLIER;
      if (available < required) {
        res.status(507).json({
          error: 'Insufficient disk space',
          details: `Need ${required} bytes (declared ${contentLength}, ${DISK_SAFETY_MULTIPLIER}x safety), only ${available} bytes free on trace volume`,
        });
        return;
      }
      next();
    })
    .catch(() => next());
}

interface FinalizedTraceUploadInfo {
  uploadTime?: Date;
  status?: string;
  port?: number;
  leaseId?: string;
  leaseState?: string;
  leaseMode?: string;
  leaseModeReason?: string;
  leaseQueueLength?: number;
  processor?: {
    status: string;
  };
}

interface TraceProcessorLeaseAcquisition {
  lease: TraceProcessorLeaseRecord;
  decision: TraceProcessorLeaseModeDecision;
}

function requireTracePermission(permission: 'trace:read' | 'trace:write', details: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const context = requireRequestContext(req);
    if (!hasRbacPermission(context, permission)) {
      sendForbidden(res, details);
      return;
    }
    next();
  };
}

function enterpriseLeasesEnabled(): boolean {
  return resolveFeatureConfig().enterprise;
}

function leaseScopeFromContext(context: RequestContext) {
  return {
    tenantId: context.tenantId,
    workspaceId: context.workspaceId,
    userId: context.userId,
  };
}

function markLeaseReadyIfNew(
  lease: TraceProcessorLeaseRecord,
  context: RequestContext,
): TraceProcessorLeaseRecord {
  if (lease.state !== 'pending') return lease;
  const store = getTraceProcessorLeaseStore();
  const scope = leaseScopeFromContext(context);
  const starting = store.markStarting(scope, lease.id);
  return store.markReady(scope, starting.id);
}

function recordLeaseRssFromProcessor(
  lease: TraceProcessorLeaseRecord,
  context: RequestContext,
): TraceProcessorLeaseRecord {
  const processor = TraceProcessorFactory.getStats().processors
    .find(item => item.traceId === lease.traceId && (
      lease.mode === 'isolated'
        ? item.leaseId === lease.id
        : (item.leaseMode ?? 'shared') === 'shared'
    ));
  const rssBytes = processor?.rssBytes
    ?? processor?.peakRssBytes
    ?? processor?.startupRssBytes
    ?? null;
  if (rssBytes === null) return lease;
  return getTraceProcessorLeaseStore().recordRss(leaseScopeFromContext(context), lease.id, rssBytes);
}

function processorQueueLength(processor: TraceProcessorRuntimeStats): number {
  const worker = processor.sqlWorker;
  return worker ? worker.queuedP0 + worker.queuedP1 + worker.queuedP2 : 0;
}

function queueLengthForLease(
  lease: TraceProcessorLeaseRecord,
  processors: TraceProcessorRuntimeStats[],
): number {
  if (lease.mode === 'isolated') {
    return processors
      .filter(processor => processor.traceId === lease.traceId && processor.leaseId === lease.id)
      .reduce((sum, processor) => sum + processorQueueLength(processor), 0);
  }
  return sharedQueueLengthForTrace(lease.traceId, processors);
}

function recordTraceCleanupAudit(
  context: RequestContext,
  action: 'trace_cleanup_blocked' | 'trace_cleanup_completed',
  metadata: Record<string, unknown>,
): void {
  const db = openEnterpriseDb();
  try {
    const actor = db.prepare<unknown[], { id: string }>(`
      SELECT id FROM users WHERE tenant_id = ? AND id = ? LIMIT 1
    `).get(context.tenantId, context.userId);
    recordEnterpriseAuditEvent(db, {
      tenantId: context.tenantId,
      workspaceId: context.workspaceId,
      actorUserId: actor?.id,
      action,
      resourceType: 'trace_cleanup',
      resourceId: context.workspaceId,
      metadata,
    });
  } finally {
    db.close();
  }
}

function recordTraceDeleteAudit(
  context: RequestContext,
  traceId: string,
  action: 'trace_delete_blocked',
  metadata: Record<string, unknown>,
): void {
  const db = openEnterpriseDb();
  try {
    const actor = db.prepare<unknown[], { id: string }>(`
      SELECT id FROM users WHERE tenant_id = ? AND id = ? LIMIT 1
    `).get(context.tenantId, context.userId);
    recordEnterpriseAuditEvent(db, {
      tenantId: context.tenantId,
      workspaceId: context.workspaceId,
      actorUserId: actor?.id,
      action,
      resourceType: 'trace',
      resourceId: traceId,
      metadata,
    });
  } finally {
    db.close();
  }
}

function recordTraceAudit(
  context: RequestContext,
  action: 'trace.uploaded' | 'trace.read' | 'trace.deleted',
  traceId: string,
  metadata: Record<string, unknown>,
): void {
  recordEnterpriseAuditEventForContext(context, {
    action,
    resourceType: 'trace',
    resourceId: traceId,
    metadata,
  });
}

function sendTraceQuotaDenied(
  res: Response,
  decision: EnterpriseQuotaDecision,
): Response {
  return res.status(decision.httpStatus).json({
    success: false,
    code: decision.code,
    status: decision.status,
    error: decision.message,
    details: decision.details,
  });
}

function summarizeLeaseBlockers(leases: TraceProcessorLeaseRecord[]): Array<{
  id: string;
  traceId: string;
  state: string;
  holderCount: number;
  holderTypes: string[];
}> {
  return leases.map(lease => ({
    id: lease.id,
    traceId: lease.traceId,
    state: lease.state,
    holderCount: lease.holderCount,
    holderTypes: Array.from(new Set(lease.holders.map(holder => holder.holderType))),
  }));
}

function listActiveTraceRuns(context: RequestContext, traceId: string): Array<{
  runId: string;
  sessionId: string;
  status: string;
}> {
  const db = openEnterpriseDb();
  try {
    return db.prepare<unknown[], { run_id: string; session_id: string; status: string }>(`
      SELECT r.id AS run_id, r.session_id, r.status
      FROM analysis_runs r
      JOIN analysis_sessions s
        ON s.tenant_id = r.tenant_id
       AND s.workspace_id = r.workspace_id
       AND s.id = r.session_id
      WHERE r.tenant_id = ?
        AND r.workspace_id = ?
        AND s.trace_id = ?
      ORDER BY r.started_at ASC, r.id ASC
    `).all(context.tenantId, context.workspaceId, traceId)
      .filter(row => DELETE_BLOCKING_RUN_STATUSES.has(row.status))
      .map(row => ({
        runId: row.run_id,
        sessionId: row.session_id,
        status: row.status,
      }));
  } finally {
    db.close();
  }
}

function blockEnterpriseTraceDeleteIfActive(
  context: RequestContext,
  traceId: string,
): {
  blocked: boolean;
  blockedLeases: ReturnType<typeof summarizeLeaseBlockers>;
  activeRuns: Array<{ runId: string; sessionId: string; status: string }>;
} {
  const scope = leaseScopeFromContext(context);
  const store = getTraceProcessorLeaseStore();
  const activeLeases = store.listLeases(scope, { traceId })
    .filter(lease => !CLEANUP_TERMINAL_LEASE_STATES.has(lease.state) && lease.holderCount > 0);
  const drainedLeases = activeLeases.map(lease =>
    lease.state === 'draining' ? lease : store.beginDraining(scope, lease.id),
  );
  const activeRuns = listActiveTraceRuns(context, traceId);
  const blockedLeases = summarizeLeaseBlockers(drainedLeases);
  const blocked = blockedLeases.length > 0 || activeRuns.length > 0;

  if (blocked) {
    recordTraceDeleteAudit(context, traceId, 'trace_delete_blocked', {
      blockedLeaseCount: blockedLeases.length,
      activeRunCount: activeRuns.length,
      blockedLeases,
      activeRuns,
    });
  }

  return {
    blocked,
    blockedLeases,
    activeRuns,
  };
}

async function cleanupEnterpriseWorkspaceProcessors(context: RequestContext): Promise<{
  blocked: boolean;
  blockedLeases: Array<{
    id: string;
    traceId: string;
    state: string;
    holderCount: number;
    holderTypes: string[];
  }>;
  releasedLeaseIds: string[];
  cleanedProcessors: number;
  traceIds: string[];
}> {
  const scope = leaseScopeFromContext(context);
  const traces = await listTraceMetadataForContext(context);
  const traceIds = traces.map(trace => trace.id);
  const traceIdSet = new Set(traceIds);
  const store = getTraceProcessorLeaseStore();
  const leases = store.listLeases(scope)
    .filter(lease => traceIdSet.has(lease.traceId) && !CLEANUP_TERMINAL_LEASE_STATES.has(lease.state));
  const blockedLeases = summarizeLeaseBlockers(
    leases.filter(lease => lease.holderCount > 0),
  );

  if (blockedLeases.length > 0) {
    recordTraceCleanupAudit(context, 'trace_cleanup_blocked', {
      traceCount: traceIds.length,
      blockedLeaseCount: blockedLeases.length,
      blockedLeases,
    });
    return {
      blocked: true,
      blockedLeases,
      releasedLeaseIds: [],
      cleanedProcessors: 0,
      traceIds,
    };
  }

  const releasedLeaseIds: string[] = [];
  for (const lease of leases) {
    const drained = lease.state === 'draining'
      ? lease
      : store.beginDraining(scope, lease.id);
    const current = store.getLeaseById(scope, drained.id);
    if (current?.state === 'released') {
      releasedLeaseIds.push(current.id);
    }
  }

  const cleanedProcessors = getTraceProcessorService().cleanupProcessorsForTraces(traceIdSet);
  recordTraceCleanupAudit(context, 'trace_cleanup_completed', {
    traceCount: traceIds.length,
    releasedLeaseCount: releasedLeaseIds.length,
    cleanedProcessors,
    traceIds,
  });

  return {
    blocked: false,
    blockedLeases: [],
    releasedLeaseIds,
    cleanedProcessors,
    traceIds,
  };
}

function ownedTraceIdForProcessorKey(processorKey: string, ownedTraceIds: Set<string>): string | null {
  if (ownedTraceIds.has(processorKey)) return processorKey;
  for (const traceId of ownedTraceIds) {
    if (processorKey.startsWith(`${traceId}:lease:`)) return traceId;
  }
  return null;
}

function decideLeaseModeForTrace(
  context: RequestContext,
  traceId: string,
  holderType: TraceProcessorHolderType,
): TraceProcessorLeaseModeDecision {
  const scope = leaseScopeFromContext(context);
  const store = getTraceProcessorLeaseStore();
  const processorStats = TraceProcessorFactory.getStats();
  return buildTraceProcessorLeaseModeDecision({
    traceId,
    holderType,
    leases: store.listLeases(scope, { traceId }),
    processors: processorStats.processors,
    ramBudget: processorStats.ramBudget,
  });
}

function leaseResponseFields(acquisition: TraceProcessorLeaseAcquisition | null | undefined): {
  leaseId?: string;
  leaseState?: string;
  leaseMode?: string;
  leaseModeReason?: string;
  leaseQueueLength?: number;
} {
  if (!acquisition) return {};
  return {
    leaseId: acquisition.lease.id,
    leaseState: acquisition.lease.state,
    leaseMode: acquisition.lease.mode,
    leaseModeReason: acquisition.decision.reason,
    leaseQueueLength: acquisition.decision.signals.sharedQueueLength,
  };
}

function acquireFrontendTraceLease(
  context: RequestContext,
  traceId: string,
  sessionId?: string,
): TraceProcessorLeaseAcquisition | null {
  if (!enterpriseLeasesEnabled()) return null;
  const holderRef = context.windowId || sessionId || context.requestId || context.userId;
  const decision = decideLeaseModeForTrace(context, traceId, 'frontend_http_rpc');
  const lease = getTraceProcessorLeaseStore().acquireHolder(
    leaseScopeFromContext(context),
    traceId,
    {
      holderType: 'frontend_http_rpc',
      holderRef,
      windowId: context.windowId,
      sessionId,
      metadata: {
        requestId: context.requestId,
        leaseModeReason: decision.reason,
        leaseModeSignals: decision.signals,
      },
    },
    { mode: decision.mode },
  );
  return {
    lease: recordLeaseRssFromProcessor(markLeaseReadyIfNew(lease, context), context),
    decision,
  };
}

function acquireManualRegisterLease(
  context: RequestContext,
  traceId: string,
  port: number,
): TraceProcessorLeaseAcquisition | null {
  if (!enterpriseLeasesEnabled()) return null;
  const decision = decideLeaseModeForTrace(context, traceId, 'manual_register');
  const lease = getTraceProcessorLeaseStore().acquireHolder(
    leaseScopeFromContext(context),
    traceId,
    {
      holderType: 'manual_register',
      holderRef: `port:${port}`,
      metadata: {
        port,
        requestId: context.requestId,
        leaseModeReason: decision.reason,
        leaseModeSignals: decision.signals,
      },
    },
    { mode: decision.mode },
  );
  return {
    lease: recordLeaseRssFromProcessor(markLeaseReadyIfNew(lease, context), context),
    decision,
  };
}

async function finalizeTraceUpload(
  traceId: string,
  filename: string,
  size: number,
  finalPath: string,
  context: RequestContext,
  uploadSource: 'local' | 'url',
): Promise<FinalizedTraceUploadInfo | undefined> {
  const tps = getTraceProcessorService();

  if (tps) {
    await tps.initializeUploadWithId(traceId, filename, size, finalPath);
    console.log(`[TraceProcessor] Initialized upload with traceId: ${traceId}`);
  }

  const metadata = {
    id: traceId,
    filename,
    size,
    uploadedAt: new Date().toISOString(),
    status: 'ready',
    path: finalPath,
    ...buildTraceOwnerMetadata(context),
  };
  await writeTraceMetadata(metadata);
  console.log(`[TraceProcessor] Created metadata for trace: ${traceId}`);
  recordTraceAudit(context, 'trace.uploaded', traceId, {
    filename,
    size,
    uploadSource,
  });

  if (tps) {
    try {
      await tps.completeUpload(traceId);
      console.log(`[TraceProcessor] Loaded trace ${traceId}`);
    } catch (tpError: any) {
      console.error(`[TraceProcessor] Failed to load trace ${traceId}:`, tpError.message);
    }
  }

  const traceWithPort = tps?.getTraceWithPort(traceId);
  const acquisition = acquireFrontendTraceLease(context, traceId);
  return acquisition ? { ...(traceWithPort ?? {}), ...leaseResponseFields(acquisition) } : traceWithPort;
}

function getFilenameFromUrl(rawUrl: string, fallback = 'trace.perfetto'): string {
  try {
    const url = new URL(rawUrl);
    const name = path.basename(url.pathname);
    return name || fallback;
  } catch {
    return fallback;
  }
}

function isBlockedTraceUrl(url: URL): boolean {
  const hostname = url.hostname.toLowerCase();
  if (hostname === 'localhost') return true;

  const ipVersion = net.isIP(hostname);
  if (ipVersion === 4) {
    const parts = hostname.split('.').map(part => Number.parseInt(part, 10));
    if (parts[0] === 10 || parts[0] === 127 || parts[0] === 0) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;
  } else if (ipVersion === 6) {
    if (hostname === '::1') return true;
    if (hostname.startsWith('fc') || hostname.startsWith('fd') || hostname.startsWith('fe80')) return true;
  }

  return false;
}

function tempUploadFilename(): string {
  return `${uuidv4()}${TEMP_UPLOAD_SUFFIX}`;
}

async function cleanupFile(filePath: string | undefined): Promise<void> {
  if (!filePath) return;
  try {
    await fs.unlink(filePath);
  } catch {
    // Best-effort cleanup only.
  }
}

async function renameTraceAtomically(tempPath: string, finalPath: string): Promise<void> {
  await fs.rename(tempPath, finalPath);
}

function createUploadSizeLimitStream(maxBytes: number): { stream: Transform; getBytesWritten: () => number } {
  let bytesWritten = 0;
  const stream = new Transform({
    transform(chunk, _encoding, callback) {
      const bytes = Buffer.isBuffer(chunk)
        ? chunk.length
        : chunk instanceof Uint8Array
          ? chunk.byteLength
          : Buffer.byteLength(String(chunk));
      bytesWritten += bytes;
      if (bytesWritten > maxBytes) {
        callback(new TraceUploadTooLargeError(maxBytes));
        return;
      }
      callback(null, chunk);
    },
  });

  return {
    stream,
    getBytesWritten: () => bytesWritten,
  };
}

async function streamResponseBodyToTempFile(response: globalThis.Response, tempPath: string): Promise<number> {
  if (!response.body) {
    throw new Error('Trace URL response body is empty');
  }

  const limiter = createUploadSizeLimitStream(resolveTraceUploadLimitBytes());
  try {
    await pipeline(
      Readable.fromWeb(response.body as any),
      limiter.stream,
      createWriteStream(tempPath, { flags: 'wx' }),
    );
    return limiter.getBytesWritten();
  } catch (error) {
    await cleanupFile(tempPath);
    throw error;
  }
}

// GET /api/traces/health - Health check for auto-upload feature
// This endpoint allows the frontend to quickly check if the backend is available
router.get('/health', (req, res) => {
  res.json({
    available: true,
    version: '1.0',
    timestamp: new Date().toISOString(),
  });
});

router.use(attachRequestContext);

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    let tracesDir: string;
    try {
      tracesDir = getWritableTraceDirForContext(requireRequestContext(req));
    } catch (error) {
      cb(error as Error, process.env.UPLOAD_DIR || './uploads');
      return;
    }

    fs.mkdir(tracesDir, { recursive: true })
      .then(() => cb(null, tracesDir))
      .catch((error) => cb(error, tracesDir));
  },
  filename: (req, file, cb) => {
    cb(null, tempUploadFilename());
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: resolveTraceUploadLimitBytes(),
  },
});

// POST /api/traces/upload - Simple upload with RequestContext ownership
router.post(
  '/upload',
  requireTracePermission('trace:write', 'Uploading traces requires trace:write permission'),
  checkUploadDiskSpace,
  upload.single('file'),
  async (req, res) => {
    try {
      const context = requireRequestContext(req);
      if (!req.file) {
        return res.status(400).json({
          error: 'No file uploaded'
        });
      }

      const file = req.file;
      const tenantDecision = evaluateTenantMutationPolicy(context);
      if (!tenantDecision.allowed) {
        await cleanupFile(file.path);
        return res.status(tenantDecision.httpStatus).json(sendTenantMutationDeniedPayload(tenantDecision));
      }
      const quotaDecision = evaluateTraceUploadQuota(context, file.size);
      if (!quotaDecision.allowed) {
        await cleanupFile(file.path);
        return sendTraceQuotaDenied(res, quotaDecision);
      }

      // Generate trace ID upfront for consistency
      const traceId = uuidv4();

      // Move file to traces directory with proper name
      const tracesDir = path.dirname(file.path);
      const finalPath = path.join(tracesDir, `${traceId}.trace`);
      await renameTraceAtomically(file.path, finalPath);

      console.log(`File uploaded successfully: ${file.originalname} -> ${traceId}`);

      // Get trace status and processor port from service
      const traceInfo = await finalizeTraceUpload(traceId, file.originalname, file.size, finalPath, context, 'local');

      res.json({
        success: true,
        trace: {
          id: traceId,
          filename: file.originalname,
          size: file.size,
          uploadedAt: traceInfo?.uploadTime || new Date().toISOString(),
          status: traceInfo?.status || 'ready',
          // Port for HTTP RPC mode - frontend can connect to trace_processor directly
          port: traceInfo?.port,
          leaseId: traceInfo?.leaseId,
          leaseState: traceInfo?.leaseState,
          leaseMode: traceInfo?.leaseMode,
          leaseModeReason: traceInfo?.leaseModeReason,
          leaseQueueLength: traceInfo?.leaseQueueLength,
          processorStatus: traceInfo?.processor?.status,
        }
      });

    } catch (error: any) {
      await cleanupFile(req.file?.path);
      console.error('Upload error:', error);
      res.status(500).json({
        error: 'Upload failed',
        details: error.message
      });
    }
  },
);

// POST /api/traces/:traceId/bugreport - Attach a bugreport to an existing trace
router.post(
  '/:traceId/bugreport',
  requireTracePermission('trace:write', 'Attaching bugreport requires trace:write permission'),
  upload.single('file'),
  async (req, res) => {
    try {
      const { traceId } = req.params as { traceId: string };
      if (!isSafeTraceId(traceId)) {
        return res.status(400).json({ error: 'Invalid trace ID' });
      }

      if (!req.file) {
        return res.status(400).json({ error: 'No bugreport file uploaded' });
      }

      const bugreportPath = req.file.path;
      console.log(`[bugreport] Parsing bugreport for trace ${traceId}: ${req.file.originalname}`);

      // Parse the bugreport
      const profile = await parseBugreportFile(bugreportPath);

      // Try to detect voice assistant from trace process activity (higher priority than bugreport inference)
      try {
        const tps = getTraceProcessorService();
        const traceQueryFn = async (sql: string) => {
          const result = await tps.query(traceId, sql);
          return { rows: (result as any).rows || [] };
        };
        const fromTrace = await inferVoiceAssistantFromTrace(traceId, traceQueryFn);
        if (fromTrace && fromTrace.assistant !== 'unknown') {
          console.log(`[bugreport] Voice assistant from trace overrides bugreport: ${profile.voiceAssistant} → ${fromTrace.assistant}`);
          profile.voiceAssistant = fromTrace.assistant;
        }
      } catch (traceErr: any) {
        console.log(`[bugreport] Trace voice detection skipped: ${traceErr.message}`);
      }

      // Fallback: infer voice assistant from OS variant if still unknown
      if (profile.voiceAssistant === 'unknown') {
        const osVoiceMap: Record<string, DeviceProfile['voiceAssistant']> = {
          'google_tv': 'katniss',
          'firetv': 'vizzini',
          'aosp_china': 'walleve',
        };
        const inferred = osVoiceMap[profile.osVariant];
        if (inferred) {
          console.log(`[bugreport] Voice assistant inferred from OS variant: ${profile.osVariant} → ${inferred}`);
          profile.voiceAssistant = inferred;
        }
      }

      const profileText = formatDeviceProfileForPrompt(profile);

      // Clean up the uploaded bugreport file
      await cleanupFile(bugreportPath);

      // Read existing trace metadata and add deviceProfile
      const metadata = await readTraceMetadata(traceId);
      if (!metadata) {
        return res.status(404).json({ error: 'Trace not found' });
      }

      metadata.deviceProfile = profileText;
      await writeTraceMetadata(metadata);

      console.log(`[bugreport] Device profile saved for trace ${traceId}: ${profile.socPlatform || 'unknown'} / ${profile.memoryTotalMb || '?'}MB / ${profile.osVariant}`);

      res.json({
        success: true,
        traceId,
        deviceProfile: {
          model: profile.model,
          brand: profile.brand,
          socPlatform: profile.socPlatform,
          socVendor: profile.socVendor,
          memoryTotalMb: profile.memoryTotalMb,
          memoryTier: profile.memoryTier,
          osVariant: profile.osVariant,
          androidVersion: profile.androidVersion,
          cpuCoreCount: profile.cpuCoreCount,
          gpuDriver: profile.gpuDriver,
          voiceAssistant: profile.voiceAssistant,
          cpuFreq: profile.cpuFreq,
          swappiness: profile.swappiness,
          zramSizeMb: profile.zramSizeMb,
          readaheadKb: profile.readaheadKb,
          displayResolution: profile.displayResolution,
          displayRefreshRate: profile.displayRefreshRate,
          gpuRenderer: profile.gpuRenderer,
          securityPatch: profile.securityPatch,
          buildType: profile.buildType,
          kernelVersion: profile.kernelVersion,
        },
      });
    } catch (error: any) {
      await cleanupFile(req.file?.path);
      console.error('[bugreport] Parse error:', error);
      res.status(500).json({
        error: 'Failed to parse bugreport',
        details: error.message,
      });
    }
  },
);

// POST /api/traces/upload-url - Fetch a remote trace from the backend side.
router.post('/upload-url', async (req, res) => {
  try {
    const context = requireRequestContext(req);
    if (!hasRbacPermission(context, 'trace:write')) {
      return sendForbidden(res, 'Uploading traces requires trace:write permission');
    }
    const tenantDecision = evaluateTenantMutationPolicy(context);
    if (!tenantDecision.allowed) {
      return res.status(tenantDecision.httpStatus).json(sendTenantMutationDeniedPayload(tenantDecision));
    }
    const rawUrl = typeof req.body?.url === 'string' ? req.body.url : '';
    if (!rawUrl) {
      return res.status(400).json({
        error: 'No URL provided'
      });
    }

    const url = new URL(rawUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return res.status(400).json({
        error: 'Only http and https trace URLs are supported'
      });
    }
    if (isBlockedTraceUrl(url)) {
      return res.status(400).json({
        error: 'Local and private trace URLs are not supported'
      });
    }

    const filename = typeof req.body?.filename === 'string' && req.body.filename.trim()
      ? path.basename(req.body.filename.trim())
      : getFilenameFromUrl(rawUrl);

    console.log(`Fetching URL trace: ${rawUrl}`);
    const response = await fetch(rawUrl, {
      signal: AbortSignal.timeout(URL_UPLOAD_TIMEOUT_MS),
    });
    if (!response.ok) {
      return res.status(502).json({
        error: 'Failed to fetch trace URL',
        details: `${response.status} ${response.statusText}`
      });
    }

    const contentLength = response.headers.get('content-length');
    const uploadLimitBytes = resolveTraceUploadLimitBytes();
    const contentLengthBytes = contentLength ? Number.parseInt(contentLength, 10) : Number.NaN;
    if (Number.isFinite(contentLengthBytes) && contentLengthBytes > uploadLimitBytes) {
      return res.status(413).json({
        error: 'Trace file too large',
        details: `Remote trace exceeds ${uploadLimitBytes} bytes`
      });
    }
    if (Number.isFinite(contentLengthBytes)) {
      const quotaDecision = evaluateTraceUploadQuota(context, contentLengthBytes);
      if (!quotaDecision.allowed) {
        return sendTraceQuotaDenied(res, quotaDecision);
      }
    }

    const tracesDir = getWritableTraceDirForContext(context);
    await fs.mkdir(tracesDir, { recursive: true });

    const traceId = uuidv4();
    const tempPath = path.join(tracesDir, tempUploadFilename());
    const finalPath = path.join(tracesDir, `${traceId}.trace`);
    let size = 0;
    try {
      size = await streamResponseBodyToTempFile(response, tempPath);
      const quotaDecision = evaluateTraceUploadQuota(context, size);
      if (!quotaDecision.allowed) {
        await cleanupFile(tempPath);
        return sendTraceQuotaDenied(res, quotaDecision);
      }
      await renameTraceAtomically(tempPath, finalPath);
    } catch (streamError) {
      await cleanupFile(tempPath);
      throw streamError;
    }

    console.log(`URL trace fetched successfully: ${rawUrl} -> ${traceId}`);

    const traceInfo = await finalizeTraceUpload(traceId, filename, size, finalPath, context, 'url');

    res.json({
      success: true,
      trace: {
        id: traceId,
        filename,
        size,
        uploadedAt: traceInfo?.uploadTime || new Date().toISOString(),
        status: traceInfo?.status || 'ready',
        port: traceInfo?.port,
        leaseId: traceInfo?.leaseId,
        leaseState: traceInfo?.leaseState,
        leaseMode: traceInfo?.leaseMode,
        leaseModeReason: traceInfo?.leaseModeReason,
        leaseQueueLength: traceInfo?.leaseQueueLength,
        processorStatus: traceInfo?.processor?.status,
      }
    });

  } catch (error: any) {
    if (error instanceof TraceUploadTooLargeError) {
      return res.status(413).json({
        error: 'Trace file too large',
        details: `Remote trace exceeds ${error.maxBytes} bytes`,
      });
    }
    console.error('URL upload error:', error);
    res.status(500).json({
      error: 'URL upload failed',
      details: error.message
    });
  }
});

// GET /api/traces - List all traces
router.get('/', async (req, res) => {
  try {
    const context = requireRequestContext(req);
    if (!hasRbacPermission(context, 'trace:read')) {
      return sendForbidden(res, 'Listing traces requires trace:read permission');
    }
    const ownedTraces: TraceMetadata[] = await listTraceMetadataForContext(context);

    // Sort by upload date (newest first)
    ownedTraces.sort((a, b) => new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime());

    res.json({ traces: ownedTraces });
  } catch (error: any) {
    console.error('List traces error:', error);
    res.status(500).json({
      error: 'Failed to list traces',
      details: error.message
    });
  }
});

// GET /api/traces/stats - Get resource usage statistics
// IMPORTANT: Must be before /:id to avoid matching "stats" as an id
router.get('/stats', async (req, res) => {
  try {
    const context = requireRequestContext(req);
    if (!hasRbacPermission(context, 'trace:read')) {
      return sendForbidden(res, 'Trace stats require trace:read permission');
    }
    const ownedTraceIds = new Set<string>();
    for (const metadata of await listTraceMetadataForContext(context)) {
      ownedTraceIds.add(metadata.id);
    }
    const portPoolStats = getPortPool().getStats();
    const processorStats = TraceProcessorFactory.getStats();
    const traceService = getTraceProcessorService();
    const traces = traceService.getAllTraces().filter(t => ownedTraceIds.has(t.id));
    const allocations = portPoolStats.allocations
      .map(allocation => ({
        ...allocation,
        ownerTraceId: ownedTraceIdForProcessorKey(allocation.traceId, ownedTraceIds),
      }))
      .filter(allocation => allocation.ownerTraceId !== null);
    const processors = processorStats.processors.filter(processor => ownedTraceIds.has(processor.traceId));
    const queueLength = processors.reduce((sum, processor) => {
      const worker = processor.sqlWorker;
      return sum + (worker ? worker.queuedP0 + worker.queuedP1 + worker.queuedP2 : 0);
    }, 0);
    const leases = enterpriseLeasesEnabled()
      ? getTraceProcessorLeaseStore().listLeases(leaseScopeFromContext(context))
        .filter(lease => ownedTraceIds.has(lease.traceId))
      : [];
    const activeLeases = leases.filter(lease => lease.state !== 'released' && lease.state !== 'failed');

    res.json({
      success: true,
      stats: {
        ramBudget: processorStats.ramBudget,
        portPool: {
          total: portPoolStats.total,
          available: portPoolStats.available,
          allocated: allocations.length,
          allocations: allocations.map(a => ({
            port: a.port,
            traceId: a.ownerTraceId,
            processorKey: a.traceId,
            allocatedAt: a.allocatedAt,
          })),
        },
        processors: {
          count: processors.length,
          traceIds: processors.map(processor => processor.traceId),
          queueLength,
          items: processors,
        },
        leases: {
          count: leases.length,
          activeCount: activeLeases.length,
          crashCount: leases.filter(lease => lease.state === 'crashed').length,
          holderCount: leases.reduce((sum, lease) => sum + lease.holderCount, 0),
          items: leases.map(lease => ({
            id: lease.id,
            traceId: lease.traceId,
            mode: lease.mode,
            state: lease.state,
            rssBytes: lease.rssBytes,
            queueLength: queueLengthForLease(lease, processors),
            holderCount: lease.holderCount,
            holders: lease.holders.map(holder => ({
              holderType: holder.holderType,
              holderRef: holder.holderRef,
              windowId: holder.windowId,
              heartbeatAt: holder.heartbeatAt,
              expiresAt: holder.expiresAt,
            })),
          })),
        },
        traces: {
          count: traces.length,
          items: traces.map(t => ({
            id: t.id,
            filename: t.filename,
            status: t.status,
            uploadTime: t.uploadTime,
          })),
        },
      },
    });
  } catch (error: any) {
    console.error('[Traces] Stats error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// POST /api/traces/cleanup - Cleanup all resources
// IMPORTANT: Must be before /:id to avoid matching "cleanup" as an id
router.post('/cleanup', async (req, res) => {
  try {
    const context = requireRequestContext(req);
    const isEnterprise = enterpriseLeasesEnabled();
    const canAdminCleanup = isEnterprise
      ? hasRbacPermission(context, 'trace:delete_any')
      : isPrivilegedRequestContext(context);
    if (!canAdminCleanup) {
      return sendResourceNotFound(res);
    }

    if (isEnterprise) {
      const result = await cleanupEnterpriseWorkspaceProcessors(context);
      if (result.blocked) {
        return res.status(409).json({
          success: false,
          error: 'Trace cleanup blocked by active trace processor leases',
          blockedLeases: result.blockedLeases,
        });
      }

      return res.json({
        success: true,
        message: `Enterprise cleanup complete. Released ${result.releasedLeaseIds.length} lease(s) and cleaned ${result.cleanedProcessors} processor(s).`,
        releasedLeaseIds: result.releasedLeaseIds,
        cleanedProcessors: result.cleanedProcessors,
        traceCount: result.traceIds.length,
      });
    }

    console.log('[Traces] Starting full cleanup...');

    // Cleanup all trace processors
    TraceProcessorFactory.cleanup();

    // Cleanup stale port allocations
    const portPool = getPortPool();
    const staleCount = portPool.cleanupStale(0); // Cleanup all

    console.log(`[Traces] Cleanup complete. Released ${staleCount} stale allocations.`);

    res.json({
      success: true,
      message: `Cleanup complete. Released ${staleCount} port allocations.`,
      stats: portPool.getStats(),
    });
  } catch (error: any) {
    console.error('[Traces] Cleanup error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// POST /api/traces/register-rpc - Register an existing HTTP RPC connection
// This is used when frontend is already connected to a trace_processor via HTTP RPC
// and wants to enable AI analysis without re-uploading the trace
router.post('/register-rpc', async (req, res) => {
  try {
    const context = requireRequestContext(req);
    if (!hasRbacPermission(context, 'trace:write')) {
      return sendForbidden(res, 'Registering traces requires trace:write permission');
    }
    if (enterpriseLeasesEnabled()) {
      return res.status(410).json({
        success: false,
        error: 'Direct RPC registration is disabled in enterprise mode; use backend lease proxy targets.',
      });
    }
    const { port, traceName } = req.body;

    if (!port) {
      return res.status(400).json({
        success: false,
        error: 'Port is required',
      });
    }

    console.log(`[Traces] Registering external RPC connection on port ${port}, name: ${traceName || 'External Trace'}`);

    // Generate a trace ID for this external connection
    const traceId = `external-rpc-${port}-${Date.now()}`;

    // Get the trace processor service
    const tps = getTraceProcessorService();

    if (tps) {
      // Register the external RPC connection
      await tps.registerExternalRpc(traceId, port, traceName || 'External RPC Trace');
      console.log(`[Traces] Registered external RPC as traceId: ${traceId}`);
    }

    await writeTraceMetadata({
      id: traceId,
      filename: traceName || 'External RPC Trace',
      size: 0,
      uploadedAt: new Date().toISOString(),
      status: 'ready',
      externalRpc: true,
      port,
      ...buildTraceOwnerMetadata(context),
    });

    const lease = acquireManualRegisterLease(context, traceId, Number(port));

    res.json({
      success: true,
      traceId,
      port,
      ...leaseResponseFields(lease),
      message: `External RPC connection registered successfully`,
    });

  } catch (error: any) {
    console.error('[Traces] Register RPC error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// GET /api/traces/:id - Get a single trace info (for verifying trace exists)
router.get('/:id', async (req, res) => {
  try {
    const context = requireRequestContext(req);
    const { id } = req.params;
    const metadata = await readTraceMetadataForContext(id, context);

    if (!metadata) {
      return res.status(404).json({
        error: 'Trace not found',
        id
      });
    }

    // Also check TraceProcessorService for processor status
    const tps = getTraceProcessorService();
    const traceInfo = tps?.getTraceWithPort(id);

    const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : undefined;
    const lease = traceInfo?.port ? acquireFrontendTraceLease(context, id, sessionId) : null;
    recordTraceAudit(context, 'trace.read', id, {
      filename: metadata.filename,
      size: metadata.size,
      hasProcessor: Boolean(traceInfo?.processor),
    });

    res.json({
      success: true,
      trace: {
        ...metadata,
        processorStatus: traceInfo?.status || 'unknown',
        hasProcessor: !!traceInfo?.processor,
        port: traceInfo?.port ?? metadata.port,
        ...leaseResponseFields(lease),
      }
    });
  } catch (error: any) {
    console.error('[Traces] Get trace error:', error);
    res.status(500).json({
      error: 'Failed to get trace',
      details: error.message
    });
  }
});

// DELETE /api/traces/:id - Delete a trace and cleanup all resources
router.delete('/:id', async (req, res) => {
  try {
    const context = requireRequestContext(req);
    const { id } = req.params;
    const metadata = await readTraceMetadata(id);
    if (!metadata) {
      return res.status(404).json({
        error: 'Trace not found',
        id
      });
    }
    if (!sharesWorkspaceWithContext(metadata, context)) {
      return res.status(404).json({
        error: 'Trace not found',
        id
      });
    }
    if (!canDeleteTraceResource(metadata, context)) {
      return sendForbidden(res, 'Deleting this trace requires trace delete permission');
    }
    if (enterpriseLeasesEnabled()) {
      const blockers = blockEnterpriseTraceDeleteIfActive(context, id);
      if (blockers.blocked) {
        return res.status(409).json({
          success: false,
          error: 'Trace delete blocked by active analysis runs or trace processor leases',
          blockedLeases: blockers.blockedLeases,
          activeRuns: blockers.activeRuns,
        });
      }
    }
    console.log(`[Traces] Deleting trace ${id} and cleaning up resources...`);

    // First, cleanup the trace processor (this will release the port)
    try {
      const traceService = getTraceProcessorService();
      await traceService.deleteTrace(id);
      console.log(`[Traces] Trace processor cleaned up for ${id}`);
    } catch (error: any) {
      console.log(`[Traces] Trace processor cleanup skipped: ${error.message}`);
    }

    // Delete trace file
    const tracePath = metadata.path || getTraceFilePath(id);
    try {
      if (tracePath) {
        await fs.unlink(tracePath);
        console.log(`[Traces] Trace file deleted: ${tracePath}`);
      }
    } catch (error) {
      // File might not exist, continue
    }

    await deleteTraceMetadataForContext(id, context);
    console.log(`[Traces] Metadata deleted for ${id}`);
    recordTraceAudit(context, 'trace.deleted', id, {
      filename: metadata.filename,
      size: metadata.size,
    });

    console.log(`[Traces] Trace ${id} fully deleted`);
    res.json({ success: true, message: 'Trace deleted successfully' });

  } catch (error: any) {
    console.error('[Traces] Delete trace error:', error);
    res.status(500).json({
      error: 'Failed to delete trace',
      details: error.message
    });
  }
});

// GET /api/traces/:id/file - Download trace file
router.get('/:id/file', async (req, res) => {
  try {
    const context = requireRequestContext(req);
    const { id } = req.params;
    const metadata = await readTraceMetadataForContext(id, context);
    if (!metadata) {
      return res.status(404).json({
        error: 'Trace file not found',
        id
      });
    }
    if (!canDownloadTraceResource(metadata, context)) {
      return sendForbidden(res, 'Downloading traces requires trace download permission');
    }
    const tracePath = metadata.path || getTraceFilePath(id);
    if (!tracePath) {
      return res.status(404).json({
        error: 'Trace file not found',
        id
      });
    }

    try {
      await fs.access(tracePath);
      res.sendFile(path.resolve(tracePath));
    } catch (error) {
      res.status(404).json({
        error: 'Trace file not found',
        id
      });
    }
  } catch (error: any) {
    console.error('Download trace error:', error);
    res.status(500).json({
      error: 'Failed to download trace',
      details: error.message
    });
  }
});

export default router;

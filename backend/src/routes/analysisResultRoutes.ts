// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import express from 'express';
import { requireRequestContext } from '../middleware/auth';
import { openEnterpriseDb } from '../services/enterpriseDb';
import { createAnalysisResultSnapshotRepository } from '../services/analysisResultSnapshotStore';
import {
  canShareAnalysisResultResource,
  hasRbacPermission,
  sendForbidden,
} from '../services/rbac';
import type {
  AnalysisResultSceneType,
  AnalysisResultVisibility,
} from '../types/multiTraceComparison';

const VALID_SCENE_TYPES = new Set<AnalysisResultSceneType>([
  'startup',
  'scrolling',
  'interaction',
  'memory',
  'cpu',
  'general',
]);

const VALID_VISIBILITIES = new Set<AnalysisResultVisibility>(['private', 'workspace']);

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function parseLimit(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 500) {
    throw new Error('limit must be an integer between 1 and 500');
  }
  return parsed;
}

const router = express.Router();

router.get('/', (req, res) => {
  const context = requireRequestContext(req);
  if (!hasRbacPermission(context, 'analysis_result:read')) {
    sendForbidden(res, 'analysis_result:read permission is required');
    return;
  }

  const sceneType = optionalString(req.query.sceneType);
  if (sceneType && !VALID_SCENE_TYPES.has(sceneType as AnalysisResultSceneType)) {
    res.status(400).json({
      success: false,
      error: 'Invalid sceneType',
    });
    return;
  }

  const visibility = optionalString(req.query.visibility);
  if (visibility && !VALID_VISIBILITIES.has(visibility as AnalysisResultVisibility)) {
    res.status(400).json({
      success: false,
      error: 'Invalid visibility',
    });
    return;
  }

  let limit: number | undefined;
  try {
    limit = parseLimit(req.query.limit);
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Invalid limit',
    });
    return;
  }

  const db = openEnterpriseDb();
  try {
    const repository = createAnalysisResultSnapshotRepository(db);
    const results = repository.listSnapshots(
      {
        tenantId: context.tenantId,
        workspaceId: context.workspaceId,
        userId: context.userId,
      },
      {
        traceId: optionalString(req.query.traceId),
        sceneType: sceneType as AnalysisResultSceneType | undefined,
        visibility: visibility as AnalysisResultVisibility | undefined,
        createdBy: optionalString(req.query.createdBy),
        limit,
      },
    );
    res.json({
      success: true,
      results,
      count: results.length,
    });
  } catch (error) {
    console.error('[AnalysisResultRoutes] Failed to list analysis results:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to list analysis results',
    });
  } finally {
    db.close();
  }
});

router.get('/:snapshotId', (req, res) => {
  const context = requireRequestContext(req);
  if (!hasRbacPermission(context, 'analysis_result:read')) {
    sendForbidden(res, 'analysis_result:read permission is required');
    return;
  }

  const snapshotId = optionalString(req.params.snapshotId);
  if (!snapshotId) {
    res.status(400).json({
      success: false,
      error: 'snapshotId is required',
    });
    return;
  }

  const db = openEnterpriseDb();
  try {
    const repository = createAnalysisResultSnapshotRepository(db);
    const snapshot = repository.getSnapshot(
      {
        tenantId: context.tenantId,
        workspaceId: context.workspaceId,
        userId: context.userId,
      },
      snapshotId,
    );
    if (!snapshot) {
      res.status(404).json({
        success: false,
        error: 'Analysis result snapshot not found',
      });
      return;
    }

    res.json({
      success: true,
      snapshot,
    });
  } catch (error) {
    console.error('[AnalysisResultRoutes] Failed to read analysis result:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to read analysis result',
    });
  } finally {
    db.close();
  }
});

router.patch('/:snapshotId', (req, res) => {
  const context = requireRequestContext(req);
  const snapshotId = optionalString(req.params.snapshotId);
  if (!snapshotId) {
    res.status(400).json({
      success: false,
      error: 'snapshotId is required',
    });
    return;
  }

  const visibility = optionalString(req.body?.visibility);
  if (!visibility || !VALID_VISIBILITIES.has(visibility as AnalysisResultVisibility)) {
    res.status(400).json({
      success: false,
      error: 'Invalid visibility',
    });
    return;
  }

  const db = openEnterpriseDb();
  try {
    const repository = createAnalysisResultSnapshotRepository(db);
    const existing = repository.getSnapshot(
      {
        tenantId: context.tenantId,
        workspaceId: context.workspaceId,
        userId: context.userId,
      },
      snapshotId,
    );
    if (!existing) {
      res.status(404).json({
        success: false,
        error: 'Analysis result snapshot not found',
      });
      return;
    }

    if (!canShareAnalysisResultResource({
      tenantId: existing.tenantId,
      workspaceId: existing.workspaceId,
      userId: existing.createdBy,
    }, context)) {
      sendForbidden(res, 'analysis_result:share permission is required');
      return;
    }

    const updated = repository.updateVisibility(
      {
        tenantId: context.tenantId,
        workspaceId: context.workspaceId,
        userId: context.userId,
        auditActorUserId: context.userId,
      },
      snapshotId,
      visibility as AnalysisResultVisibility,
    );
    if (!updated) {
      res.status(404).json({
        success: false,
        error: 'Analysis result snapshot not found',
      });
      return;
    }

    res.json({
      success: true,
      snapshot: updated,
    });
  } catch (error) {
    console.error('[AnalysisResultRoutes] Failed to update analysis result:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update analysis result',
    });
  } finally {
    db.close();
  }
});

export default router;

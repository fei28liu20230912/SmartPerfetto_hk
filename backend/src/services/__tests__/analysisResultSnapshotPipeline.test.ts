// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import fs from 'fs';
import os from 'os';
import path from 'path';
import type { DataEnvelope } from '../../types/dataContract';
import {
  buildCompletedAnalysisResultSnapshot,
  persistCompletedAnalysisResultSnapshot,
} from '../analysisResultSnapshotPipeline';
import { ENTERPRISE_DB_PATH_ENV, openEnterpriseDb } from '../enterpriseDb';

const originalDbPath = process.env[ENTERPRISE_DB_PATH_ENV];
const tmpDirs: string[] = [];

function useTempEnterpriseDb(): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smartperfetto-snapshot-pipeline-'));
  tmpDirs.push(tmpDir);
  const dbPath = path.join(tmpDir, 'enterprise.sqlite');
  process.env[ENTERPRISE_DB_PATH_ENV] = dbPath;
  return dbPath;
}

afterEach(() => {
  if (originalDbPath === undefined) {
    delete process.env[ENTERPRISE_DB_PATH_ENV];
  } else {
    process.env[ENTERPRISE_DB_PATH_ENV] = originalDbPath;
  }
  while (tmpDirs.length > 0) {
    fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

function envelope(): DataEnvelope {
  return {
    meta: {
      type: 'skill_result',
      version: '2.0.0',
      source: 'startup_analysis',
      skillId: 'startup_analysis',
      stepId: 'summary',
      timestamp: 123,
    },
    data: { rows: [] },
    display: {
      layer: 'overview',
      format: 'table',
      title: 'Startup summary',
    },
  };
}

describe('analysis result snapshot pipeline', () => {
  test('builds a partial snapshot from completed run metadata', () => {
    const snapshot = buildCompletedAnalysisResultSnapshot({
      tenantId: 'tenant-a',
      workspaceId: 'workspace-a',
      userId: 'user-a',
      traceId: 'trace-a',
      sessionId: 'session-a',
      runId: 'run-a',
      reportId: 'report-a',
      query: '分析启动速度',
      conclusion: '启动耗时偏高。\n需要继续看主线程。',
      conclusionContract: {
        claims: [{
          id: 'Q1',
          text: '启动耗时偏高',
          references: [{ evidenceRefId: 'data:startup:summary:123', sourceRef: '表 1' }],
        }],
      },
      confidence: 0.7,
      dataEnvelopes: [envelope()],
      createdAt: 1234,
    });

    expect(snapshot).toEqual(expect.objectContaining({
      tenantId: 'tenant-a',
      workspaceId: 'workspace-a',
      traceId: 'trace-a',
      sessionId: 'session-a',
      runId: 'run-a',
      reportId: 'report-a',
      createdBy: 'user-a',
      sceneType: 'startup',
      visibility: 'private',
      status: 'partial',
      createdAt: 1234,
    }));
    expect(snapshot?.summary).toEqual(expect.objectContaining({
      headline: '启动耗时偏高。',
      confidence: 0.7,
      partialReasons: expect.arrayContaining(['No normalized comparison metrics extracted yet']),
    }));
    expect(snapshot?.conclusionContract).toEqual(expect.objectContaining({
      claims: [expect.objectContaining({ id: 'Q1' })],
    }));
    expect(snapshot?.metrics).toEqual([]);
    expect(snapshot?.evidenceRefs).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'report:report-a', type: 'report' }),
      expect.objectContaining({ type: 'data_envelope', label: 'Startup summary' }),
    ]));
  });

  test('returns null when tenant, workspace, or run metadata is missing', () => {
    expect(buildCompletedAnalysisResultSnapshot({
      traceId: 'trace-a',
      sessionId: 'session-a',
      query: 'analyze',
    })).toBeNull();
  });

  test('extracts startup metrics from structured DataEnvelope rows', () => {
    const snapshot = buildCompletedAnalysisResultSnapshot({
      tenantId: 'tenant-a',
      workspaceId: 'workspace-a',
      traceId: 'trace-a',
      sessionId: 'session-a',
      runId: 'run-a',
      query: 'startup analysis',
      dataEnvelopes: [{
        ...envelope(),
        data: {
          columns: ['startup_id', 'total_ms', 'first_frame_ms'],
          rows: [[1, 1450.5, 620]],
        },
      }],
      createdAt: 1234,
    });

    expect(snapshot?.status).toBe('ready');
    expect(snapshot?.metrics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: 'startup.total_ms',
        value: 1450.5,
        unit: 'ms',
        source: expect.objectContaining({ skillId: 'startup_analysis' }),
      }),
      expect.objectContaining({
        key: 'startup.first_frame_ms',
        value: 620,
      }),
    ]));
    expect(snapshot?.summary.partialReasons).toBeUndefined();
  });

  test('extracts scrolling metrics and normalizes fractional jank rate to percent', () => {
    const snapshot = buildCompletedAnalysisResultSnapshot({
      tenantId: 'tenant-a',
      workspaceId: 'workspace-a',
      traceId: 'trace-a',
      sessionId: 'session-a',
      runId: 'run-a',
      query: '对比 FPS 和 jank',
      dataEnvelopes: [{
        ...envelope(),
        meta: {
          ...envelope().meta,
          source: 'scrolling_analysis',
          skillId: 'scrolling_analysis',
          stepId: 'session_jank',
        },
        display: {
          ...envelope().display,
          title: 'Scrolling summary',
        },
        data: {
          rows: [{
            avg_fps: '58.5',
            frame_count: 240,
            jank_count: 12,
            jank_rate: 0.05,
            p95_frame_ms: 28,
          }],
        } as any,
      }],
      createdAt: 1234,
    });

    expect(snapshot?.sceneType).toBe('scrolling');
    expect(snapshot?.metrics).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'scrolling.avg_fps', value: 58.5, unit: 'fps' }),
      expect.objectContaining({ key: 'scrolling.jank_rate_pct', value: 5, unit: '%' }),
      expect.objectContaining({ key: 'scrolling.p95_frame_ms', value: 28, unit: 'ms' }),
    ]));
  });

  test('uses stable DataEnvelope evidence refs without collapsing SQL comparison tables', () => {
    const currentSql = {
      ...envelope(),
      meta: {
        type: 'sql_result' as const,
        version: '2.0.0',
        source: 'execute_sql',
        timestamp: 0,
        evidenceRefId: 'data:sql:current:trace-a:q1',
        traceSide: 'current' as const,
        traceId: 'trace-a',
        queryHash: 'q1',
        sourceToolCallId: 'execute_sql_on:1:params_hash:current',
        paramsHash: 'params_hash',
        planPhaseId: 'phase-compare',
        planPhaseTitle: 'Compare FPS',
        planPhaseGoal: 'Query current and reference FPS',
        toolNarration: '执行对比 SQL：查询当前 Trace 帧率',
        producerReason: '验证当前 Trace FPS 基线',
      },
      data: {
        columns: ['avg_fps'],
        rows: [[58]],
      },
      display: {
        layer: 'list' as const,
        format: 'table' as const,
        title: 'SQL Query current',
      },
    };
    const referenceSql = {
      ...currentSql,
      meta: {
        ...currentSql.meta,
        evidenceRefId: 'data:sql:reference:trace-b:q1',
        traceSide: 'reference' as const,
        traceId: 'trace-b',
        sourceToolCallId: 'execute_sql_on:2:params_hash:reference',
        toolNarration: '执行对比 SQL：查询参考 Trace 帧率',
        producerReason: '验证参考 Trace FPS 基线',
      },
      display: {
        ...currentSql.display,
        title: 'SQL Query reference',
      },
    };

    const snapshot = buildCompletedAnalysisResultSnapshot({
      tenantId: 'tenant-a',
      workspaceId: 'workspace-a',
      traceId: 'trace-a',
      sessionId: 'session-a',
      runId: 'run-a',
      query: 'compare fps',
      dataEnvelopes: [currentSql, referenceSql],
      createdAt: 1234,
    });

    const dataRefs = snapshot?.evidenceRefs.filter(ref => ref.type === 'data_envelope');
    expect(dataRefs?.map(ref => ref.id)).toEqual([
      'data:sql:current:trace-a:q1',
      'data:sql:reference:trace-b:q1',
    ]);
    expect(dataRefs?.[0].metadata).toEqual(expect.objectContaining({
      traceSide: 'current',
      traceId: 'trace-a',
      queryHash: 'q1',
      sourceToolCallId: 'execute_sql_on:1:params_hash:current',
      paramsHash: 'params_hash',
      planPhaseId: 'phase-compare',
      planPhaseTitle: 'Compare FPS',
      planPhaseGoal: 'Query current and reference FPS',
      toolNarration: '执行对比 SQL：查询当前 Trace 帧率',
      producerReason: '验证当前 Trace FPS 基线',
    }));
    expect(dataRefs?.[1].metadata).toEqual(expect.objectContaining({
      traceSide: 'reference',
      traceId: 'trace-b',
      queryHash: 'q1',
      sourceToolCallId: 'execute_sql_on:2:params_hash:reference',
      paramsHash: 'params_hash',
      planPhaseId: 'phase-compare',
      planPhaseTitle: 'Compare FPS',
      planPhaseGoal: 'Query current and reference FPS',
      toolNarration: '执行对比 SQL：查询参考 Trace 帧率',
      producerReason: '验证参考 Trace FPS 基线',
    }));
  });

  test('keeps duplicate evidence refs separate when tool call ids differ', () => {
    const first = {
      ...envelope(),
      meta: {
        ...envelope().meta,
        evidenceRefId: 'data:sql:duplicate',
        sourceToolCallId: 'execute_sql:1:params',
        timestamp: 1,
      },
      display: {
        ...envelope().display,
        title: 'Duplicate table 1',
      },
      data: {
        columns: ['value'],
        rows: [[1]],
      },
    };
    const second = {
      ...first,
      meta: {
        ...first.meta,
        sourceToolCallId: 'execute_sql:2:params',
        timestamp: 2,
      },
      display: {
        ...first.display,
        title: 'Duplicate table 2',
      },
      data: {
        columns: ['value'],
        rows: [[2]],
      },
    };

    const snapshot = buildCompletedAnalysisResultSnapshot({
      tenantId: 'tenant-a',
      workspaceId: 'workspace-a',
      traceId: 'trace-a',
      sessionId: 'session-a',
      runId: 'run-a',
      query: 'duplicate evidence refs',
      dataEnvelopes: [first, second],
      conclusionContract: {
        claims: [{
          id: 'Q1',
          text: '第二个表的值为 2',
          references: [{
            evidence_ref_id: 'data:sql:duplicate',
            source_tool_call_id: 'execute_sql:2:params',
            row_index: 0,
            column: 'value',
            value: 2,
          }],
        }],
      },
      createdAt: 1234,
    });

    const dataRefs = snapshot?.evidenceRefs.filter(ref => ref.type === 'data_envelope') || [];
    expect(dataRefs.map(ref => ref.id)).toEqual([
      'data:sql:duplicate:tool:execute_sql:1:params',
      'data:sql:duplicate:tool:execute_sql:2:params',
    ]);
    expect(dataRefs.map(ref => ref.metadata?.sourceToolCallId)).toEqual([
      'execute_sql:1:params',
      'execute_sql:2:params',
    ]);
  });

  test('keeps claim-referenced DataEnvelope evidence refs beyond the snapshot list cap', () => {
    const dataEnvelopes = Array.from({ length: 105 }, (_, index): DataEnvelope => ({
      ...envelope(),
      meta: {
        ...envelope().meta,
        evidenceRefId: `data:sql:${index + 1}`,
        sourceToolCallId: `execute_sql:${index + 1}:params`,
        timestamp: index + 1,
      },
      display: {
        ...envelope().display,
        title: `SQL table ${index + 1}`,
      },
      data: {
        columns: ['idx', 'value'],
        rows: [[index + 1, index + 1]],
      },
    }));

    const snapshot = buildCompletedAnalysisResultSnapshot({
      tenantId: 'tenant-a',
      workspaceId: 'workspace-a',
      traceId: 'trace-a',
      sessionId: 'session-a',
      runId: 'run-a',
      query: 'long evidence run',
      dataEnvelopes,
      conclusionContract: {
        claims: [{
          id: 'Q1',
          text: '第 105 个表的值为 105',
          references: [{
            evidence_ref_id: 'data:sql:105',
            source_tool_call_id: 'execute_sql:105:params',
            source_ref: '表 105',
            row_index: 0,
            column: 'value',
            value: 105,
          }],
        }],
      },
      createdAt: 1234,
    });

    const dataRefs = snapshot?.evidenceRefs.filter(ref => ref.type === 'data_envelope') || [];
    expect(dataRefs).toHaveLength(101);
    expect(dataRefs.map(ref => ref.id)).toContain('data:sql:100');
    expect(dataRefs.map(ref => ref.id)).not.toContain('data:sql:101');
    expect(dataRefs.map(ref => ref.id)).toContain('data:sql:105');
    expect(dataRefs.find(ref => ref.id === 'data:sql:105')).toEqual(expect.objectContaining({
      label: 'SQL table 105',
      metadata: expect.objectContaining({
        evidenceRefId: 'data:sql:105',
        sourceToolCallId: 'execute_sql:105:params',
      }),
    }));
  });

  test('keeps source_ref-only claim tables beyond the snapshot list cap', () => {
    const dataEnvelopes = Array.from({ length: 105 }, (_, index): DataEnvelope => ({
      ...envelope(),
      meta: {
        ...envelope().meta,
        evidenceRefId: `data:sql:${index + 1}`,
        sourceToolCallId: `execute_sql:${index + 1}:params`,
        timestamp: index + 1,
      },
      display: {
        ...envelope().display,
        title: `SQL table ${index + 1}`,
      },
      data: {
        columns: ['idx', 'value'],
        rows: [[index + 1, index + 1]],
      },
    }));

    const snapshot = buildCompletedAnalysisResultSnapshot({
      tenantId: 'tenant-a',
      workspaceId: 'workspace-a',
      traceId: 'trace-a',
      sessionId: 'session-a',
      runId: 'run-a',
      query: 'long source_ref-only run',
      dataEnvelopes,
      conclusionContract: {
        claims: [{
          id: 'Q1',
          text: '第 105 个表的值为 105',
          references: [{
            source_ref: '表 105',
            row_index: 0,
            column: 'value',
            value: 105,
          }],
        }],
      },
      createdAt: 1234,
    });

    const dataRefs = snapshot?.evidenceRefs.filter(ref => ref.type === 'data_envelope') || [];
    expect(dataRefs.map(ref => ref.id)).toContain('data:sql:105');
    expect(dataRefs.find(ref => ref.id === 'data:sql:105')).toEqual(expect.objectContaining({
      label: 'SQL table 105',
    }));
  });

  test('persists snapshot when the parent run graph does not exist yet', () => {
    useTempEnterpriseDb();

    const snapshot = persistCompletedAnalysisResultSnapshot({
      tenantId: 'tenant-a',
      workspaceId: 'workspace-a',
      userId: 'user-a',
      traceId: 'trace-a',
      sessionId: 'session-a',
      runId: 'run-a',
      query: '分析滑动性能',
      conclusion: '滑动整体稳定。',
      dataEnvelopes: [{
        ...envelope(),
        meta: {
          ...envelope().meta,
          source: 'scrolling_analysis',
          skillId: 'scrolling_analysis',
        },
        data: {
          rows: [{
            avg_fps: 60,
            jank_count: 0,
          }],
        } as any,
      }],
      createdAt: 1778937300000,
    });

    expect(snapshot).toEqual(expect.objectContaining({
      tenantId: 'tenant-a',
      workspaceId: 'workspace-a',
      traceId: 'trace-a',
      sessionId: 'session-a',
      runId: 'run-a',
      status: 'ready',
    }));

    const db = openEnterpriseDb();
    try {
      const row = db.prepare(`
        SELECT s.id AS snapshot_id, r.id AS run_id, t.id AS trace_id
        FROM analysis_result_snapshots s
        JOIN analysis_runs r
          ON r.tenant_id = s.tenant_id
          AND r.workspace_id = s.workspace_id
          AND r.id = s.run_id
        JOIN trace_assets t
          ON t.tenant_id = s.tenant_id
          AND t.workspace_id = s.workspace_id
          AND t.id = s.trace_id
        WHERE s.id = ?
      `).get(snapshot!.id) as { snapshot_id: string; run_id: string; trace_id: string } | undefined;
      expect(row).toEqual({
        snapshot_id: snapshot!.id,
        run_id: 'run-a',
        trace_id: 'trace-a',
      });
    } finally {
      db.close();
    }
  });
});

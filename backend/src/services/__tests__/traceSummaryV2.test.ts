// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, it, expect} from '@jest/globals';
import {
  _getDefaultProbeIdsForTesting,
  buildTraceSummaryV2,
} from '../traceSummaryV2';
import {isUnsupported} from '../../types/sparkContracts';

type MockRow = {columns: string[]; rows: any[][]; error?: string};

function makeMockQuery(responses: Record<string, MockRow>) {
  return async (sql: string): Promise<MockRow> => {
    for (const [key, value] of Object.entries(responses)) {
      if (sql.includes(key)) return value;
    }
    return {columns: [], rows: [], error: 'no mock for: ' + sql.slice(0, 40)};
  };
}

describe('traceSummaryV2', () => {
  it('builds a contract with all probes successful', async () => {
    const query = makeMockQuery({
      trace_bounds: {columns: ['start_ts', 'end_ts'], rows: [[1_000, 5_000_000_000]]},
      'COUNT(*) FROM process': {columns: ['c'], rows: [[42]]},
      'COUNT(*) FROM slice': {columns: ['c'], rows: [[10_000]]},
      actual_frame_timeline_slice: {columns: ['total', 'jank'], rows: [[600, 18]]},
      'ORDER BY slice.dur DESC': {
        columns: ['name', 'dur'],
        rows: [
          ['Choreographer#doFrame', 10_000_000],
          ['View.measure', 8_000_000],
        ],
      },
    });

    const contract = await buildTraceSummaryV2({
      query,
      traceProcessorBuild: 'v55.0',
    });

    expect(isUnsupported(contract)).toBe(false);
    expect(contract.traceProcessorBuild).toBe('v55.0');
    expect(contract.traceRange.endNs).toBe(5_000_000_000);
    expect(contract.probes.trace_bounds).toBe(true);
    expect(contract.probes.frame_timeline_jank).toBe(true);

    const jank = contract.metrics.find(m => m.metricId === 'frames.jank_count');
    expect(jank?.value).toBe(18);
    expect(jank?.layer).toBe('L2');

    // Top-slices probe yields per-row metrics with evidence.
    const topMetrics = contract.metrics.filter(m =>
      m.metricId.startsWith('slice.top_'),
    );
    expect(topMetrics.length).toBe(2);
    expect(topMetrics[0].evidence?.description).toBe('Choreographer#doFrame');

    // Coverage entries for all three Spark numbers.
    const covered = contract.coverage.map(c => c.sparkId);
    expect(covered).toEqual([2, 22, 102]);
  });

  it('treats missing FrameTimeline data as unsupported, not 0 jank (Codex round 7 regression)', async () => {
    // SQL probe filters out the result row when per_frame is empty, so
    // runProbe sees rows.length === 0 and marks the probe unsupported.
    const query = makeMockQuery({
      trace_bounds: {columns: ['start_ts', 'end_ts'], rows: [[0, 1_000]]},
      'COUNT(*) FROM process': {columns: ['c'], rows: [[1]]},
      'COUNT(*) FROM slice': {columns: ['c'], rows: [[1]]},
      // FrameTimeline probe returns no rows (simulating empty per_frame CTE).
      actual_frame_timeline_slice: {columns: ['total', 'jank'], rows: []},
      'ORDER BY slice.dur DESC': {
        columns: ['name', 'dur'],
        rows: [['x', 1]],
      },
    });
    const contract = await buildTraceSummaryV2({query});
    expect(contract.probes.frame_timeline_jank).toBe(false);
    // No frames.* metric should claim 0 jank.
    const jank = contract.metrics.find(m => m.metricId === 'frames.jank_count');
    expect(jank).toBeUndefined();
    const unsupported = contract.metrics.find(m => m.metricId === 'frame_timeline_jank.unsupported');
    expect(unsupported).toBeDefined();
  });

  it('marks failing probes unsupported instead of zero-filling metrics', async () => {
    const query = makeMockQuery({
      trace_bounds: {columns: ['start_ts', 'end_ts'], rows: [[0, 1_000_000]]},
      // Other probes intentionally not mocked so they fail.
    });

    const contract = await buildTraceSummaryV2({query});

    expect(contract.probes.trace_bounds).toBe(true);
    expect(contract.probes.frame_timeline_jank).toBe(false);

    const failed = contract.metrics.find(m => m.metricId.endsWith('.unsupported'));
    expect(failed).toBeDefined();
    expect(failed?.unsupportedReason).toBeTruthy();
  });

  it('marks the entire contract unsupported when every probe fails', async () => {
    const query = async (): Promise<MockRow> => ({
      columns: [],
      rows: [],
      error: 'trace_processor unreachable',
    });

    const contract = await buildTraceSummaryV2({query});

    expect(isUnsupported(contract)).toBe(true);
    expect(contract.unsupportedReason).toMatch(/all probes failed/);
    expect(_getDefaultProbeIdsForTesting()).toContain('trace_bounds');
  });
});

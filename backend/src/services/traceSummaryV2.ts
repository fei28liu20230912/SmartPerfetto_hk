// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Trace Summary v2 (Spark Plan 02)
 *
 * Runs a small, deterministic catalog of probe queries against a live
 * `trace_processor_shell --httpd` (Spark #102 — engine continues to be
 * canonical) and returns a `TraceSummaryV2Contract` with hierarchical
 * L0-L3 metrics plus per-probe support flags.
 *
 * Design choices:
 *  - The query function is injected so this module is unit-testable without
 *    spinning up trace_processor; production callers pass a TraceProcessor.
 *  - Each metric is fully self-describing (`unit`, `layer`, `source`,
 *    optional `evidenceRef`, `unsupportedReason`) so AI consumers can quote
 *    provenance for every value.
 *  - Probes that return an error or empty result mark the metric
 *    `unsupportedReason` rather than fabricating a zero, satisfying the plan
 *    invariant that missing data is never silently filled.
 */

import {
  makeSparkProvenance,
  type TraceSummaryBaselineRef,
  type TraceSummaryLayer,
  type TraceSummaryMetric,
  type TraceSummaryV2Contract,
} from '../types/sparkContracts';

export interface QueryFn {
  (sql: string): Promise<{
    columns: string[];
    rows: any[][];
    error?: string;
  }>;
}

export interface TraceSummaryV2Options {
  query: QueryFn;
  /** Optional trace processor build identifier (semver / git sha). */
  traceProcessorBuild?: string;
  /** Optional baseline pointer to attach for diff context. */
  baseline?: TraceSummaryBaselineRef;
}

interface ProbeSpec {
  /** Probe identifier — also used as the `probes` flag key. */
  id: string;
  /** Layer the resulting metric belongs to. */
  layer: TraceSummaryLayer;
  /** SQL to run against trace_processor. */
  sql: string;
  /** Convert the result rows to TraceSummaryMetric entries. */
  toMetrics: (rows: any[][]) => TraceSummaryMetric[];
}

const SECOND_NS = 1_000_000_000;

/** L0 — total trace duration in ns. */
const PROBE_TRACE_BOUNDS: ProbeSpec = {
  id: 'trace_bounds',
  layer: 'L0',
  sql: 'SELECT start_ts, end_ts FROM trace_bounds',
  toMetrics: rows => {
    if (rows.length === 0) return [];
    const startNs = Number(rows[0][0]);
    const endNs = Number(rows[0][1]);
    return [
      {
        metricId: 'trace.duration_ns',
        value: endNs - startNs,
        unit: 'ns',
        range: {startNs, endNs},
        layer: 'L0',
        source: 'trace_bounds',
      },
    ];
  },
};

/** L1 — process count and slice count. */
const PROBE_PROCESS_COUNT: ProbeSpec = {
  id: 'process_count',
  layer: 'L1',
  sql: 'SELECT COUNT(*) FROM process',
  toMetrics: rows => [
    {
      metricId: 'trace.process_count',
      value: Number(rows[0]?.[0] ?? 0),
      unit: 'count',
      layer: 'L1',
      source: 'process',
    },
  ],
};

const PROBE_SLICE_COUNT: ProbeSpec = {
  id: 'slice_count',
  layer: 'L1',
  sql: 'SELECT COUNT(*) FROM slice',
  toMetrics: rows => [
    {
      metricId: 'trace.slice_count',
      value: Number(rows[0]?.[0] ?? 0),
      unit: 'count',
      layer: 'L1',
      source: 'slice',
    },
  ],
};

/**
 * L2 — frame timeline jank counts (Spark #16 ground truth surface).
 *
 * Codex round 5 caught that COUNT(*) over actual_frame_timeline_slice
 * counts timeline-slice rows, not frames — multi-layer apps produce
 * multiple slice rows per frame, inflating both totals. Aggregate by
 * (upid, name) first so the L2 metric reports distinct frames.
 *
 * Codex round 7: when a trace has no FrameTimeline rows at all (e.g.
 * captured without surfaceflinger.frametimeline data source), the
 * aggregate would still return one row with COUNT=0 and SUM=NULL,
 * making missing capture data look like "valid no-jank". The outer
 * filter drops the result row when per_frame is empty so runProbe
 * marks the probe unsupported instead of silently zero-filling.
 */
const PROBE_FRAME_TIMELINE_JANK: ProbeSpec = {
  id: 'frame_timeline_jank',
  layer: 'L2',
  sql: `
    WITH per_frame AS (
      SELECT
        upid,
        name,
        MAX(CASE WHEN jank_type IS NOT NULL AND jank_type != 'None' THEN 1 ELSE 0 END) AS is_jank
      FROM actual_frame_timeline_slice
      GROUP BY upid, name
    )
    SELECT total, jank
    FROM (
      SELECT
        COUNT(*) AS total,
        COALESCE(SUM(is_jank), 0) AS jank
      FROM per_frame
    )
    WHERE total > 0
  `,
  toMetrics: rows => {
    const total = Number(rows[0]?.[0] ?? 0);
    const jank = Number(rows[0]?.[1] ?? 0);
    return [
      {
        metricId: 'frames.total_count',
        value: total,
        unit: 'count',
        layer: 'L2',
        source: 'actual_frame_timeline_slice',
      },
      {
        metricId: 'frames.jank_count',
        value: jank,
        unit: 'count',
        layer: 'L2',
        source: 'actual_frame_timeline_slice',
      },
    ];
  },
};

/** L3 — top heaviest slices (deepest detail). */
const PROBE_TOP_SLICES: ProbeSpec = {
  id: 'top_slices_by_dur',
  layer: 'L3',
  sql: `
    SELECT slice.name AS name, slice.dur AS dur
    FROM slice
    ORDER BY slice.dur DESC
    LIMIT 5
  `,
  toMetrics: rows =>
    rows.map((row, i) => ({
      metricId: `slice.top_${i + 1}.dur_ns`,
      value: Number(row[1]),
      unit: 'ns',
      layer: 'L3' as TraceSummaryLayer,
      source: 'slice',
      evidence: {sql: 'slice ORDER BY dur DESC LIMIT 5', description: String(row[0])},
    })),
};

const DEFAULT_PROBES: ProbeSpec[] = [
  PROBE_TRACE_BOUNDS,
  PROBE_PROCESS_COUNT,
  PROBE_SLICE_COUNT,
  PROBE_FRAME_TIMELINE_JANK,
  PROBE_TOP_SLICES,
];

interface ProbeOutcome {
  probe: ProbeSpec;
  ok: boolean;
  metrics: TraceSummaryMetric[];
  errorMessage?: string;
}

async function runProbe(probe: ProbeSpec, query: QueryFn): Promise<ProbeOutcome> {
  try {
    const result = await query(probe.sql);
    if (result.error) {
      return {probe, ok: false, metrics: [], errorMessage: result.error};
    }
    if (!result.rows || result.rows.length === 0) {
      return {probe, ok: false, metrics: [], errorMessage: 'no rows'};
    }
    const metrics = probe.toMetrics(result.rows);
    return {probe, ok: true, metrics};
  } catch (err: any) {
    return {probe, ok: false, metrics: [], errorMessage: err?.message ?? String(err)};
  }
}

/**
 * Run the canonical probe catalog and assemble a TraceSummaryV2Contract.
 *
 * Probes that fail or return empty results are reflected in `probes[id]=false`
 * and produce a single metric with `unsupportedReason` rather than being
 * silently zero-filled, so AI consumers cannot quote fabricated values.
 */
export async function buildTraceSummaryV2(
  options: TraceSummaryV2Options,
): Promise<TraceSummaryV2Contract> {
  const probes: Record<string, boolean> = {};
  const metrics: TraceSummaryMetric[] = [];
  let traceRange = {startNs: 0, endNs: 0};

  for (const probeSpec of DEFAULT_PROBES) {
    const outcome = await runProbe(probeSpec, options.query);
    probes[probeSpec.id] = outcome.ok;

    if (outcome.ok) {
      metrics.push(...outcome.metrics);
      // Adopt the trace_bounds range when we have it so consumers can render
      // any later metric against the canonical window.
      if (probeSpec.id === 'trace_bounds' && outcome.metrics[0]?.range) {
        traceRange = outcome.metrics[0].range;
      }
    } else {
      // Surface a sentinel metric so the contract still records the gap.
      metrics.push({
        metricId: `${probeSpec.id}.unsupported`,
        value: 0,
        unit: 'count',
        layer: probeSpec.layer,
        source: probeSpec.id,
        unsupportedReason: outcome.errorMessage ?? 'probe failed',
      });
    }
  }

  const allFailed = Object.values(probes).every(v => !v);
  return {
    ...makeSparkProvenance({
      source: 'trace-summary-v2',
      ...(allFailed ? {unsupportedReason: 'all probes failed; trace_processor unavailable'} : {}),
    }),
    traceProcessorBuild: options.traceProcessorBuild,
    traceRange,
    probes,
    metrics,
    ...(options.baseline ? {baseline: options.baseline} : {}),
    coverage: [
      {sparkId: 2, planId: '02', status: 'implemented'},
      {sparkId: 22, planId: '02', status: 'implemented'},
      {
        sparkId: 102,
        planId: '02',
        status: 'implemented',
        note: 'trace_processor httpd remains the canonical engine driving these probes.',
      },
    ],
  };
}

/** For tests: surface the probe catalog so callers can assert on coverage. */
export function _getDefaultProbeIdsForTesting(): string[] {
  return DEFAULT_PROBES.map(p => p.id);
}

/** SECOND_NS export used for downstream layer math (Plan 25 baseline diff). */
export {SECOND_NS as TRACE_SECOND_NS};

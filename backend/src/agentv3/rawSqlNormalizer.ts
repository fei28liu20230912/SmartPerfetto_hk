// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

export interface RawSqlNormalizationResult {
  sql: string;
  rewrites: string[];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const THREAD_SLICE_FROM = /\bFROM\s+thread_slice(?:\s+(?:AS\s+)?(?!WHERE\b|JOIN\b|LEFT\b|RIGHT\b|INNER\b|OUTER\b|CROSS\b|GROUP\b|ORDER\b|LIMIT\b|ON\b|USING\b)([A-Za-z_]\w*))?/i;
const SLICE_FROM_WITH_ALIAS = /\bFROM\s+slice\s+(?:AS\s+)?([A-Za-z_]\w*)\b/i;

function findThreadSliceAlias(sql: string): string | undefined {
  return THREAD_SLICE_FROM.exec(sql)?.[1];
}

function hasSqlAlias(sql: string, alias: string): boolean {
  return new RegExp(`\\b(?:FROM|JOIN)\\s+(?:"[^"]+"|[A-Za-z_]\\w*)(?:\\s+(?:AS\\s+)?)${escapeRegExp(alias)}\\b`, 'i')
    .test(sql);
}

function columnRef(base: string | undefined, column: string): string {
  return base ? `${base}.${column}` : column;
}

function replaceDanglingAliasColumn(
  sql: string,
  alias: string,
  column: string,
  replacement: string,
): { sql: string; count: number } {
  let count = 0;
  const pattern = new RegExp(`\\b${escapeRegExp(alias)}\\.${escapeRegExp(column)}\\b`, 'gi');
  const nextSql = sql.replace(pattern, () => {
    count += 1;
    return replacement;
  });
  return { sql: nextSql, count };
}

function normalizeReversedLiteralBetween(sql: string): { sql: string; count: number } {
  let count = 0;
  const normalized = sql.replace(/\bBETWEEN\s+(\d{6,})\s+AND\s+(\d{6,})\b/gi, (match, start: string, end: string) => {
    try {
      const startNs = BigInt(start);
      const endNs = BigInt(end);
      if (startNs <= endNs) return match;
      count += 1;
      return `BETWEEN ${end} AND ${start}`;
    } catch {
      return match;
    }
  });
  return { sql: normalized, count };
}

function normalizeGluedBooleanKeywordColumns(sql: string): { sql: string; count: number } {
  const knownColumns = [
    'arg_set_id',
    'blocked_function',
    'cpu',
    'dur',
    'end_ts',
    'frame_id',
    'id',
    'jank_type',
    'name',
    'pid',
    'process_name',
    'start_ts',
    'state',
    'thread_name',
    'tid',
    'track_id',
    'ts',
    'upid',
    'utid',
    'value',
  ].join('|');
  let count = 0;
  const normalized = sql.replace(
    new RegExp(`\\b(AND|OR)(${knownColumns})\\b(?=\\s*(?:=|!=|<>|<=|>=|<|>|IN\\b|LIKE\\b|GLOB\\b|BETWEEN\\b|IS\\b))`, 'gi'),
    (_match, op: string, column: string) => {
      count += 1;
      return `${op} ${column}`;
    },
  );
  return { sql: normalized, count };
}

function normalizeBareSliceColumnsAfterJoins(sql: string): { sql: string; rewrites: string[] } {
  const fromMatch = SLICE_FROM_WITH_ALIAS.exec(sql);
  if (!fromMatch) return { sql, rewrites: [] };
  if (!/\bJOIN\s+(?:thread|process|thread_track)\b/i.test(sql)) return { sql, rewrites: [] };

  const alias = fromMatch[1];
  const rewrites: string[] = [];
  let normalized = sql;
  let changedName = 0;
  normalized = normalized.replace(/\bSELECT\s+name\b/i, () => {
    changedName += 1;
    return `SELECT ${alias}.name AS slice_name`;
  });
  if (changedName > 0) {
    rewrites.push(`qualified bare slice name as ${alias}.name after joins with other name columns`);
  }

  let changedDur = 0;
  normalized = normalized.replace(/(?<!\.)\bdur\s*\/\s*1e6\b/gi, () => {
    changedDur += 1;
    return `${alias}.dur/1e6`;
  });
  normalized = normalized.replace(/\bORDER\s+BY\s+dur\b/gi, () => {
    changedDur += 1;
    return `ORDER BY ${alias}.dur`;
  });
  if (changedDur > 0) {
    rewrites.push(`qualified bare slice dur as ${alias}.dur after slice joins`);
  }

  return { sql: normalized, rewrites };
}

function normalizeThreadTrackProcessJoin(sql: string): { sql: string; rewrites: string[] } {
  const threadTrackMatch = /\bJOIN\s+thread_track\s+(?:AS\s+)?([A-Za-z_]\w*)\s+ON\s+([A-Za-z_]\w*)\.track_id\s*=\s*\1\.id\b/i.exec(sql);
  if (!threadTrackMatch) return { sql, rewrites: [] };

  const threadTrackAlias = threadTrackMatch[1];
  const processJoinPattern = new RegExp(
    `\\bJOIN\\s+process\\s+(?:AS\\s+)?([A-Za-z_]\\w*)\\s+ON\\s+${escapeRegExp(threadTrackAlias)}\\.upid\\s*=\\s*\\1\\.upid\\b`,
    'i',
  );
  const processJoinMatch = processJoinPattern.exec(sql);
  if (!processJoinMatch) return { sql, rewrites: [] };

  const processAlias = processJoinMatch[1];
  const threadAlias = hasSqlAlias(sql, 'th') ? 'thread_ref' : 'th';
  const rewrites: string[] = [];
  let normalized = sql.replace(
    processJoinPattern,
    `JOIN thread ${threadAlias} ON ${threadTrackAlias}.utid = ${threadAlias}.utid\nJOIN process ${processAlias} ON ${threadAlias}.upid = ${processAlias}.upid`,
  );

  const threadNamePattern = new RegExp(
    `\\b${escapeRegExp(threadTrackAlias)}\\.name\\s+AS\\s+thread_name\\b`,
    'gi',
  );
  normalized = normalized.replace(threadNamePattern, `${threadAlias}.name AS thread_name`);
  rewrites.push(
    `joined thread between thread_track ${threadTrackAlias} and process ${processAlias}; thread_track exposes utid but not upid`,
  );

  return { sql: normalized, rewrites };
}

function extractRequestedFrameIds(sql: string): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  const frameIdPattern = /\b(?:SELECT|UNION(?:\s+ALL)?\s+SELECT)\s+'([^']+)'\s+(?:AS\s+frame_id\b)?/gi;
  let match: RegExpExecArray | null;
  while ((match = frameIdPattern.exec(sql)) !== null) {
    const id = match[1]?.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function quoteSqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function extractFrameIdPredicates(sql: string): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  const add = (value: string | undefined) => {
    const id = value?.trim().replace(/^['"]|['"]$/g, '');
    if (!id || seen.has(id)) return;
    seen.add(id);
    ids.push(id);
  };

  const equalityPattern = /\bframe_id\s*=\s*(['"]?)([A-Za-z0-9_.:-]+)\1/gi;
  let match: RegExpExecArray | null;
  while ((match = equalityPattern.exec(sql)) !== null) {
    add(match[2]);
  }

  const inPattern = /\bframe_id\s+IN\s*\(([^)]*)\)/gi;
  while ((match = inPattern.exec(sql)) !== null) {
    for (const raw of match[1].split(',')) {
      add(raw);
    }
  }

  return ids;
}

function normalizeUnsupportedIntrinsicBatchFrameRootCauseLookup(sql: string): { sql: string; rewrites: string[] } {
  if (!/\bFROM\s+__intrinsic_batch_frame_root_cause\b/i.test(sql)) return { sql, rewrites: [] };

  const frameIds = extractFrameIdPredicates(sql);
  const requestedFrames = frameIds.length > 0
    ? frameIds
      .map((frameId, index) => `${index === 0 ? 'SELECT' : 'UNION ALL SELECT'} ${quoteSqlString(frameId)} AS frame_id`)
      .join('\n  ')
    : 'SELECT frame_id FROM frame_lookup WHERE COALESCE(jank_type, \'None\') != \'None\' LIMIT 50';

  return {
    sql: `WITH frame_lookup AS (
  SELECT
    CAST(COALESCE(a.display_frame_token, a.surface_frame_token, a.id) AS TEXT) AS frame_id,
    a.ts AS start_ts,
    a.dur AS dur,
    a.jank_type AS jank_type
  FROM actual_frame_timeline_slice a
),
requested_frames AS (
  ${requestedFrames}
)
SELECT
  r.frame_id,
  CASE WHEN f.start_ts IS NULL THEN NULL ELSE printf('%d', f.start_ts) END AS start_ts,
  CASE WHEN f.start_ts IS NULL THEN NULL ELSE printf('%d', f.start_ts + f.dur) END AS end_ts,
  ROUND(f.dur / 1e6, 2) AS dur_ms,
  f.jank_type AS jank_type,
  CASE
    WHEN f.jank_type IN ('Self Jank', 'App Deadline Missed') THEN 'APP'
    WHEN f.jank_type GLOB '*SurfaceFlinger*' THEN 'SF'
    WHEN f.jank_type = 'Buffer Stuffing' THEN 'BUFFER_STUFFING'
    WHEN f.jank_type = 'None' OR f.jank_type IS NULL THEN 'HIDDEN'
    ELSE 'UNKNOWN'
  END AS jank_responsibility,
  CAST(NULL AS TEXT) AS reason_code,
  CAST(NULL AS TEXT) AS top_slice_name,
  CAST(NULL AS REAL) AS top_slice_ms,
  CAST(NULL AS REAL) AS main_q4b_pct,
  'batch_frame_root_cause is a skill artifact; use fetch_artifact for derived reason_code/top_slice/quadrant fields' AS source_note
FROM requested_frames r
LEFT JOIN frame_lookup f USING(frame_id)
ORDER BY f.dur DESC`,
    rewrites: [
      'replaced unsupported __intrinsic_batch_frame_root_cause lookup with a safe FrameTimeline lookup; batch_frame_root_cause is a skill artifact and derived fields require fetch_artifact',
    ],
  };
}

function normalizeUnsupportedActualFrameTimelineFrequencyLookup(sql: string): { sql: string; rewrites: string[] } {
  if (!/\bactual_frame_timeline_slice\b/i.test(sql)) return { sql, rewrites: [] };
  if (!/\bbig_avg_freq_mhz\b/i.test(sql) && !/\bdevice_peak_freq_mhz\b/i.test(sql)) return { sql, rewrites: [] };
  if (!/\bFROM\s*\(\s*SELECT\s+'[^']+'\s+AS\s+frame_id\b/i.test(sql)) return { sql, rewrites: [] };

  const frameIds = extractRequestedFrameIds(sql);
  if (frameIds.length === 0) return { sql, rewrites: [] };

  const requestedFrames = frameIds
    .map((frameId, index) => `${index === 0 ? 'SELECT' : 'UNION ALL SELECT'} ${quoteSqlString(frameId)} AS frame_id`)
    .join('\n  ');

  return {
    sql: `WITH requested_frames AS (
  ${requestedFrames}
)
SELECT
  r.frame_id,
  ROUND(a.dur / 1e6, 2) AS dur_ms,
  CAST(NULL AS REAL) AS big_avg_freq_mhz,
  CAST(NULL AS REAL) AS device_peak_freq_mhz,
  CAST(NULL AS REAL) AS freq_ratio,
  CAST(NULL AS TEXT) AS cpu_freq_clusters_json
FROM requested_frames r
LEFT JOIN actual_frame_timeline_slice a
  ON CAST(a.id AS TEXT) = r.frame_id
  OR CAST(a.display_frame_token AS TEXT) = r.frame_id
  OR a.name = r.frame_id
ORDER BY a.dur DESC`,
    rewrites: [
      'replaced unsupported actual_frame_timeline_slice frequency lookup with a safe frame duration lookup; frequency columns are skill-derived, not FrameTimeline table columns',
    ],
  };
}

/**
 * Normalize high-confidence Perfetto SQL footguns before trace_processor sees
 * them. This is intentionally conservative: rewrite only when the dropped
 * table alias is not referenced by the rest of the query.
 */
export function normalizeRawSql(sql: string): RawSqlNormalizationResult {
  if (!sql || typeof sql !== 'string') return { sql, rewrites: [] };

  let normalized = sql;
  const rewrites: string[] = [];
  const threadSliceAlias = findThreadSliceAlias(normalized);

  const reversedBetween = normalizeReversedLiteralBetween(normalized);
  if (reversedBetween.count > 0) {
    normalized = reversedBetween.sql;
    rewrites.push('swapped reversed numeric BETWEEN bounds so the time range is start <= end');
  }

  const gluedBooleanColumns = normalizeGluedBooleanKeywordColumns(normalized);
  if (gluedBooleanColumns.count > 0) {
    normalized = gluedBooleanColumns.sql;
    rewrites.push('inserted missing whitespace between boolean operators and known Perfetto columns');
  }

  const sliceColumns = normalizeBareSliceColumnsAfterJoins(normalized);
  if (sliceColumns.rewrites.length > 0) {
    normalized = sliceColumns.sql;
    rewrites.push(...sliceColumns.rewrites);
  }

  const threadTrackProcessJoin = normalizeThreadTrackProcessJoin(normalized);
  if (threadTrackProcessJoin.rewrites.length > 0) {
    normalized = threadTrackProcessJoin.sql;
    rewrites.push(...threadTrackProcessJoin.rewrites);
  }

  const intrinsicBatchFrameRootCauseLookup = normalizeUnsupportedIntrinsicBatchFrameRootCauseLookup(normalized);
  if (intrinsicBatchFrameRootCauseLookup.rewrites.length > 0) {
    normalized = intrinsicBatchFrameRootCauseLookup.sql;
    rewrites.push(...intrinsicBatchFrameRootCauseLookup.rewrites);
  }

  const actualFrameFrequencyLookup = normalizeUnsupportedActualFrameTimelineFrequencyLookup(normalized);
  if (actualFrameFrequencyLookup.rewrites.length > 0) {
    normalized = actualFrameFrequencyLookup.sql;
    rewrites.push(...actualFrameFrequencyLookup.rewrites);
  }

  if (/\bFROM\s+thread_slice\b/i.test(normalized)) {
    const threadSliceBase = threadSliceAlias;
    if (threadSliceAlias !== 't' && !hasSqlAlias(normalized, 't')) {
      for (const [sourceColumn, targetColumn] of [
        ['name', 'thread_name'],
        ['is_main_thread', 'is_main_thread'],
        ['tid', 'tid'],
        ['utid', 'utid'],
      ]) {
        const result = replaceDanglingAliasColumn(
          normalized,
          't',
          sourceColumn,
          columnRef(threadSliceBase, targetColumn),
        );
        if (result.count > 0) {
          normalized = result.sql;
          rewrites.push(
            `rewrote dangling t.${sourceColumn} reference to thread_slice ${targetColumn}; thread_slice already exposes thread columns`,
          );
        }
      }
    }
    if (threadSliceAlias !== 'p' && !hasSqlAlias(normalized, 'p')) {
      const result = replaceDanglingAliasColumn(
        normalized,
        'p',
        'name',
        columnRef(threadSliceBase, 'process_name'),
      );
      if (result.count > 0) {
        normalized = result.sql;
        rewrites.push(
          'rewrote dangling p.name reference to thread_slice process_name; thread_slice already exposes process columns',
        );
      }
    }
  }

  if (/\bactual_frame_timeline_slice\b/i.test(normalized)) {
    const threadUsingUtidJoin = /\b(?:INNER\s+|LEFT(?:\s+OUTER)?\s+|CROSS\s+)?JOIN\s+thread(?:\s+(?:AS\s+)?([A-Za-z_]\w*))?\s+USING\s*\(\s*utid\s*\)/gi;
    normalized = normalized.replace(threadUsingUtidJoin, (match: string, alias: string | undefined, offset: number, full: string) => {
      const withoutJoin = full.slice(0, offset) + full.slice(offset + match.length);
      const referencePattern = alias
        ? new RegExp(`\\b${escapeRegExp(alias)}\\.`, 'i')
        : /\bthread\./i;
      if (referencePattern.test(withoutJoin)) return match;

      rewrites.push(
        'removed JOIN thread USING(utid) from actual_frame_timeline_slice query; FrameTimeline rows expose upid but not utid',
      );
      return '';
    });
  }

  if (
    /\bFROM\s+thread_slice\b/i.test(normalized) &&
    /\bself_dur\b/i.test(normalized) &&
    !/\b(?:FROM|JOIN)\s+slice_self_dur\b/i.test(normalized)
  ) {
    normalized = normalized.replace(THREAD_SLICE_FROM, match => {
      rewrites.push(
        'joined slice_self_dur for thread_slice self_dur lookup; thread_slice does not expose self_dur directly',
      );
      return `${match}\nLEFT JOIN slice_self_dur USING(id)`;
    });
  }

  return { sql: normalized, rewrites };
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import crypto from 'crypto';
import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  getTraceProcessorPath,
  type QueryResult,
  WorkingTraceProcessor,
  type TraceProcessorRuntimeStats,
} from '../services/workingTraceProcessor';
import {
  REQUIRED_RSS_BENCHMARK_SCENES,
  REQUIRED_RSS_BENCHMARK_SIZE_BUCKETS,
  type RequiredScene,
  type RequiredSizeBucket,
  type SizeBucket,
} from './enterpriseRssBenchmarkMatrix';

export {
  REQUIRED_RSS_BENCHMARK_SCENES,
  REQUIRED_RSS_BENCHMARK_SIZE_BUCKETS,
} from './enterpriseRssBenchmarkMatrix';
export type {
  RequiredScene,
  RequiredSizeBucket,
  SizeBucket,
} from './enterpriseRssBenchmarkMatrix';

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const DEFAULT_SAMPLE_INTERVAL_MS = 250;

type BenchmarkPhase = 'startup_load' | 'post_load' | 'query';

export interface QuerySpec {
  name: string;
  sql: string;
}

export interface TraceBenchmarkSpec {
  scene: string;
  path: string;
  label: string;
  sizeBucket?: SizeBucket;
}

export interface BenchmarkOptions {
  traces: TraceBenchmarkSpec[];
  outputPath?: string;
  markdownPath?: string;
  sampleIntervalMs: number;
  queries: QuerySpec[];
  requireCompleteMatrix: boolean;
}

interface TimelineSample {
  elapsedMs: number;
  phase: BenchmarkPhase;
  pid?: number;
  rssBytes: number | null;
  source: TraceProcessorRuntimeStats['rssSampleSource'];
  error?: string;
}

interface QueryBenchmarkResult {
  name: string;
  sql: string;
  durationMs: number;
  wallMs: number;
  rowCount: number;
  columns: string[];
  error?: string;
}

export interface RssSummary {
  startupRssBytes: number | null;
  loadPeakRssBytes: number | null;
  postLoadRssBytes: number | null;
  queryPeakRssBytes: number | null;
  queryIncrementalRssBytes: number | null;
  queryHeadroomBytes: number | null;
  maxRssBytes: number | null;
  traceSizeToLoadPeakRatio: number | null;
}

export interface TraceBenchmarkResult {
  traceId: string;
  scene: string;
  label: string;
  path: string;
  sizeBytes: number;
  sizeBucket: SizeBucket;
  status: 'passed' | 'failed';
  initializeMs: number;
  rssSummary: RssSummary;
  queries: QueryBenchmarkResult[];
  samples: TimelineSample[];
  error?: string;
}

export interface BenchmarkCoverage {
  complete: boolean;
  missingCells: string[];
  observedCells: string[];
}

export interface BenchmarkReport {
  generatedAt: string;
  traceProcessorPath: string;
  host: {
    platform: string;
    arch: string;
    node: string;
    totalMemoryBytes: number;
    freeMemoryBytesAtStart: number;
    cpuCount: number;
  };
  sampleIntervalMs: number;
  requiredMatrix: {
    scenes: readonly RequiredScene[];
    sizeBuckets: readonly RequiredSizeBucket[];
  };
  coverage: BenchmarkCoverage;
  traces: TraceBenchmarkResult[];
}

const DEFAULT_QUERIES: QuerySpec[] = [
  {
    name: 'metadata_count',
    sql: 'SELECT COUNT(*) AS value FROM metadata;',
  },
  {
    name: 'slice_count',
    sql: 'SELECT COUNT(*) AS value FROM slice;',
  },
  {
    name: 'thread_state_count',
    sql: 'SELECT COUNT(*) AS value FROM thread_state;',
  },
  {
    name: 'top_slice_durations',
    sql: `
      SELECT slice.name AS name, COUNT(*) AS count, SUM(slice.dur) AS total_dur
      FROM slice
      WHERE slice.dur > 0
      GROUP BY slice.name
      ORDER BY total_dur DESC
      LIMIT 20;
    `,
  },
];

const DEFAULT_TRACE_CANDIDATES: TraceBenchmarkSpec[] = [
  {
    scene: 'startup',
    label: 'launch-heavy-local',
    path: '../test-traces/lacunh_heavy.pftrace',
  },
  {
    scene: 'startup',
    label: 'launch-light-local',
    path: '../test-traces/launch_light.pftrace',
  },
  {
    scene: 'scroll',
    label: 'scroll-standard-local',
    path: '../test-traces/scroll_Standard-AOSP-App-Without-PreAnimation.pftrace',
  },
  {
    scene: 'scroll',
    label: 'scroll-customer-local',
    path: '../test-traces/scroll-demo-customer-scroll.pftrace',
  },
  {
    scene: 'scroll',
    label: 'flutter-textureview-local',
    path: '../test-traces/Scroll-Flutter-327-TextureView.pftrace',
  },
  {
    scene: 'scroll',
    label: 'flutter-surfaceview-local',
    path: '../test-traces/Scroll-Flutter-SurfaceView-Wechat-Wenyiwen.pftrace',
  },
];

function printUsage(): void {
  console.log('Usage: npx tsx src/scripts/benchmarkTraceProcessorRss.ts [options]');
  console.log('');
  console.log('Options:');
  console.log('  --manifest <path>             JSON manifest with a traces array.');
  console.log('  --trace <scene=path>          Trace to benchmark. Repeatable.');
  console.log('  --trace <path>                Trace to benchmark; scene inferred from filename.');
  console.log('  --output <path>               JSON report path. Defaults to backend/test-output.');
  console.log('  --markdown <path>             Optional Markdown report path.');
  console.log('  --sample-interval-ms <ms>     RSS sample interval. Default: 250.');
  console.log('  --query <name=sql>            Extra query to run. Repeatable.');
  console.log('  --require-complete-matrix     Exit non-zero if any §0.4.3 scene/size cell is missing.');
  console.log('  --help                        Show this help.');
}

export function classifyRequiredSizeBucket(sizeBytes: number): SizeBucket {
  if (sizeBytes >= GIB) return '1GB';
  if (sizeBytes >= 500 * MIB) return '500MB';
  if (sizeBytes >= 100 * MIB) return '100MB';
  return 'under-100MB';
}

export function inferBenchmarkSceneFromPath(filePath: string): string {
  const lower = path.basename(filePath).toLowerCase();
  if (lower.includes('scroll') || lower.includes('flutter')) return 'scroll';
  if (lower.includes('launch') || lower.includes('startup') || lower.includes('lacunh')) return 'startup';
  if (lower.includes('anr')) return 'anr';
  if (lower.includes('heapprofd')) return 'heapprofd';
  if (lower.includes('heap') || lower.includes('memory') || lower.includes('oom')) return 'memory';
  if (lower.includes('vendor') || lower.includes('oem')) return 'vendor';
  return 'unknown';
}

function parseTraceArg(value: string, cwd: string): TraceBenchmarkSpec {
  const separator = value.indexOf('=');
  if (separator > 0) {
    const scene = value.slice(0, separator).trim();
    const tracePath = path.resolve(cwd, value.slice(separator + 1));
    return {
      scene,
      path: tracePath,
      label: `${scene}-${path.basename(tracePath)}`,
    };
  }

  const tracePath = path.resolve(cwd, value);
  const scene = inferBenchmarkSceneFromPath(tracePath);
  return {
    scene,
    path: tracePath,
    label: `${scene}-${path.basename(tracePath)}`,
  };
}

function parseQueryArg(value: string): QuerySpec {
  const separator = value.indexOf('=');
  if (separator <= 0) {
    throw new Error('--query requires name=sql');
  }
  return {
    name: value.slice(0, separator).trim(),
    sql: value.slice(separator + 1),
  };
}

function normalizeManifestTrace(input: any, manifestDir: string): TraceBenchmarkSpec {
  if (!input || typeof input !== 'object') {
    throw new Error('Manifest trace entries must be objects');
  }
  if (typeof input.path !== 'string' || input.path.trim().length === 0) {
    throw new Error('Manifest trace entry requires path');
  }
  const tracePath = path.resolve(manifestDir, input.path);
  const scene = typeof input.scene === 'string' && input.scene.trim()
    ? input.scene.trim()
    : inferBenchmarkSceneFromPath(tracePath);
  return {
    scene,
    path: tracePath,
    label: typeof input.label === 'string' && input.label.trim()
      ? input.label.trim()
      : `${scene}-${path.basename(tracePath)}`,
    ...(typeof input.sizeBucket === 'string' ? { sizeBucket: input.sizeBucket as SizeBucket } : {}),
  };
}

function loadManifest(manifestPath: string): TraceBenchmarkSpec[] {
  const resolved = path.resolve(process.cwd(), manifestPath);
  const parsed = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  if (!Array.isArray(parsed.traces)) {
    throw new Error('Manifest must contain a traces array');
  }
  return parsed.traces.map((entry: any) => normalizeManifestTrace(entry, path.dirname(resolved)));
}

function resolveDefaultTraceSpecs(cwd: string): TraceBenchmarkSpec[] {
  return DEFAULT_TRACE_CANDIDATES
    .map(spec => ({
      ...spec,
      path: path.resolve(cwd, spec.path),
    }))
    .filter(spec => fs.existsSync(spec.path));
}

export function parseBenchmarkArgs(argv: string[], cwd = process.cwd()): BenchmarkOptions {
  const traces: TraceBenchmarkSpec[] = [];
  const queries: QuerySpec[] = [...DEFAULT_QUERIES];
  let outputPath: string | undefined;
  let markdownPath: string | undefined;
  let sampleIntervalMs = DEFAULT_SAMPLE_INTERVAL_MS;
  let requireCompleteMatrix = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === '--help') {
      printUsage();
      process.exit(0);
    }
    if (arg === '--manifest') {
      if (!next) throw new Error('--manifest requires a value');
      traces.push(...loadManifest(path.resolve(cwd, next)));
      i += 1;
      continue;
    }
    if (arg === '--trace') {
      if (!next) throw new Error('--trace requires a value');
      traces.push(parseTraceArg(next, cwd));
      i += 1;
      continue;
    }
    if (arg === '--output') {
      if (!next) throw new Error('--output requires a value');
      outputPath = path.resolve(cwd, next);
      i += 1;
      continue;
    }
    if (arg === '--markdown') {
      if (!next) throw new Error('--markdown requires a value');
      markdownPath = path.resolve(cwd, next);
      i += 1;
      continue;
    }
    if (arg === '--sample-interval-ms') {
      if (!next) throw new Error('--sample-interval-ms requires a value');
      sampleIntervalMs = Number.parseInt(next, 10);
      if (!Number.isInteger(sampleIntervalMs) || sampleIntervalMs < 50) {
        throw new Error('--sample-interval-ms must be an integer >= 50');
      }
      i += 1;
      continue;
    }
    if (arg === '--query') {
      if (!next) throw new Error('--query requires a value');
      queries.push(parseQueryArg(next));
      i += 1;
      continue;
    }
    if (arg === '--require-complete-matrix') {
      requireCompleteMatrix = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return {
    traces: traces.length > 0 ? traces : resolveDefaultTraceSpecs(cwd),
    outputPath,
    markdownPath,
    sampleIntervalMs,
    queries,
    requireCompleteMatrix,
  };
}

function maxNullable(values: Array<number | null>): number | null {
  const finiteValues = values.filter((value): value is number => typeof value === 'number');
  if (finiteValues.length === 0) return null;
  return Math.max(...finiteValues);
}

function summarizeRss(samples: TimelineSample[], traceSizeBytes: number): RssSummary {
  const startupRssBytes = samples.find(sample => sample.phase === 'startup_load' && sample.rssBytes !== null)?.rssBytes ?? null;
  const loadPeakRssBytes = maxNullable(samples
    .filter(sample => sample.phase === 'startup_load')
    .map(sample => sample.rssBytes));
  const postLoadRssBytes = [...samples]
    .reverse()
    .find(sample => sample.phase === 'post_load' && sample.rssBytes !== null)?.rssBytes ?? null;
  const queryPeakRssBytes = maxNullable(samples
    .filter(sample => sample.phase === 'query')
    .map(sample => sample.rssBytes));
  const maxRssBytes = maxNullable(samples.map(sample => sample.rssBytes));
  const queryIncrementalRssBytes = postLoadRssBytes !== null && queryPeakRssBytes !== null
    ? Math.max(0, queryPeakRssBytes - postLoadRssBytes)
    : null;

  return {
    startupRssBytes,
    loadPeakRssBytes,
    postLoadRssBytes,
    queryPeakRssBytes,
    queryIncrementalRssBytes,
    queryHeadroomBytes: queryPeakRssBytes !== null ? Math.max(0, os.totalmem() - queryPeakRssBytes) : null,
    maxRssBytes,
    traceSizeToLoadPeakRatio: loadPeakRssBytes !== null && traceSizeBytes > 0
      ? loadPeakRssBytes / traceSizeBytes
      : null,
  };
}

class ProcessorRssSampler {
  private samples: TimelineSample[] = [];
  private timer: NodeJS.Timeout | undefined;
  private readonly startedAt = Date.now();
  private phase: BenchmarkPhase = 'startup_load';

  constructor(
    private readonly getStats: () => TraceProcessorRuntimeStats,
    private readonly sampleIntervalMs: number,
  ) {}

  start(): void {
    this.sample();
    this.timer = setInterval(() => this.sample(), this.sampleIntervalMs);
  }

  setPhase(phase: BenchmarkPhase): void {
    this.phase = phase;
  }

  sample(): void {
    const stats = this.getStats();
    this.samples.push({
      elapsedMs: Date.now() - this.startedAt,
      phase: this.phase,
      ...(stats.pid ? { pid: stats.pid } : {}),
      rssBytes: stats.rssBytes,
      source: stats.rssSampleSource,
      ...(stats.rssSampleError ? { error: stats.rssSampleError } : {}),
    });
  }

  stop(): TimelineSample[] {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.sample();
    return this.samples;
  }
}

function normalizeQueryResult(
  spec: QuerySpec,
  wallMs: number,
  result: QueryResult,
): QueryBenchmarkResult {
  return {
    name: spec.name,
    sql: spec.sql,
    durationMs: result.durationMs,
    wallMs,
    rowCount: result.rows.length,
    columns: result.columns,
    ...(result.error ? { error: result.error } : {}),
  };
}

async function runTraceBenchmark(
  spec: TraceBenchmarkSpec,
  options: Pick<BenchmarkOptions, 'sampleIntervalMs' | 'queries'>,
): Promise<TraceBenchmarkResult> {
  const stat = await fsp.stat(spec.path);
  const traceId = `rss-${crypto.randomUUID()}`;
  const processor = new WorkingTraceProcessor(traceId, spec.path);
  const sampler = new ProcessorRssSampler(() => processor.getRuntimeStats(), options.sampleIntervalMs);
  const startedAt = Date.now();
  const queries: QueryBenchmarkResult[] = [];

  sampler.start();
  try {
    await processor.initialize();
    const initializeMs = Date.now() - startedAt;
    sampler.setPhase('post_load');
    sampler.sample();
    sampler.setPhase('query');

    for (const query of options.queries) {
      const queryStartedAt = Date.now();
      try {
        const result = await processor.query(query.sql);
        queries.push(normalizeQueryResult(query, Date.now() - queryStartedAt, result));
      } catch (error: any) {
        queries.push({
          name: query.name,
          sql: query.sql,
          durationMs: Date.now() - queryStartedAt,
          wallMs: Date.now() - queryStartedAt,
          rowCount: 0,
          columns: [],
          error: error.message,
        });
      } finally {
        sampler.sample();
      }
    }

    const samples = sampler.stop();
    return {
      traceId,
      scene: spec.scene,
      label: spec.label,
      path: spec.path,
      sizeBytes: stat.size,
      sizeBucket: spec.sizeBucket ?? classifyRequiredSizeBucket(stat.size),
      status: queries.some(query => query.error) ? 'failed' : 'passed',
      initializeMs,
      rssSummary: summarizeRss(samples, stat.size),
      queries,
      samples,
    };
  } catch (error: any) {
    const samples = sampler.stop();
    return {
      traceId,
      scene: spec.scene,
      label: spec.label,
      path: spec.path,
      sizeBytes: stat.size,
      sizeBucket: spec.sizeBucket ?? classifyRequiredSizeBucket(stat.size),
      status: 'failed',
      initializeMs: Date.now() - startedAt,
      rssSummary: summarizeRss(samples, stat.size),
      queries,
      samples,
      error: error.message,
    };
  } finally {
    processor.destroy();
  }
}

export function computeBenchmarkCoverage(results: TraceBenchmarkResult[]): BenchmarkCoverage {
  const observed = new Set<string>();
  for (const result of results) {
    if (result.status !== 'passed') continue;
    if (!(REQUIRED_RSS_BENCHMARK_SCENES as readonly string[]).includes(result.scene)) continue;
    if (!(REQUIRED_RSS_BENCHMARK_SIZE_BUCKETS as readonly string[]).includes(result.sizeBucket)) continue;
    observed.add(`${result.scene}:${result.sizeBucket}`);
  }

  const missingCells: string[] = [];
  for (const scene of REQUIRED_RSS_BENCHMARK_SCENES) {
    for (const sizeBucket of REQUIRED_RSS_BENCHMARK_SIZE_BUCKETS) {
      const cell = `${scene}:${sizeBucket}`;
      if (!observed.has(cell)) missingCells.push(cell);
    }
  }

  return {
    complete: missingCells.length === 0,
    missingCells,
    observedCells: Array.from(observed).sort(),
  };
}

export async function runBenchmarkReport(options: BenchmarkOptions): Promise<BenchmarkReport> {
  if (options.traces.length === 0) {
    throw new Error('No trace files found. Pass --trace or --manifest.');
  }

  const traces: TraceBenchmarkResult[] = [];
  for (const trace of options.traces) {
    if (!fs.existsSync(trace.path)) {
      traces.push({
        traceId: `missing-${crypto.randomUUID()}`,
        scene: trace.scene,
        label: trace.label,
        path: trace.path,
        sizeBytes: 0,
        sizeBucket: 'under-100MB',
        status: 'failed',
        initializeMs: 0,
        rssSummary: summarizeRss([], 0),
        queries: [],
        samples: [],
        error: 'Trace file not found',
      });
      continue;
    }
    console.log(`[RSS Benchmark] ${trace.scene} ${trace.label}: ${trace.path}`);
    traces.push(await runTraceBenchmark(trace, options));
  }

  return {
    generatedAt: new Date().toISOString(),
    traceProcessorPath: getTraceProcessorPath(),
    host: {
      platform: os.platform(),
      arch: os.arch(),
      node: process.version,
      totalMemoryBytes: os.totalmem(),
      freeMemoryBytesAtStart: os.freemem(),
      cpuCount: os.cpus().length,
    },
    sampleIntervalMs: options.sampleIntervalMs,
    requiredMatrix: {
      scenes: REQUIRED_RSS_BENCHMARK_SCENES,
      sizeBuckets: REQUIRED_RSS_BENCHMARK_SIZE_BUCKETS,
    },
    coverage: computeBenchmarkCoverage(traces),
    traces,
  };
}

export function determineBenchmarkExitCode(report: BenchmarkReport, options: Pick<BenchmarkOptions, 'requireCompleteMatrix'>): number {
  if (report.traces.some(trace => trace.status === 'failed')) return 1;
  if (options.requireCompleteMatrix && !report.coverage.complete) return 2;
  return 0;
}

function formatBytes(value: number | null): string {
  if (value === null) return 'n/a';
  if (value >= GIB) return `${(value / GIB).toFixed(2)} GiB`;
  return `${(value / MIB).toFixed(1)} MiB`;
}

export function buildMarkdownReport(report: BenchmarkReport): string {
  const lines: string[] = [];
  lines.push('# Trace Processor RSS Benchmark');
  lines.push('');
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push('');
  lines.push(`Coverage status: ${report.coverage.complete ? 'complete' : 'blocked_missing_required_traces'}`);
  lines.push('');
  lines.push('| Trace | Scene | Size bucket | File size | Init | Startup RSS | Load peak | Post-load RSS | Query peak | Query delta | Query headroom | Status |');
  lines.push('| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |');
  for (const trace of report.traces) {
    lines.push([
      `| ${trace.label}`,
      trace.scene,
      trace.sizeBucket,
      formatBytes(trace.sizeBytes),
      `${trace.initializeMs}ms`,
      formatBytes(trace.rssSummary.startupRssBytes),
      formatBytes(trace.rssSummary.loadPeakRssBytes),
      formatBytes(trace.rssSummary.postLoadRssBytes),
      formatBytes(trace.rssSummary.queryPeakRssBytes),
      formatBytes(trace.rssSummary.queryIncrementalRssBytes),
      formatBytes(trace.rssSummary.queryHeadroomBytes),
      `${trace.status}${trace.error ? ` (${trace.error})` : ''} |`,
    ].join(' | '));
  }
  lines.push('');
  lines.push('Missing required matrix cells:');
  if (report.coverage.missingCells.length === 0) {
    lines.push('');
    lines.push('- none');
  } else {
    lines.push('');
    for (const cell of report.coverage.missingCells) {
      lines.push(`- ${cell}`);
    }
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

async function writeReportFiles(report: BenchmarkReport, options: BenchmarkOptions): Promise<void> {
  const outputPath = options.outputPath
    ?? path.resolve(process.cwd(), 'test-output/trace-processor-rss-benchmark.json');
  await fsp.mkdir(path.dirname(outputPath), { recursive: true });
  await fsp.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`[RSS Benchmark] JSON report: ${outputPath}`);

  if (options.markdownPath) {
    await fsp.mkdir(path.dirname(options.markdownPath), { recursive: true });
    await fsp.writeFile(options.markdownPath, buildMarkdownReport(report), 'utf8');
    console.log(`[RSS Benchmark] Markdown report: ${options.markdownPath}`);
  }
}

async function main(): Promise<void> {
  const options = parseBenchmarkArgs(process.argv.slice(2));
  const report = await runBenchmarkReport(options);
  await writeReportFiles(report, options);

  if (!report.coverage.complete) {
    console.warn(`[RSS Benchmark] Required §0.4.3 matrix is incomplete: ${report.coverage.missingCells.join(', ')}`);
  }

  process.exitCode = determineBenchmarkExitCode(report, options) || undefined;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[RSS Benchmark] ${error.message}`);
    process.exit(1);
  });
}

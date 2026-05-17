// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';
import { uuidv4 } from '../utils/uuid';

const execAsync = promisify(exec);

interface TraceQueryResult {
  columns: string[];
  rows: any[][];
  error?: string;
}

interface TraceInfo {
  totalTimeNs: number;
  numCpus: number;
  numGpus: number;
  numProcessNames: number;
  numThreads: number;
}

class PerfettoService {
  private wasmPath: string;
  private traceProcessorShell: string;

  constructor() {
    // Path to the trace processor shell in the cloned perfetto repo
    this.wasmPath = path.join(__dirname, '../../perfetto/out/wasm/');
    this.traceProcessorShell = path.join(__dirname, '../../perfetto/out/linux/trace_processor_shell');
  }

  /**
   * Execute SQL query on a trace file using the actual Perfetto Trace Processor
   */
  async executeQuery(traceFilePath: string, sqlQuery: string): Promise<TraceQueryResult> {
    try {
      // Create a temporary file for the query
      const queryId = uuidv4();
      const queryFilePath = `/tmp/query_${queryId}.sql`;
      await fs.writeFile(queryFilePath, sqlQuery);

      // Execute the query using trace_processor_shell
      const command = `${this.traceProcessorShell} --query-file ${queryFilePath} ${traceFilePath}`;
      const { stdout, stderr } = await execAsync(command);

      // Clean up temporary query file
      await fs.unlink(queryFilePath);

      // Parse the output
      if (stderr && stderr.includes('Error')) {
        return {
          columns: [],
          rows: [],
          error: stderr
        };
      }

      // Parse TSV output
      const lines = stdout.trim().split('\n');
      if (lines.length === 0 || (lines.length === 1 && lines[0] === '')) {
        return { columns: [], rows: [] };
      }

      // First line contains column names
      const columns = lines[0].split('\t');

      // Remaining lines contain data
      const rows = lines.slice(1).map(line => line.split('\t'));

      return { columns, rows };
    } catch (error) {
      console.error('Error executing Perfetto query:', error);
      return {
        columns: [],
        rows: [],
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Get metadata about the trace
   */
  async getTraceInfo(traceFilePath: string): Promise<TraceInfo> {
    const sqlQuery = `
      SELECT
        MAX(slice.ts + slice.dur) AS totalTimeNs,
        COUNT(DISTINCT sched.cpu) AS numCpus,
        COUNT(DISTINCT CASE WHEN slice.name LIKE 'GPU%' THEN sched.cpu END) AS numGpus,
        COUNT(DISTINCT process.name) AS numProcessNames,
        COUNT(DISTINCT thread.tid) AS numThreads
      FROM slice
      JOIN thread_track ON slice.track_id = thread_track.id
      JOIN thread USING (utid)
      JOIN process USING (upid)
      LEFT JOIN sched USING (utid)
    `;

    const result = await this.executeQuery(traceFilePath, sqlQuery);

    if (result.error || result.rows.length === 0) {
      throw new Error(`Failed to get trace info: ${result.error}`);
    }

    const row = result.rows[0];
    return {
      totalTimeNs: parseInt(row[0]) || 0,
      numCpus: parseInt(row[1]) || 0,
      numGpus: parseInt(row[2]) || 0,
      numProcessNames: parseInt(row[3]) || 0,
      numThreads: parseInt(row[4]) || 0
    };
  }

  /**
   * Get table schema information
   */
  async getTableSchema(): Promise<any[]> {
    // This would typically use the WASM version to query schema
    // For now, return a static list based on Perfetto documentation
    return [
      {
        name: 'slice',
        table_type: 'table',
        columns: [
          { name: 'id', type: 'INTEGER', is_nullable: false },
          { name: 'type', type: 'STRING', is_nullable: false },
          { name: 'ts', type: 'LONG', is_nullable: false },
          { name: 'dur', type: 'LONG', is_nullable: false },
          { name: 'track_id', type: 'LONG', is_nullable: false },
          { name: 'category', type: 'STRING', is_nullable: true },
          { name: 'name', type: 'STRING', is_nullable: false },
          { name: 'depth', type: 'INTEGER', is_nullable: false },
          { name: 'parent_id', type: 'INTEGER', is_nullable: true },
          { name: 'arg_set_id', type: 'INTEGER', is_nullable: true }
        ]
      },
      {
        name: 'thread',
        table_type: 'table',
        columns: [
          { name: 'utid', type: 'INTEGER', is_nullable: false },
          { name: 'tid', type: 'INTEGER', is_nullable: false },
          { name: 'name', type: 'STRING', is_nullable: true },
          { name: 'start_ts', type: 'LONG', is_nullable: false },
          { name: 'end_ts', type: 'LONG', is_nullable: true },
          { name: 'upid', type: 'INTEGER', is_nullable: true },
          { name: 'is_main_thread', type: 'INTEGER', is_nullable: false }
        ]
      },
      {
        name: 'process',
        table_type: 'table',
        columns: [
          { name: 'upid', type: 'INTEGER', is_nullable: false },
          { name: 'pid', type: 'INTEGER', is_nullable: false },
          { name: 'name', type: 'STRING', is_nullable: false },
          { name: 'start_ts', type: 'LONG', is_nullable: false },
          { name: 'end_ts', type: 'LONG', is_nullable: true },
          { name: 'parent_upid', type: 'INTEGER', is_nullable: true },
          { name: 'uid', type: 'INTEGER', is_nullable: true },
          { name: 'android_pkgname', type: 'STRING', is_nullable: true }
        ]
      },
      {
        name: 'sched',
        table_type: 'table',
        columns: [
          { name: 'id', type: 'INTEGER', is_nullable: false },
          { name: 'ts', type: 'LONG', is_nullable: false },
          { name: 'dur', type: 'LONG', is_nullable: false },
          { name: 'utid', type: 'INTEGER', is_nullable: false },
          { name: 'cpu', type: 'INTEGER', is_nullable: false },
          { name: 'end_state', type: 'INTEGER', is_nullable: false },
          { name: 'priority', type: 'INTEGER', is_nullable: false },
          { name: 'waker_utid', type: 'INTEGER', is_nullable: true }
        ]
      },
      {
        name: 'counter',
        table_type: 'table',
        columns: [
          { name: 'id', type: 'INTEGER', is_nullable: false },
          { name: 'ts', type: 'LONG', is_nullable: false },
          { name: 'value', type: 'DOUBLE', is_nullable: false },
          { name: 'track_id', type: 'LONG', is_nullable: false }
        ]
      },
      {
        name: 'ftrace_event',
        table_type: 'table',
        columns: [
          { name: 'id', type: 'INTEGER', is_nullable: false },
          { name: 'ts', type: 'LONG', is_nullable: false },
          { name: 'name', type: 'STRING', is_nullable: false },
          { name: 'utid', type: 'INTEGER', is_nullable: false },
          { name: 'cpu', type: 'INTEGER', is_nullable: false },
          { name: 'arg_set_id', type: 'INTEGER', is_nullable: false },
          { name: 'common_flags', type: 'INTEGER', is_nullable: false }
        ]
      }
    ];
  }

  /**
   * Analyze trace for common performance issues
   */
  async analyzeTraceForPerformanceIssues(traceFilePath: string): Promise<any[]> {
    const analyses: any[] = [];

    // 1. Check for ANRs (Application Not Responding)
    const anrQuery = `
      SELECT
        thread.name AS thread_name,
        process.name AS process_name,
        process.android_pkgname AS package_name,
        slice.ts / 1e6 AS start_time_ms,
        slice.dur / 1e6 AS duration_ms
      FROM slice
      JOIN thread_track ON slice.track_id = thread_track.id
      JOIN thread USING (utid)
      JOIN process USING (upid)
      WHERE slice.dur > 5e9  -- 5 seconds
        AND process.name NOT LIKE 'com.android.'
      ORDER BY slice.dur DESC
      LIMIT 10
    `;

    const anrResult = await this.executeQuery(traceFilePath, anrQuery);
    if (anrResult.rows.length > 0) {
      analyses.push({
        type: 'ANR',
        severity: 'high',
        count: anrResult.rows.length,
        details: anrResult.rows
      });
    }

    // 2. Check for jank (frame drops)
    const jankQuery = `
      WITH main_thread_gfx AS (
        SELECT slice.*
        FROM slice
        JOIN thread_track ON slice.track_id = thread_track.id
        JOIN thread USING (utid)
        JOIN process USING (upid)
        WHERE thread.is_main_thread = 1
          AND slice.category = 'gfx'
          AND slice.name LIKE 'Frame%'
      )
      SELECT
        name,
        COUNT(*) AS frame_count,
        COUNT(CASE WHEN dur > 16.67e6 THEN 1 END) AS jank_count,
        AVG(dur) / 1e6 AS avg_dur_ms,
        MAX(dur) / 1e6 AS max_dur_ms
      FROM main_thread_gfx
      GROUP BY name
    `;

    const jankResult = await this.executeQuery(traceFilePath, jankQuery);
    if (jankResult.rows.length > 0) {
      analyses.push({
        type: 'JANK',
        severity: 'medium',
        count: jankResult.rows.reduce((sum, row) => sum + parseInt(row[2]), 0),
        details: jankResult.rows
      });
    }

    // 3. Check for high memory usage
    const memoryQuery = `
      SELECT
        process.name,
        process.android_pkgname,
        heap_graph_object.type_name,
        COUNT(*) AS object_count,
        SUM(heap_graph_object.self_size) / 1024 / 1024 AS total_size_mb
      FROM heap_graph_object
      JOIN process USING (upid)
      WHERE heap_graph_object.self_size > 0
      GROUP BY process.name, process.android_pkgname, heap_graph_object.type_name
      HAVING total_size_mb > 100
      ORDER BY total_size_mb DESC
      LIMIT 10
    `;

    const memoryResult = await this.executeQuery(traceFilePath, memoryQuery);
    if (memoryResult.rows.length > 0) {
      analyses.push({
        type: 'MEMORY',
        severity: 'medium',
        count: memoryResult.rows.length,
        details: memoryResult.rows
      });
    }

    // 4. Check for CPU throttling
    const cpuThrottlingQuery = `
      SELECT
        cpu,
        COUNT(*) AS throttling_events,
        AVG(dur) / 1e6 AS avg_duration_ms
      FROM ftrace_event
      WHERE name LIKE 'cpu_frequency%'
        OR name LIKE 'cpu_idle%'
      GROUP BY cpu
      HAVING throttling_events > 10
    `;

    const cpuThrottlingResult = await this.executeQuery(traceFilePath, cpuThrottlingQuery);
    if (cpuThrottlingResult.rows.length > 0) {
      analyses.push({
        type: 'CPU_THROTTLING',
        severity: 'low',
        count: cpuThrottlingResult.rows.length,
        details: cpuThrottlingResult.rows
      });
    }

    return analyses;
  }

  /**
   * Convert trace to other format (e.g., JSON)
   */
  async convertTrace(traceFilePath: string, outputPath: string, format: 'json' | 'csv'): Promise<void> {
    const command = `${this.traceProcessorShell} --output ${outputPath} ${traceFilePath}`;
    await execAsync(command);
  }
}

export default PerfettoService;

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import fs from 'fs';
import path from 'path';

import {describe, expect, it} from '@jest/globals';

type SourceFile = {
  path: string;
  text: string;
};

type SqlChunk = SourceFile & {
  sql: string;
  offset: number;
};

const SQL_SCAN_EXTENSIONS = new Set(['.ts', '.md', '.yaml', '.yml']);
const SKIP_DIRS = new Set(['__tests__', 'node_modules', 'dist']);
const SQL_KEYWORDS = new Set([
  'where',
  'join',
  'left',
  'right',
  'inner',
  'outer',
  'cross',
  'on',
  'using',
  'group',
  'order',
  'limit',
]);

const backendRoot = path.resolve(__dirname, '../../..');
const scanRoots = [
  path.join(backendRoot, 'src'),
  path.join(backendRoot, 'skills'),
  path.join(backendRoot, 'strategies'),
];

function walkFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, {withFileTypes: true});
  const files: string[] = [];
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(fullPath));
      continue;
    }
    if (entry.isFile() && SQL_SCAN_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(fullPath);
    }
  }
  return files;
}

function loadSourceFiles(): SourceFile[] {
  return scanRoots
    .flatMap(walkFiles)
    .map(filePath => ({
      path: path.relative(backendRoot, filePath),
      text: fs.readFileSync(filePath, 'utf8'),
    }));
}

function lineAt(text: string, offset: number): number {
  return text.slice(0, offset).split('\n').length;
}

function extractSqlChunks(file: SourceFile): SqlChunk[] {
  const chunks: SqlChunk[] = [];
  const markdownSql = /```sql\s*\n([\s\S]*?)```/gi;
  for (const match of file.text.matchAll(markdownSql)) {
    chunks.push({...file, sql: match[1], offset: match.index ?? 0});
  }

  if (/\.(yaml|yml)$/.test(file.path)) {
    const lines = file.text.split('\n');
    let offset = 0;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const blockMatch = line.match(/^(\s*)sql:\s*[|>]/);
      if (!blockMatch) {
        offset += line.length + 1;
        continue;
      }

      const baseIndent = blockMatch[1].length;
      const sqlLines: string[] = [];
      let blockOffset = offset + line.length + 1;
      for (let j = i + 1; j < lines.length; j += 1) {
        const next = lines[j];
        if (next.trim() !== '') {
          const indent = next.match(/^\s*/)?.[0].length ?? 0;
          if (indent <= baseIndent) break;
          sqlLines.push(next.slice(Math.min(indent, baseIndent + 2)));
        } else {
          sqlLines.push('');
        }
      }
      chunks.push({...file, sql: sqlLines.join('\n'), offset: blockOffset});
      offset += line.length + 1;
    }
  }

  if (file.path.endsWith('.ts')) {
    const templateSql = /`([\s\S]*?\b(?:SELECT|WITH|FROM|JOIN)\b[\s\S]*?)`/gi;
    for (const match of file.text.matchAll(templateSql)) {
      chunks.push({...file, sql: match[1], offset: match.index ?? 0});
    }
  }

  return chunks;
}

function collectAliases(sql: string, table: string): string[] {
  const aliases: string[] = [];
  const tableAlias = new RegExp(`\\b(?:FROM|JOIN)\\s+${table}\\s+(?:AS\\s+)?([A-Za-z_]\\w*)`, 'gi');
  for (const match of sql.matchAll(tableAlias)) {
    const alias = match[1].toLowerCase();
    if (!SQL_KEYWORDS.has(alias)) aliases.push(match[1]);
  }
  return aliases;
}

function pushIssue(issues: string[], file: SourceFile, offset: number, rule: string, detail: string): void {
  issues.push(`${file.path}:${lineAt(file.text, offset)} ${rule}: ${detail}`);
}

describe('SQL safety patterns', () => {
  it('rejects known trace_processor SQL footguns in runtime sources and prompt assets', () => {
    const files = loadSourceFiles();
    const issues: string[] = [];

    const directRules: Array<{name: string; regex: RegExp}> = [
      {name: 'slice has no utid/upid column', regex: /\bslice\.(?:utid|upid)\b/gi},
      {name: 'thread_track has no track_id column', regex: /\bthread_track\.track_id\b/gi},
      {name: 'thread_track cannot be joined USING(track_id)', regex: /\bJOIN\s+thread_track\s+USING\s*\(\s*track_id\s*\)/gi},
      {name: 'actual_frame_timeline_slice cannot be joined to thread USING(utid)', regex: /\bactual_frame_timeline_slice\b[\s\S]{0,400}\bJOIN\s+thread(?:\s+(?:AS\s+)?[A-Za-z_]\w*)?\s+USING\s*\(\s*utid\s*\)/gi},
      {name: 'arg_set alias is not joined', regex: /\barg_set\.arg_set_id\b/gi},
      {
        name: 'slice.track_id must not be matched to thread.utid',
        regex: /\b(?:s|slice)\.track_id\s*=\s*(?:t|thread)\.utid\b|\b(?:t|thread)\.utid\s*=\s*(?:s|slice)\.track_id\b/gi,
      },
      {
        name: 'bare SELECT name,dur is ambiguous-prone',
        regex: /\bSELECT\s+(?:DISTINCT\s+)?name\s*,\s*dur(?:\s*,|\s*\/)/gi,
      },
    ];

    for (const file of files) {
      for (const rule of directRules) {
        for (const match of file.text.matchAll(rule.regex)) {
          pushIssue(issues, file, match.index ?? 0, rule.name, match[0]);
        }
      }
    }

    for (const chunk of files.flatMap(extractSqlChunks)) {
      const sliceAliases = collectAliases(chunk.sql, 'slice');
      for (const alias of sliceAliases) {
        const invalidColumn = new RegExp(`\\b${alias}\\.(?:utid|upid)\\b`, 'gi');
        for (const match of chunk.sql.matchAll(invalidColumn)) {
          pushIssue(issues, chunk, chunk.offset + (match.index ?? 0), 'slice alias has no utid/upid column', match[0]);
        }
      }

      const threadTrackAliases = collectAliases(chunk.sql, 'thread_track');
      for (const alias of threadTrackAliases) {
        const invalidColumn = new RegExp(`\\b${alias}\\.track_id\\b`, 'gi');
        for (const match of chunk.sql.matchAll(invalidColumn)) {
          pushIssue(issues, chunk, chunk.offset + (match.index ?? 0), 'thread_track alias has no track_id column', match[0]);
        }
      }

      const threadAliases = collectAliases(chunk.sql, 'thread');
      const processAliases = collectAliases(chunk.sql, 'process');
      for (const sliceAlias of sliceAliases) {
        for (const threadAlias of threadAliases) {
          const badJoin = new RegExp(
            `\\b${sliceAlias}\\.track_id\\s*=\\s*${threadAlias}\\.utid\\b|\\b${threadAlias}\\.utid\\s*=\\s*${sliceAlias}\\.track_id\\b`,
            'gi',
          );
          for (const match of chunk.sql.matchAll(badJoin)) {
            pushIssue(issues, chunk, chunk.offset + (match.index ?? 0), 'slice.track_id must join thread_track.id first', match[0]);
          }
        }
      }

      const threadSliceAliases = collectAliases(chunk.sql, 'thread_slice');
      if (/\bFROM\s+thread_slice\b/i.test(chunk.sql)) {
        if (
          !threadAliases.some(alias => alias.toLowerCase() === 't') &&
          !threadSliceAliases.some(alias => alias.toLowerCase() === 't')
        ) {
          const danglingThreadName = /\bt\.name\b/gi;
          for (const match of chunk.sql.matchAll(danglingThreadName)) {
            pushIssue(
              issues,
              chunk,
              chunk.offset + (match.index ?? 0),
              'thread_slice exposes thread_name directly',
              'use thread_name or thread_slice_alias.thread_name instead of t.name unless JOIN thread t is present',
            );
          }
        }
        if (
          !processAliases.some(alias => alias.toLowerCase() === 'p') &&
          !threadSliceAliases.some(alias => alias.toLowerCase() === 'p')
        ) {
          const danglingProcessName = /\bp\.name\b/gi;
          for (const match of chunk.sql.matchAll(danglingProcessName)) {
            pushIssue(
              issues,
              chunk,
              chunk.offset + (match.index ?? 0),
              'thread_slice exposes process_name directly',
              'use process_name or thread_slice_alias.process_name instead of p.name unless JOIN process p is present',
            );
          }
        }
      }

      if (/\bJOIN\b/i.test(chunk.sql)) {
        const selectHead = chunk.sql.match(/\bSELECT\b[\s\S]*?\bFROM\b/i)?.[0] ?? '';
        const bareName = /\bSELECT\s+(?:DISTINCT\s+)?name\s*,/i.exec(selectHead);
        if (bareName) {
          pushIssue(issues, chunk, chunk.offset + bareName.index, 'bare name selected before JOIN', bareName[0]);
        }
      }

      if (
        /\bFROM\s+thread_slice\b/i.test(chunk.sql) &&
        /\bself_dur\b/i.test(chunk.sql) &&
        !/\b(?:FROM|JOIN)\s+slice_self_dur\b/i.test(chunk.sql)
      ) {
        const match = /\bself_dur\b/i.exec(chunk.sql);
        pushIssue(
          issues,
          chunk,
          chunk.offset + (match?.index ?? 0),
          'thread_slice does not expose self_dur directly',
          'JOIN slice_self_dur USING(id) before selecting self_dur',
        );
      }
    }

    expect(issues).toEqual([]);
  });
});

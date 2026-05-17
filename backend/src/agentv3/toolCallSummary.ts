// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Build a one-line digest of an MCP tool's `input` object so plan-adherence
 * checks can confirm the *right* call was made, not just any call with the
 * right tool name. Two `invoke_skill` calls targeting different skills
 * should be distinguishable in the tool log.
 *
 * Phase 0.5 of the v2.1 context-engineering refactor introduces this; Phase
 * 0.6 changes `PlanPhase.expectedCalls` to a structured `{tool, skillId?,
 * paramsPredicate?}` matcher that consumes `skillId` / `inputSummary`.
 */

import { createHash } from 'crypto';

const SHORT_LIMIT = 120;

function shorten(s: string): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > SHORT_LIMIT ? flat.slice(0, SHORT_LIMIT - 3) + '...' : flat;
}

function hashInput(input: unknown): string {
  return createHash('sha256').update(JSON.stringify(input ?? null)).digest('hex').slice(0, 8);
}

export interface ToolCallSummary {
  inputSummary?: string;
  skillId?: string;
  paramsHash?: string;
}

/**
 * Resolve a structured digest for an MCP tool call. `toolName` must be the
 * short form (without the `mcp__smartperfetto__` prefix).
 *
 * Tools with well-known input shapes (`execute_sql`, `invoke_skill`,
 * `fetch_artifact`) get hand-tuned summaries; everything else falls back
 * to a truncated JSON dump.
 */
export function summarizeToolCallInput(toolName: string, input: unknown): ToolCallSummary {
  if (input == null || typeof input !== 'object') return {};
  const obj = input as Record<string, unknown>;
  const paramsHash = hashInput(input);

  switch (toolName) {
    case 'execute_sql': {
      const sql = typeof obj.sql === 'string' ? obj.sql : '';
      return { inputSummary: shorten(sql) || undefined, paramsHash };
    }
    case 'invoke_skill': {
      const skillId = typeof obj.skillId === 'string' ? obj.skillId : undefined;
      const params = obj.params && typeof obj.params === 'object'
        ? obj.params as Record<string, unknown>
        : {};
      const paramKeys = Object.keys(params).sort().join(',');
      const inputSummary = skillId
        ? (paramKeys ? `${skillId}(${paramKeys})` : skillId)
        : undefined;
      return { skillId, inputSummary, paramsHash };
    }
    case 'fetch_artifact': {
      const id = obj.artifactId ?? obj.id ?? '?';
      const detail = obj.detail ?? '?';
      const purpose = typeof obj.purpose === 'string' ? ` ${shorten(obj.purpose)}` : '';
      return { inputSummary: `${id}@${detail}${purpose}`, paramsHash };
    }
    default: {
      return { inputSummary: shorten(JSON.stringify(input)), paramsHash };
    }
  }
}

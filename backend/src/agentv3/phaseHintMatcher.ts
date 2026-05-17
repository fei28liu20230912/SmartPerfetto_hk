// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Pure phase-hint matching used by `update_plan_phase` to pick the
 * restatement to inject into a tool response. Extracted from
 * `claudeMcpServer.ts` (Phase 4 of v2.1) so the algorithm can be unit
 * tested without standing up a full MCP server.
 *
 * Match by weighted keyword overlap against the next phase's `name + goal`.
 * Phase names are weighted higher than goals so a phase named "综合结论"
 * is not stolen by goal text that happens to mention "根因/代表帧".
 *
 * Do not use an unconditional critical fallback here. Real e2e runs showed
 * that fallback injecting root-cause reminders into identity/global-context
 * phases is worse than omitting a reminder.
 */

import type { PhaseHint } from './strategyLoader';

interface PhaseSnapshot {
  name: string;
  goal?: string;
  summary?: string;
  status: 'pending' | 'in_progress' | 'completed' | 'skipped';
}

/**
 * Resolve the hint to inject into the response of a phase transition.
 * Returns `undefined` when no hint is applicable (e.g. agent's phase
 * matches no keywords AND every critical hint has already been covered).
 */
export function matchPhaseHintForNextPhase(input: {
  hints: ReadonlyArray<PhaseHint>;
  nextPhase: { name: string; goal?: string };
  finishedPhases: ReadonlyArray<PhaseSnapshot>;
}): PhaseHint | undefined {
  const { hints, nextPhase, finishedPhases } = input;
  if (hints.length === 0) return undefined;

  const phaseName = nextPhase.name.toLowerCase();
  const phaseGoal = (nextPhase.goal ?? '').toLowerCase();

  const keywordWeight = (keyword: string): number => {
    const normalized = keyword.trim();
    if (normalized.length <= 1) return 0;
    if (normalized.length <= 2) return 4;
    return 6 + Math.min(normalized.length, 12);
  };

  const scoreHint = (hint: PhaseHint): number => {
    let score = 0;
    for (const keyword of hint.keywords) {
      const kw = keyword.toLowerCase();
      if (!kw) continue;
      const weight = keywordWeight(kw);
      if (phaseName.includes(kw)) score += weight * 5;
      if (phaseGoal.includes(kw)) score += weight;
    }
    return score;
  };

  const keywordMatches = hints
    .map((hint, index) => ({ hint, index, score: scoreHint(hint) }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index);
  if (keywordMatches.length > 0) return keywordMatches[0].hint;

  return undefined;
}

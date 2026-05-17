// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Shared "normalize an AnalysisResult before it reaches the user" helpers.
 *
 * Both delivery paths (HTTP SSE and CLI HTML report) need to:
 *   1. Run the conclusion text through `normalizeConclusionOutput` when the
 *      heuristic says to (see `shouldNormalizeConclusionOutput`).
 *   2. If the orchestrator didn't populate `conclusionContract`, derive one
 *      from the normalized-but-unsanitized conclusion so machine-readable
 *      evidence refs survive display cleanup.
 *   3. Sanitize user-facing narrative text (strip internal evidence IDs,
 *      replace legacy phrases).
 *
 * HTTP route used to inline all of this in `sendAgentDrivenResult`. CLI's
 * `buildReportHtml` skipped the step entirely, so the CLI-produced HTML
 * diverged from the web UI for the same session. Centralize the logic
 * here so `buildAgentDrivenReportData` receives an already-normalized
 * result regardless of the delivery path.
 */

import {
  deriveConclusionContract,
  normalizeConclusionOutput,
  shouldNormalizeConclusionOutput,
} from '../agent/core/conclusionGenerator';
import { sanitizeNarrativeForClient } from '../routes/narrativeSanitizer';
import type { AnalysisResult } from '../agent/core/orchestratorTypes';
import type { ConclusionContract } from '../agent/core/conclusionContract';

interface ConclusionContractDeriveOptions {
  mode?: 'initial_report' | 'focused_answer' | 'need_input';
  singleFrameDrillDown?: boolean;
  sceneId?: string;
}

/**
 * Normalize a conclusion string for contract parsing without user-facing
 * sanitization. This keeps evidence/source ids available for
 * `deriveConclusionContract`; display sanitization may intentionally remove
 * those ids later.
 */
export function normalizeNarrativeForContract(narrative: string): string {
  const raw = String(narrative || '');
  const trimmed = raw.trim();
  if (!trimmed) return raw;

  if (shouldNormalizeConclusionOutput(trimmed)) {
    try {
      return normalizeConclusionOutput(trimmed).trim() || raw;
    } catch {
      return raw;
    }
  }

  return raw;
}

/**
 * Derive a conclusion contract before display sanitization can remove internal
 * evidence ids from machine-readable references.
 */
export function deriveConclusionContractForNarrative(
  narrative: string,
  options: ConclusionContractDeriveOptions = {},
): ConclusionContract | undefined {
  const contractSource = normalizeNarrativeForContract(narrative);
  return (
    deriveConclusionContract(contractSource, options) ||
    deriveConclusionContract(normalizeNarrativeForClient(narrative), options) ||
    undefined
  );
}

/**
 * Normalize a conclusion string for end-user display. Safe to call on any
 * input; falls back to the original text when normalization would empty it.
 */
export function normalizeNarrativeForClient(narrative: string): string {
  const normalized = normalizeNarrativeForContract(narrative);
  return sanitizeNarrativeForClient(normalized) || normalized;
}

/**
 * Normalize an AnalysisResult's conclusion + re-derive its conclusionContract
 * (if missing) using the same rounds-based mode heuristic the HTTP path uses.
 * Returns the input unchanged when no fields would actually change, so the
 * identity check in callers (`result === normalized`) stays cheap.
 */
export function normalizeResultForReport(result: AnalysisResult): AnalysisResult {
  const normalizedConclusion = normalizeNarrativeForClient(result.conclusion);
  const normalizedContract =
    result.conclusionContract ||
    deriveConclusionContractForNarrative(result.conclusion, {
      mode: result.rounds > 1 ? 'focused_answer' : 'initial_report',
    }) ||
    undefined;

  if (
    normalizedConclusion === result.conclusion &&
    normalizedContract === result.conclusionContract
  ) {
    return result;
  }
  return {
    ...result,
    conclusion: normalizedConclusion,
    conclusionContract: normalizedContract,
  };
}

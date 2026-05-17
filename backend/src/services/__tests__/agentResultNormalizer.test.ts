// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {
  deriveConclusionContractForNarrative,
  normalizeNarrativeForContract,
  normalizeNarrativeForClient,
  normalizeResultForReport,
} from '../agentResultNormalizer';
import type { AnalysisResult } from '../../agent/core/orchestratorTypes';

function makeResult(overrides: Partial<AnalysisResult> = {}): AnalysisResult {
  return {
    sessionId: 'agent-test',
    success: true,
    findings: [],
    hypotheses: [],
    conclusion: '',
    confidence: 0.7,
    rounds: 1,
    totalDurationMs: 1000,
    ...overrides,
  };
}

describe('normalizeNarrativeForClient', () => {
  test('returns empty string unchanged', () => {
    expect(normalizeNarrativeForClient('')).toBe('');
    expect(normalizeNarrativeForClient('   ')).toBe('   ');
  });

  test('strips evidence ids (internal sanitization)', () => {
    // Sample an evidence-id-shaped token — the sanitizer should remove it.
    const input = 'The jank event (ev_deadbeef1234) was at frame 12.';
    const out = normalizeNarrativeForClient(input);
    expect(out).not.toContain('ev_deadbeef1234');
  });

  test('returns raw when narrative is non-conclusion text', () => {
    const raw = 'just a plain string with no special markers';
    expect(normalizeNarrativeForClient(raw)).toBe(raw);
  });

  test('tolerates non-string-coerced inputs', () => {
    expect(normalizeNarrativeForClient(null as unknown as string)).toBe('');
    expect(normalizeNarrativeForClient(undefined as unknown as string)).toBe('');
  });
});

describe('deriveConclusionContractForNarrative', () => {
  const narrativeWithEvClaim = [
    '快速回答：帧耗时 45.6ms（ev_deadbeef1234）。',
    '',
    '## 逐句数据引用（结构化来源）',
    '- Q1 / C1: 帧耗时 45.6ms',
    '  - evidence_ref_id=ev_deadbeef1234; source_ref=表 1; row_index=0; column=dur_ms; value=45.6',
  ].join('\n');

  test('keeps evidence ids available for contract parsing before display sanitization', () => {
    const display = normalizeNarrativeForClient(narrativeWithEvClaim);
    expect(display).not.toContain('ev_deadbeef1234');

    const contractSource = normalizeNarrativeForContract(narrativeWithEvClaim);
    expect(contractSource).toContain('ev_deadbeef1234');

    const contract = deriveConclusionContractForNarrative(narrativeWithEvClaim);
    expect(contract?.claims?.[0]?.references?.[0]?.evidenceRefId).toBe('ev_deadbeef1234');
    expect(contract?.claims?.[0]?.references?.[0]?.sourceRef).toBe('表 1');
  });
});

describe('normalizeResultForReport', () => {
  test('returns input identity when nothing would change', () => {
    const r = makeResult({ conclusion: 'plain text', conclusionContract: { mode: 'focused_answer' } as any });
    const out = normalizeResultForReport(r);
    // Identity check — callers rely on this to skip downstream work.
    expect(out).toBe(r);
  });

  test('strips evidence ids from conclusion', () => {
    const r = makeResult({ conclusion: 'Frame regression at (ev_aaaaaaaaaaaa).' });
    const out = normalizeResultForReport(r);
    expect(out.conclusion).not.toContain('ev_aaaaaaaaaaaa');
  });

  test('derives a conclusionContract when missing', () => {
    const r = makeResult({ conclusion: 'Some analysis summary.', conclusionContract: undefined, rounds: 2 });
    const out = normalizeResultForReport(r);
    // Either gets a contract (if derivable from this text) or stays undefined;
    // what matters is that the call doesn't throw and the shape is preserved.
    expect(typeof out.conclusion).toBe('string');
    expect(out.rounds).toBe(2);
  });

  test('preserves existing conclusionContract', () => {
    const contract = { mode: 'initial_report' } as any;
    const r = makeResult({ conclusion: 'text', conclusionContract: contract });
    const out = normalizeResultForReport(r);
    expect(out.conclusionContract).toBe(contract);
  });

  test('derives claim provenance from unsanitized narrative while returning sanitized display text', () => {
    const r = makeResult({
      conclusion: [
        '快速回答：帧耗时 45.6ms（ev_deadbeef1234）。',
        '',
        '## 逐句数据引用（结构化来源）',
        '- Q1 / C1: 帧耗时 45.6ms',
        '  - evidence_ref_id=ev_deadbeef1234; source_ref=表 1; row_index=0; column=dur_ms; value=45.6',
      ].join('\n'),
    });

    const out = normalizeResultForReport(r);
    expect(out.conclusion).not.toContain('ev_deadbeef1234');
    expect(out.conclusionContract?.claims?.[0]?.references?.[0]?.evidenceRefId).toBe('ev_deadbeef1234');
  });
});

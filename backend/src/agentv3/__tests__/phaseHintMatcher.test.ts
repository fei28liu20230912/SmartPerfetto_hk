// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Phase 4 of v2.1 — exercise the next_phase_reminder selection logic
 * without standing up a full MCP server. Two-stage match: keyword
 * against the next phase's `name + goal`. It deliberately does not use
 * a critical fallback because that polluted unrelated phases in e2e runs.
 */

import { describe, it, expect } from '@jest/globals';
import { matchPhaseHintForNextPhase } from '../phaseHintMatcher';
import type { PhaseHint } from '../strategyLoader';

const overviewHint: PhaseHint = {
  id: 'overview',
  keywords: ['概览', 'overview', 'frame', 'jank', '帧'],
  constraints: '调用 scrolling_analysis 取全帧统计',
  criticalTools: ['scrolling_analysis'],
  critical: false,
};

const rootCauseHint: PhaseHint = {
  id: 'root_cause_drill',
  keywords: ['根因', 'root cause', 'drill', '深钻', '代表帧', '逐帧'],
  constraints: '对占比 >15% 的 reason_code 必须深钻',
  criticalTools: ['jank_frame_detail'],
  critical: true,
};

const conclusionHint: PhaseHint = {
  id: 'conclusion',
  keywords: ['结论', 'conclusion', '报告', '输出'],
  constraints: '输出全帧根因分布表 + 代表帧分析',
  criticalTools: [],
  critical: false,
};

const missingFrameHint: PhaseHint = {
  id: 'missing_frame_gap',
  keywords: ['缺帧', 'gap', 'frame_production_gap', '帧间'],
  constraints: '按触发条件决定是否调用 frame_production_gap',
  criticalTools: ['frame_production_gap'],
  critical: false,
};

describe('matchPhaseHintForNextPhase', () => {
  it('returns undefined when no hints are configured', () => {
    expect(matchPhaseHintForNextPhase({
      hints: [],
      nextPhase: { name: '根因分析', goal: '查找卡顿原因' },
      finishedPhases: [],
    })).toBeUndefined();
  });

  it('keyword match — picks the hint whose keyword appears in the phase name/goal', () => {
    const result = matchPhaseHintForNextPhase({
      hints: [overviewHint, rootCauseHint, conclusionHint],
      nextPhase: { name: '根因分析', goal: '查找卡顿原因' },
      finishedPhases: [],
    });
    expect(result?.id).toBe('root_cause_drill');
  });

  it('keyword match is case-insensitive across English keywords', () => {
    const result = matchPhaseHintForNextPhase({
      hints: [overviewHint, rootCauseHint, conclusionHint],
      nextPhase: { name: 'Deep Drill Analysis', goal: 'identify the underlying cause' },
      finishedPhases: [],
    });
    // "drill" hits rootCauseHint; overview keywords (frame/jank/overview) absent.
    expect(result?.id).toBe('root_cause_drill');
  });

  it('does not fall back to an unrelated critical hint when keyword matching misses', () => {
    const result = matchPhaseHintForNextPhase({
      hints: [overviewHint, rootCauseHint, conclusionHint],
      nextPhase: { name: 'Mystery Phase', goal: 'do unspecified work' },
      finishedPhases: [],
    });
    expect(result).toBeUndefined();
  });

  it('does not inject a covered critical hint when keyword matching misses', () => {
    const result = matchPhaseHintForNextPhase({
      hints: [overviewHint, rootCauseHint, conclusionHint],
      nextPhase: { name: 'Mystery Phase', goal: 'do unspecified work' },
      finishedPhases: [
        { name: '根因深钻', summary: '已分析 reason_code 分布', status: 'completed' },
      ],
    });
    expect(result).toBeUndefined();
  });

  it('does not let unfinished covered-looking phases trigger fallback', () => {
    const result = matchPhaseHintForNextPhase({
      hints: [overviewHint, rootCauseHint, conclusionHint],
      nextPhase: { name: 'Mystery Phase', goal: 'do unspecified work' },
      finishedPhases: [
        { name: '根因深钻', summary: '尚未开始', status: 'pending' },
      ],
    });
    expect(result).toBeUndefined();
  });

  it('returns undefined when no critical hint exists and keyword matching missed', () => {
    const onlyNonCritical = [overviewHint, conclusionHint]; // both critical: false
    const result = matchPhaseHintForNextPhase({
      hints: onlyNonCritical,
      nextPhase: { name: 'Mystery Phase', goal: 'do unspecified work' },
      finishedPhases: [],
    });
    expect(result).toBeUndefined();
  });

  it('phase name matches outrank generic goal words', () => {
    const result = matchPhaseHintForNextPhase({
      hints: [overviewHint, rootCauseHint, conclusionHint],
      nextPhase: { name: '根因深钻', goal: '选代表帧做逐帧诊断，确认每帧为什么卡顿' },
      finishedPhases: [],
    });
    expect(result?.id).toBe('root_cause_drill');
  });

  it('conclusion phase is not stolen by root-cause words in the output goal', () => {
    const result = matchPhaseHintForNextPhase({
      hints: [overviewHint, rootCauseHint, conclusionHint],
      nextPhase: { name: '综合结论', goal: '输出全帧根因分布表、代表帧分析和优化建议' },
      finishedPhases: [
        { name: '数据采集与概览', summary: '347帧和掉帧统计已完成', status: 'completed' },
        { name: '根因深钻', summary: '已完成代表帧和 reason_code 深钻', status: 'completed' },
      ],
    });
    expect(result?.id).toBe('conclusion');
  });

  it('ignores one-character generic keywords such as 帧', () => {
    const result = matchPhaseHintForNextPhase({
      hints: [overviewHint, rootCauseHint, conclusionHint],
      nextPhase: { name: '缺帧检测', goal: '检测帧间 gap 导致的感知卡顿' },
      finishedPhases: [],
    });
    expect(result).toBeUndefined();
  });

  it('uses the dedicated missing-frame hint instead of repeating overview constraints', () => {
    const result = matchPhaseHintForNextPhase({
      hints: [overviewHint, rootCauseHint, missingFrameHint, conclusionHint],
      nextPhase: {
        name: '缺帧检测',
        goal: '复核 scrolling_analysis 的 real_jank_count 后决定是否调用 frame_production_gap 检测帧间 gap',
      },
      finishedPhases: [],
    });
    expect(result?.id).toBe('missing_frame_gap');
  });

  it('handles missing goal gracefully', () => {
    const result = matchPhaseHintForNextPhase({
      hints: [overviewHint],
      nextPhase: { name: 'overview gathering' },
      finishedPhases: [],
    });
    expect(result?.id).toBe('overview');
  });
});

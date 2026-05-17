// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { describe, expect, it, jest } from '@jest/globals';
import { OpenAIRuntime, __testing } from '../openAiRuntime';
import type { AnalysisPlanV3, PlanPhase } from '../../agentv3/types';

function phase(id: string, status: PlanPhase['status']): PlanPhase {
  const p: PlanPhase = {
    id,
    name: `Phase ${id}`,
    goal: `Goal ${id}`,
    expectedTools: ['invoke_skill'],
    status,
  };
  if (status === 'completed' || status === 'skipped') {
    p.summary = `Evidence summary for ${id}`;
  }
  return p;
}

function plan(phases: PlanPhase[]): AnalysisPlanV3 {
  return {
    phases,
    successCriteria: 'Complete every phase before final answer',
    submittedAt: Date.now(),
    toolCallLog: [],
  };
}

describe('OpenAIRuntime plan completion guard', () => {
  it('treats full-mode runs as incomplete until every plan phase is closed', () => {
    const runtime = new OpenAIRuntime({} as any) as any;

    expect(runtime.getPlanCompletionStatus('s1', false)).toMatchObject({
      complete: false,
      hasPlan: false,
      pendingPhases: [],
    });

    runtime.sessionPlans.set('s1', {
      current: plan([phase('p1', 'completed'), phase('p2', 'pending'), phase('p3', 'in_progress')]),
      history: [],
    });

    expect(runtime.getPlanCompletionStatus('s1', false)).toMatchObject({
      complete: false,
      hasPlan: true,
      pendingPhases: [
        expect.objectContaining({ id: 'p2' }),
        expect.objectContaining({ id: 'p3' }),
      ],
    });

    runtime.sessionPlans.set('s1', {
      current: plan([phase('p1', 'completed'), phase('p2', 'skipped')]),
      history: [],
    });

    expect(runtime.getPlanCompletionStatus('s1', false)).toMatchObject({
      complete: true,
      hasPlan: true,
      pendingPhases: [],
    });
  });

  it('does not require a plan in quick mode', () => {
    const runtime = new OpenAIRuntime({} as any) as any;

    expect(runtime.getPlanCompletionStatus('s1', true)).toMatchObject({
      complete: true,
      hasPlan: false,
      pendingPhases: [],
    });
  });

  it('does not treat closed phases with weak summaries as complete', () => {
    const runtime = new OpenAIRuntime({} as any) as any;
    const weak = phase('p1', 'completed');
    weak.summary = 'done';

    runtime.sessionPlans.set('s1', {
      current: plan([weak]),
      history: [],
    });

    expect(runtime.getPlanCompletionStatus('s1', false)).toMatchObject({
      complete: false,
      hasPlan: true,
      pendingPhases: [expect.objectContaining({ id: 'p1' })],
    });
  });

  it('allows deterministic stream finalization after full-mode plan completion', () => {
    const runtime = new OpenAIRuntime({} as any) as any;

    runtime.sessionPlans.set('s1', {
      current: plan([phase('p1', 'completed'), phase('p2', 'in_progress')]),
      history: [],
    });
    expect(runtime.shouldFinalizeAfterPlanComplete('s1', false, 'final text')).toBe(false);

    runtime.sessionPlans.set('s1', {
      current: plan([phase('p1', 'completed'), phase('p2', 'skipped')]),
      history: [],
    });
    expect(runtime.shouldFinalizeAfterPlanComplete('s1', false, '')).toBe(true);
    expect(runtime.shouldFinalizeAfterPlanComplete('s1', false, 'final text')).toBe(true);
    expect(runtime.shouldFinalizeAfterPlanComplete('s1', false, '', 'previous answer')).toBe(true);
    expect(runtime.shouldFinalizeAfterPlanComplete('s1', true, 'final text')).toBe(false);
  });

  it('does not read finalOutput after forced plan-complete aborts', () => {
    const stream = {
      get finalOutput() {
        throw new Error('finalOutput getter should not be read');
      },
    };

    expect(__testing.readCompletedStreamFinalOutput(stream, {
      streamCompleted: false,
      completedByPlanIdle: true,
      timedOut: false,
    })).toBeUndefined();
    expect(__testing.readCompletedStreamFinalOutput(stream, {
      streamCompleted: true,
      completedByPlanIdle: true,
      timedOut: false,
    })).toBeUndefined();
    expect(__testing.readCompletedStreamFinalOutput(stream, {
      streamCompleted: true,
      completedByPlanIdle: false,
      timedOut: true,
    })).toBeUndefined();
  });

  it('reads finalOutput only after natural stream completion', () => {
    expect(__testing.readCompletedStreamFinalOutput({ finalOutput: 'done' }, {
      streamCompleted: true,
      completedByPlanIdle: false,
      timedOut: false,
    })).toBe('done');
  });

  it('strips leading process narration from plan-idle conclusions', () => {
    const sanitized = __testing.sanitizeOpenAiConclusionText(
      '我需要完成剩余的阶段状态更新。p2.7 的触发条件检查已经完成，接下来输出结论。\n\n' +
      '**根因编号映射**\n\n' +
      '- S1: 主线程 Running 占比 63%，对应 art-1 的线程状态表。\n' +
      '- S2: Sleeping 占比 35%，对应 art-2 的阻塞明细表，需要作为次要风险说明。',
      { completedByPlanIdle: true, planComplete: true, fallbackConclusion: 'fallback' },
    );

    expect(sanitized).toContain('**根因编号映射**');
    expect(sanitized).not.toContain('我需要完成剩余的阶段状态更新');
  });

  it('strips multi-paragraph planning narration before the report body', () => {
    const sanitized = __testing.sanitizeOpenAiConclusionText(
      '我来分析 `com.example.launch.aosp.heavy` 的启动性能。这是一个启动分析场景。\n\n' +
      '首先，提交分析计划：## Phase 1 — 启动概览采集\n\n' +
      '调用 `startup_analysis` 获取启动事件列表、延迟归因、主线程热点。\n\n' +
      '### Phase 1 关键发现记录\n\n' +
      '- 冷启动 dur=1338ms，TTID=1912ms，证据来自 art-2。\n' +
      '- 主线程 Running=63%，证据来自 art-10。',
    );

    expect(sanitized).toContain('### Phase 1 关键发现记录');
    expect(sanitized).not.toContain('我来分析');
    expect(sanitized).not.toContain('提交分析计划');
    expect(sanitized).not.toContain('调用 `startup_analysis`');
  });

  it('strips scratch findings and continuation narration before an embedded final report heading', () => {
    const sanitized = __testing.sanitizeOpenAiConclusionText(
      '**根因分布统计：**\n' +
      '- **workload_heavy**: 6帧 (85.7%) - 最严重62.73ms，超预算7.5倍\n\n' +
      '根据 Phase 1.9 要求，我需要对占比 >15% 的根因类型进行深钻。workload_heavy 占比 85.7%，必须深钻。\n\n' +
      '让我更新计划并执行深钻：## 滑动性能分析报告\n\n' +
      '### 概览\n\n' +
      '本次分析覆盖 347 帧，结论引用 art-14 和 art-16。\n\n' +
      '### 根因\n\n' +
      '主线程 animation/CustomScroll_longFrameLoad 是主要耗时点，证据来自 frame_blocking_calls。',
      { completedByPlanIdle: true, planComplete: true },
    );

    expect(sanitized.trim().startsWith('## 滑动性能分析报告')).toBe(true);
    expect(sanitized).toContain('本次分析覆盖 347 帧');
    expect(sanitized).not.toContain('根据 Phase 1.9 要求');
    expect(sanitized).not.toContain('让我更新计划');
  });

  it('falls back to completed phase summaries when the candidate is only process narration', () => {
    expect(__testing.sanitizeOpenAiConclusionText(
      '我需要完成剩余的阶段状态更新。现在继续调用 update_plan_phase。',
      {
        completedByPlanIdle: true,
        planComplete: true,
        fallbackConclusion: '分析计划已完成，基于已完成阶段摘要输出。',
      },
    )).toBe('分析计划已完成，基于已完成阶段摘要输出。');
  });

  it('recovers the accumulated report when the plan-idle candidate is only bookkeeping', () => {
    const report = '## 概览\n\n' +
      '启动诊断完成，主线程 Running=63%，ChaosTask self=456ms，结论引用 art-10 和 data:sql_summary:current:abc。\n\n' +
      '## 根因\n\n' +
      '模拟负载是主要瓶颈，LoadSimulator_ActivityInit=250ms，相关数据来自 art-32。';

    const chosen = __testing.chooseOpenAiConclusionText({
      candidate: '我需要完成剩余的阶段状态更新。现在继续调用 update_plan_phase。',
      accumulatedAnswer: report,
      completedByPlanIdle: true,
      planComplete: true,
      fallbackConclusion: '分析计划已完成，基于已完成阶段摘要输出。',
    });

    expect(chosen).toBe(report);
  });

  it('builds a user-facing structured fallback when a completed plan has no final answer text', () => {
    const runtime = new OpenAIRuntime({} as any) as any;
    const p1 = phase('p1', 'completed');
    p1.name = '获取启动概览';
    p1.summary = '检测到冷启动 dur=1338ms，TTID=1912ms，证据来自 art-2。';
    const p2 = phase('p2', 'completed');
    p2.name = '综合结论';
    p2.goal = '输出最终结论和优化建议';
    p2.summary = '主要瓶颈是 ChaosTask self=456ms，相关数据来自 art-30。';
    runtime.sessionPlans.set('s1', {
      current: plan([p1, p2]),
      history: [],
    });

    const fallback = runtime.buildCompletedPlanFallbackConclusion('s1', false, 'zh-CN');

    expect(fallback).toContain('## 综合结论');
    expect(fallback).toContain('主要瓶颈是 ChaosTask self=456ms');
    expect(fallback).toContain('## 分阶段证据摘要');
    expect(fallback).toContain('art-30');
    expect(fallback).not.toContain('模型未生成独立最终段落');
  });

  it('recognizes provider stream termination as recoverable', () => {
    expect(__testing.isRecoverableOpenAIStreamTermination(new Error('terminated'))).toBe(true);
    expect(__testing.isRecoverableOpenAIStreamTermination(new Error('stream terminated before completion'))).toBe(true);
    expect(__testing.isRecoverableOpenAIStreamTermination(new Error('socket hang up'))).toBe(true);
    expect(__testing.isRecoverableOpenAIStreamTermination(new Error('rate limit exceeded'))).toBe(false);
  });

  it('builds partial phase-summary fallback for interrupted incomplete plans', () => {
    const runtime = new OpenAIRuntime({} as any) as any;
    runtime.sessionPlans.set('s1', {
      current: plan([phase('p1', 'completed'), phase('p2', 'completed'), phase('p3', 'pending')]),
      history: [],
    });

    const fallback = runtime.buildPlanPhaseSummaryFallbackConclusion('s1', false, 'zh');

    expect(fallback).toContain('OpenAI 流在计划完成前中断');
    expect(fallback).toContain('p1 Phase p1');
    expect(fallback).toContain('p2 Phase p2');
    expect(fallback).toContain('未完成阶段：p3:Phase p3');
  });
});

describe('OpenAIRuntime previous response recovery', () => {
  it('recognizes stale previous response errors from OpenAI Responses', () => {
    expect(__testing.isMissingOpenAIPreviousResponseError(
      new Error('No response found with id resp_old_123'),
      'resp_old_123',
    )).toBe(true);
    expect(__testing.isMissingOpenAIPreviousResponseError(
      new Error('previous_response_id does not exist'),
      'resp_old_123',
    )).toBe(true);
    expect(__testing.isMissingOpenAIPreviousResponseError(
      new Error('rate limit exceeded'),
      'resp_old_123',
    )).toBe(false);
  });

  it('does not expose stale OpenAI response mappings for persistence', () => {
    const now = 1_700_000_000_000;
    const runtime = new OpenAIRuntime({} as any) as any;
    runtime.sessionMap.set('s1', {
      lastResponseId: 'resp_stale',
      updatedAt: now - (5 * 60 * 60 * 1000),
    });

    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(now);
    try {
      expect(runtime.getSdkSessionId('s1')).toBeUndefined();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('clears stale previous response ids while preserving local history', () => {
    const runtime = new OpenAIRuntime({} as any) as any;
    const history = [{ role: 'user', content: 'previous question' }];
    runtime.sessionMap.set('s1', {
      history,
      lastResponseId: 'resp_stale',
      runState: '{"state":true}',
      updatedAt: Date.now(),
    });

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      runtime.forgetOpenAILastResponseId('s1', 'No response found with id resp_stale');
    } finally {
      warnSpy.mockRestore();
    }

    expect(runtime.sessionMap.get('s1')).toEqual(expect.objectContaining({
      history,
      lastResponseId: undefined,
      runState: undefined,
    }));
  });

  it('does not persist stale OpenAI response mappings into snapshots', () => {
    const now = 1_700_000_000_000;
    const runtime = new OpenAIRuntime({} as any) as any;
    runtime.sessionMap.set('s1', {
      history: [{ role: 'user', content: 'previous question' }],
      lastResponseId: 'resp_stale',
      updatedAt: now - (5 * 60 * 60 * 1000),
    });

    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const snapshot = runtime.takeSnapshot('s1', 'trace-1', {
        conversationSteps: [],
        queryHistory: [],
        conclusionHistory: [],
        agentDialogue: [],
        agentResponses: [],
        dataEnvelopes: [],
        hypotheses: [],
        runSequence: 0,
        conversationOrdinal: 0,
      });

      expect(snapshot.sdkSessionId).toBeUndefined();
      expect(snapshot.openAILastResponseId).toBeUndefined();
      expect(snapshot.openAIHistory).toBeUndefined();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('persists fresh OpenAI response mappings into snapshots', () => {
    const now = 1_700_000_000_000;
    const runtime = new OpenAIRuntime({} as any) as any;
    const history = [{ role: 'user', content: 'previous question' }];
    runtime.sessionMap.set('s1', {
      history,
      lastResponseId: 'resp_fresh',
      runState: '{"state":true}',
      updatedAt: now - (30 * 60 * 1000),
    });

    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const snapshot = runtime.takeSnapshot('s1', 'trace-1', {
        conversationSteps: [],
        queryHistory: [],
        conclusionHistory: [],
        agentDialogue: [],
        agentResponses: [],
        dataEnvelopes: [],
        hypotheses: [],
        runSequence: 0,
        conversationOrdinal: 0,
      });

      expect(snapshot.sdkSessionId).toBe('resp_fresh');
      expect(snapshot.openAILastResponseId).toBe('resp_fresh');
      expect(snapshot.openAIHistory).toBe(history);
      expect(snapshot.openAIRunState).toBe('{"state":true}');
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('restores OpenAI response mappings with the snapshot timestamp', () => {
    const runtime = new OpenAIRuntime({} as any) as any;
    const snapshotTimestamp = Date.now() - (5 * 60 * 60 * 1000);

    runtime.restoreFromSnapshot('s1', 'trace-1', {
      version: 1,
      snapshotTimestamp,
      sessionId: 's1',
      traceId: 'trace-1',
      conversationSteps: [],
      queryHistory: [],
      conclusionHistory: [],
      agentDialogue: [],
      agentResponses: [],
      dataEnvelopes: [],
      hypotheses: [],
      analysisNotes: [],
      analysisPlan: null,
      planHistory: [],
      uncertaintyFlags: [],
      openAIHistory: [{ role: 'user', content: 'previous question' }],
      openAILastResponseId: 'resp_old',
      runSequence: 0,
      conversationOrdinal: 0,
    });

    expect(runtime.sessionMap.get('s1')).toEqual(expect.objectContaining({
      lastResponseId: 'resp_old',
      updatedAt: snapshotTimestamp,
    }));
  });
});

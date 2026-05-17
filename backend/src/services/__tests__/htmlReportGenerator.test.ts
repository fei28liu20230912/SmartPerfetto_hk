// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { HTMLReportGenerator } from '../htmlReportGenerator';
import type { DataEnvelope } from '../../types/dataContract';

const originalOutputLanguage = process.env.SMARTPERFETTO_OUTPUT_LANGUAGE;

function makeEnvelopeWithFrameId(frameId: number): DataEnvelope {
  return {
    meta: {
      type: 'skill_result',
      version: '2.0.0',
      source: 'scrolling_analysis:get_app_jank_frames#t1',
      timestamp: Date.now(),
      skillId: 'scrolling_analysis',
      stepId: 'get_app_jank_frames',
    },
    display: {
      layer: 'list',
      format: 'table',
      title: '掉帧列表',
      columns: [
        { name: 'frame_id', label: '帧 ID', type: 'number' as any },
        { name: 'dur_ms', label: '帧耗时', type: 'number' as any },
      ],
    },
    data: {
      columns: ['frame_id', 'dur_ms'],
      rows: [[frameId, 16.9]],
    } as any,
  };
}

describe('HTMLReportGenerator', () => {
  beforeEach(() => {
    delete process.env.SMARTPERFETTO_OUTPUT_LANGUAGE;
  });

  afterAll(() => {
    if (originalOutputLanguage === undefined) {
      delete process.env.SMARTPERFETTO_OUTPUT_LANGUAGE;
    } else {
      process.env.SMARTPERFETTO_OUTPUT_LANGUAGE = originalOutputLanguage;
    }
  });

  test('does not render identifier columns with thousands separators', () => {
    const generator = new HTMLReportGenerator();
    const html = generator.generateAgentDrivenHTML({
      traceId: 'trace-1',
      query: '分析滑动掉帧',
      timestamp: Date.now(),
      hypotheses: [],
      dialogue: [],
      agentResponses: [],
      dataEnvelopes: [makeEnvelopeWithFrameId(1435508)],
      result: {
        sessionId: 'session-1',
        success: true,
        findings: [],
        hypotheses: [],
        conclusion: 'ok',
        confidence: 0.8,
        rounds: 1,
        totalDurationMs: 1000,
      },
    });

    expect(html).toContain('1435508');
    expect(html).not.toContain('1,435,508');
  });

  test('formats layered duration-like keys in ms only', () => {
    const generator = new HTMLReportGenerator() as any;
    expect(generator.formatLayeredCellValue(1338654478, 'dur_ns')).toBe('1338.65ms');
    expect(generator.formatLayeredCellValue(1500, 'startup_time_ms')).toBe('1500.00ms');
  });

  test('renders ordered conversation timeline in report', () => {
    const generator = new HTMLReportGenerator();
    const html = generator.generateAgentDrivenHTML({
      traceId: 'trace-2',
      query: '分析启动慢',
      timestamp: Date.now(),
      hypotheses: [],
      dialogue: [],
      conversationTimeline: [
        {
          eventId: 'evt-2',
          ordinal: 2,
          phase: 'tool',
          role: 'agent',
          text: '执行关键 SQL',
          timestamp: Date.now(),
          sourceEventType: 'tool_call',
        },
        {
          eventId: 'evt-1',
          ordinal: 1,
          phase: 'progress',
          role: 'system',
          text: '进入阶段 discovery',
          timestamp: Date.now() - 10,
          sourceEventType: 'stage_transition',
        },
      ],
      agentResponses: [],
      dataEnvelopes: [],
      result: {
        sessionId: 'session-2',
        success: true,
        findings: [],
        hypotheses: [],
        conclusion: 'ok',
        confidence: 0.9,
        rounds: 1,
        totalDurationMs: 800,
      },
    });

    expect(html).toContain('🧵 对话时间线');
    expect(html).toContain('#1');
    expect(html).toContain('#2');
    expect(html).toContain('进入阶段 discovery');
    expect(html).toContain('执行关键 SQL');
    expect(html.indexOf('进入阶段 discovery')).toBeLessThan(html.indexOf('执行关键 SQL'));
  });

  test('renders legacy duration_us format as ms', () => {
    const generator = new HTMLReportGenerator() as any;
    const formatted = generator.formatCellValueFromDefinition(
      1910,
      { name: 'ttid_us', type: 'duration', format: 'duration_us', unit: 'us' },
      null
    );
    expect(formatted).toContain('1.91 ms');
    expect(formatted).not.toContain('μs');
  });

  test('renders summary DataEnvelope provenance and metrics', () => {
    const generator = new HTMLReportGenerator();
    const summaryEnvelope: DataEnvelope = {
      meta: {
        type: 'sql_result',
        version: '2.0.0',
        source: 'execute_sql',
        timestamp: Date.now(),
        evidenceRefId: 'data:sql_summary:reference:trace-hash:query-hash:tool-hash',
        traceSide: 'reference',
        traceId: 'trace-ref',
        queryHash: 'query-hash',
        sourceToolCallId: 'execute_sql_on:1:params_hash:reference',
        paramsHash: 'params_hash',
        planPhaseId: 'p1',
        planPhaseTitle: 'Compare baseline',
        planPhaseGoal: 'Summarize reference trace',
        producerReason: '执行参考 Trace SQL，验证对比差异。',
      },
      display: {
        layer: 'overview',
        format: 'summary',
        title: 'Reference SQL Summary',
      },
      data: {
        summary: {
          title: 'SQL Summary (10 rows)',
          content: 'Total rows: 10',
          metrics: [
            { label: 'total_rows', value: 10, severity: 'info' },
          ],
        },
      } as any,
    };

    const html = generator.generateAgentDrivenHTML({
      traceId: 'trace-4',
      query: '对比参考 trace',
      timestamp: Date.now(),
      hypotheses: [],
      dialogue: [],
      agentResponses: [],
      dataEnvelopes: [summaryEnvelope],
      result: {
        sessionId: 'session-4',
        success: true,
        findings: [],
        hypotheses: [],
        conclusion: 'ok',
        confidence: 0.8,
        rounds: 1,
        totalDurationMs: 1000,
      },
    });

    expect(html).toContain('Reference SQL Summary');
    expect(html).toContain('data:sql_summary:reference:trace-hash:query-hash:tool-hash');
    expect(html).toContain('阶段: p1 Compare baseline');
    expect(html).toContain('工具调用: execute_sql_on:1:params_hash:reference');
    expect(html).toContain('执行参考 Trace SQL，验证对比差异。');
    expect(html).toContain('total_rows');
    expect(html).toContain('10');
    expect(html).not.toContain('无汇总数据');
  });

  test('renders structured conclusion claim references in report', () => {
    const generator = new HTMLReportGenerator();
    const evidenceRefId = 'data:sql_table:current:trace-hash:query-hash:tool-hash';
    const sourceToolCallId = 'execute_sql:7:params_hash';
    const envelope: DataEnvelope = {
      meta: {
        type: 'sql_result',
        version: '2.0.0',
        source: 'execute_sql',
        timestamp: Date.now(),
        evidenceRefId,
        sourceToolCallId,
      },
      display: {
        layer: 'list',
        format: 'table',
        title: 'Frame duration table',
        columns: [
          { name: 'frame_id', label: '帧 ID', type: 'number' as any },
          { name: 'dur_ms', label: '帧耗时', type: 'number' as any },
        ],
      },
      data: {
        columns: ['frame_id', 'dur_ms'],
        rows: [[1435508, 45.6]],
      } as any,
    };

    const html = generator.generateAgentDrivenHTML({
      traceId: 'trace-claim',
      query: '解释掉帧来源',
      timestamp: Date.now(),
      hypotheses: [],
      dialogue: [],
      agentResponses: [],
      dataEnvelopes: [envelope],
      result: {
        sessionId: 'session-claim',
        success: true,
        findings: [],
        hypotheses: [],
        conclusion: '帧 1435508 耗时 45.6ms。',
        conclusionContract: {
          schemaVersion: 'conclusion_contract_v1',
          mode: 'focused_answer',
          conclusions: [],
          clusters: [],
          evidenceChain: [],
          claim_refs: [{
            claim_id: 'Q1',
            conclusion_id: 'C1',
            claim: '帧 1435508 耗时 45.6ms。',
            evidence_refs: [{
              evidence_ref_id: evidenceRefId,
              source_ref: '表 1',
              tool_call_id: sourceToolCallId,
              row_index: 0,
              row_selector: { frame_id: 1435508 },
              col: 'dur_ms',
              value: 45.6,
            }],
          }],
          uncertainties: [],
          nextSteps: [],
        },
        confidence: 0.8,
        rounds: 1,
        totalDurationMs: 1000,
      },
    });

    expect(html).toContain('逐句数据引用');
    expect(html).toContain('Q1 / C1');
    expect(html).toContain('帧 1435508 耗时 45.6ms。');
    expect(html).toContain('报告来源: 数据表 1 · Frame duration table');
    expect(html).toContain(evidenceRefId);
    expect(html).toContain(sourceToolCallId);
    expect(html).toContain('行号: 0 / 行选择器: frame_id=1435508');
    expect(html).toContain('列: <code>dur_ms</code>');
    expect(html).toContain('值: <code>45.6</code>');
    expect(html).toContain('已找到来源表');
  });

  test('marks duplicate claim evidence refs as ambiguous unless tool call disambiguates them', () => {
    const generator = new HTMLReportGenerator();
    const evidenceRefId = 'data:sql_table:duplicate';
    const firstEnvelope: DataEnvelope = {
      meta: {
        type: 'sql_result',
        version: '2.0.0',
        source: 'execute_sql',
        timestamp: Date.now(),
        evidenceRefId,
        sourceToolCallId: 'execute_sql:1:params',
      },
      display: {
        layer: 'list',
        format: 'table',
        title: 'First duplicate table',
      },
      data: {
        columns: ['value'],
        rows: [[1]],
      } as any,
    };
    const secondEnvelope: DataEnvelope = {
      ...firstEnvelope,
      meta: {
        ...firstEnvelope.meta,
        sourceToolCallId: 'execute_sql:2:params',
      },
      display: {
        ...firstEnvelope.display,
        title: 'Second duplicate table',
      },
      data: {
        columns: ['value'],
        rows: [[2]],
      } as any,
    };

    const ambiguousHtml = generator.generateAgentDrivenHTML({
      traceId: 'trace-claim-duplicate',
      query: '解释重复来源',
      timestamp: Date.now(),
      hypotheses: [],
      dialogue: [],
      agentResponses: [],
      dataEnvelopes: [firstEnvelope, secondEnvelope],
      result: {
        sessionId: 'session-claim-duplicate',
        success: true,
        findings: [],
        hypotheses: [],
        conclusion: '值为 2。',
        conclusionContract: {
          claims: [{
            id: 'Q1',
            text: '值为 2。',
            references: [{ evidence_ref_id: evidenceRefId, column: 'value', value: 2 }],
          }],
        },
        confidence: 0.8,
        rounds: 1,
        totalDurationMs: 1000,
      },
    });

    expect(ambiguousHtml).toContain('来源不唯一');
    expect(ambiguousHtml).toContain('匹配到 2 个来源');

    const disambiguatedHtml = generator.generateAgentDrivenHTML({
      traceId: 'trace-claim-duplicate',
      query: '解释重复来源',
      timestamp: Date.now(),
      hypotheses: [],
      dialogue: [],
      agentResponses: [],
      dataEnvelopes: [firstEnvelope, secondEnvelope],
      result: {
        sessionId: 'session-claim-duplicate',
        success: true,
        findings: [],
        hypotheses: [],
        conclusion: '值为 2。',
        conclusionContract: {
          claims: [{
            id: 'Q1',
            text: '值为 2。',
            references: [{
              evidence_ref_id: evidenceRefId,
              source_tool_call_id: 'execute_sql:2:params',
              column: 'value',
              value: 2,
            }],
          }],
        },
        confidence: 0.8,
        rounds: 1,
        totalDurationMs: 1000,
      },
    });

    expect(disambiguatedHtml).toContain('报告来源: 数据表 2 · Second duplicate table');
    expect(disambiguatedHtml).toContain('已找到来源表');
    expect(disambiguatedHtml).not.toContain('来源不唯一');
  });

  test('falls back to visible source_ref labels when claim machine ids are missing', () => {
    const generator = new HTMLReportGenerator();
    const envelope: DataEnvelope = {
      meta: {
        type: 'sql_result',
        version: '2.0.0',
        source: 'execute_sql',
        timestamp: Date.now(),
      },
      display: {
        layer: 'list',
        format: 'table',
        title: 'Frame duration table',
      },
      data: {
        columns: ['frame_id', 'dur_ms'],
        rows: [[1435508, 45.6]],
      } as any,
    };

    const html = generator.generateAgentDrivenHTML({
      traceId: 'trace-source-ref-only',
      query: '解释掉帧来源',
      timestamp: Date.now(),
      hypotheses: [],
      dialogue: [],
      agentResponses: [],
      dataEnvelopes: [envelope],
      result: {
        sessionId: 'session-source-ref-only',
        success: true,
        findings: [],
        hypotheses: [],
        conclusion: '帧 1435508 耗时 45.6ms。',
        conclusionContract: {
          claims: [{
            id: 'Q1',
            text: '帧 1435508 耗时 45.6ms。',
            references: [{
              source_ref: '表 1',
              row_index: 0,
              column: 'dur_ms',
              value: 45.6,
            }],
          }],
        },
        confidence: 0.8,
        rounds: 1,
        totalDurationMs: 1000,
      },
    });

    expect(html).toContain('模型标签: <code>表 1</code>');
    expect(html).toContain('报告来源: 数据表 1 · Frame duration table');
    expect(html).toContain('已找到来源表');
    expect(html).not.toContain('缺少机器 ID');
  });

  test('renders text DataEnvelope diagnostics instead of an empty table', () => {
    const generator = new HTMLReportGenerator();
    const diagnosticEnvelope: DataEnvelope = {
      meta: {
        type: 'diagnostic',
        version: '2.0.0',
        source: 'execute_sql',
        timestamp: Date.now(),
        evidenceRefId: 'data:sql_diagnostic:current:trace-hash:query-hash:tool-hash',
        sourceToolCallId: 'execute_sql:1:params_hash',
        planPhaseAttribution: 'inferred',
      },
      display: {
        layer: 'diagnosis',
        format: 'text',
        title: 'SQL execution diagnostic',
      },
      data: {
        text: 'SQL execution did not produce a table: bad sql',
      } as any,
    };

    const html = generator.generateAgentDrivenHTML({
      traceId: 'trace-5',
      query: '分析失败 SQL',
      timestamp: Date.now(),
      hypotheses: [],
      dialogue: [],
      agentResponses: [],
      dataEnvelopes: [diagnosticEnvelope],
      result: {
        sessionId: 'session-5',
        success: true,
        findings: [],
        hypotheses: [],
        conclusion: 'ok',
        confidence: 0.8,
        rounds: 1,
        totalDurationMs: 1000,
      },
    });

    expect(html).toContain('SQL execution diagnostic');
    expect(html).toContain('SQL execution did not produce a table: bad sql');
    expect(html).toContain('阶段归因: inferred');
    expect(html).not.toContain('无数据');
  });

  test('renders mermaid diagrams with stronger visual defaults for causal chains', () => {
    const generator = new HTMLReportGenerator();
    const html = generator.generateAgentDrivenHTML({
      traceId: 'trace-3',
      query: '分析因果链',
      timestamp: Date.now(),
      hypotheses: [],
      dialogue: [],
      agentResponses: [],
      dataEnvelopes: [],
      result: {
        sessionId: 'session-3',
        success: true,
        findings: [],
        hypotheses: [],
        conclusion: [
          '### 根因分析：因果链',
          '```mermaid',
          'graph TB',
          'A[输入] --> B[处理]',
          'B --> C[结果]',
          '```',
        ].join('\n'),
        confidence: 0.85,
        rounds: 1,
        totalDurationMs: 500,
      },
    });

    expect(html).toContain('class="mermaid-wrapper"');
    expect(html).toContain('function parseMermaidFlowSource(source)');
    expect(html).toContain("className = 'causal-map'");
    expect(html).toContain("textContent = '因果链流程图'");
    expect(html).toContain("textContent = '查看原始 Mermaid 图'");
    expect(html).toContain("querySelector: 'pre.mermaid[data-render-mode=\"mermaid\"]'");
  });

  test('renders agent-driven report shell in English when configured', () => {
    process.env.SMARTPERFETTO_OUTPUT_LANGUAGE = 'en';
    const generator = new HTMLReportGenerator();
    const html = generator.generateAgentDrivenHTML({
      traceId: 'trace-en',
      query: 'Why is startup slow?',
      timestamp: Date.now(),
      hypotheses: [],
      dialogue: [],
      conversationTimeline: [{
        eventId: 'evt-en-1',
        ordinal: 1,
        phase: 'progress',
        role: 'system',
        text: 'Starting analysis',
        timestamp: Date.now(),
      }],
      agentResponses: [],
      dataEnvelopes: [],
      result: {
        sessionId: 'session-en',
        success: true,
        findings: [],
        hypotheses: [],
        conclusion: [
          '### Causal chain',
          '```mermaid',
          'graph TB',
          'A[Input] --> B[Processing]',
          'B --> C[Result]',
          '```',
        ].join('\n'),
        confidence: 0.85,
        rounds: 1,
        totalDurationMs: 500,
      },
    });

    expect(html).toContain('<html lang="en">');
    expect(html).toContain('SmartPerfetto Agent-Driven Analysis Report');
    expect(html).toContain('Execution Overview');
    expect(html).toContain('User Question');
    expect(html).toContain('Conversation Timeline');
    expect(html).toContain('Analysis Conclusion');
    expect(html).toContain('Causal Chain Flow');
    expect(html).toContain('View original Mermaid diagram');
    expect(html).not.toContain('SmartPerfetto Agent-Driven 分析报告');
    expect(html).not.toContain('用户问题');
    expect(html).not.toContain('对话时间线');
    expect(html).not.toContain('查看原始 Mermaid 图');
  });
});

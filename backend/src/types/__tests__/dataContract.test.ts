// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, it, expect} from '@jest/globals';
import {
  buildColumnDefinitions,
  createDataEnvelope,
  displayResultToEnvelope,
  inferColumnDefinition,
  validateDataEnvelope,
} from '../dataContract';

describe('dataContract column inference', () => {
  it('infers start timestamp columns as range-navigable', () => {
    const start = inferColumnDefinition('start_ts');

    expect(start.type).toBe('timestamp');
    expect(start.clickAction).toBe('navigate_range');
    expect(start.durationColumn).toBe('dur_str');
    expect(start.unit).toBe('ns');
  });

  it('infers end timestamp columns as point-navigable', () => {
    const end = inferColumnDefinition('end_ts');

    expect(end.type).toBe('timestamp');
    expect(end.clickAction).toBe('navigate_timeline');
    expect(end.durationColumn).toBeUndefined();
    expect(end.unit).toBe('ns');
  });

  it('infers explicit duration suffix units correctly', () => {
    const durMs = inferColumnDefinition('dur_ms');
    const durUs = inferColumnDefinition('dur_us');
    const durNs = inferColumnDefinition('dur_ns');

    expect(durMs.type).toBe('duration');
    expect(durMs.format).toBe('duration_ms');
    expect(durMs.unit).toBe('ms');

    expect(durUs.type).toBe('duration');
    expect(durUs.format).toBe('duration_ms');
    expect(durUs.unit).toBe('us');

    expect(durNs.type).toBe('duration');
    expect(durNs.format).toBe('duration_ms');
    expect(durNs.unit).toBe('ns');
  });

  it('does not misclassify refresh_rate as percentage', () => {
    const refreshRate = inferColumnDefinition('refresh_rate');

    expect(refreshRate.type).not.toBe('percentage');
  });

  it('normalizes invalid display values when creating envelopes', () => {
    const env = createDataEnvelope(
      {columns: ['value'], rows: [[1]]},
      {
        type: 'skill_result',
        source: 'test:rows',
        title: 'Rows',
        layer: 'duration' as any,
        format: 'detail' as any,
        level: 'list' as any,
      },
    );

    expect(env.display.layer).toBe('list');
    expect(env.display.format).toBe('table');
    expect(env.display.level).toBe('detail');
    expect(validateDataEnvelope(env)).toEqual([]);
  });

  it('keeps stable evidence and trace metadata on created envelopes', () => {
    const env = createDataEnvelope(
      {columns: ['value'], rows: [[1]]},
      {
        type: 'sql_result',
        source: 'execute_sql',
        title: 'Rows',
        evidenceRefId: 'data:sql:current:trace_hash:query_hash',
        traceSide: 'current',
        traceId: 'trace-a',
        queryHash: 'query_hash',
        sourceToolCallId: 'execute_sql:1:params_hash',
        paramsHash: 'params_hash',
        planPhaseId: 'phase-1',
        planPhaseTitle: 'Collect evidence',
        planPhaseGoal: 'Query frame stats',
        planPhaseAttribution: 'active',
        planPhaseWarning: 'phase matched',
        toolNarration: '执行 SQL：查询帧数据',
        producerReason: '验证本阶段帧耗时数据',
        intent: 'ad_hoc_sql_verification',
      },
    );

    expect(env.meta).toEqual(expect.objectContaining({
      evidenceRefId: 'data:sql:current:trace_hash:query_hash',
      traceSide: 'current',
      traceId: 'trace-a',
      queryHash: 'query_hash',
      sourceToolCallId: 'execute_sql:1:params_hash',
      paramsHash: 'params_hash',
      planPhaseId: 'phase-1',
      planPhaseTitle: 'Collect evidence',
      planPhaseGoal: 'Query frame stats',
      planPhaseAttribution: 'active',
      planPhaseWarning: 'phase matched',
      toolNarration: '执行 SQL：查询帧数据',
      producerReason: '验证本阶段帧耗时数据',
      intent: 'ad_hoc_sql_verification',
    }));
    expect(validateDataEnvelope(env)).toEqual([]);
  });

  it('sanitizes invalid explicit column definitions before DataEnvelope output', () => {
    const columns = buildColumnDefinitions(['ts', 'value'], [
      {
        name: 'ts',
        type: 'bad_type' as any,
        format: 'bad_format' as any,
        clickAction: 'bad_action' as any,
        unit: 'frames' as any,
        width: 'giant' as any,
      },
      {
        name: 'value',
        type: 'number',
        width: 'narrow',
      },
    ]);

    expect(columns[0]).toMatchObject({
      name: 'ts',
      type: 'timestamp',
      format: 'timestamp_relative',
      clickAction: 'navigate_range',
      unit: 'ns',
    });
    expect((columns[0] as any).width).toBeUndefined();
    expect(columns[1]).toMatchObject({
      name: 'value',
      type: 'number',
      width: 'narrow',
    });
  });

  it('keeps DisplayResult to DataEnvelope conversion valid even with invalid display metadata', () => {
    const env = displayResultToEnvelope({
      stepId: 'rows',
      title: 'Rows',
      layer: 'bytes' as any,
      level: 'overview' as any,
      format: 'detail' as any,
      data: {columns: ['ts'], rows: [[123]]},
      columnDefinitions: [
        {
          name: 'ts',
          type: 'bad_type',
          format: 'bad_format',
          clickAction: 'bad_action',
        },
      ],
      metadataConfig: {fields: ['process_name', 123]},
    } as any, 'test_skill', undefined);

    expect(env.display.layer).toBe('list');
    expect(env.display.format).toBe('table');
    expect(env.display.level).toBe('detail');
    expect(env.display.metadataFields).toEqual(['process_name']);
    expect(validateDataEnvelope(env)).toEqual([]);
  });

  it('rejects malformed display columns and metadata fields during validation', () => {
    const env = createDataEnvelope(
      {columns: ['value'], rows: [[1]]},
      {
        type: 'skill_result',
        source: 'test:rows',
        title: 'Rows',
      },
    );

    (env.display as any).columns = {name: 'value'};
    (env.display as any).metadataFields = ['process_name', 42];

    const errors = validateDataEnvelope(env);
    expect(errors.map(error => error.path)).toEqual(
      expect.arrayContaining(['display.columns', 'display.metadataFields[1]']),
    );
  });
});

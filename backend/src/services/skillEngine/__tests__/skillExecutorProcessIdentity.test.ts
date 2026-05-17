// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { SkillExecutor } from '../skillExecutor';
import type { SkillDefinition } from '../types';

const resolverSkill: SkillDefinition = {
  name: 'process_identity_resolver',
  version: '1.0',
  type: 'atomic',
  meta: { display_name: 'Resolver', description: 'Resolver' },
  identity: { policy: 'exempt', scope: 'process' },
  inputs: [
    { name: 'package', type: 'string', required: false },
    { name: 'process_name', type: 'string', required: false },
    { name: 'max_rows', type: 'integer', required: false },
  ],
  sql: 'SELECT 1 AS resolver_probe',
};

const targetSkill: SkillDefinition = {
  name: 'target_process_skill',
  version: '1.0',
  type: 'atomic',
  meta: { display_name: 'Target', description: 'Target' },
  identity: {
    policy: 'required',
    scope: 'process',
    aliases: ['process_name', 'package'],
    rewriteTo: 'recommended_process_name_param',
  },
  inputs: [
    { name: 'process_name', type: 'string', required: true },
  ],
  sql: "SELECT '${process_name}' AS process_name",
};

const packageTargetSkill: SkillDefinition = {
  name: 'target_package_skill',
  version: '1.0',
  type: 'atomic',
  meta: { display_name: 'Target Package', description: 'Target Package' },
  identity: {
    policy: 'required',
    scope: 'process',
    aliases: ['process_name', 'package'],
    rewriteTo: 'recommended_process_name_param',
  },
  inputs: [
    { name: 'package', type: 'string', required: true },
  ],
  sql: "SELECT '${package}' AS package_name, '${process_name}' AS leaked_process_name",
};

function createExecutor(query: jest.Mock): SkillExecutor {
  const executor = new SkillExecutor({ query });
  executor.registerSkills([resolverSkill, targetSkill, packageTargetSkill]);
  return executor;
}

describe('SkillExecutor process identity gate', () => {
  it('runs resolver and rewrites process_name before executing required process skills', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({
        columns: ['rank', 'confidence_score', 'identity_status', 'canonical_package_name', 'recommended_process_name_param', 'upid', 'target_match_sources', 'supporting_sources', 'identity_warning'],
        rows: [[1, 90, 'confirmed', 'com.example', 'com.real.process', 42, 'android_process_metadata.package_name', 'frame_timeline.upid', 'ok']],
        durationMs: 1,
      })
      .mockResolvedValueOnce({
        columns: ['process_name'],
        rows: [['com.real.process']],
        durationMs: 1,
      });

    const result = await createExecutor(query).execute('target_process_skill', 'trace', {
      process_name: 'com.example',
    });

    expect(result.success).toBe(true);
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1][1]).toContain("SELECT 'com.real.process' AS process_name");
  });

  it('does not leak undeclared process aliases into skill parameter validation', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({
        columns: ['rank', 'confidence_score', 'identity_status', 'canonical_package_name', 'recommended_process_name_param', 'upid', 'target_match_sources', 'supporting_sources', 'identity_warning'],
        rows: [[1, 90, 'confirmed', 'com.example', 'com.real.process', 42, 'android_process_metadata.package_name', 'frame_timeline.upid', 'ok']],
        durationMs: 1,
      })
      .mockResolvedValueOnce({
        columns: ['package_name', 'leaked_process_name'],
        rows: [['com.real.process', '']],
        durationMs: 1,
      });

    const result = await createExecutor(query).execute('target_package_skill', 'trace', {
      process_name: 'com.example',
    });

    expect(result.success).toBe(true);
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1][1]).toContain("SELECT 'com.real.process' AS package_name, '' AS leaked_process_name");
  });

  it('blocks required process skills when resolver returns only weak identity evidence', async () => {
    const query = jest.fn().mockResolvedValueOnce({
      columns: ['rank', 'confidence_score', 'identity_status', 'canonical_package_name', 'recommended_process_name_param', 'upid', 'target_match_sources', 'supporting_sources', 'identity_warning'],
      rows: [[1, 20, 'weak_match', 'com.example', 'com.uncertain', 42, 'thread.name', '', 'shared UID']],
      durationMs: 1,
    });

    const result = await createExecutor(query).execute('target_process_skill', 'trace', {
      process_name: 'com.example',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('could not be verified');
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('blocks required process skills before querying when target is missing', async () => {
    const query = jest.fn();
    const result = await createExecutor(query).execute('target_process_skill', 'trace', {});

    expect(result.success).toBe(false);
    expect(result.error).toContain('no package/process/upid target');
    expect(query).not.toHaveBeenCalled();
  });

  it('does not cache transient resolver failures', async () => {
    const query = jest.fn()
      .mockRejectedValueOnce(new Error('trace processor warming up'))
      .mockResolvedValueOnce({
        columns: ['rank', 'confidence_score', 'identity_status', 'canonical_package_name', 'recommended_process_name_param', 'upid', 'target_match_sources', 'supporting_sources', 'identity_warning'],
        rows: [[1, 90, 'confirmed', 'com.example', 'com.real.process', 42, 'android_process_metadata.package_name', 'frame_timeline.upid', 'ok']],
        durationMs: 1,
      })
      .mockResolvedValueOnce({
        columns: ['process_name'],
        rows: [['com.real.process']],
        durationMs: 1,
      });

    const executor = createExecutor(query);
    const first = await executor.execute('target_process_skill', 'trace', {
      process_name: 'com.example',
    });
    const second = await executor.execute('target_process_skill', 'trace', {
      process_name: 'com.example',
    });

    expect(first.success).toBe(false);
    expect(second.success).toBe(true);
    expect(query).toHaveBeenCalledTimes(3);
  });
});

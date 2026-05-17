// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import Database from 'better-sqlite3';
import {
  applyEnterpriseMinimalSchema,
  ENTERPRISE_CORE_SCHEMA_TABLES,
} from '../enterpriseSchema';

function tableNames(db: Database.Database): Set<string> {
  const rows = db.prepare<unknown[], { name: string }>(`
    SELECT name FROM sqlite_master WHERE type = 'table'
  `).all();
  return new Set(rows.map(row => row.name));
}

function columnNames(db: Database.Database, table: string): Set<string> {
  const rows = db.prepare<unknown[], { name: string }>(`PRAGMA table_info(${table})`).all();
  return new Set(rows.map(row => row.name));
}

function indexNames(db: Database.Database): Set<string> {
  const rows = db.prepare<unknown[], { name: string }>(`
    SELECT name FROM sqlite_master WHERE type = 'index'
  `).all();
  return new Set(rows.map(row => row.name));
}

function expectColumns(db: Database.Database, table: string, columns: string[]): void {
  expect([...columnNames(db, table)]).toEqual(expect.arrayContaining(columns));
}

function seedCoreGraph(db: Database.Database, now = Date.now()): void {
  db.prepare(`
    INSERT INTO organizations (id, name, status, plan, created_at, updated_at)
    VALUES ('tenant-a', 'Tenant A', 'active', 'enterprise', ?, ?)
  `).run(now, now);
  db.prepare(`
    INSERT INTO workspaces (id, tenant_id, name, created_at, updated_at)
    VALUES ('workspace-a', 'tenant-a', 'Workspace A', ?, ?)
  `).run(now, now);
  db.prepare(`
    INSERT INTO users (id, tenant_id, email, display_name, idp_subject, created_at, updated_at)
    VALUES ('user-a', 'tenant-a', 'a@example.test', 'User A', 'oidc|a', ?, ?)
  `).run(now, now);
  db.prepare(`
    INSERT INTO memberships (tenant_id, workspace_id, user_id, role, created_at)
    VALUES ('tenant-a', 'workspace-a', 'user-a', 'admin', ?)
  `).run(now);
  db.prepare(`
    INSERT INTO trace_assets
      (id, tenant_id, workspace_id, owner_user_id, local_path, sha256, size_bytes, status, created_at)
    VALUES
      ('trace-a', 'tenant-a', 'workspace-a', 'user-a', '/tmp/trace-a.pftrace', 'abc123', 1024, 'ready', ?)
  `).run(now);
  db.prepare(`
    INSERT INTO provider_snapshots
      (id, tenant_id, provider_id, snapshot_hash, runtime_kind, resolved_config_json, secret_version, created_at)
    VALUES
      ('provider-snapshot-a', 'tenant-a', 'provider-a', 'hash-a', 'openai-agents-sdk', '{"models":{}}', 'v1', ?)
  `).run(now);
  db.prepare(`
    INSERT INTO analysis_sessions
      (id, tenant_id, workspace_id, trace_id, created_by, provider_snapshot_id, visibility, status, created_at, updated_at)
    VALUES
      ('session-a', 'tenant-a', 'workspace-a', 'trace-a', 'user-a', 'provider-snapshot-a', 'private', 'running', ?, ?)
  `).run(now, now);
  db.prepare(`
    INSERT INTO analysis_runs
      (id, tenant_id, workspace_id, session_id, mode, status, question, started_at)
    VALUES
      ('run-a', 'tenant-a', 'workspace-a', 'session-a', 'full', 'running', 'analyze', ?)
  `).run(now);
}

describe('enterprise core schema', () => {
  let db: Database.Database | undefined;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  test('creates the §10.2 core enterprise tables and key columns', () => {
    applyEnterpriseMinimalSchema(db!);

    const tables = tableNames(db!);
    for (const table of ENTERPRISE_CORE_SCHEMA_TABLES) {
      expect(tables.has(table)).toBe(true);
    }
    expect(tables.has('enterprise_schema_migrations')).toBe(true);
    expect(tables.has('sso_sessions')).toBe(true);

    expectColumns(db!, 'organizations', [
      'id',
      'name',
      'status',
      'plan',
      'created_at',
      'updated_at',
    ]);
    expectColumns(db!, 'workspaces', [
      'id',
      'tenant_id',
      'name',
      'retention_policy',
      'quota_policy',
      'created_at',
      'updated_at',
    ]);
    expectColumns(db!, 'users', [
      'id',
      'tenant_id',
      'email',
      'display_name',
      'idp_subject',
      'created_at',
      'updated_at',
    ]);
    expectColumns(db!, 'memberships', [
      'tenant_id',
      'workspace_id',
      'user_id',
      'role',
      'created_at',
    ]);
    expectColumns(db!, 'api_keys', [
      'id',
      'tenant_id',
      'workspace_id',
      'owner_user_id',
      'key_hash',
      'scopes',
      'expires_at',
      'revoked_at',
    ]);
    expectColumns(db!, 'trace_assets', [
      'id',
      'tenant_id',
      'workspace_id',
      'owner_user_id',
      'local_path',
      'sha256',
      'size_bytes',
      'status',
      'metadata_json',
      'created_at',
      'expires_at',
    ]);
    expectColumns(db!, 'trace_processor_leases', [
      'id',
      'tenant_id',
      'workspace_id',
      'trace_id',
      'mode',
      'state',
      'rss_bytes',
      'heartbeat_at',
      'expires_at',
    ]);
    expectColumns(db!, 'trace_processor_holders', [
      'id',
      'lease_id',
      'holder_type',
      'holder_ref',
      'window_id',
      'heartbeat_at',
      'expires_at',
      'created_at',
      'metadata_json',
    ]);
    expectColumns(db!, 'analysis_sessions', [
      'id',
      'tenant_id',
      'workspace_id',
      'trace_id',
      'created_by',
      'provider_snapshot_id',
      'title',
      'visibility',
      'status',
      'created_at',
      'updated_at',
    ]);
    expectColumns(db!, 'analysis_runs', [
      'id',
      'tenant_id',
      'workspace_id',
      'session_id',
      'mode',
      'status',
      'question',
      'started_at',
      'completed_at',
      'heartbeat_at',
      'updated_at',
      'error_json',
    ]);
    expectColumns(db!, 'conversation_turns', [
      'id',
      'tenant_id',
      'workspace_id',
      'session_id',
      'run_id',
      'role',
      'content_json',
      'created_at',
    ]);
    expectColumns(db!, 'agent_events', [
      'id',
      'tenant_id',
      'workspace_id',
      'run_id',
      'cursor',
      'event_type',
      'payload_json',
      'created_at',
    ]);
    expectColumns(db!, 'analysis_result_snapshots', [
      'id',
      'tenant_id',
      'workspace_id',
      'trace_id',
      'session_id',
      'run_id',
      'report_id',
      'created_by',
      'visibility',
      'scene_type',
      'title',
      'user_query',
      'trace_label',
      'trace_metadata_json',
      'summary_json',
      'conclusion_contract_json',
      'status',
      'schema_version',
      'created_at',
      'expires_at',
    ]);
    expectColumns(db!, 'analysis_result_metrics', [
      'id',
      'snapshot_id',
      'metric_key',
      'metric_group',
      'label',
      'value_json',
      'numeric_value',
      'unit',
      'direction',
      'aggregation',
      'confidence',
      'missing_reason',
      'source_json',
    ]);
    expectColumns(db!, 'analysis_result_evidence_refs', [
      'id',
      'snapshot_id',
      'ref_type',
      'ref_json',
      'created_at',
    ]);
    expectColumns(db!, 'analysis_result_window_states', [
      'tenant_id',
      'workspace_id',
      'window_id',
      'user_id',
      'trace_id',
      'backend_trace_id',
      'active_session_id',
      'latest_snapshot_id',
      'trace_title',
      'scene_type',
      'metadata_json',
      'updated_at',
      'expires_at',
    ]);
    expectColumns(db!, 'multi_trace_comparison_runs', [
      'id',
      'tenant_id',
      'workspace_id',
      'created_by',
      'baseline_snapshot_id',
      'query',
      'status',
      'result_json',
      'report_id',
      'error',
      'schema_version',
      'created_at',
      'completed_at',
    ]);
    expectColumns(db!, 'multi_trace_comparison_inputs', [
      'comparison_id',
      'snapshot_id',
      'role',
      'ordinal',
    ]);
    expectColumns(db!, 'runtime_snapshots', [
      'id',
      'tenant_id',
      'workspace_id',
      'session_id',
      'run_id',
      'runtime_type',
      'snapshot_json',
      'created_at',
    ]);
    expectColumns(db!, 'provider_credentials', [
      'id',
      'tenant_id',
      'workspace_id',
      'owner_user_id',
      'scope',
      'name',
      'type',
      'models_json',
      'secret_ref',
      'policy_json',
      'created_at',
      'updated_at',
    ]);
    expectColumns(db!, 'provider_snapshots', [
      'id',
      'tenant_id',
      'provider_id',
      'snapshot_hash',
      'runtime_kind',
      'resolved_config_json',
      'secret_version',
      'created_at',
    ]);
    expectColumns(db!, 'report_artifacts', [
      'id',
      'tenant_id',
      'workspace_id',
      'session_id',
      'run_id',
      'local_path',
      'content_hash',
      'visibility',
      'created_by',
      'created_at',
      'expires_at',
    ]);
    expectColumns(db!, 'memory_entries', [
      'id',
      'tenant_id',
      'workspace_id',
      'scope',
      'source_run_id',
      'content_json',
      'embedding_ref',
      'created_at',
      'updated_at',
    ]);
    expectColumns(db!, 'skill_registry_entries', [
      'id',
      'tenant_id',
      'workspace_id',
      'scope',
      'version',
      'enabled',
      'source_path',
      'created_at',
      'updated_at',
    ]);
    expectColumns(db!, 'tenant_tombstones', [
      'tenant_id',
      'requested_by',
      'requested_at',
      'purge_after',
      'status',
      'proof_hash',
    ]);
    expectColumns(db!, 'audit_events', [
      'id',
      'tenant_id',
      'workspace_id',
      'actor_user_id',
      'action',
      'resource_type',
      'resource_id',
      'metadata_json',
      'created_at',
    ]);
  });

  test('creates owner-guard, replay, migration, audit, and tombstone indexes', () => {
    applyEnterpriseMinimalSchema(db!);

    const indexes = indexNames(db!);
    for (const index of [
      'idx_trace_assets_owner_guard',
      'idx_trace_assets_tenant_workspace_id_unique',
      'idx_trace_processor_leases_owner_guard',
      'idx_trace_processor_leases_trace',
      'idx_trace_processor_holders_lease',
      'idx_trace_processor_holders_expiry',
      'idx_analysis_sessions_owner_guard',
      'idx_analysis_sessions_tenant_workspace_id_unique',
      'idx_analysis_runs_status',
      'idx_analysis_runs_heartbeat',
      'idx_analysis_runs_tenant_workspace_id_unique',
      'idx_conversation_turns_session',
      'idx_conversation_turns_run',
      'idx_agent_events_replay',
      'idx_agent_events_owner_guard',
      'idx_analysis_result_snapshots_trace',
      'idx_analysis_result_snapshots_scene',
      'idx_analysis_result_snapshots_visibility',
      'idx_analysis_result_snapshots_owner_guard',
      'idx_analysis_result_snapshots_run',
      'idx_analysis_result_metrics_snapshot',
      'idx_analysis_result_metrics_key',
      'idx_analysis_result_evidence_refs_snapshot',
      'idx_analysis_result_window_states_workspace',
      'idx_analysis_result_window_states_trace',
      'idx_analysis_result_window_states_snapshot',
      'idx_multi_trace_comparison_runs_workspace',
      'idx_multi_trace_comparison_runs_status',
      'idx_multi_trace_comparison_inputs_snapshot',
      'idx_runtime_snapshots_session',
      'idx_runtime_snapshots_run',
      'idx_provider_credentials_scope',
      'idx_provider_credentials_owner',
      'idx_provider_snapshots_provider',
      'idx_report_artifacts_owner_guard',
      'idx_report_artifacts_session',
      'idx_memory_entries_scope',
      'idx_skill_registry_entries_scope',
      'idx_audit_events_tenant_time',
      'idx_audit_events_actor',
      'idx_tenant_tombstones_status',
      'idx_sso_sessions_user',
      'idx_sso_sessions_expiry',
      'idx_api_keys_scope',
      'idx_api_keys_owner',
      'idx_api_keys_expiry',
    ]) {
      expect(indexes.has(index)).toBe(true);
    }
  });

  test('is idempotent and records every applied schema version once', () => {
    applyEnterpriseMinimalSchema(db!);
    applyEnterpriseMinimalSchema(db!);

    const rows = db!.prepare<unknown[], { version: number }>(
      'SELECT version FROM enterprise_schema_migrations ORDER BY version',
    ).all();
    expect(rows).toEqual([
      { version: 1 },
      { version: 2 },
      { version: 3 },
      { version: 4 },
      { version: 5 },
      { version: 6 },
      { version: 7 },
      { version: 8 },
      { version: 9 },
      { version: 10 },
    ]);
  });

  test('enforces the full tenant workspace session run event chain', () => {
    applyEnterpriseMinimalSchema(db!);
    const now = Date.now();
    seedCoreGraph(db!, now);

    db!.prepare(`
      INSERT INTO trace_processor_leases
        (id, tenant_id, workspace_id, trace_id, mode, state, rss_bytes, heartbeat_at, expires_at)
      VALUES
        ('lease-a', 'tenant-a', 'workspace-a', 'trace-a', 'shared', 'active', 1234, ?, ?)
    `).run(now, now + 60_000);
    db!.prepare(`
      INSERT INTO trace_processor_holders
        (id, lease_id, holder_type, holder_ref, window_id, heartbeat_at, created_at)
      VALUES
        ('holder-a', 'lease-a', 'agent_run', 'run-a', 'window-a', ?, ?)
    `).run(now, now);
    db!.prepare(`
      INSERT INTO conversation_turns
        (id, tenant_id, workspace_id, session_id, run_id, role, content_json, created_at)
      VALUES
        ('turn-a', 'tenant-a', 'workspace-a', 'session-a', 'run-a', 'user', '{"text":"analyze"}', ?)
    `).run(now);
    db!.prepare(`
      INSERT INTO agent_events
        (id, tenant_id, workspace_id, run_id, cursor, event_type, payload_json, created_at)
      VALUES
        ('event-a-1', 'tenant-a', 'workspace-a', 'run-a', 1, 'progress', '{}', ?)
    `).run(now);
    db!.prepare(`
      INSERT INTO runtime_snapshots
        (id, tenant_id, workspace_id, session_id, run_id, runtime_type, snapshot_json, created_at)
      VALUES
        ('runtime-snapshot-a', 'tenant-a', 'workspace-a', 'session-a', 'run-a', 'claude-agent-sdk', '{}', ?)
    `).run(now);
    db!.prepare(`
      INSERT INTO provider_credentials
        (id, tenant_id, workspace_id, owner_user_id, scope, name, type, models_json, secret_ref, policy_json, created_at, updated_at)
      VALUES
        ('provider-credential-a', 'tenant-a', 'workspace-a', 'user-a', 'workspace', 'Provider A', 'openai', '[]', 'secret:v1', '{}', ?, ?)
    `).run(now, now);
    db!.prepare(`
      INSERT INTO report_artifacts
        (id, tenant_id, workspace_id, session_id, run_id, local_path, content_hash, visibility, created_by, created_at, expires_at)
      VALUES
        ('report-a', 'tenant-a', 'workspace-a', 'session-a', 'run-a', '/tmp/report-a.html', 'hash-report', 'private', 'user-a', ?, ?)
    `).run(now, now + 60_000);
    db!.prepare(`
      INSERT INTO memory_entries
        (id, tenant_id, workspace_id, scope, source_run_id, content_json, embedding_ref, created_at, updated_at)
      VALUES
        ('memory-a', 'tenant-a', 'workspace-a', 'workspace', 'run-a', '{}', 'embedding:a', ?, ?)
    `).run(now, now);
    db!.prepare(`
      INSERT INTO skill_registry_entries
        (id, tenant_id, workspace_id, scope, version, enabled, source_path, created_at, updated_at)
      VALUES
        ('skill-a', 'tenant-a', 'workspace-a', 'workspace', '1', 1, 'skills/custom.skill.yaml', ?, ?)
    `).run(now, now);
    db!.prepare(`
      INSERT INTO tenant_tombstones
        (tenant_id, requested_by, requested_at, purge_after, status, proof_hash)
      VALUES
        ('tenant-a', 'user-a', ?, ?, 'pending', 'proof-a')
    `).run(now, now + 7 * 24 * 60 * 60 * 1000);
    db!.prepare(`
      INSERT INTO audit_events
        (id, tenant_id, workspace_id, actor_user_id, action, resource_type, resource_id, metadata_json, created_at)
      VALUES
        ('audit-a', 'tenant-a', 'workspace-a', 'user-a', 'tenant.delete.requested', 'tenant', 'tenant-a', '{}', ?)
    `).run(now);

    expect(() => {
      db!.prepare(`
        INSERT INTO agent_events
          (id, tenant_id, workspace_id, run_id, cursor, event_type, payload_json, created_at)
        VALUES
          ('event-a-duplicate', 'tenant-a', 'workspace-a', 'run-a', 1, 'progress', '{}', ?)
      `).run(now);
    }).toThrow();
    expect(() => {
      db!.prepare(`
        INSERT INTO trace_processor_holders
          (id, lease_id, holder_type, holder_ref, created_at)
        VALUES
          ('holder-missing', 'missing-lease', 'agent_run', 'run-a', ?)
      `).run(now);
    }).toThrow();
    expect(() => {
      db!.prepare(`
        INSERT INTO runtime_snapshots
          (id, tenant_id, workspace_id, session_id, run_id, runtime_type, snapshot_json, created_at)
        VALUES
          ('runtime-snapshot-missing', 'tenant-a', 'workspace-a', 'session-a', 'missing-run', 'claude-agent-sdk', '{}', ?)
      `).run(now);
    }).toThrow();
  });

  test('rejects cross-tenant workspace and session/run references on new core tables', () => {
    applyEnterpriseMinimalSchema(db!);
    const now = Date.now();
    seedCoreGraph(db!, now);

    db!.prepare(`
      INSERT INTO organizations (id, name, status, plan, created_at, updated_at)
      VALUES ('tenant-b', 'Tenant B', 'active', 'enterprise', ?, ?)
    `).run(now, now);
    db!.prepare(`
      INSERT INTO workspaces (id, tenant_id, name, created_at, updated_at)
      VALUES ('workspace-b', 'tenant-b', 'Workspace B', ?, ?)
    `).run(now, now);

    expect(() => {
      db!.prepare(`
        INSERT INTO trace_processor_leases
          (id, tenant_id, workspace_id, trace_id, mode, state, heartbeat_at)
        VALUES
          ('lease-cross-workspace', 'tenant-a', 'workspace-b', 'trace-a', 'shared', 'active', ?)
      `).run(now);
    }).toThrow();
    expect(() => {
      db!.prepare(`
        INSERT INTO conversation_turns
          (id, tenant_id, workspace_id, session_id, run_id, role, content_json, created_at)
        VALUES
          ('turn-cross-session', 'tenant-b', 'workspace-b', 'session-a', 'run-a', 'user', '{}', ?)
      `).run(now);
    }).toThrow();
  });
});

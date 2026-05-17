// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Phase 2.1 of v2.1 — verify the strategy-frontmatter `plan_template:`
 * pipeline.
 *
 * `getScenePlanTemplate(scene)` is dual-read: it prefers a template
 * declared in the strategy's frontmatter and falls back to the legacy
 * hardcoded `SCENE_PLAN_TEMPLATES` map. Once every strategy migrates,
 * the legacy map can be removed; until then both shapes must coexist
 * without surprise.
 */

import { describe, it, expect } from '@jest/globals';
import { getScenePlanTemplate } from '../scenePlanTemplates';
import { getPlanTemplate, invalidateStrategyCache, getRegisteredScenes } from '../strategyLoader';

describe('plan_template frontmatter pipeline', () => {
  beforeAll(() => invalidateStrategyCache());

  it('loads scrolling plan_template from strategy.md frontmatter', () => {
    const tpl = getPlanTemplate('scrolling');
    expect(tpl).not.toBeNull();
    expect(tpl!.mandatoryAspects.length).toBeGreaterThan(0);
    // Frontmatter aspects carry stable ids, unlike legacy entries.
    for (const aspect of tpl!.mandatoryAspects) {
      expect(aspect.id.length).toBeGreaterThan(0);
      expect(aspect.matchKeywords.length).toBeGreaterThan(0);
      expect(aspect.suggestion.trim().length).toBeGreaterThan(0);
    }
  });

  it('returns null for scenes that have no frontmatter plan_template (e.g. general)', () => {
    expect(getPlanTemplate('general')).toBeNull();
    expect(getPlanTemplate('interaction')).toBeNull();
  });

  it('returns null for unknown scenes', () => {
    expect(getPlanTemplate('this-scene-does-not-exist')).toBeNull();
  });

  it('every migrated scene exposes ids that round-trip through getScenePlanTemplate()', () => {
    // Scenes that were migrated to frontmatter should expose `id` on every
    // aspect; scenes that still rely on the legacy map have `id` undefined.
    const migrated = [
      'scrolling', 'startup', 'anr', 'teaching', 'scroll_response',
      'pipeline', 'memory', 'game', 'overview', 'touch_tracking',
    ];
    for (const scene of migrated) {
      const tpl = getScenePlanTemplate(scene);
      expect(tpl).toBeDefined();
      expect(tpl!.mandatoryAspects.length).toBeGreaterThan(0);
      for (const aspect of tpl!.mandatoryAspects) {
        expect(aspect.id).toBeTruthy();
      }
    }
  });

  it('does not break for opt-out scenes when a plan is submitted against them', () => {
    expect(getScenePlanTemplate('general')).toBeUndefined();
    expect(getScenePlanTemplate('interaction')).toBeUndefined();
  });

  it('frontmatter-sourced templates contain the same matchKeywords as the legacy map (migration parity)', () => {
    // Spot-check scrolling: its frontmatter aspects must mention the same
    // critical keywords that the legacy map carried, otherwise the
    // hard-gate behaviour silently changed during migration.
    const scrollingTpl = getScenePlanTemplate('scrolling');
    expect(scrollingTpl).toBeDefined();
    const allKeywords = scrollingTpl!.mandatoryAspects.flatMap(a => a.matchKeywords.map(k => k.toLowerCase()));
    for (const required of ['frame', 'jank', 'scrolling_analysis', 'jank_frame_detail']) {
      expect(allKeywords).toContain(required);
    }
  });

  it('keeps Chrome scroll jank as a conditional hint, not a generic scrolling plan gate', () => {
    const scrollingTpl = getScenePlanTemplate('scrolling');
    expect(scrollingTpl).toBeDefined();
    const ids = scrollingTpl!.mandatoryAspects.map(a => a.id);
    expect(ids).not.toContain('chrome_scroll_jank');
  });

  it('every registered scene resolves through dual-read without throwing', () => {
    for (const def of getRegisteredScenes()) {
      // Either frontmatter, or legacy fallback, or undefined (opt-out) — all OK.
      expect(() => getScenePlanTemplate(def.scene)).not.toThrow();
    }
  });
});

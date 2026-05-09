import { describe, expect, it } from 'vitest';

import { buildRollbackSql } from './rollback-plan.js';

describe('buildRollbackSql', () => {
  it('emits executable SQL for executed migrations in reverse order', () => {
    const sql = buildRollbackSql([
      '001-init-skill-and-strategy.sql',
      '002-init-replenishment.sql',
      '007-seed-default-platform-strategy.sql',
      '010-init-mastra-workflow-suspend.sql',
    ]);

    expect(sql).toMatch(/-- rollback: 010-init-mastra-workflow-suspend\.sql/);
    expect(sql).toMatch(/DROP TABLE IF EXISTS mastra_workflow_suspend;/);
    expect(sql).toMatch(
      /DELETE FROM agent_merchant_strategy\s+WHERE merchant_id='__PLATFORM_DEFAULT__'\s+AND version='platform-default-v1\.0\.0';/,
    );
    expect(sql).toMatch(/DROP TABLE IF EXISTS replenishment_adjustment_log;/);
    expect(sql).toMatch(/DROP TABLE IF EXISTS replenishment_draft;/);
    expect(sql).toMatch(/DROP TABLE IF EXISTS agent_store_strategy;/);
    expect(sql).toMatch(/DROP TABLE IF EXISTS agent_merchant_strategy;/);
    expect(sql).toMatch(/DROP TABLE IF EXISTS agent_skill_def;/);
    expect(sql).toMatch(
      /DELETE FROM `_agent_migrations` WHERE name = '001-init-skill-and-strategy\.sql';/,
    );

    expect(sql.indexOf('-- rollback: 010-init-mastra-workflow-suspend.sql')).toBeLessThan(
      sql.indexOf('-- rollback: 007-seed-default-platform-strategy.sql'),
    );
    expect(sql.indexOf('-- rollback: 007-seed-default-platform-strategy.sql')).toBeLessThan(
      sql.indexOf('-- rollback: 002-init-replenishment.sql'),
    );
    expect(sql.indexOf('-- rollback: 002-init-replenishment.sql')).toBeLessThan(
      sql.indexOf('-- rollback: 001-init-skill-and-strategy.sql'),
    );
  });
});

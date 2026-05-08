import assert from 'node:assert/strict';
import test from 'node:test';

import { buildRollbackSql } from './rollback-plan.js';

void test('buildRollbackSql emits executable SQL for executed migrations in reverse order', () => {
  const sql = buildRollbackSql([
    '001-init-skill-and-strategy.sql',
    '002-init-replenishment.sql',
    '007-seed-default-platform-strategy.sql',
    '010-init-mastra-workflow-suspend.sql',
  ]);

  assert.match(sql, /-- rollback: 010-init-mastra-workflow-suspend\.sql/);
  assert.match(sql, /DROP TABLE IF EXISTS mastra_workflow_suspend;/);
  assert.match(
    sql,
    /DELETE FROM agent_merchant_strategy\s+WHERE merchant_id='__PLATFORM_DEFAULT__'\s+AND version='platform-default-v1\.0\.0';/,
  );
  assert.match(sql, /DROP TABLE IF EXISTS replenishment_adjustment_log;/);
  assert.match(sql, /DROP TABLE IF EXISTS replenishment_draft;/);
  assert.match(sql, /DROP TABLE IF EXISTS agent_store_strategy;/);
  assert.match(sql, /DROP TABLE IF EXISTS agent_merchant_strategy;/);
  assert.match(sql, /DROP TABLE IF EXISTS agent_skill_def;/);
  assert.match(
    sql,
    /DELETE FROM `_agent_migrations` WHERE name = '001-init-skill-and-strategy\.sql';/,
  );

  assert.ok(
    sql.indexOf('-- rollback: 010-init-mastra-workflow-suspend.sql') <
      sql.indexOf('-- rollback: 007-seed-default-platform-strategy.sql'),
  );
  assert.ok(
    sql.indexOf('-- rollback: 007-seed-default-platform-strategy.sql') <
      sql.indexOf('-- rollback: 002-init-replenishment.sql'),
  );
  assert.ok(
    sql.indexOf('-- rollback: 002-init-replenishment.sql') <
      sql.indexOf('-- rollback: 001-init-skill-and-strategy.sql'),
  );
});

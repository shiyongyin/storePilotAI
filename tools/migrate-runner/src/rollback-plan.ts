const META_TABLE = '_agent_migrations';

const ROLLBACK_SQL_BY_MIGRATION: Record<string, string[]> = {
  '001-init-skill-and-strategy.sql': [
    'DROP TABLE IF EXISTS agent_store_strategy;',
    'DROP TABLE IF EXISTS agent_merchant_strategy;',
    'DROP TABLE IF EXISTS agent_skill_def;',
  ],
  '002-init-replenishment.sql': [
    'DROP TABLE IF EXISTS replenishment_adjustment_log;',
    'DROP TABLE IF EXISTS replenishment_draft;',
  ],
  '003-init-agent-runlog.sql': [
    'DROP TABLE IF EXISTS agent_skill_run_log;',
    'DROP TABLE IF EXISTS agent_run_log;',
  ],
  '004-init-api-key.sql': ['DROP TABLE IF EXISTS agent_api_key;'],
  '005-init-strategy-invalidation.sql': ['DROP TABLE IF EXISTS strategy_invalidation;'],
  '006-init-agent-session.sql': ['DROP TABLE IF EXISTS agent_session;'],
  '007-seed-default-platform-strategy.sql': [
    "DELETE FROM agent_merchant_strategy\nWHERE merchant_id='__PLATFORM_DEFAULT__'\n  AND version='platform-default-v1.0.0';",
  ],
  '008-init-mastra-workflow-snapshot.sql': ['DROP TABLE IF EXISTS mastra_workflow_snapshot;'],
  '009-init-mastra-workflow-event.sql': ['DROP TABLE IF EXISTS mastra_workflow_event;'],
  '010-init-mastra-workflow-suspend.sql': ['DROP TABLE IF EXISTS mastra_workflow_suspend;'],
  '011-seed-agent-skill-def.sql': [
    "DELETE FROM agent_skill_def\nWHERE skill_code IN ('business_daily_report','business_monthly_report','replenishment_forecast','replenishment_adjustment','purchase_order_create')\n  AND version='1.0.0';",
  ],
};

function escapeSqlString(value: string): string {
  return value.replaceAll("'", "''");
}

export function buildRollbackSql(executedMigrationNames: readonly string[]): string {
  const blocks = [...executedMigrationNames].reverse().map((name) => {
    const statements = ROLLBACK_SQL_BY_MIGRATION[name] ?? [
      `-- No rollback SQL registered for ${name}; review manually before executing.`,
    ];
    return [
      `-- rollback: ${name}`,
      ...statements,
      `DELETE FROM \`${META_TABLE}\` WHERE name = '${escapeSqlString(name)}';`,
    ].join('\n');
  });

  return `${blocks.join('\n\n')}\n`;
}

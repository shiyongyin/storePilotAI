# 数据库迁移说明 — 切片 03(T-INFRA-03)

## 命令

```bash
# 在仓库根执行
pnpm migrate:up                      # 顺序执行 001..010(可重入)
pnpm migrate:down --dry-run          # 输出可审阅回滚 SQL,不真删
```

要求:
- Node 22.x LTS(>=22.13.0 <23) / pnpm ≥ 9.7
- MySQL 8.0.30+(切片 02 docker-compose `mysql` 服务,数据库名 `store_pilot`)
- `DATABASE_URL` env 已配(切片 01 envSchema)

## 13 张总表(10 Agent 侧 + 3 Mastra)

| # | 文件 | 表 | 关键字段 / 索引 |
|---|------|------|---------------|
| 001 | `001-init-skill-and-strategy.sql` | `agent_skill_def` | `skill_code+version` 唯一 |
| 001 | 同上 | `agent_merchant_strategy` | `merchant_id+version` 唯一;`__PLATFORM_DEFAULT__` 约定 |
| 001 | 同上 | `agent_store_strategy` | `merchant_id+store_id+version` 唯一 |
| 002 | `002-init-replenishment.sql` | `replenishment_draft` | `draft_id` PK / `idx_draft_session` / `idx_draft_tenant_recent` / `idx_draft_expires`;`status` 7 状态 |
| 002 | 同上 | `replenishment_adjustment_log` | `adjustment_id` 唯一 |
| 003 | `003-init-agent-runlog.sql` | `agent_run_log` | `idx_runlog_trace` / `idx_runlog_tenant_time` |
| 003 | 同上 | `agent_skill_run_log` | `idx_skillrun_trace` / `idx_skillrun_skill_time` |
| 004 | `004-init-api-key.sql` | `agent_api_key` | `idx_api_key_prefix_status`(切片 09 P95 < 200ms) |
| 005 | `005-init-strategy-invalidation.sql` | `strategy_invalidation` | scope (PLATFORM/MERCHANT/STORE) |
| 006 | `006-init-agent-session.sql` | `agent_session` | **5 HITL 字段**:`active_run_id` / `active_run_step` / `active_run_expires_at` / `resume_locked_at` / `active_draft_id`;`idx_active_run` |
| 007 | `007-seed-default-platform-strategy.sql` | (种子)| 平台默认策略 1 行(`__PLATFORM_DEFAULT__`)|
| 008 | `008-init-mastra-workflow-snapshot.sql` | `mastra_workflow_snapshot` | `(workflow_name, run_id)` PK |
| 009 | `009-init-mastra-workflow-event.sql` | `mastra_workflow_event` | `idx_event_run` / `idx_event_type_time` |
| 010 | `010-init-mastra-workflow-suspend.sql` | `mastra_workflow_suspend` | `idx_expires`(切片 16 cron 5 分钟扫描) |

合计 **13 表 + 1 行种子**；`_agent_migrations` 是迁移工具元数据表，不计入业务 / 编排总表。

## DraftStatus 7 状态(切片 04 SSOT)

```
DRAFT → WAIT_CONFIRM → CONFIRMED → SUBMITTED   (终态)
                                  → FAILED      (终态)
DRAFT / WAIT_CONFIRM         → EXPIRED         (终态)
DRAFT / WAIT_CONFIRM / CONFIRMED → CANCELLED   (终态)
```

终态:`SUBMITTED | EXPIRED | CANCELLED | FAILED` — DDL 不强约束流转,切片 13 `DraftManager.assertDraftTransitAllowed` 应用层守门。

## 共同约束

- 所有表 `ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
- 时间字段统一 `DATETIME(3)`(毫秒精度),默认 `CURRENT_TIMESTAMP(3)`,`updated_at` 加 `ON UPDATE CURRENT_TIMESTAMP(3)`
- JSON 字段用原生 `JSON` 类型;**禁止** SQL 内 `JSON_EXTRACT` 做业务判断(性能差,TS 层处理)
- 多次执行 `pnpm migrate:up` **必须可重入**(SQL `IF NOT EXISTS` + `ON DUPLICATE KEY` + umzug 元数据表)

## 元数据表

`_agent_migrations`(name PK, executed_at DATETIME(3))— 由 `tools/migrate-runner` 自动维护,记录已执行的 migration 文件名。

## 回滚口径

- **生产环境**:`tools/migrate-runner` 检测 `NODE_ENV=production` 时**禁止** `down`(只允许 `--dry-run`)
- **本地 / dev**:`down --dry-run` 输出按 010..001 反序排列的可审阅回滚 SQL，包含 `DROP TABLE IF EXISTS ...` / 默认策略种子删除 / `_agent_migrations` 元数据清理语句；命令本身不执行删除。

## V1 明确不建

- `requirement_inbox`(V2 自演化能力,V1 不做;切片 03 §7 MUST NOT §5)

## 引用

- 切片 03 任务卡:[`docs/tanks/03-infra-mysql-ddl.md`](../docs/tanks/03-infra-mysql-ddl.md)
- 切片 04 SSOT:[`packages/shared-contracts/src/`](../packages/shared-contracts/src/)

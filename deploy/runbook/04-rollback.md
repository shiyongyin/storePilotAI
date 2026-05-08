# Runbook 04 — 回滚 SOP（服务 / Skill / 策略 三类，切片 21 / T-OPS-02）

> 版本：V1（切片 21 落地）
> 适用范围：灰度阶段 / 上线后任意时点出现 P0 时的快速回滚。
> 关联任务卡：`docs/任务卡/I-运维.md` §T-OPS-02 §5 / §8.3 / §8.4 / §8.5。
> 关联切片：03（DDL）、11（StrategyEngine + invalidation）、20（部署）、21（灰度 / V2）。

## 0. 快速决策树

```text
观察到 P0 信号？
├── YES → 是哪一类？
│   ├── 服务故障（启动失败 / 5xx 飙升 / 数据库连接异常）       → §1 服务回滚
│   ├── Skill 故障（特定 Skill 误提单 / 重复提单 / 输出错误）    → §2 Skill 回滚
│   └── 策略故障（补货激增 / 安全策略错误 / 跨商家影响）         → §3 策略回滚
└── NO  → 继续观察（不要乱滚）
```

> **MUST DO（任务卡 §7 MUST DO §2）**：误提单 / 重复提单 / MCP 不可用 = P0；
> 出现即立即回滚，不等观察期结束。
> **MUST NOT（任务卡 §7 MUST NOT §3 / §5）**：
> - 不得直接 UPDATE 覆盖 `agent_merchant_strategy.strategy_json` 历史；
> - 不得对已创建的真实采购单做"程序化撤销"（只能走 ERP 审批撤销）。

## 1. 服务回滚（K8s rollout undo / Compose 回滚镜像）

### 1.1 触发条件

- 新版本启动六行绿灯缺失（参考 `01-startup-six-greens.md`）
- `/health/ready` 持续 503 ≥ 3 分钟
- 5xx 错误率 > 5 %（运维手册 §7 P0）
- `tool_calls` 泄漏 / 跨租户访问被监控捕获

### 1.2 K8s 回滚（首选）

```bash
# 1) 立即回滚到上一稳定版本
kubectl rollout undo deploy/agent-service -n storepilot

# 2) 等 rollout 完成（terminationGracePeriodSeconds=35 已生效，给 SSE 25s + 10s 保险）
kubectl rollout status deploy/agent-service -n storepilot --timeout=120s

# 3) 验证启动六行绿灯（runbook 01）
kubectl logs -n storepilot deploy/agent-service --tail=20 \
  | grep -E "env-ok|db-ok|mastra-storage-ok|mcp-tools-verified|skill-def-verified|listening :"

# 4) 验证健康检查
curl -s https://agent.example.com/health/ready
# 期望：{"status":"UP", "db":..., "mcp":...}

# 5) 通报：5 分钟内回到 v1（任务卡 §10 测试场景 2 SLA）
```

### 1.3 Docker Compose 回滚

```bash
docker compose pull agent-service:vX.Y.Z-prev
docker compose up -d agent-service
docker logs storepilot-agent-service --tail=20 \
  | grep -E "env-ok|db-ok|mastra-storage-ok|mcp-tools-verified|skill-def-verified|listening :"
```

### 1.4 回滚 SLA

- 决策 → undo 命令：≤ 1 分钟
- undo → 旧版本可用：≤ 5 分钟（K8s rollout SLA）
- 期间在途 SSE：25s 内自然完成（切片 20 优雅停机）

## 2. Skill 回滚（agent_skill_def.status 切换）

### 2.1 触发条件

- 单个 Skill 输出错误（如 `replenishment_forecast` 数字偏离）
- 单个 Skill 出现 NUMBER_INCONSISTENT / SCHEMA_FAIL 持续 ≥ 5 分钟
- 写路径 Skill `purchase_order_create` 出现误提单 / 重复提单

### 2.2 行动 — disable 整条 Skill

```sql
-- 立即停用某个 Skill（dispatcher 在白名单 gate 中 throw SKILL_NOT_AVAILABLE）
UPDATE agent_skill_def
SET    status = 'disabled',
       updated_at = CURRENT_TIMESTAMP(3)
WHERE  skill_code = 'replenishment_forecast'
  AND  status IN ('enabled','gray');
```

> **生效时机**：dispatcher 每次入站请求都从内存 SkillRegistry 读取最新 status；
> 切片 21 实现的 `loadSkillRegistryFromDb` 在每次启动时刷新，运行期通过
> `strategy_invalidation` + cron 推动重新加载（V1 不要求实时；如需 < 30s 生效，
> 可对 agent-service 触发 `kubectl rollout restart`）。

### 2.3 行动 — 灰度收回（切回 enabled → gray）

```sql
-- 将一个 Skill 从全量收回到灰度（仅 GRAY_MERCHANT_WHITELIST 内商家可用）
UPDATE agent_skill_def
SET    status = 'gray',
       updated_at = CURRENT_TIMESTAMP(3)
WHERE  skill_code = 'purchase_order_create'
  AND  status = 'enabled';
```

### 2.4 行动 — Skill active_version 回退（切回上一 version）

> 当前 V1 schema (`agent_skill_def.version` UNIQUE 与 `skill_code` 联合) 仅支持
> 单 row 一个 active version；多 version 共存的 `active_version` 抽象由 V2 演进，
> 本卡按 V1 schema 给出可执行 SQL：

```sql
-- 在已存在的多行 (skill_code, version) 中切回上一 version：
--  - 把当前 active 行 disable
--  - 重新 INSERT 旧 version 行 status='enabled'（或保留旧行 → 直接置 enabled）
START TRANSACTION;
UPDATE agent_skill_def
SET    status = 'disabled', updated_at = CURRENT_TIMESTAMP(3)
WHERE  skill_code = 'replenishment_forecast' AND version = '1.1.0';

UPDATE agent_skill_def
SET    status = 'enabled',  updated_at = CURRENT_TIMESTAMP(3)
WHERE  skill_code = 'replenishment_forecast' AND version = '1.0.0';
COMMIT;
```

### 2.5 验收

- 客户提问触发该 Skill → 返回 friendlyMessage "该 Skill 暂不可用 / 该功能暂不可用"
- `agent_runlog` / OTel：`SKILL_NOT_AVAILABLE` 计数上升、对应 workflow 不再触发

## 3. 策略回滚（agent_merchant_strategy 版本切换 + invalidation）

> **核心约束（任务卡 §7 MUST DO §5 / MUST NOT §3）**：
> - 必须**新增版本**或保留旧版本行；
> - 必须把当前生效版本的 `status` 置为 `'disabled'`（语义等价 DEPRECATED）；
> - **不得**直接 UPDATE 覆盖 `agent_merchant_strategy.strategy_json` 字段；
> - 必须 INSERT 一条 `strategy_invalidation` 触发 LRU 失效广播。

### 3.1 触发条件

- 新策略导致补货量异常激增 / 缩减
- 新策略 `requireUserConfirmForWrite=false` 等安全开关被误关
- 新策略阻塞业务（如 `enabledSkills` 误删导致客户能力消失）

### 3.2 行动 — 商家级策略回滚

```sql
-- 假设：商家 M001 当前 active 版本为 'merchant-M001-v3'，要切回 'merchant-M001-v2'
START TRANSACTION;

-- 1) 旧版本（v2）置 enabled
UPDATE agent_merchant_strategy
SET    status = 'enabled', updated_at = CURRENT_TIMESTAMP(3)
WHERE  merchant_id = 'M001' AND version = 'merchant-M001-v2';

-- 2) 新版本（v3）置 disabled（语义 DEPRECATED；不删行 / 不覆盖 strategy_json）
UPDATE agent_merchant_strategy
SET    status = 'disabled', updated_at = CURRENT_TIMESTAMP(3)
WHERE  merchant_id = 'M001' AND version = 'merchant-M001-v3';

-- 3) 触发 invalidation 广播（切片 11 LRU 30s 内清理 M001 的所有缓存条目）
INSERT INTO strategy_invalidation (scope, merchant_id, store_id, reason, invalidated_at)
VALUES ('MERCHANT', 'M001', NULL, 'ROLLBACK_v3_TO_v2', CURRENT_TIMESTAMP(3));

COMMIT;
```

### 3.3 行动 — 平台默认策略回滚

```sql
-- 平台默认策略沿 merchant_id='__PLATFORM_DEFAULT__'；操作同 §3.2，但 scope=PLATFORM
START TRANSACTION;
UPDATE agent_merchant_strategy
SET    status = 'enabled', updated_at = CURRENT_TIMESTAMP(3)
WHERE  merchant_id = '__PLATFORM_DEFAULT__' AND version = 'platform-default-v1.0.0';
UPDATE agent_merchant_strategy
SET    status = 'disabled', updated_at = CURRENT_TIMESTAMP(3)
WHERE  merchant_id = '__PLATFORM_DEFAULT__' AND version <> 'platform-default-v1.0.0';
INSERT INTO strategy_invalidation (scope, merchant_id, store_id, reason, invalidated_at)
VALUES ('PLATFORM', NULL, NULL, 'ROLLBACK_PLATFORM_DEFAULT', CURRENT_TIMESTAMP(3));
COMMIT;
```

### 3.4 行动 — 门店级策略回滚

```sql
-- agent_store_strategy 同样按版本 + invalidation
START TRANSACTION;
UPDATE agent_store_strategy
SET    status = 'enabled', updated_at = CURRENT_TIMESTAMP(3)
WHERE  merchant_id = 'M001' AND store_id = 'S001' AND version = 'store-M001-S001-v2';
UPDATE agent_store_strategy
SET    status = 'disabled', updated_at = CURRENT_TIMESTAMP(3)
WHERE  merchant_id = 'M001' AND store_id = 'S001' AND version = 'store-M001-S001-v3';
INSERT INTO strategy_invalidation (scope, merchant_id, store_id, reason, invalidated_at)
VALUES ('STORE', 'M001', 'S001', 'ROLLBACK_STORE_v3_TO_v2', CURRENT_TIMESTAMP(3));
COMMIT;
```

### 3.5 验收

```bash
# 1) 旧版本 enabled / 新版本 disabled
mysql -e "
  SELECT version, status, updated_at FROM agent_merchant_strategy
  WHERE merchant_id='M001' ORDER BY id DESC LIMIT 5
"
# 期望：v2 status='enabled'；v3 status='disabled'

# 2) invalidation 行已写入（30s 内 LRU 应清理）
mysql -e "
  SELECT scope, merchant_id, store_id, reason, invalidated_at, consumed_at
  FROM strategy_invalidation
  WHERE merchant_id='M001' AND consumed_at IS NULL
  ORDER BY id DESC LIMIT 1
"

# 3) 业务感知：30s 后客户端再次请求，dispatcher 用 v2 策略响应（OTel span "strategy.version=v2"）
```

## 4. 已创建的真实采购单（绝对禁止程序化撤销）

任务卡 §7 MUST NOT §5 / runbook 05 §3：
- 已 SUBMITTED 到 ERP 的真实采购单**不得**通过 SQL UPDATE / DELETE 撤销；
- 必须由运营 / 财务在 ERP 审批工作流中撤销；
- agent-service 侧只能在 `replenishment_draft` 标记 `cancelled_at` 等审计字段，
  不能改 `submitted_po_no` / `submitted_at`（保留资金 / 库存追溯链）。

## 5. 联动通报

| 角色      | 通知动作                                       | 时限 |
| --------- | ---------------------------------------------- | ---- |
| oncall    | 触发 P0 → PagerDuty 5 分钟内呼通                | < 5 min |
| 业务方    | 误提单 / 客户感知问题 → 立刻通知商家联系人       | < 15 min |
| 客服      | 在客服平台发布"系统暂时不可用"统一话术           | < 15 min |
| ERP 团队  | 涉及真实采购单 / V2 切换 → 双向同步             | < 30 min |
| 老板 / GM | P0 持续 ≥ 30 分钟未恢复                          | 30 min |

## 6. 自检清单（回滚后必填）

- [ ] 启动六行绿灯齐全（`01-startup-six-greens.md`）
- [ ] `/health/ready` `200`（含 db + mcp）
- [ ] 误提单 / 重复提单计数 = 0（`SELECT COUNT(*) FROM agent_runlog WHERE event IN ('WRONG_PO','DUP_PO')`）
- [ ] 灰度白名单 (`GRAY_MERCHANT_WHITELIST`) 状态确认
- [ ] 策略回滚后 `strategy_invalidation` 行 30s 内被消费（`consumed_at IS NOT NULL`）
- [ ] PagerDuty 工单已 close 或转为已知问题
- [ ] 写一份事后复盘（POSTMORTEM 模板）

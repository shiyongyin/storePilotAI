# Runbook 06 — 新增客户 SOP（DBA SQL 三步 + 客户登录 + 监控，切片 21 / T-OPS-02）

> 版本：V1（切片 21 落地）
> 适用范围：在 V1 已上线的前提下接入一个新商家 / 新门店 / 新员工。
> 关联任务卡：`docs/任务卡/I-运维.md` §T-OPS-02 §5.7 / §7 MUST DO §6 / §8.7。
> 关联工具：`tools/seed-strategy/` CLI（V1 用，从 JSON 导入 `agent_merchant_strategy`）、
> `tools/api-key-issuer`（颁发 sk-agent-xxx）。

## 0. 核心红线（任务卡 §7 MUST DO §6 / §7 MUST NOT §4）

> **整个流程零应用部署**：不允许重启 agent-service、不允许新发版、不允许
> 改代码。所有动作都通过 DBA SQL + 客户侧登录完成。

> **SLA**：从运营在 ERP 后台开账户 → 客户首条 SSE 成功 < 30 分钟（任务卡 §10 §5）。

## 1. 新增客户的三类粒度

| 粒度 | 触发场景 | 步骤 |
| ---- | -------- | ---- |
| 新商家 | 新公司 / 新连锁品牌签约                       | §2 全 4 步 |
| 新门店 | 已签约商家增开门店                            | §3 仅 §3.1 + §3.4 |
| 新员工 | 已存在商家 / 门店增老板助理 / 经理            | §4 仅颁发 sk-agent-xxx + §3.4 |

## 2. 新商家完整流程（4 步）

### 2.1 步骤 1：运营 ERP 开账户

> **责任方**：运营。
> **产出**：`merchantId` / `storeId` 列表 / `userId`（老板的 ERP 账号）。

```text
- 在 ERP 后台为新商家建账户（含 1 个或多个门店）
- 记录：merchantId="M042", storeIds=["S042-01","S042-02"], userId="boss-042"
- 与 CS / 实施确认门店业态（便于挑 baseTemplateCode）
```

### 2.2 步骤 2：DBA SQL（agent_api_key + agent_merchant_strategy + 必要时 agent_store_strategy）

> **责任方**：DBA / 平台运维。
> **强约束（任务卡 §7 MUST DO §6 / MUST NOT §3）**：
> - 用 INSERT，**不**直接 UPDATE 任何已存在的策略（避免覆盖历史）。
> - 颁发 sk-agent-xxx 必须用 `tools/api-key-issuer`（argon2id + prefix 索引）—— 不
>   允许任何地方手写 hash。

#### 2.2.1 颁发 API Key（明文一次性给客户）

```bash
# 用工具脚本颁发（切片 09）；明文 sk-agent-xxx 立即给客户，不存任何地方。
pnpm issue:apikey -- \
  --merchantId M042 \
  --storeId    S042-01 \
  --userId     boss-042
# 输出形如：
#   [issue:apikey] OK
#     plaintext: sk-agent-XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
#     prefix:    sk-agent-XXXXX
#     hashedAt:  2026-05-08T01:00:00.000Z
#   ⚠️ 明文仅本次输出；请用安全通道发给客户后立刻销毁这段日志。
```

> 等价 SQL（仅当 `pnpm issue:apikey` 不可用时；通常**不**应该手写）：
>
> ```sql
> INSERT INTO agent_api_key (
>   api_key_hash, api_key_prefix, merchant_id, store_id, user_id, status, created_at
> ) VALUES (
>   '<argon2id-hash>', 'sk-agent-XXXXX', 'M042', 'S042-01', 'boss-042', 'ENABLED',
>   CURRENT_TIMESTAMP(3)
> );
> ```

#### 2.2.2 写商家策略（用 `tools/seed-strategy` CLI）

```bash
# 准备 strategy JSON（按业态从 baseTemplateCode 衍生；§5 模板）
cat > /tmp/strategy-M042.json <<'JSON'
{
  "merchantId": "M042",
  "version": "merchant-M042-v1.0.0",
  "status": "enabled",
  "strategyJson": {
    "baseTemplateCode": "convenience-store-default",
    "enabledSkills": [
      "business_daily_report",
      "business_monthly_report",
      "replenishment_forecast",
      "replenishment_adjustment",
      "purchase_order_create"
    ],
    "replenishmentPolicy": {
      "forecastDays": 7,
      "safetyStockDays": 2,
      "requireConfirmBeforePurchaseOrder": true,
      "allowAutoPurchaseOrder": false,
      "forecastMethod": "weighted_moving_average"
    },
    "reportPolicy": { "maxSummaryChars": 8000, "maxCards": 12 },
    "safetyPolicy": {
      "requireUserConfirmForWrite": true,
      "maxAdjustmentsPerDraft": 10,
      "majorAdjustmentRatio": 0.5,
      "draftAutoExpireMinutes": 30
    }
  }
}
JSON

DATABASE_URL=mysql://... \
pnpm --filter @storepilot/tools-seed-strategy run start -- --file /tmp/strategy-M042.json
# 期望：[seed-strategy] inserted merchant M042 version=merchant-M042-v1.0.0
```

> 等价 SQL（仅在 CLI 不可用时；不推荐）：
>
> ```sql
> INSERT INTO agent_merchant_strategy (merchant_id, strategy_json, version, status)
> VALUES ('M042', '<json>', 'merchant-M042-v1.0.0', 'enabled');
> ```

#### 2.2.3 必要时写门店策略

> 仅当客户对个别门店有特殊策略时才写；否则继承平台 / 商家层。

```bash
cat > /tmp/strategy-M042-S042-01.json <<'JSON'
{
  "merchantId": "M042",
  "storeId":    "S042-01",
  "version":    "store-M042-S042-01-v1.0.0",
  "status":     "enabled",
  "strategyJson": {
    "replenishmentPolicy": { "forecastDays": 5 }
  }
}
JSON

DATABASE_URL=mysql://... \
pnpm --filter @storepilot/tools-seed-strategy run start -- --file /tmp/strategy-M042-S042-01.json
```

### 2.3 步骤 3：通知客户登录 LobeChat

> **责任方**：实施 / CS。
> **动作**：把 `sk-agent-XXXXX` 通过安全通道（邮件链接 / IM 加密）给客户老板，
> 引导其在 LobeChat 客户端粘贴到"自定义模型 / API Key"配置中。

LobeChat 配置：

```text
模型服务商：OpenAI Compatible
API Key：    sk-agent-XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
API Base URL: https://agent.example.com/v1
模型：       store-agent-v1
```

### 2.4 步骤 4：监控首日（必跑 30 分钟内）

```bash
# 1) 客户首条请求落地后，用 traceId / apiKeyPrefix 查 agent_runlog
mysql -e "
  SELECT trace_id, intent, http_status, latency_ms, created_at
  FROM agent_runlog
  WHERE api_key_prefix = 'sk-agent-XXXXX'
  ORDER BY id DESC LIMIT 5
"

# 2) Grafana 看板：merchant=M042 在 5 分钟 / 1 小时窗口的请求成功率 / Token 用量
#    （运维手册 §5.1 业务侧维度）

# 3) 抽样客户首日报表 / 补货建议：内容是否与门店实情一致
```

### 2.5 验收

- [ ] 客户用 sk-agent-XXXXX 在 LobeChat 发送"今天 S042-01 卖得怎么样" → 收到完整日报
- [ ] `agent_runlog` 中能看到该 traceId / apiKeyPrefix 的成功调用
- [ ] 首日 24h：请求成功率 ≥ 99 %、误提单 = 0、补货生成成功率 ≥ 95 %
- [ ] 整流程**零应用部署**（无 deploy / no rollout）

## 3. 新门店流程（已存在商家追加门店）

### 3.1 步骤 1：DBA 写门店

```sql
-- 通常 ERP 已有 store_id；agent-service 侧只需要确认 merchant_id 已经在
-- agent_merchant_strategy 中存在。如果该商家有一个 enabled 行，门店默认继承。
SELECT version, status FROM agent_merchant_strategy
WHERE merchant_id = 'M042' AND status = 'enabled';
-- 期望：1 行（已在 §2.2.2 落地）
```

### 3.2 步骤 2：可选 — 写 agent_store_strategy（同 §2.2.3）

### 3.3 步骤 3：API Key（按需追加 / 复用）

- 老板已有 sk-agent-xxx 且 `agent_api_key.store_id IS NULL` → 自动覆盖该商家的所有门店
- 否则 §2.2.1 颁发新 sk-agent-xxx，绑定新 storeId

### 3.4 步骤 4：监控（同 §2.4）

## 4. 新员工流程

### 4.1 步骤 1：DBA 颁发 sk-agent-xxx（绑定 merchantId / storeId / 新 userId）

```bash
pnpm issue:apikey -- \
  --merchantId M042 \
  --storeId    S042-01 \
  --userId     manager-042-01
```

### 4.2 步骤 2：通知员工登录（同 §2.3）

### 4.3 步骤 3：监控（同 §2.4）

## 5. baseTemplateCode 模板速查（§2.2.2 用）

> 这些模板由实施 / 业务运维维护；本 runbook 仅列出 V1 内置 + 可能用到的取值。
> 真实模板内容由产品 / 实施给定，DBA 写入 `agent_merchant_strategy.strategy_json`
> 时**全文嵌入**，不引用 / 不外联。

| baseTemplateCode | 业态 | 适用 enabledSkills | 备注 |
| ---------------- | ---- | ------------------ | ---- |
| `convenience-store-default` | 便利店 | 5 项全部 | V1 默认 |
| `fresh-supermarket-default` | 生鲜 / 超市 | 5 项全部 | 7 天预测 + 较高 safety stock |
| `restaurant-default` | 餐饮 | 4 项（无 purchase_order_create） | 订货走线下流程，灰度评估后再开 |
| `pharmacy-default` | 药店 | 4 项（purchase_order_create gray） | 写路径全程 HITL；渐进开放 |

## 6. 自检清单

- [ ] 步骤 1（运营 ERP）已确认 merchantId / storeId / userId
- [ ] 步骤 2.1（API Key）已经用 `pnpm issue:apikey` 颁发；明文已通过安全通道交付客户
- [ ] 步骤 2.2（agent_merchant_strategy）已写入 `version='merchant-M042-vX.Y.Z'` `status='enabled'`
- [ ] 步骤 2.3（agent_store_strategy，若有）已写入 `status='enabled'`
- [ ] 客户已确认能在 LobeChat 收到首条响应
- [ ] 30 分钟内完成上述全部步骤（任务卡 §10 §5 SLA）
- [ ] **零应用部署**：本流程未触发任何 `kubectl rollout` / `docker compose up`

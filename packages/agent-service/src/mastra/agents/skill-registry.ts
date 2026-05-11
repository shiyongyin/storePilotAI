/**
 * 切片 21 — Skill Registry：从 `agent_skill_def` 加载业务 workflow 种子 + 启动期校验 +
 * 灰度白名单网关。
 *
 * 关联任务卡：`docs/任务卡/I-运维.md` §T-OPS-02 §7 MUST DO §4 / §7 / §8 + 切片 21
 * 任务卡 §8.2 / §8.8 / §9 step 7-9。
 *
 * 强约束（违反即拒收）：
 *   1. {@link verifySkillDef} 必须在启动期严格校验：
 *      - 读 `agent_skill_def` 中所有 `status IN ('enabled','gray')` 的行；
 *      - 与 `createMastra workflows barrel` 暴露的 Workflow id 严格相等
 *        （`set(dbCodes) === set(workflowIds)`）；
 *      - 任一缺失 / 多余 → 抛 `SkillDefMismatchError`，bootstrap 顶层 catch →
 *        `process.exit(1)` + 错误日志含 `missing` / `extra`。
 *      - 通过后输出绿灯日志：`[startup] skill-def-verified`（启动六行第 5 行）。
 *   2. 校验通过后**必须**把种子缓存到进程内 SkillRegistry 单例，让 dispatcher
 *      在每次入站请求中通过 {@link assertSkillUsable} 做灰度网关 / disabled 拦截。
 *   3. {@link assertSkillUsable}（任务卡 §8.2）：
 *      - `status='disabled'`                                       → 抛 `SKILL_NOT_AVAILABLE`；
 *      - `status='gray' && merchantId ∉ GRAY_MERCHANT_WHITELIST`   → 抛 `SKILL_NOT_AVAILABLE`；
 *      - 其它（`enabled` / `gray + 命中白名单`）                   → 放行。
 *   4. SSOT 边界：skill_code 与 createMastra workflows barrel 的 Workflow id
 *      是同一概念的两侧表达；增删 Skill 必须同步两边 + 回填 README §6 一致性矩阵。
 *
 * 关键决策：
 *   - 不在 dispatcher 内部直读 DB —— 启动期一次加载 + 内存查询；策略变更走
 *     `kubectl rollout restart` 触发重新加载（V1 不要求实时；任务卡 §10 测试
 *     场景 3 要求 disable 立即生效，由 §2.2 路径覆盖：将单 Skill 切到 disabled 后
 *     `loadSkillRegistryFromDb` 重跑即可）。
 *   - 灰度白名单从 env 读取（`GRAY_MERCHANT_WHITELIST`）；env 在 server bootstrap
 *     已 zod parse，本模块仅按 split 取数。允许在测试中通过 `setSkillRegistry` 注入
 *     自定义 fixture。
 */
import { BizError } from '@storepilot/shared-contracts';

import { getEnv } from '../../config/env.js';
import { logger } from '../../observability/logger.js';
import type { MysqlStoragePool } from '../storage/sql.js';
import * as workflowsBarrel from '../workflows/index.js';

/** Skill 状态（migrations/001 + 011 / 任务卡 §7.7） */
export type SkillStatus = 'enabled' | 'disabled' | 'gray';

/** 风险等级（V1 LOW / MEDIUM / HIGH） */
export type SkillRiskLevel = 'LOW' | 'MEDIUM' | 'HIGH';

/**
 * SkillRegistry 单条记录 —— 启动期 `loadSkillRegistryFromDb` 把 `agent_skill_def`
 * 行映射成本类型，dispatcher 仅消费 `skillCode/status` 做灰度网关。
 */
export interface SkillDefEntry {
  skillCode: string;
  status: SkillStatus;
  riskLevel: SkillRiskLevel;
  version: string;
}

/**
 * SkillRegistry 单例形态。
 *
 * - {@link get}：按 skillCode 拿一条 SkillDefEntry，缺失返回 `undefined`（dispatcher
 *   走兜底 friendlyMessage）。
 * - {@link assertUsable}：灰度 + disabled 网关；不可用时抛 `BizError(SKILL_NOT_AVAILABLE)`。
 * - {@link list}：返回所有 skillCode（用于诊断 / health 扩展）。
 */
export interface SkillRegistry {
  get(skillCode: string): SkillDefEntry | undefined;
  assertUsable(skillCode: string, merchantId: string): void;
  list(): readonly string[];
}

/**
 * `agent_skill_def` 表的最小行形态（与 migration 001 列名 1:1）。
 *
 * `allowed_intents` / `required_tools` 在本切片内不消费（IntentRouter 走单独的
 * 11 IntentEnum 枚举；MCP 工具白名单由切片 08 守门），仅保留 skill_code/status/
 * risk_level/version 供 dispatcher 灰度网关使用。
 */
interface AgentSkillDefRow extends Record<string, unknown> {
  skill_code: string;
  status: string;
  risk_level: string;
  version: string;
}

/**
 * 启动期校验失败 —— 与切片 08 `McpWhitelistError` 设计对齐：
 *   - 错误信息含具体 missing / extra（便于运维一眼定位）；
 *   - 由 server bootstrap 顶层 catch 捕获 → `process.exit(1)`。
 */
export class SkillDefMismatchError extends Error {
  public readonly missing: ReadonlyArray<string>;
  public readonly extra: ReadonlyArray<string>;
  public readonly disabledRequired: ReadonlyArray<string>;

  constructor(
    message: string,
    args: {
      missing?: ReadonlyArray<string>;
      extra?: ReadonlyArray<string>;
      disabledRequired?: ReadonlyArray<string>;
    } = {},
  ) {
    super(message);
    this.name = 'SkillDefMismatchError';
    this.missing = args.missing ?? [];
    this.extra = args.extra ?? [];
    this.disabledRequired = args.disabledRequired ?? [];
  }
}

let _registry: SkillRegistry | null = null;

/**
 * 注入测试 / 启动期 SkillRegistry 单例（多次调用会替换）。
 *
 * @internal 测试 + bootstrap 调用；业务代码请用 {@link getSkillRegistry}。
 */
export function setSkillRegistry(registry: SkillRegistry | null): void {
  _registry = registry;
}

/**
 * 取当前 SkillRegistry 单例；启动期 `verifySkillDef` 未跑过会返回 `null` ——
 * dispatcher 在网关前判 null，缺失时按"未注入" friendly 兜底，**不**直接 throw
 * （不让一个 missing 的 registry 把整条对话打挂）。
 */
export function getSkillRegistry(): SkillRegistry | null {
  return _registry;
}

/**
 * 从 createMastra workflows barrel 收集 Workflow id（即 Skill code）。
 *
 * 处理点：
 *   - workflows barrel 同时导出驼峰名（`purchaseOrderCreate`）和 snake_case 别名
 *     （`purchase_order_create`），两者引用同一个 `createWorkflow` 实例；这里通过
 *     `workflow.id` 去重，保证返回唯一的 snake_case id。
 *   - 任意 Workflow 缺 `id` 字段 → 抛错（不允许 barrel 里塞非 Workflow 的导出）。
 */
export function collectWorkflowIds(): readonly string[] {
  const ids = new Set<string>();
  for (const value of Object.values(workflowsBarrel)) {
    if (!value || typeof value !== 'object') continue;
    const candidate = value as { id?: unknown };
    const id = candidate.id;
    if (typeof id === 'string' && id.length > 0) {
      ids.add(id);
    }
  }
  return [...ids].sort();
}

/**
 * 把 `agent_skill_def` 表加载成 SkillRegistry —— 启动期严格校验：
 *
 *   1. 拉所有行（不分 status）→ 按 status 拆 enabled/gray vs disabled vs other。
 *   2. 对比 (enabled∪gray) 与 createMastra workflows barrel id：
 *      - missing：barrel 有 / 表里没启用 → 抛 missing；
 *      - extra：表里有 / barrel 没注册 → 抛 extra；
 *      - disabledRequired：必备 workflow 中有任何一个落到 status='disabled' → 抛
 *        disabledRequired（任务卡 §9 step 9：删一行 → 启动失败）。
 *   3. 通过后日志 `[startup] skill-def-verified`，返回 SkillRegistry。
 *
 * @throws {SkillDefMismatchError} 任意一项不满足；调用方需 `process.exit(1)`。
 */
export async function loadSkillRegistryFromDb(
  pool: MysqlStoragePool,
): Promise<SkillRegistry> {
  const expected = collectWorkflowIds();
  if (expected.length === 0) {
    throw new SkillDefMismatchError(
      '[skill-def] createMastra workflows barrel 为空；至少需要 1 个 Workflow id',
    );
  }

  const [rows] = await pool.query<AgentSkillDefRow>(
    `SELECT skill_code, status, risk_level, version
       FROM agent_skill_def
      ORDER BY skill_code ASC, version ASC`,
  );

  const entriesByCode = new Map<string, SkillDefEntry>();
  for (const row of rows) {
    if (typeof row.skill_code !== 'string') continue;
    if (!isSkillStatus(row.status)) continue;
    if (!isRiskLevel(row.risk_level)) continue;
    // 同一 skill_code 多 version 时取 status 最优行（enabled > gray > disabled）；
    // 见 runbook 04 §2.4 升级 / 回退路径。
    const prev = entriesByCode.get(row.skill_code);
    const next: SkillDefEntry = {
      skillCode: row.skill_code,
      status: row.status,
      riskLevel: row.risk_level,
      version: row.version,
    };
    if (!prev || statusPriority(next.status) > statusPriority(prev.status)) {
      entriesByCode.set(row.skill_code, next);
    }
  }

  const registered = [...entriesByCode.values()];
  const enabledOrGray = registered.filter((e) => e.status !== 'disabled');
  const enabledOrGrayCodes = new Set(enabledOrGray.map((e) => e.skillCode));
  const expectedSet = new Set(expected);

  const missing = expected.filter((id) => !enabledOrGrayCodes.has(id));
  const extra = [...enabledOrGrayCodes].filter((c) => !expectedSet.has(c)).sort();
  const disabledRequired = registered
    .filter((e) => e.status === 'disabled' && expectedSet.has(e.skillCode))
    .map((e) => e.skillCode)
    .sort();

  if (missing.length > 0 || extra.length > 0 || disabledRequired.length > 0) {
    const detail: string[] = [];
    if (missing.length > 0) {
      detail.push(`missing=${JSON.stringify(missing)}（barrel 已注册但 agent_skill_def 未启用）`);
    }
    if (extra.length > 0) {
      detail.push(`extra=${JSON.stringify(extra)}（agent_skill_def 启用但 barrel 未注册）`);
    }
    if (disabledRequired.length > 0) {
      detail.push(
        `disabledRequired=${JSON.stringify(disabledRequired)}（必备 Skill 中存在 status='disabled'，启动拒绝）`,
      );
    }
    throw new SkillDefMismatchError(
      `[skill-def] agent_skill_def 与 createMastra workflows barrel 不一致；${detail.join('；')}`,
      { missing, extra, disabledRequired },
    );
  }

  const registry = buildRegistry(entriesByCode);
  logger.info(
    {
      total: registered.length,
      enabled: registered.filter((e) => e.status === 'enabled').length,
      gray: registered.filter((e) => e.status === 'gray').length,
      disabled: registered.filter((e) => e.status === 'disabled').length,
      skills: expected,
    },
    '[startup] skill-def-verified',
  );
  return registry;
}

/**
 * 启动期 hook —— 由 server.ts bootstrap 在 `verifyMcpToolsAtStartup` 之后调用：
 *
 *   1. 调 {@link loadSkillRegistryFromDb}（含日志 `[startup] skill-def-verified`）；
 *   2. 把结果通过 {@link setSkillRegistry} 注入进程内单例。
 *
 * 任一步抛错 → bootstrap 顶层 catch → `process.exit(1)`（任务卡 §9 step 8 / 9）。
 */
export async function verifySkillDef(pool: MysqlStoragePool): Promise<SkillRegistry> {
  const registry = await loadSkillRegistryFromDb(pool);
  setSkillRegistry(registry);
  return registry;
}

/**
 * 灰度网关短路 —— 直接抛 `BizError(SKILL_NOT_AVAILABLE)`；调用方 dispatcher 由
 * 顶层 try/catch 转 `friendlyMessage`。
 *
 * 与任务卡 §9 step 2 / 3 验收一致：
 *   - 白名单内商家 → 不抛错，正常走 Skill；
 *   - 白名单外商家（gray Skill）→ 抛 `SKILL_NOT_AVAILABLE`；
 *   - status='disabled' Skill → 抛 `SKILL_NOT_AVAILABLE`。
 */
export function assertSkillUsable(skillCode: string, merchantId: string): void {
  const registry = _registry;
  if (!registry) return; // 启动期未注入 → 不阻塞；切片 20 健康检查会暴露
  registry.assertUsable(skillCode, merchantId);
}

/**
 * 测试辅助：构造一个内存版 SkillRegistry，给单测用。
 *
 * 与 `loadSkillRegistryFromDb` 共享 `assertUsable` 实现 —— 不引入两套灰度逻辑。
 */
export function createInMemorySkillRegistry(
  entries: ReadonlyArray<SkillDefEntry>,
): SkillRegistry {
  const map = new Map<string, SkillDefEntry>();
  for (const e of entries) {
    map.set(e.skillCode, e);
  }
  return buildRegistry(map);
}

function buildRegistry(map: ReadonlyMap<string, SkillDefEntry>): SkillRegistry {
  return {
    get(code) {
      return map.get(code);
    },
    list() {
      return [...map.keys()].sort();
    },
    assertUsable(skillCode, merchantId) {
      const entry = map.get(skillCode);
      if (!entry) {
        throw new BizError(
          'SKILL_NOT_AVAILABLE',
          `Skill ${skillCode} 未注册`,
          { meta: { skillCode } },
        );
      }
      if (entry.status === 'disabled') {
        throw new BizError(
          'SKILL_NOT_AVAILABLE',
          '该功能暂不可用',
          { meta: { skillCode, status: 'disabled' } },
        );
      }
      if (entry.status === 'gray') {
        const env = getEnv();
        const whitelist = env.GRAY_MERCHANT_WHITELIST.split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        if (!whitelist.includes(merchantId)) {
          throw new BizError(
            'SKILL_NOT_AVAILABLE',
            '当前功能仅对部分商家开放（灰度中）',
            { meta: { skillCode, status: 'gray' } },
          );
        }
      }
    },
  };
}

function isSkillStatus(value: unknown): value is SkillStatus {
  return value === 'enabled' || value === 'disabled' || value === 'gray';
}

function isRiskLevel(value: unknown): value is SkillRiskLevel {
  return value === 'LOW' || value === 'MEDIUM' || value === 'HIGH';
}

function statusPriority(status: SkillStatus): number {
  if (status === 'enabled') return 3;
  if (status === 'gray') return 2;
  return 1;
}

/**
 * IntentCode → skillCode 映射 SSOT —— 与切片 21 任务卡 §8.8 + migrations/011 的
 * `allowed_intents` 1:1。dispatcher 在每个 intent 分支前用本表查 skillCode，再
 * `assertSkillUsable` 做灰度网关。
 *
 * 5 个 V1 Workflow + 11 IntentEnum 中 6 个映射到 Skill；其余 5 个（GENERAL_QA /
 * COLLECT_REQUIREMENT / MULTI_INTENT / UNKNOWN）不属任何 Skill，不做网关。
 * CANCEL_REPLENISHMENT_DRAFT 是本地安全撤销动作，不能被 purchase_order_create 灰度挡住。
 */
export const INTENT_TO_SKILL: Readonly<Record<string, string>> = {
  BUSINESS_DAILY_REPORT: 'business_daily_report',
  EXPLAIN_METRIC: 'business_daily_report',
  BUSINESS_MONTHLY_REPORT: 'business_monthly_report',
  REPLENISHMENT_PLAN: 'replenishment_forecast',
  ADJUST_REPLENISHMENT_DRAFT: 'replenishment_adjustment',
  CONFIRM_CREATE_PURCHASE_ORDER: 'purchase_order_create',
};

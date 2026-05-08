/**
 * 切片 06 — createMastra() 工厂
 * 切片 07 — storage init 生命周期上移到 server.ts（见下方"!! 与切片 07 的协作 !!" ）
 *
 * 严格按 docs/任务卡/D-Mastra.md §T-MASTRA-01.5.1 + 切片 06 任务卡 §8.1 落地。
 *
 * 强约束（违反即拒收）:
 *   - 红线 1: @mastra/core / @mastra/mcp / @mastra/loggers 必须**同主版本** 1.0.x
 *     （已在 packages/agent-service/package.json 精确锁 1.0.0，无 ^）
 *   - 红线 3: **不传 memory**（V1 关闭 Mastra Memory；MySQL 是业务真相单源）
 *
 * !! API drift（mastra 1.0 vs 任务卡 0.x 文本）!!
 *   - ConsoleLogger → PinoLogger（@mastra/loggers 1.0 已迁移）
 *   - telemetry: {...}  → 1.0 用 observability 实例（@mastra/observability）
 *     本切片**不传** telemetry / observability，由 OTel SDK（observability/otel.ts）
 *     在 server.ts 顶部启动时全局接管 trace 透出，与任务卡 §8.5 traceId 5 层贯穿一致。
 *   - storage 类型 MastraStorage → MastraCompositeStore；本切片**不传 storage**，
 *     避免侵入 1.0 store 体系。切片 07 已落地完整 9 方法 adapter（mysql-adapter.ts），
 *     但仍**不**接到 Mastra 1.0 的 Composite store（API 形态不一致）；后续若有 workflow
 *     真正消费 Mastra storage，再单独写 CompositeStore 适配层。
 *
 * !! 与切片 07 的协作 !!
 *   - 切片 06 旧实现是「createMastra() 内 fire-and-forget storage.init()」，但 init() 是真正
 *     的表存在性校验，必须 fail-fast；fire-and-forget 会让缺表错误被吞。
 *   - 切片 07 把 storage init 上移到 server.ts bootstrap（line 3 mastra-storage-ok 紧前），
 *     await initImpl(...) 失败 → process.exit(1)。本工厂仅负责 Mastra 实例的纯组合，
 *     不再触发 DB 副作用（让单测 / dev:agent 在缺 DB 场景可控）。
 */
import { Mastra } from '@mastra/core';
import { PinoLogger } from '@mastra/loggers';

import { generalQa, intentRouter, requirementCollector } from './agents/index.js';
// workflows barrel：5 个 Workflow 由切片 12/14/15/17 各自加导出；本切片仅占位 export {}
import * as workflows from './workflows/index.js';

/**
 * 工厂方法 — 必须**幂等**（多次调用返回独立实例，不共享状态）。
 *
 * @returns 一个 Mastra 实例；`mastra.memory` **必须** 为 undefined（红线 3 验收）。
 */
export function createMastra() {
  return new Mastra({
    agents: { intentRouter, generalQa, requirementCollector },
    // workflows barrel 当前空（占位 export {}）；下游切片往 barrel 加导出后自动生效
    workflows: { ...workflows },
    logger: new PinoLogger({ name: 'agent-service', level: 'info' }),
    // 红线 3：不传 memory（任何形式）。1.0 的 memory 是 Record<string, MastraMemory>，
    // 不传等价于 disable。saveMemory / loadMemory 在 mysql-adapter 中再次抛
    // NOT_IMPLEMENTED_IN_V1 双保险（切片 07）。
  });
}

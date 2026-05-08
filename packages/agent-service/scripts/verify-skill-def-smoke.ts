/**
 * 切片 21 验收 §9 step 8/9 一次性烟雾测试 —— 与真实 MySQL（dev 容器）联通：
 *
 *   1. 调 `verifySkillDef`：5 个 Skill 全注册，输出 `[startup] skill-def-verified`；
 *   2. UPDATE `agent_skill_def` SET status='disabled' WHERE skill_code='purchase_order_create'；
 *   3. 再调 `verifySkillDef` → 期望 `SkillDefMismatchError(disabledRequired:[...])`；
 *   4. 复原 status='gray'，幂等。
 *
 * 用法：从 packages/agent-service 目录执行
 *   DATABASE_URL=mysql://root:rootpw@127.0.0.1:3306/store_pilot \
 *   pnpm exec tsx scripts/verify-skill-def-smoke.ts
 *
 * 仅供本地 / CI 烟雾验证，**不**进生产路径；放在 packages/agent-service/scripts/
 * 以便复用 pnpm workspace 的 @storepilot/shared-contracts 解析。
 */
import { getOrCreateMysqlStoragePool } from '../src/mastra/storage/sql.js';
import {
  SkillDefMismatchError,
  verifySkillDef,
} from '../src/mastra/agents/skill-registry.js';

async function main(): Promise<void> {
  const pool = getOrCreateMysqlStoragePool({
    DATABASE_URL: 'mysql://root:rootpw@127.0.0.1:3306/store_pilot',
  });

  console.log('--- step 1: verifySkillDef happy path ---');
  const reg = await verifySkillDef(pool);
  console.log('skills =', reg.list());

  console.log('--- step 2: disable purchase_order_create ---');
  await pool.execute(
    `UPDATE agent_skill_def SET status='disabled' WHERE skill_code='purchase_order_create'`,
  );

  console.log('--- step 3: verifySkillDef should fail ---');
  let didThrow = false;
  try {
    await verifySkillDef(pool);
  } catch (e) {
    if (e instanceof SkillDefMismatchError) {
      didThrow = true;
      console.log('OK SkillDefMismatchError thrown');
      console.log('  disabledRequired =', e.disabledRequired);
      console.log('  message =', e.message);
    } else {
      throw e;
    }
  }
  if (!didThrow) {
    throw new Error('UNEXPECTED: verifySkillDef did not throw');
  }

  console.log('--- step 4: restore status=gray ---');
  await pool.execute(
    `UPDATE agent_skill_def SET status='gray' WHERE skill_code='purchase_order_create'`,
  );

  await pool.end();
  console.log('--- DONE ---');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

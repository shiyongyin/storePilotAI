import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = join(import.meta.dirname, '..', '..', '..', '..');
const fixtureDir = join(
  repoRoot,
  'packages',
  'agent-service',
  'src',
  '__consistency_test_fixture__',
);
const fixtureFile = join(fixtureDir, 'env-assignment.test.ts');

function runConsistencyCheck(): ReturnType<typeof spawnSync> {
  return spawnSync('node', ['tools/consistency-check.mjs'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
}

afterEach(() => {
  rmSync(fixtureDir, { force: true, recursive: true });
});

describe('切片 18 — consistency-check 测试 env 红线', () => {
  it('测试文件中直接赋值 env 必须被一致性脚本拦截', () => {
    mkdirSync(fixtureDir, { recursive: true });
    writeFileSync(
      fixtureFile,
      [
        "const fixture: Record<string, string> = { NODE_ENV: 'test' };",
        'for (const [key, value] of Object.entries(fixture)) process.' + 'env[key] = value;',
        '',
      ].join('\n'),
      'utf8',
    );

    const result = runConsistencyCheck();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('no-test-env-assignment-agent');
  });
});

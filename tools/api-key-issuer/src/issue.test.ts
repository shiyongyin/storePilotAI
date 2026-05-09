import argon2 from 'argon2';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { issueAgentApiKey, parseIssueArgs, readIssueEnv } from './issue.js';

describe('parseIssueArgs', () => {
  it('accepts store scoped keys and ttl override', () => {
    expect(
      parseIssueArgs([
        '--merchantId',
        'M001',
        '--storeId=S001',
        '--userId',
        'boss-001',
        '--ttlDays',
        '30',
      ]),
    ).toEqual({
      merchantId: 'M001',
      storeId: 'S001',
      userId: 'boss-001',
      ttlDays: 30,
    });
  });

  it('defaults storeId to null and ttlDays to 90', () => {
    expect(parseIssueArgs(['--merchantId', 'M001', '--userId', 'boss-001'])).toEqual({
      merchantId: 'M001',
      storeId: null,
      userId: 'boss-001',
      ttlDays: 90,
    });
  });

  it('rejects invalid ttl values without exiting the process', () => {
    expect(() =>
      parseIssueArgs(['--merchantId', 'M001', '--userId', 'boss-001', '--ttlDays', '366']),
    ).toThrow(/参数错误/);
  });
});

describe('readIssueEnv', () => {
  it('requires mysql DATABASE_URL, long pepper, and fixed prefix', () => {
    expect(
      readIssueEnv({
        DATABASE_URL: 'mysql://root:rootpw@127.0.0.1:3306/store_pilot',
        AGENT_API_KEY_HASH_SALT: 'salt-32chars-xxxxxxxxxxxxxxxx',
        AGENT_API_KEY_PREFIX: 'sk-agent-',
      }),
    ).toEqual({
      databaseUrl: 'mysql://root:rootpw@127.0.0.1:3306/store_pilot',
      salt: 'salt-32chars-xxxxxxxxxxxxxxxx',
      prefix: 'sk-agent-',
    });
  });

  it('fails fast when the pepper is missing', () => {
    expect(() => readIssueEnv({ DATABASE_URL: 'mysql://root:rootpw@127.0.0.1:3306/db' })).toThrow(
      /AGENT_API_KEY_HASH_SALT/,
    );
  });
});

describe('issueAgentApiKey', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('stores only argon2 hash and prefix, never the plaintext key', async () => {
    const execute = vi.fn().mockResolvedValue([{ affectedRows: 1 }, undefined]);
    const end = vi.fn().mockResolvedValue(undefined);
    const createConnection = vi.fn().mockResolvedValue({ execute, end });

    const result = await issueAgentApiKey({
      args: {
        merchantId: 'M001',
        storeId: null,
        userId: 'boss-001',
        ttlDays: 90,
      },
      env: {
        databaseUrl: 'mysql://root:rootpw@127.0.0.1:3306/store_pilot',
        salt: 'salt-32chars-xxxxxxxxxxxxxxxx',
        prefix: 'sk-agent-',
      },
      createConnection,
      generateKey: () => ({
        plaintext: 'sk-agent-plain-secret-that-must-not-be-stored',
        prefix: 'sk-agent-plain-',
      }),
    });

    expect(createConnection).toHaveBeenCalledWith({
      uri: 'mysql://root:rootpw@127.0.0.1:3306/store_pilot',
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenCalledTimes(1);

    const [sql, params] = execute.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('INSERT INTO agent_api_key');
    expect(params).toHaveLength(6);
    expect(params).not.toContain(result.plaintext);
    expect(params[1]).toBe('sk-agent-plain-');
    expect(params.slice(2)).toEqual(['M001', null, 'boss-001', 90]);

    expect(typeof params[0]).toBe('string');
    expect(params[0]).not.toBe(result.plaintext);
    expect(await argon2.verify(params[0] as string, result.plaintext, {
      secret: Buffer.from('salt-32chars-xxxxxxxxxxxxxxxx'),
    })).toBe(true);
    expect(result).toEqual({
      plaintext: 'sk-agent-plain-secret-that-must-not-be-stored',
      prefix: 'sk-agent-plain-',
      args: {
        merchantId: 'M001',
        storeId: null,
        userId: 'boss-001',
        ttlDays: 90,
      },
    });
  });

  it('closes the database connection when insert fails', async () => {
    const execute = vi.fn().mockRejectedValue(new Error('insert failed'));
    const end = vi.fn().mockResolvedValue(undefined);

    await expect(
      issueAgentApiKey({
        args: {
          merchantId: 'M001',
          storeId: 'S001',
          userId: 'boss-001',
          ttlDays: 7,
        },
        env: {
          databaseUrl: 'mysql://root:rootpw@127.0.0.1:3306/store_pilot',
          salt: 'salt-32chars-xxxxxxxxxxxxxxxx',
          prefix: 'sk-agent-',
        },
        createConnection: vi.fn().mockResolvedValue({ execute, end }),
        generateKey: () => ({
          plaintext: 'sk-agent-failing-secret',
          prefix: 'sk-agent-failin',
        }),
      }),
    ).rejects.toThrow(/insert failed/);

    expect(end).toHaveBeenCalledTimes(1);
  });
});

/**
 * 切片 17 §9.6 — `assertDraftCanCreatePo` 8 项前置校验单测
 *
 * 覆盖矩阵（与任务卡 §7 MUST DO §3 一一对应）：
 *
 * | 校验项 | 失败场景                                       | 期望 ErrorCode             |
 * | ----- | --------------------------------------------- | -------------------------- |
 * | 3     | status = DRAFT / SUBMITTED / EXPIRED 等       | DRAFT_NOT_FOUND / DRAFT_EXPIRED / DRAFT_ALREADY_SUBMITTED |
 * | 4     | items 为空                                     | DRAFT_NOT_FOUND            |
 * | 5     | 存在 finalSuggestQty < 0                       | SCHEMA_FAIL                |
 * | 6     | submittedPoNo 已有值                           | DRAFT_ALREADY_SUBMITTED    |
 * | 7     | status = EXPIRED 或 expiresAt 已过             | DRAFT_EXPIRED              |
 *
 * 校验项 1 / 2 / 8 由外层守门（getByIdStrict / IntentRouter / ConfirmManager），
 * 本函数纯同步无 IO，只关心传入 DraftView 是否合法。
 */
import { BizError, type DraftItem } from '@storepilot/shared-contracts';
import { describe, expect, it } from 'vitest';

import type { DraftView } from '../../safety/draft-manager.js';

import { assertDraftCanCreatePo } from './assert-draft-can-create-po.js';

function makeItem(over: Partial<DraftItem> = {}): DraftItem {
  return {
    skuId: 'SKU001',
    skuName: '矿泉水 550ml',
    unit: '瓶',
    baseSuggestQty: 100,
    finalSuggestQty: 100,
    reason: '加权日均 10',
    adjustmentTrace: [],
    ...over,
  };
}

function makeDraft(over: Partial<DraftView> = {}): DraftView {
  const now = new Date();
  return {
    draftId: 'drf_aaaaaaaaaaaaaaaaaaaaaaaa',
    sessionId: 'sess_test',
    merchantId: 'M-1',
    storeId: 'S-1',
    userId: 'U-1',
    traceId: 'trace_seed',
    forecastDays: 7,
    status: 'WAIT_CONFIRM',
    items: [makeItem(), makeItem({ skuId: 'SKU002', finalSuggestQty: 50 })],
    strategyVersion: 'M0-S0-Pp-1',
    submittedPoNo: null,
    expiresAt: new Date(now.getTime() + 30 * 60_000).toISOString(),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    ...over,
  };
}

describe('切片 17 §9.6 — assertDraftCanCreatePo（8 项前置校验）', () => {
  describe('正常路径', () => {
    it('WAIT_CONFIRM + items 非空 + finalSuggestQty >= 0 + submittedPoNo IS NULL + 未过期 → 通过', () => {
      expect(() => assertDraftCanCreatePo(makeDraft())).not.toThrow();
    });

    it('CONFIRMED 同样允许（V1 与 WAIT_CONFIRM 等价）', () => {
      expect(() => assertDraftCanCreatePo(makeDraft({ status: 'CONFIRMED' }))).not.toThrow();
    });
  });

  describe('§3 status 非法', () => {
    it('DRAFT → DRAFT_NOT_FOUND（不允许 DRAFT 直接走）', () => {
      const fn = () => assertDraftCanCreatePo(makeDraft({ status: 'DRAFT' }));
      expect(fn).toThrow(BizError);
      try {
        fn();
      } catch (e) {
        expect((e as BizError).code).toBe('DRAFT_NOT_FOUND');
      }
    });

    it('SUBMITTED → DRAFT_ALREADY_SUBMITTED（重复提单更精确）', () => {
      const fn = () =>
        assertDraftCanCreatePo(
          makeDraft({ status: 'SUBMITTED', submittedPoNo: 'PO_OLD' }),
        );
      try {
        fn();
        expect.fail('应抛错');
      } catch (e) {
        expect((e as BizError).code).toBe('DRAFT_ALREADY_SUBMITTED');
        expect((e as BizError).message).toContain('PO_OLD');
      }
    });

    it('CANCELLED → DRAFT_NOT_FOUND', () => {
      try {
        assertDraftCanCreatePo(makeDraft({ status: 'CANCELLED' }));
      } catch (e) {
        expect((e as BizError).code).toBe('DRAFT_NOT_FOUND');
      }
    });

    it('FAILED → DRAFT_NOT_FOUND', () => {
      try {
        assertDraftCanCreatePo(makeDraft({ status: 'FAILED' }));
      } catch (e) {
        expect((e as BizError).code).toBe('DRAFT_NOT_FOUND');
      }
    });
  });

  describe('§4 items 非空', () => {
    it('items 空数组 → DRAFT_NOT_FOUND', () => {
      try {
        assertDraftCanCreatePo(makeDraft({ items: [] }));
        expect.fail('应抛错');
      } catch (e) {
        expect((e as BizError).code).toBe('DRAFT_NOT_FOUND');
        expect((e as BizError).message).toContain('明细为空');
      }
    });
  });

  describe('§5 finalSuggestQty 非负', () => {
    it('存在 finalSuggestQty < 0 → SCHEMA_FAIL', () => {
      const draft = makeDraft({
        items: [
          makeItem({ skuId: 'SKU001', finalSuggestQty: 100 }),
          makeItem({ skuId: 'SKU002', finalSuggestQty: -5 }), // 非法
        ],
      });
      try {
        assertDraftCanCreatePo(draft);
        expect.fail('应抛错');
      } catch (e) {
        expect((e as BizError).code).toBe('SCHEMA_FAIL');
        const meta = (e as BizError).meta as { skuId?: string };
        expect(meta?.skuId).toBe('SKU002');
      }
    });

    it('finalSuggestQty = 0 → 通过（任务卡 §7 MUST DO §3.5：>= 0）', () => {
      expect(() =>
        assertDraftCanCreatePo(
          makeDraft({ items: [makeItem({ finalSuggestQty: 0 })] }),
        ),
      ).not.toThrow();
    });
  });

  describe('§6 submittedPoNo 必须为空', () => {
    it('submittedPoNo 已有值 → DRAFT_ALREADY_SUBMITTED', () => {
      try {
        assertDraftCanCreatePo(makeDraft({ submittedPoNo: 'PO_ABC123' }));
        expect.fail('应抛错');
      } catch (e) {
        expect((e as BizError).code).toBe('DRAFT_ALREADY_SUBMITTED');
        expect((e as BizError).message).toContain('PO_ABC123');
      }
    });
  });

  describe('§7 草稿未过期', () => {
    it('status = EXPIRED → DRAFT_EXPIRED', () => {
      try {
        assertDraftCanCreatePo(makeDraft({ status: 'EXPIRED' }));
        expect.fail('应抛错');
      } catch (e) {
        expect((e as BizError).code).toBe('DRAFT_EXPIRED');
        expect((e as BizError).message).toContain('EXPIRED');
      }
    });

    it('expiresAt 已过 → DRAFT_EXPIRED', () => {
      const draft = makeDraft({
        expiresAt: new Date(Date.now() - 1000).toISOString(), // 1 秒前
      });
      try {
        assertDraftCanCreatePo(draft);
        expect.fail('应抛错');
      } catch (e) {
        expect((e as BizError).code).toBe('DRAFT_EXPIRED');
      }
    });

    it('expiresAt 是非法字符串 → DRAFT_EXPIRED', () => {
      const draft = makeDraft({ expiresAt: 'not-a-date' });
      try {
        assertDraftCanCreatePo(draft);
        expect.fail('应抛错');
      } catch (e) {
        expect((e as BizError).code).toBe('DRAFT_EXPIRED');
      }
    });

    it('expiresAt 在未来 30 分钟 → 通过', () => {
      const draft = makeDraft({
        expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
      });
      expect(() => assertDraftCanCreatePo(draft)).not.toThrow();
    });
  });

  describe('错误顺序（与本体 §12.2 校验顺序一致）', () => {
    it('status 非法 + items 空 → 优先抛 status（校验顺序 §3 在前）', () => {
      const draft = makeDraft({ status: 'DRAFT', items: [] });
      try {
        assertDraftCanCreatePo(draft);
      } catch (e) {
        expect((e as BizError).code).toBe('DRAFT_NOT_FOUND');
        expect((e as BizError).message).toContain('状态非法');
      }
    });

    it('submittedPoNo 已有 + 已过期 → 优先抛 ALREADY_SUBMITTED（§6 在 §7 前）', () => {
      const draft = makeDraft({
        submittedPoNo: 'PO_X',
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      });
      try {
        assertDraftCanCreatePo(draft);
      } catch (e) {
        expect((e as BizError).code).toBe('DRAFT_ALREADY_SUBMITTED');
      }
    });
  });
});

import { describe, expect, it } from 'vitest';

import {
  buildRepurchaseReminderItems,
  buildRepurchaseReminderMarkdown,
  deriveRepurchaseTiming,
} from './repurchase-rules.js';

const segments = [
  {
    memberId: 'MBR_00123',
    nameMasked: '王女士',
    phoneMasked: '138****1234',
    lastVisitAt: '2026-03-10',
    segmentCode: 'REPURCHASE_DUE',
    matchReason: '距上次到店 61 天，超过个人平均复购周期',
    score: 9.2,
  },
  {
    memberId: 'MBR_00135',
    nameMasked: '李女士',
    phoneMasked: '139****0135',
    lastVisitAt: '2026-04-01',
    segmentCode: 'REPURCHASE_DUE',
    matchReason: '距上次到店接近个人平均复购周期',
    score: 8.1,
  },
  {
    memberId: 'MBR_00142',
    nameMasked: '陈先生',
    phoneMasked: '137****0142',
    lastVisitAt: '2026-04-15',
    segmentCode: 'REPURCHASE_DUE',
    matchReason: '新会员样本少，接近复购窗口',
    score: 6.4,
  },
  {
    memberId: 'MBR_00150',
    nameMasked: '周先生',
    phoneMasked: '135****0150',
    lastVisitAt: '2026-02-28',
    segmentCode: 'DORMANT_NORMAL',
    matchReason: '普通沉睡会员',
    score: 6.8,
  },
  {
    memberId: 'MBR_00152',
    nameMasked: '低响应会员',
    phoneMasked: '134****0152',
    lastVisitAt: '2026-02-01',
    segmentCode: 'LOW_RESPONSIVE',
    matchReason: '历史活动低响应',
    score: 2.1,
  },
] as const;

const cycles = [
  {
    memberId: 'MBR_00123',
    avgRepurchaseDays: 28,
    daysSinceLastPurchase: 61,
    confidence: 'HIGH',
    sampleSize: 12,
  },
  {
    memberId: 'MBR_00135',
    avgRepurchaseDays: 32,
    daysSinceLastPurchase: 29,
    confidence: 'MEDIUM',
    sampleSize: 5,
  },
  {
    memberId: 'MBR_00142',
    avgRepurchaseDays: 30,
    daysSinceLastPurchase: 28,
    confidence: 'LOW',
    sampleSize: 1,
  },
] as const;

const frequentProductsByMember = {
  MBR_00123: ['轻跑鞋 SKU001'],
  MBR_00135: ['儿童运动鞋 SKU021'],
  MBR_00142: ['儿童运动鞋 SKU021'],
} as const;

describe('US-004 repurchase cycle reminder rules', () => {
  it('derives overdue and near-due timing only from cycle tool numbers', () => {
    expect(
      deriveRepurchaseTiming({
        avgRepurchaseDays: 28,
        daysSinceLastPurchase: 61,
      }),
    ).toMatchObject({
      daysToNextExpected: -33,
      overdueDays: 33,
      dueText: '已超过预计复购时间 33 天',
    });

    expect(
      deriveRepurchaseTiming({
        avgRepurchaseDays: 32,
        daysSinceLastPurchase: 29,
      }),
    ).toMatchObject({
      daysToNextExpected: 3,
      overdueDays: 0,
      dueText: '预计 3 天后到复购时间',
    });
  });

  it('uses REPURCHASE_DUE as the main segment, filters dormant and low-responsive rows, and sorts by urgency', () => {
    const items = buildRepurchaseReminderItems({
      segments,
      cycles,
      frequentProductsByMember,
    });

    expect(items.map((item) => item.memberId)).toEqual(['MBR_00123', 'MBR_00135', 'MBR_00142']);
    expect(items.map((item) => item.memberId)).not.toContain('MBR_00150');
    expect(items.map((item) => item.memberId)).not.toContain('MBR_00152');
    expect(items[0]).toMatchObject({
      confidence: 'HIGH',
      daysToNextExpected: -33,
      overdueDays: 33,
      frequentProductText: '轻跑鞋 SKU001',
    });
    expect(items[1]?.nearnessRatio).toBeCloseTo(29 / 32, 3);
  });

  it('marks low confidence or sampleSize below 3 as small sample and avoids strong conclusions', () => {
    const items = buildRepurchaseReminderItems({
      segments,
      cycles,
      frequentProductsByMember,
    });
    const low = items.find((item) => item.memberId === 'MBR_00142');

    expect(low?.sampleNote).toBe('样本较小，仅做提醒参考');
    expect(low?.confidenceLabel).toBe('LOW（样本较小）');
    expect(low?.suggestedScript).toContain('可以来店里看看');
    expect(low?.suggestedScript).not.toMatch(/一定|肯定|必然|今天会来/);
    expect(low?.suggestedScript.split(/[。！？]/).filter(Boolean)).toHaveLength(2);
  });

  it('builds safe markdown and member_wakeup_list_card data without full PII or internal terms', () => {
    const markdown = buildRepurchaseReminderMarkdown({
      segments,
      cycles,
      frequentProductsByMember,
    });

    expect(markdown).toContain('## 复购周期提醒');
    expect(markdown).toContain('| 顾客 | 常购商品 | 平均周期 | 距上次消费 | 到期状态 | 置信度 | 建议话术 |');
    expect(markdown).toContain('已超过预计复购时间 33 天');
    expect(markdown).toContain('样本较小');
    expect(markdown).toContain('member_wakeup_list_card');
    expect(markdown).not.toMatch(/(?<![*\d])1[0-9]{10}(?![*\d])/);
    expect(markdown).not.toMatch(/tool_calls|function_call|traceId|merchantId|storeId|agent_run_id/i);
    const alreadyBroadcasted = `已经${'群发'}`;
    expect(markdown).not.toContain('自动群发');
    expect(markdown).not.toContain(alreadyBroadcasted);
    expect(markdown).not.toContain('创建采购单');
    expect(markdown).not.toContain('采购补货');

    const cardJson = markdown.match(/<!-- card_data:start -->(.*?)<!-- card_data:end -->/s)?.[1];
    expect(cardJson).toBeDefined();
    const card = JSON.parse(cardJson ?? '{}') as {
      cardType: string;
      members: Array<{ reasonCode: string; confidence: string; priority: number }>;
    };
    expect(card.cardType).toBe('member_wakeup_list_card');
    expect(card.members.map((member) => member.reasonCode)).toEqual([
      'REPURCHASE_DUE',
      'REPURCHASE_DUE',
      'REPURCHASE_DUE',
    ]);
    expect(card.members.map((member) => member.priority)).toEqual([1, 2, 3]);
  });
});

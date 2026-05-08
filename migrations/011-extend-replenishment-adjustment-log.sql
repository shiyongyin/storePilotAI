-- ============================================================================
-- Migration 011 — 扩展 replenishment_adjustment_log（切片 15 调整审计 SSOT）
--
-- 切片 15 §7 MUST DO §5 / §9 步骤 5 强约束：每次调整必须写一行
--   - before_items_json   ：调整前 DraftItem[] 全文（JSON）
--   - after_items_json    ：调整后 DraftItem[] 全文（JSON）
--   - instruction_json    ：完整 AdjustmentInstruction（含 targetType / adjustmentType / rate|qty）
--   - affected_sku_ids    ：被影响的 SKU ID 数组（JSON）
--
-- 与 002-init-replenishment.sql 保持向后兼容：保留所有原始列；新列允许 NULL，
-- 老行无需回填即可继续工作。`applied=1` 由切片 15 写入时设置。
-- ============================================================================

ALTER TABLE replenishment_adjustment_log
  ADD COLUMN IF NOT EXISTS before_items_json JSON NULL
    COMMENT '调整前 DraftItem[] 全文（切片 15）',
  ADD COLUMN IF NOT EXISTS after_items_json  JSON NULL
    COMMENT '调整后 DraftItem[] 全文（切片 15）',
  ADD COLUMN IF NOT EXISTS instruction_json  JSON NULL
    COMMENT '完整 AdjustmentInstruction JSON（切片 15）',
  ADD COLUMN IF NOT EXISTS affected_sku_ids  JSON NULL
    COMMENT '被影响 SKU ID 数组（切片 15 §9 步骤 5 验收依据）';

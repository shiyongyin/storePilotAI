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

SET @before_items_json_missing := (
  SELECT COUNT(*) = 0
    FROM information_schema.columns
   WHERE table_schema = DATABASE()
     AND table_name = 'replenishment_adjustment_log'
     AND column_name = 'before_items_json'
);
SET @ddl := IF(
  @before_items_json_missing,
  'ALTER TABLE replenishment_adjustment_log ADD COLUMN before_items_json JSON NULL COMMENT ''调整前 DraftItem[] 全文（切片 15）''',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @after_items_json_missing := (
  SELECT COUNT(*) = 0
    FROM information_schema.columns
   WHERE table_schema = DATABASE()
     AND table_name = 'replenishment_adjustment_log'
     AND column_name = 'after_items_json'
);
SET @ddl := IF(
  @after_items_json_missing,
  'ALTER TABLE replenishment_adjustment_log ADD COLUMN after_items_json JSON NULL COMMENT ''调整后 DraftItem[] 全文（切片 15）''',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @instruction_json_missing := (
  SELECT COUNT(*) = 0
    FROM information_schema.columns
   WHERE table_schema = DATABASE()
     AND table_name = 'replenishment_adjustment_log'
     AND column_name = 'instruction_json'
);
SET @ddl := IF(
  @instruction_json_missing,
  'ALTER TABLE replenishment_adjustment_log ADD COLUMN instruction_json JSON NULL COMMENT ''完整 AdjustmentInstruction JSON（切片 15）''',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @affected_sku_ids_missing := (
  SELECT COUNT(*) = 0
    FROM information_schema.columns
   WHERE table_schema = DATABASE()
     AND table_name = 'replenishment_adjustment_log'
     AND column_name = 'affected_sku_ids'
);
SET @ddl := IF(
  @affected_sku_ids_missing,
  'ALTER TABLE replenishment_adjustment_log ADD COLUMN affected_sku_ids JSON NULL COMMENT ''被影响 SKU ID 数组（切片 15 §9 步骤 5 验收依据）''',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

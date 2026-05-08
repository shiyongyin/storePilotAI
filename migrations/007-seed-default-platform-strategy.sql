-- ============================================================================
-- Migration 007 — 平台默认策略种子(__PLATFORM_DEFAULT__)
-- 切片 03 / 对接切片 11(三层合并基础层)
-- 必须可重入:用 INSERT IGNORE 或 ON DUPLICATE KEY 守门。
-- ============================================================================

INSERT INTO agent_merchant_strategy (
  merchant_id, strategy_json, version, status
)
VALUES (
  '__PLATFORM_DEFAULT__',
  JSON_OBJECT(
    'enabledSkills', JSON_ARRAY(
      'business_daily_report',
      'business_monthly_report',
      'replenishment_forecast',
      'replenishment_adjustment',
      'purchase_order_create'
    ),
    'replenishmentPolicy', JSON_OBJECT(
      'forecastDays', 7,
      'safetyStockDays', 2,
      'requireConfirmBeforePurchaseOrder', TRUE,
      'allowAutoPurchaseOrder', FALSE,
      'forecastMethod', 'weighted_moving_average'
    ),
    'reportPolicy', JSON_OBJECT(
      'maxSummaryChars', 8000,
      'maxCards', 12
    ),
    'safetyPolicy', JSON_OBJECT(
      'requireUserConfirmForWrite', TRUE,
      'maxAdjustmentsPerDraft', 10,
      'majorAdjustmentRatio', 0.5,
      'draftAutoExpireMinutes', 30
    )
  ),
  'platform-default-v1.0.0',
  'enabled'
)
ON DUPLICATE KEY UPDATE
  strategy_json = VALUES(strategy_json),
  status = VALUES(status);

/**
 * 切片 06 — OpenTelemetry SDK 启动（必须在 server.ts 顶部第一行 import）
 * 严格按 docs/任务卡/D-Mastra.md §T-MASTRA-04 + 切片 06 任务卡 §8.4 落地。
 *
 * 强约束:
 *   - OTEL_EXPORTER_OTLP_ENDPOINT 为空 → 仅本地 trace（不传 traceExporter）
 *   - SDK.start() 失败必须 degrade gracefully（仅 stderr，不阻断 server.ts）
 *   - serviceName='agent-service'（与 createMastra telemetry.serviceName 对齐）
 *
 * 注意: 本文件不通过 logger 输出（logger 在更晚加载；否则 OTel 自动注入 Pino 时会循环依赖）。
 * 只允许 process.stderr.write，不用 console.* （ESLint no-console: error）。
 */
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { NodeSDK } from '@opentelemetry/sdk-node';

import { getEnv } from '../config/env.js';

const env = getEnv();

// 用条件展开避免 exactOptionalPropertyTypes 下的 undefined 不兼容
const sdkConfig: ConstructorParameters<typeof NodeSDK>[0] = {
  serviceName: 'agent-service',
  instrumentations: [getNodeAutoInstrumentations()],
  ...(env.OTEL_EXPORTER_OTLP_ENDPOINT
    ? { traceExporter: new OTLPTraceExporter({ url: env.OTEL_EXPORTER_OTLP_ENDPOINT }) }
    : {}),
};
const sdk = new NodeSDK(sdkConfig);

try {
  sdk.start();
} catch (e) {
  // 切片 06 §7 MUST §7：OTel 启动失败 degrade gracefully，仅本地日志，不阻断业务
  process.stderr.write(
    `[otel] failed to start, continuing without exporter: ${e instanceof Error ? e.message : String(e)}\n`,
  );
}

const shutdown = async (signal: string): Promise<void> => {
  try {
    await sdk.shutdown();
  } catch (e) {
    process.stderr.write(
      `[otel] shutdown failed on ${signal}: ${e instanceof Error ? e.message : String(e)}\n`,
    );
  }
};

process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});
process.on('SIGINT', () => {
  void shutdown('SIGINT');
});

export { sdk as _otelSdk };

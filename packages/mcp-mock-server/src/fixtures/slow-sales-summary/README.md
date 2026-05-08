# Fixture profile: `slow-sales-summary`

**触发场景**:`queryStoreSalesSummary` 故意 `sleep 30s`(>> 默认 `MCP_TOOL_TIMEOUT_MS=15000`)。

**用于验证**:
- 切片 08(mcpClient)`runWithTimeoutAndRetry`:1 次重试后抛 `MCP_TIMEOUT`
- 切片 18 测试:超时路径 E2E

**预期错误码**:`MCP_TIMEOUT`(由 agent-service 侧抛,非 Mock 抛)

**覆写工具**:`queryStoreSalesSummary`(其余 fall back 到 happy-path)

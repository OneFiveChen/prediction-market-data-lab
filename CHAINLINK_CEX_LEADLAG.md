# Chainlink-CEX Lead-Lag Collector

目的：比较 Chainlink BTC/USD Data Streams report price 和 Binance/Gate.io/Bitget tick 价格的前后关系。

## 1. 需要的 Chainlink 凭证

Chainlink Data Streams API 需要：

```bash
STREAMS_API_KEY=...
STREAMS_API_SECRET=...
CHAINLINK_FEED_ID=...
```

官方认证规则：

```text
Authorization: <api key>
X-Authorization-Timestamp: <milliseconds timestamp>
X-Authorization-Signature-SHA256: HMAC_SHA256(secret, stringToSign)

stringToSign = METHOD FULL_PATH BODY_HASH API_KEY TIMESTAMP
```

REST latest endpoint：

```text
GET https://api.dataengine.chain.link/api/v1/reports/latest?feedID=<feedID>
```

WebSocket endpoint：

```text
wss://ws.dataengine.chain.link/api/v1/ws?feedIDs=<feedID1>,<feedID2>
```

本目录当前先实现 REST polling 版，默认 250ms poll 一次。

## 2. 配置

复制样例：

```bash
cp chainlink-cex-config.example.json chainlink-cex-config.json
```

把 `chainlink.feedId` 改成 BTC/USD Data Streams feed ID，或者在 `.env` 设置：

```bash
STREAMS_API_KEY=...
STREAMS_API_SECRET=...
CHAINLINK_FEED_ID=...
```

## 3. 采集

```bash
node collect-chainlink-cex-leadlag.js chainlink-cex-config.json
```

输出目录类似：

```text
data/chainlink-cex-leadlag/run-YYYY-MM-DD...
```

主要文件：

```text
cex_ticks.ndjson          原始交易所 tick/trade
cex_composite.ndjson      每 100ms 的三交易所 median/mean mid
chainlink_reports.ndjson  Chainlink report + 解码后的 price/bid/ask
status.ndjson             连接状态和错误
```

## 4. 分析

```bash
node analyze-chainlink-cex-leadlag.js data/chainlink-cex-leadlag/run-YYYY-MM-DD...
```

可调参数：

```bash
MIN_LAG_MS=-5000 MAX_LAG_MS=5000 LAG_STEP_MS=100 NEAREST_TOL_MS=300 \
node analyze-chainlink-cex-leadlag.js <run-dir>
```

解释：

```text
lagMs applied to Chainlink receive timestamp:
compare Chainlink(t) with CEX(t + lagMs)

best lag < 0:
  CEX earlier price matches Chainlink better, meaning CEX leads Chainlink.

best lag > 0:
  CEX later price matches Chainlink better, meaning Chainlink leads or local receive time is earlier.
```

## 5. 当前限制

- 如果没有 `STREAMS_API_KEY`、`STREAMS_API_SECRET`、`CHAINLINK_FEED_ID`，只能采集交易所数据。
- `observationsTimestamp` 是秒级字段；分析器当前默认用本机收到 Chainlink report 的毫秒时间做 lead-lag。
- 后续可以补 Chainlink WebSocket 版，减少 REST polling 的重复和延迟。

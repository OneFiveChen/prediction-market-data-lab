# Prediction Market Data Lab

Lightweight research tools for comparing Chainlink Data Streams BTC/USD reports with centralized exchange tick data.

The initial goal is to measure whether exchange prices from Binance, Gate.io, and Bitget lead or lag Chainlink Data Streams reports, and by how much. This is useful for prediction-market analytics where a market's settlement reference is derived from Chainlink while real-time trading signals come from exchange order books and trades.

## Features

- Collects BTC/USDT public tick data from Binance, Gate.io, and Bitget.
- Builds a 100ms composite CEX mid-price stream.
- Fetches Chainlink Data Streams latest reports using HMAC authentication.
- Decodes Chainlink Crypto v3 report fields: `price`, `bid`, `ask`, `observationsTimestamp`, and `validFromTimestamp`.
- Computes simple lead-lag statistics between Chainlink reports and CEX composite prices.

## Requirements

- Node.js 22 or newer. Node 24 is recommended.
- Chainlink Data Streams API access for BTC/USD:
  - `STREAMS_API_KEY`
  - `STREAMS_API_SECRET`
  - `CHAINLINK_FEED_ID`

Exchange websocket data is public and does not require exchange accounts.

## Setup

```bash
cp .env.example .env
cp chainlink-cex-config.example.json chainlink-cex-config.json
```

Fill `.env`:

```bash
STREAMS_API_KEY=your_chainlink_api_key
STREAMS_API_SECRET=your_chainlink_api_secret
CHAINLINK_FEED_ID=your_btc_usd_data_streams_feed_id
```

## Collect Data

```bash
npm run collect
```

The collector writes NDJSON files under:

```text
data/chainlink-cex-leadlag/run-YYYY-MM-DD...
```

Main outputs:

```text
cex_ticks.ndjson          Raw exchange book ticker and trade events
cex_composite.ndjson      100ms composite CEX mid-price snapshots
chainlink_reports.ndjson  Chainlink report data and decoded v3 price fields
status.ndjson             Connection status and errors
```

Stop collection with `Ctrl-C`.

## Analyze Lead-Lag

```bash
npm run analyze -- data/chainlink-cex-leadlag/run-YYYY-MM-DD...
```

Optional tuning:

```bash
MIN_LAG_MS=-5000 MAX_LAG_MS=5000 LAG_STEP_MS=100 NEAREST_TOL_MS=300 \
npm run analyze -- data/chainlink-cex-leadlag/run-YYYY-MM-DD...
```

Lag interpretation:

```text
compare Chainlink(t) with CEX(t + lagMs)

best lag < 0:
  Earlier CEX prices match Chainlink better, suggesting CEX leads Chainlink.

best lag > 0:
  Later CEX prices match Chainlink better, suggesting Chainlink leads the local CEX composite or receive-time alignment needs adjustment.
```

## Notes

- This project does not place trades.
- Secrets and collected data are intentionally excluded from git.
- Chainlink Data Streams API access is permissioned and requires credentials from Chainlink.
- `observationsTimestamp` is seconds-level; the current analyzer uses local Chainlink report receive time for millisecond lead-lag analysis.

## Documentation

See [CHAINLINK_CEX_LEADLAG.md](./CHAINLINK_CEX_LEADLAG.md) for API authentication details and operating notes.

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULT_CONFIG = {
  symbol: 'BTCUSDT',
  chainlink: {
    feedId: '',
    restUrl: 'https://api.dataengine.chain.link',
    pollMs: 250,
  },
  polymarketRtds: {
    enabled: true,
    chainlinkSymbol: 'btc/usd',
    binanceSymbol: 'btcusdt',
  },
  cex: {
    compositeMs: 100,
    binance: true,
    gateio: true,
    bitget: true,
  },
  outputDir: 'data/chainlink-cex-leadlag',
};

function loadEnv(file = '.env') {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    if (process.env[m[1]] == null) {
      process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
  }
}

function loadConfig() {
  const configPath = process.argv[2] || 'chainlink-cex-config.json';
  const userConfig = fs.existsSync(configPath)
    ? JSON.parse(fs.readFileSync(configPath, 'utf8'))
    : {};
  return {
    ...DEFAULT_CONFIG,
    ...userConfig,
    chainlink: { ...DEFAULT_CONFIG.chainlink, ...(userConfig.chainlink || {}) },
    polymarketRtds: { ...DEFAULT_CONFIG.polymarketRtds, ...(userConfig.polymarketRtds || {}) },
    cex: { ...DEFAULT_CONFIG.cex, ...(userConfig.cex || {}) },
  };
}

function mkdirp(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function makeWriter(file) {
  mkdirp(path.dirname(file));
  const stream = fs.createWriteStream(file, { flags: 'a' });
  return {
    write(row) {
      stream.write(`${JSON.stringify(row)}\n`);
    },
    close() {
      stream.end();
    },
  };
}

function nowIsoCompact() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function sha256Hex(body) {
  return crypto.createHash('sha256').update(body || '').digest('hex');
}

function chainlinkAuthHeaders(method, fullPath, apiKey, apiSecret) {
  const timestamp = Date.now().toString();
  const bodyHash = sha256Hex('');
  const stringToSign = `${method} ${fullPath} ${bodyHash} ${apiKey} ${timestamp}`;
  const signature = crypto.createHmac('sha256', apiSecret).update(stringToSign).digest('hex');
  return {
    Authorization: apiKey,
    'X-Authorization-Timestamp': timestamp,
    'X-Authorization-Signature-SHA256': signature,
  };
}

function strip0x(hex) {
  return String(hex || '').startsWith('0x') ? String(hex).slice(2) : String(hex || '');
}

function word(buf, index) {
  return buf.subarray(index * 32, index * 32 + 32);
}

function uintWord(buf) {
  return BigInt(`0x${buf.toString('hex') || '0'}`);
}

function intWord(buf, bits = 256) {
  return BigInt.asIntN(bits, uintWord(buf));
}

function decimal18(n) {
  const sign = n < 0n ? '-' : '';
  const x = n < 0n ? -n : n;
  const whole = x / 10n ** 18n;
  const frac = (x % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, '');
  return Number(`${sign}${whole.toString()}${frac ? `.${frac}` : ''}`);
}

function decodeAbiBytes32Array3AndBytes(fullReportHex) {
  const buf = Buffer.from(strip0x(fullReportHex), 'hex');
  if (buf.length < 160) throw new Error(`fullReport too short: ${buf.length} bytes`);

  const offset = Number(uintWord(word(buf, 3)));
  if (!Number.isFinite(offset) || offset + 32 > buf.length) {
    throw new Error(`invalid reportData offset ${offset}`);
  }

  const len = Number(uintWord(buf.subarray(offset, offset + 32)));
  const start = offset + 32;
  const end = start + len;
  if (!Number.isFinite(len) || end > buf.length) {
    throw new Error(`invalid reportData length ${len}`);
  }

  return {
    context: [word(buf, 0), word(buf, 1), word(buf, 2)].map((x) => `0x${x.toString('hex')}`),
    reportData: buf.subarray(start, end),
  };
}

function decodeV3Report(fullReportHex) {
  const { context, reportData } = decodeAbiBytes32Array3AndBytes(fullReportHex);
  if (reportData.length < 32 * 9) {
    throw new Error(`V3 reportData too short: ${reportData.length} bytes`);
  }
  const feedId = `0x${word(reportData, 0).toString('hex')}`;
  const version = reportData.length >= 2 ? (reportData[0] << 8) | reportData[1] : null;
  const validFromTimestamp = Number(uintWord(word(reportData, 1)));
  const observationsTimestamp = Number(uintWord(word(reportData, 2)));
  const nativeFee = uintWord(word(reportData, 3)).toString();
  const linkFee = uintWord(word(reportData, 4)).toString();
  const expiresAt = Number(uintWord(word(reportData, 5)));
  const priceRaw = intWord(word(reportData, 6), 256);
  const bidRaw = intWord(word(reportData, 7), 256);
  const askRaw = intWord(word(reportData, 8), 256);

  return {
    context,
    version,
    feedId,
    validFromTimestamp,
    observationsTimestamp,
    nativeFee,
    linkFee,
    expiresAt,
    priceRaw: priceRaw.toString(),
    bidRaw: bidRaw.toString(),
    askRaw: askRaw.toString(),
    price: decimal18(priceRaw),
    bid: decimal18(bidRaw),
    ask: decimal18(askRaw),
  };
}

async function fetchChainlinkLatest(config) {
  const apiKey = process.env.STREAMS_API_KEY || process.env.CHAINLINK_STREAMS_API_KEY;
  const apiSecret = process.env.STREAMS_API_SECRET || process.env.CHAINLINK_STREAMS_API_SECRET;
  const feedId = process.env.CHAINLINK_FEED_ID || config.chainlink.feedId;
  if (!apiKey || !apiSecret || !feedId || feedId.includes('PUT_')) {
    throw new Error('missing Chainlink credentials/feedId');
  }

  const base = config.chainlink.restUrl.replace(/\/+$/, '');
  const fullPath = `/api/v1/reports/latest?feedID=${encodeURIComponent(feedId)}`;
  const res = await fetch(`${base}${fullPath}`, {
    headers: chainlinkAuthHeaders('GET', fullPath, apiKey, apiSecret),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Chainlink HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  const body = JSON.parse(text);
  const report = body.report || body;
  const decoded = report.fullReport ? decodeV3Report(report.fullReport) : {};
  return {
    ts_recv: Date.now(),
    source: 'chainlink',
    feedID: report.feedID || decoded.feedId || feedId,
    validFromTimestamp: Number(report.validFromTimestamp || decoded.validFromTimestamp || 0),
    observationsTimestamp: Number(report.observationsTimestamp || decoded.observationsTimestamp || 0),
    decoded,
  };
}

function hasDirectChainlinkConfig(config) {
  const apiKey = process.env.STREAMS_API_KEY || process.env.CHAINLINK_STREAMS_API_KEY;
  const apiSecret = process.env.STREAMS_API_SECRET || process.env.CHAINLINK_STREAMS_API_SECRET;
  const feedId = process.env.CHAINLINK_FEED_ID || config.chainlink.feedId;
  return Boolean(apiKey && apiSecret && feedId && !String(feedId).includes('PUT_'));
}

function safeJsonParse(data) {
  try {
    return JSON.parse(String(data));
  } catch {
    return null;
  }
}

function connectWs(name, url, onOpen, onMessage, onStatus) {
  let ws;
  let stopped = false;
  let attempt = 0;

  const connect = () => {
    if (stopped) return;
    ws = new WebSocket(url);
    ws.addEventListener('open', () => {
      attempt = 0;
      onStatus({ ts_recv: Date.now(), source: name, event: 'open' });
      onOpen?.(ws);
    });
    ws.addEventListener('message', (event) => onMessage(event.data, ws));
    ws.addEventListener('error', (event) => {
      onStatus({ ts_recv: Date.now(), source: name, event: 'error', message: String(event.message || '') });
    });
    ws.addEventListener('close', (event) => {
      onStatus({ ts_recv: Date.now(), source: name, event: 'close', code: event.code, reason: event.reason });
      if (!stopped) {
        const delay = Math.min(30_000, 1_000 * 2 ** attempt++);
        setTimeout(connect, delay);
      }
    });
  };

  connect();
  return () => {
    stopped = true;
    try {
      ws?.close();
    } catch {}
  };
}

function main() {
  loadEnv();
  const config = loadConfig();
  const runDir = path.join(config.outputDir, `run-${nowIsoCompact()}`);
  mkdirp(runDir);
  fs.writeFileSync(path.join(runDir, 'config.json'), `${JSON.stringify(config, null, 2)}\n`);

  const cexWriter = makeWriter(path.join(runDir, 'cex_ticks.ndjson'));
  const compositeWriter = makeWriter(path.join(runDir, 'cex_composite.ndjson'));
  const chainlinkWriter = makeWriter(path.join(runDir, 'chainlink_reports.ndjson'));
  const polymarketRtdsWriter = makeWriter(path.join(runDir, 'polymarket_rtds_prices.ndjson'));
  const statusWriter = makeWriter(path.join(runDir, 'status.ndjson'));

  const state = new Map();
  let lastChainlinkKey = '';

  function updateState(exchange, patch) {
    const prev = state.get(exchange) || {};
    const next = { ...prev, ...patch, ts_recv: patch.ts_recv || Date.now() };
    if (Number.isFinite(next.bid) && Number.isFinite(next.ask)) {
      next.mid = (next.bid + next.ask) / 2;
    }
    state.set(exchange, next);
  }

  if (config.cex.binance) {
    const symbol = config.symbol.toLowerCase();
    const url = `wss://stream.binance.com:9443/stream?streams=${symbol}@bookTicker/${symbol}@trade`;
    connectWs('binance', url, null, (data) => {
      const msg = safeJsonParse(data);
      const recv = Date.now();
      const d = msg?.data || msg;
      if (!d) return;
      if (d.e === 'bookTicker' || d.u != null) {
        const row = {
          ts_recv: recv,
          exchange: 'binance',
          type: 'bookTicker',
          eventTime: Number(d.E || 0) || null,
          bid: Number(d.b),
          bidSize: Number(d.B),
          ask: Number(d.a),
          askSize: Number(d.A),
        };
        updateState('binance', row);
        cexWriter.write(row);
      } else if (d.e === 'trade') {
        cexWriter.write({
          ts_recv: recv,
          exchange: 'binance',
          type: 'trade',
          eventTime: Number(d.E || d.T || 0) || null,
          price: Number(d.p),
          size: Number(d.q),
          side: d.m ? 'sellAggressor' : 'buyAggressor',
        });
      }
    }, (row) => statusWriter.write(row));
  }

  if (config.cex.gateio) {
    connectWs('gateio', 'wss://api.gateio.ws/ws/v4/', (ws) => {
      ws.send(JSON.stringify({ time: Math.floor(Date.now() / 1000), channel: 'spot.book_ticker', event: 'subscribe', payload: ['BTC_USDT'] }));
      ws.send(JSON.stringify({ time: Math.floor(Date.now() / 1000), channel: 'spot.trades', event: 'subscribe', payload: ['BTC_USDT'] }));
    }, (data) => {
      const msg = safeJsonParse(data);
      const recv = Date.now();
      if (msg?.event && msg.event !== 'update') {
        statusWriter.write({ ts_recv: recv, source: 'gateio', event: msg.event, channel: msg.channel, result: msg.result });
        return;
      }
      if (msg?.channel === 'spot.book_ticker') {
        const r = Array.isArray(msg.result) ? msg.result[0] : msg.result;
        const row = {
          ts_recv: recv,
          exchange: 'gateio',
          type: 'bookTicker',
          eventTime: Number(msg.time_ms || msg.time || 0) || null,
          bid: Number(r?.b || r?.highest_bid),
          bidSize: Number(r?.B || r?.base_bid_size),
          ask: Number(r?.a || r?.lowest_ask),
          askSize: Number(r?.A || r?.base_ask_size),
        };
        if (Number.isFinite(row.bid) && Number.isFinite(row.ask)) {
          updateState('gateio', row);
          cexWriter.write(row);
        }
      } else if (msg?.channel === 'spot.trades') {
        const arr = Array.isArray(msg.result) ? msg.result : [msg.result];
        for (const r of arr) {
          cexWriter.write({
            ts_recv: recv,
            exchange: 'gateio',
            type: 'trade',
            eventTime: Number(r?.create_time_ms || msg.time_ms || 0) || null,
            price: Number(r?.price),
            size: Number(r?.amount),
            side: r?.side,
          });
        }
      }
    }, (row) => statusWriter.write(row));
  }

  if (config.cex.bitget) {
    connectWs('bitget', 'wss://ws.bitget.com/v2/ws/public', (ws) => {
      ws.send(JSON.stringify({
        op: 'subscribe',
        args: [
          { instType: 'SPOT', channel: 'ticker', instId: config.symbol },
          { instType: 'SPOT', channel: 'trade', instId: config.symbol },
        ],
      }));
      setInterval(() => {
        try {
          ws.send('ping');
        } catch {}
      }, 25_000).unref?.();
    }, (data) => {
      if (String(data) === 'pong') return;
      const msg = safeJsonParse(data);
      const recv = Date.now();
      if (msg?.event) {
        statusWriter.write({ ts_recv: recv, source: 'bitget', event: msg.event, arg: msg.arg, code: msg.code, msg: msg.msg });
        return;
      }
      if (msg?.arg?.channel === 'ticker') {
        for (const r of msg.data || []) {
          const row = {
            ts_recv: recv,
            exchange: 'bitget',
            type: 'bookTicker',
            eventTime: Number(r.ts || 0) || null,
            bid: Number(r.bidPr || r.bidPx),
            bidSize: Number(r.bidSz),
            ask: Number(r.askPr || r.askPx),
            askSize: Number(r.askSz),
          };
          if (Number.isFinite(row.bid) && Number.isFinite(row.ask)) {
            updateState('bitget', row);
            cexWriter.write(row);
          }
        }
      } else if (msg?.arg?.channel === 'trade') {
        for (const r of msg.data || []) {
          cexWriter.write({
            ts_recv: recv,
            exchange: 'bitget',
            type: 'trade',
            eventTime: Number(r.ts || 0) || null,
            price: Number(r.price || r.pr),
            size: Number(r.size || r.sz),
            side: r.side,
          });
        }
      }
    }, (row) => statusWriter.write(row));
  }

  if (config.polymarketRtds?.enabled) {
    connectWs('polymarket_rtds', 'wss://ws-live-data.polymarket.com', (ws) => {
      const subscriptions = [
        {
          topic: 'crypto_prices_chainlink',
          type: '*',
          filters: JSON.stringify({ symbol: config.polymarketRtds.chainlinkSymbol || 'btc/usd' }),
        },
        {
          topic: 'crypto_prices',
          type: '*',
          filters: JSON.stringify({ symbol: config.polymarketRtds.binanceSymbol || 'btcusdt' }),
        },
      ];
      ws.send(JSON.stringify({ action: 'subscribe', subscriptions }));
    }, (data) => {
      const recv = Date.now();
      const msg = safeJsonParse(data);
      if (!msg) {
        statusWriter.write({ ts_recv: recv, source: 'polymarket_rtds', event: 'raw', data: String(data).slice(0, 300) });
        return;
      }
      if (msg.status || msg.error || msg.message === 'PONG') {
        statusWriter.write({ ts_recv: recv, source: 'polymarket_rtds', event: 'status', data: msg });
        return;
      }
      const payload = msg.payload || msg.data || msg;
      const topic = msg.topic || payload.topic;
      const price = Number(payload.value ?? payload.price ?? payload.p ?? payload.c);
      polymarketRtdsWriter.write({
        ts_recv: recv,
        source: 'polymarket_rtds',
        topic,
        type: msg.type || payload.type || null,
        symbol: payload.symbol || payload.s || null,
        timestamp: Number(payload.timestamp || payload.ts || payload.time || 0) || null,
        price: Number.isFinite(price) ? price : null,
        raw: msg,
      });
    }, (row) => statusWriter.write(row));
  }

  const compositeTimer = setInterval(() => {
    const recv = Date.now();
    const rows = [...state.entries()]
      .map(([exchange, x]) => ({ exchange, ...x }))
      .filter((x) => recv - x.ts_recv <= 3_000 && Number.isFinite(x.mid));
    if (!rows.length) return;
    const mids = rows.map((x) => x.mid).sort((a, b) => a - b);
    const median = mids[Math.floor(mids.length / 2)];
    const mean = mids.reduce((a, b) => a + b, 0) / mids.length;
    compositeWriter.write({
      ts_recv: recv,
      source: 'cex_composite',
      exchanges: rows.map((x) => x.exchange),
      n: rows.length,
      medianMid: median,
      meanMid: mean,
      mids: Object.fromEntries(rows.map((x) => [x.exchange, x.mid])),
      spreads: Object.fromEntries(rows.map((x) => [x.exchange, x.ask - x.bid])),
    });
  }, Number(config.cex.compositeMs || 100));

  let chainlinkTimer = null;
  if (hasDirectChainlinkConfig(config)) {
    async function pollChainlink() {
      try {
        const row = await fetchChainlinkLatest(config);
        const key = `${row.feedID}:${row.observationsTimestamp}:${row.decoded?.priceRaw || ''}`;
        if (key !== lastChainlinkKey) {
          lastChainlinkKey = key;
          chainlinkWriter.write(row);
        }
      } catch (err) {
        statusWriter.write({ ts_recv: Date.now(), source: 'chainlink', event: 'error', message: err.message });
      }
    }
    chainlinkTimer = setInterval(pollChainlink, Number(config.chainlink.pollMs || 250));
    pollChainlink();
  } else {
    statusWriter.write({
      ts_recv: Date.now(),
      source: 'chainlink',
      event: 'disabled',
      message: 'missing direct Chainlink credentials/feedId; using Polymarket RTDS fallback if enabled',
    });
  }

  console.log(`writing lead-lag data to ${runDir}`);
  console.log('stop with Ctrl-C');

  function shutdown() {
    clearInterval(compositeTimer);
    if (chainlinkTimer) clearInterval(chainlinkTimer);
    cexWriter.close();
    compositeWriter.close();
    chainlinkWriter.close();
    polymarketRtdsWriter.close();
    statusWriter.close();
    process.exit(0);
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) {
  main();
}

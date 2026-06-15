'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const runDir = process.argv[2];
const minLag = Number(process.env.MIN_LAG_MS || -5000);
const maxLag = Number(process.env.MAX_LAG_MS || 5000);
const step = Number(process.env.LAG_STEP_MS || 100);
const nearestToleranceMs = Number(process.env.NEAREST_TOL_MS || 300);

if (!runDir) {
  console.error('usage: node analyze-chainlink-cex-leadlag.js <run-dir>');
  process.exit(1);
}

async function readNdjson(file, cb) {
  if (!fs.existsSync(file)) return;
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    try {
      cb(JSON.parse(line));
    } catch {}
  }
}

function corr(xs, ys) {
  if (xs.length < 3) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < xs.length; i += 1) {
    const x = xs[i] - mx;
    const y = ys[i] - my;
    num += x * y;
    dx += x * x;
    dy += y * y;
  }
  if (!dx || !dy) return null;
  return num / Math.sqrt(dx * dy);
}

function round(n, d = 6) {
  return n == null || Number.isNaN(n) ? null : Number(Number(n).toFixed(d));
}

function nearestByTs(rows, targetTs) {
  let lo = 0;
  let hi = rows.length - 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (rows[mid].ts < targetTs) lo = mid + 1;
    else hi = mid;
  }
  const candidates = [rows[lo], rows[lo - 1], rows[lo + 1]].filter(Boolean);
  let best = null;
  for (const x of candidates) {
    const dist = Math.abs(x.ts - targetTs);
    if (!best || dist < best.dist) best = { row: x, dist };
  }
  return best && best.dist <= nearestToleranceMs ? best : null;
}

function metricsForLag(chainlink, composite, lagMs, tsField) {
  const cexPrices = [];
  const clPrices = [];
  const diffs = [];

  for (const cl of chainlink) {
    const ts = cl[tsField];
    if (!Number.isFinite(ts)) continue;
    const match = nearestByTs(composite, ts + lagMs);
    if (!match) continue;
    const cex = match.row.price;
    const diff = cex - cl.price;
    cexPrices.push(cex);
    clPrices.push(cl.price);
    diffs.push(diff);
  }

  if (!diffs.length) {
    return { lagMs, n: 0 };
  }

  const mae = diffs.reduce((a, b) => a + Math.abs(b), 0) / diffs.length;
  const mse = diffs.reduce((a, b) => a + b * b, 0) / diffs.length;
  const meanSigned = diffs.reduce((a, b) => a + b, 0) / diffs.length;

  return {
    lagMs,
    n: diffs.length,
    mae: round(mae, 4),
    rmse: round(Math.sqrt(mse), 4),
    meanSigned: round(meanSigned, 4),
    corr: round(corr(cexPrices, clPrices), 6),
  };
}

function returnMetricsForLag(chainlink, composite, lagMs, tsField) {
  const pairs = [];
  for (const cl of chainlink) {
    const ts = cl[tsField];
    if (!Number.isFinite(ts)) continue;
    const match = nearestByTs(composite, ts + lagMs);
    if (match) pairs.push({ ts, cl: cl.price, cex: match.row.price });
  }
  pairs.sort((a, b) => a.ts - b.ts);
  if (pairs.length < 4) return { lagMs, n: pairs.length };

  const clRet = [];
  const cexRet = [];
  for (let i = 1; i < pairs.length; i += 1) {
    clRet.push(pairs[i].cl - pairs[i - 1].cl);
    cexRet.push(pairs[i].cex - pairs[i - 1].cex);
  }

  return {
    lagMs,
    n: clRet.length,
    returnCorr: round(corr(cexRet, clRet), 6),
    sameDirectionPct: round(
      (100 * clRet.filter((x, i) => Math.sign(x) === Math.sign(cexRet[i])).length) / clRet.length,
      2,
    ),
  };
}

async function main() {
  const chainlink = [];
  const composite = [];
  await readNdjson(path.join(runDir, 'chainlink_reports.ndjson'), (row) => {
    const price = Number(row.decoded?.price);
    if (!Number.isFinite(price)) return;
    chainlink.push({
      recvTs: Number(row.ts_recv),
      obsTs: Number(row.observationsTimestamp || row.decoded?.observationsTimestamp) * 1000,
      price,
      bid: Number(row.decoded?.bid),
      ask: Number(row.decoded?.ask),
    });
  });
  await readNdjson(path.join(runDir, 'cex_composite.ndjson'), (row) => {
    const price = Number(row.medianMid || row.meanMid);
    if (!Number.isFinite(price)) return;
    composite.push({ ts: Number(row.ts_recv), price, n: Number(row.n || 0), exchanges: row.exchanges });
  });

  chainlink.sort((a, b) => a.recvTs - b.recvTs);
  composite.sort((a, b) => a.ts - b.ts);

  if (!chainlink.length || !composite.length) {
    console.error(`not enough data: chainlink=${chainlink.length}, composite=${composite.length}`);
    process.exit(1);
  }

  const results = [];
  const returnResults = [];
  for (let lag = minLag; lag <= maxLag; lag += step) {
    results.push(metricsForLag(chainlink, composite, lag, 'recvTs'));
    returnResults.push(returnMetricsForLag(chainlink, composite, lag, 'recvTs'));
  }

  const rankedByMae = results.filter((x) => x.n >= Math.max(3, chainlink.length * 0.5)).sort((a, b) => a.mae - b.mae);
  const rankedByReturnCorr = returnResults
    .filter((x) => x.n >= Math.max(3, chainlink.length * 0.5) && x.returnCorr != null)
    .sort((a, b) => b.returnCorr - a.returnCorr);

  const summary = {
    runDir: path.resolve(runDir),
    settings: { minLag, maxLag, step, nearestToleranceMs },
    counts: { chainlink: chainlink.length, composite: composite.length },
    timeRange: {
      chainlinkFirst: new Date(chainlink[0].recvTs).toISOString(),
      chainlinkLast: new Date(chainlink[chainlink.length - 1].recvTs).toISOString(),
      compositeFirst: new Date(composite[0].ts).toISOString(),
      compositeLast: new Date(composite[composite.length - 1].ts).toISOString(),
    },
    bestByLevelMae: rankedByMae.slice(0, 10),
    bestByReturnCorr: rankedByReturnCorr.slice(0, 10),
    interpretation: {
      lagDefinition:
        'lagMs is applied to Chainlink receive timestamp when looking up CEX: compare Chainlink(t) with CEX(t + lagMs). Negative best lag means CEX before Chainlink matches better, i.e. CEX leads Chainlink by roughly abs(lagMs).',
    },
  };

  const out = path.join(runDir, 'leadlag-summary.json');
  fs.writeFileSync(out, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});


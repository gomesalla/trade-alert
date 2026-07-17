// Multi-Coin Long/Short Setup Alert
// Reads coins + tuning params from config.json — add/remove coins there, no code changes.
//
// v2 change from the original: resistance/support zones are no longer hand-typed
// price levels (those go stale as soon as the market moves and don't scale to a
// 15-coin watchlist). Instead each run auto-detects swing high/low from recent
// closed candles and layers three real filters on top before it will fire:
//   - RSI: only alert on a setup that lines up with overbought/oversold context
//   - EMA50/EMA200 trend: only take breakdown/breakout in the direction of trend
//   - Volume: breakdown/breakout must come on above-average volume
// Both long (bounce/breakout) and short (rejection/breakdown) setups are checked
// per coin now, not just short.
//
// Data: Binance public REST (data-api.binance.vision, CORS/API-key free)
// Push: ntfy.sh
// State: state.json (committed back by the workflow) — per-coin cooldown/hysteresis

const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');
const STATE_PATH = path.join(__dirname, '..', 'state.json');

const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const DEFAULTS = config.defaults || {};
const NTFY_TOPIC = config.ntfyTopic;
const COOLDOWN_MS = (config.cooldownHours || 6) * 60 * 60 * 1000;

// ---------- config helpers ----------

function param(coin, key) {
  return coin[key] !== undefined ? coin[key] : DEFAULTS[key];
}

function direction(coin) {
  return param(coin, 'direction') || 'both';
}

// ---------- state ----------

const EMPTY_COIN_STATE = {
  touchedZoneHigh: false,   // price tagged resistance, waiting on a rejection confirm
  touchedZoneHighRSI: false, // was RSI overbought at the moment it tagged resistance
  touchedZoneLow: false,    // price tagged support, waiting on a bounce confirm
  touchedZoneLowRSI: false, // was RSI oversold at the moment it tagged support
  lastRejectionAlertAt: 0,
  lastBreakdownAlertAt: 0,
  lastBounceAlertAt: 0,
  lastBreakoutAlertAt: 0,
};

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function coinState(state, symbol) {
  // Merge onto defaults so upgrading the state shape (e.g. adding long-side
  // fields) doesn't blow away a coin's existing short-side cooldown history.
  state[symbol] = Object.assign({}, EMPTY_COIN_STATE, state[symbol] || {});
  return state[symbol];
}

// ---------- data fetch ----------

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Fetch failed ${res.status}: ${url}`);
  return res.json();
}

async function getPrice(symbol) {
  const data = await fetchJSON(`https://data-api.binance.vision/api/v3/ticker/price?symbol=${symbol}`);
  return parseFloat(data.price);
}

async function getKlines(symbol, interval, limit) {
  const raw = await fetchJSON(
    `https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`
  );
  // Binance's last entry is the still-forming candle — drop it so indicators
  // and swing levels are based on fully closed candles only.
  const closed = raw.slice(0, -1);
  return {
    closes: closed.map(k => parseFloat(k[4])),
    highs: closed.map(k => parseFloat(k[2])),
    lows: closed.map(k => parseFloat(k[3])),
    volumes: closed.map(k => parseFloat(k[5])),
  };
}

// ---------- indicators ----------

function wilderRSI(closes, period) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function computeEMA(closes, period) {
  if (closes.length < period) return null;
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period; // SMA seed
  const k = 2 / (period + 1);
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
  }
  return ema;
}

function swingHigh(highs, lookback) {
  return Math.max(...highs.slice(-lookback));
}

function swingLow(lows, lookback) {
  return Math.min(...lows.slice(-lookback));
}

function avgVolume(volumes, lookback) {
  // average of the N closed candles before the most recent closed candle
  const window = volumes.slice(-(lookback + 1), -1);
  if (window.length === 0) return null;
  return window.reduce((a, b) => a + b, 0) / window.length;
}

// ---------- alerts ----------

async function pushAlert(title, message, tags) {
  if (process.env.DRY_RUN) {
    console.log(`[DRY RUN] would push: ${title} — ${message}`);
    return;
  }
  await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
    method: 'POST',
    headers: { Title: title, Priority: 'high', Tags: tags },
    body: message,
  });
  console.log(`ALERT SENT: ${title} — ${message}`);
}

function fmt(n) {
  if (n >= 1) return n.toFixed(2);
  // small-price coins (PEPE, SHIB, LUNC) need more decimals to be readable
  return n.toPrecision(4);
}

function targetsDown(fromLevel, pcts) {
  return pcts.map(p => fmt(fromLevel * (1 - p / 100))).join(' / ');
}

function targetsUp(fromLevel, pcts) {
  return pcts.map(p => fmt(fromLevel * (1 + p / 100))).join(' / ');
}

// ---------- per-coin check ----------

async function checkCoin(coin, state) {
  const cs = coinState(state, coin.symbol);
  const now = Date.now();
  const dir = direction(coin); // 'short' | 'long' | 'both'
  const interval = param(coin, 'interval');
  const klineLimit = param(coin, 'klineLimit');
  const lookback = param(coin, 'lookbackCandles');
  const rsiPeriod = param(coin, 'rsiPeriod');
  const rsiOverbought = param(coin, 'rsiOverbought');
  const rsiOversold = param(coin, 'rsiOversold');
  const emaFastP = param(coin, 'emaFast');
  const emaSlowP = param(coin, 'emaSlow');
  const volumeLookback = param(coin, 'volumeLookback');
  const volumeMultiplier = param(coin, 'volumeMultiplier');
  const zoneEnterBufferPct = param(coin, 'zoneEnterBufferPct');
  const confirmBufferPct = param(coin, 'confirmBufferPct');
  const stopBufferPct = param(coin, 'stopBufferPct');
  const targetPcts = param(coin, 'targetPcts');

  let price, k;
  try {
    [price, k] = await Promise.all([
      getPrice(coin.symbol),
      getKlines(coin.symbol, interval, klineLimit),
    ]);
  } catch (err) {
    console.error(`${coin.label}: fetch error — ${err.message}`);
    return; // skip this coin this run, don't crash the others
  }

  if (k.closes.length < Math.max(rsiPeriod + 1, emaSlowP, lookback)) {
    console.warn(`${coin.label}: not enough candle history yet, skipping`);
    return;
  }

  const rsi = wilderRSI(k.closes, rsiPeriod);
  const emaFast = computeEMA(k.closes, emaFastP);
  const emaSlow = computeEMA(k.closes, emaSlowP);
  const resistance = swingHigh(k.highs, lookback);
  const support = swingLow(k.lows, lookback);
  const lastVol = k.volumes[k.volumes.length - 1];
  const avgVol = avgVolume(k.volumes, volumeLookback);
  const volumeConfirmed = avgVol !== null && lastVol > avgVol * volumeMultiplier;
  const uptrend = emaFast !== null && emaSlow !== null && emaFast > emaSlow && price > emaFast;
  const downtrend = emaFast !== null && emaSlow !== null && emaFast < emaSlow && price < emaFast;

  console.log(
    `${coin.label} price=${price} rsi=${rsi.toFixed(1)} resistance=${fmt(resistance)} support=${fmt(support)} ` +
    `trend=${uptrend ? 'up' : downtrend ? 'down' : 'flat'} vol=${volumeConfirmed ? 'confirmed' : 'quiet'} ` +
    `state=${JSON.stringify(cs)}`
  );

  const doShort = dir === 'short' || dir === 'both';
  const doLong = dir === 'long' || dir === 'both';

  // ---------- SHORT: rejection at resistance ----------
  if (doShort) {
    const zoneEnter = resistance * (1 - zoneEnterBufferPct / 100);
    const confirmBelow = resistance * (1 - confirmBufferPct / 100);

    if (price >= zoneEnter) {
      cs.touchedZoneHigh = true;
      cs.touchedZoneHighRSI = rsi >= rsiOverbought;
    }

    if (
      cs.touchedZoneHigh && cs.touchedZoneHighRSI &&
      price < confirmBelow &&
      now - cs.lastRejectionAlertAt > COOLDOWN_MS
    ) {
      const stop = resistance * (1 + stopBufferPct / 100);
      await pushAlert(
        `${coin.label}: Rejection at resistance`,
        `${coin.label} rejected near $${fmt(resistance)} (auto swing high, ${lookback}-candle), now $${fmt(price)}. ` +
        `RSI was overbought (${rsi.toFixed(0)}) at the touch. Short entry. Stop: above $${fmt(stop)}. ` +
        `Targets: ${targetsDown(confirmBelow, targetPcts)}.`,
        'chart_with_downwards_trend'
      );
      cs.lastRejectionAlertAt = now;
      cs.touchedZoneHigh = false;
      cs.touchedZoneHighRSI = false;
    }

    // ---------- SHORT: breakdown below support ----------
    const breakdownConfirm = support * (1 - confirmBufferPct / 100);
    if (
      price < breakdownConfirm &&
      downtrend &&
      rsi < 50 &&
      volumeConfirmed &&
      now - cs.lastBreakdownAlertAt > COOLDOWN_MS
    ) {
      const stop = support * (1 + stopBufferPct / 100);
      await pushAlert(
        `${coin.label}: Breakdown confirmed`,
        `${coin.label} broke below $${fmt(support)} (auto swing low, ${lookback}-candle), now $${fmt(price)}. ` +
        `RSI ${rsi.toFixed(0)}, EMA${emaFastP}<EMA${emaSlowP} downtrend, volume ${(lastVol / avgVol).toFixed(1)}x average. ` +
        `Short confirmation. Stop: above $${fmt(stop)}. Targets: ${targetsDown(breakdownConfirm, targetPcts)}.`,
        'chart_with_downwards_trend'
      );
      cs.lastBreakdownAlertAt = now;
    }
  }

  // ---------- LONG: bounce at support ----------
  if (doLong) {
    const zoneEnter = support * (1 + zoneEnterBufferPct / 100);
    const confirmAbove = support * (1 + confirmBufferPct / 100);

    if (price <= zoneEnter) {
      cs.touchedZoneLow = true;
      cs.touchedZoneLowRSI = rsi <= rsiOversold;
    }

    if (
      cs.touchedZoneLow && cs.touchedZoneLowRSI &&
      price > confirmAbove &&
      now - cs.lastBounceAlertAt > COOLDOWN_MS
    ) {
      const stop = support * (1 - stopBufferPct / 100);
      await pushAlert(
        `${coin.label}: Bounce at support`,
        `${coin.label} bounced near $${fmt(support)} (auto swing low, ${lookback}-candle), now $${fmt(price)}. ` +
        `RSI was oversold (${rsi.toFixed(0)}) at the touch. Long entry. Stop: below $${fmt(stop)}. ` +
        `Targets: ${targetsUp(confirmAbove, targetPcts)}.`,
        'chart_with_upwards_trend'
      );
      cs.lastBounceAlertAt = now;
      cs.touchedZoneLow = false;
      cs.touchedZoneLowRSI = false;
    }

    // ---------- LONG: breakout above resistance ----------
    const breakoutConfirm = resistance * (1 + confirmBufferPct / 100);
    if (
      price > breakoutConfirm &&
      uptrend &&
      rsi > 50 &&
      volumeConfirmed &&
      now - cs.lastBreakoutAlertAt > COOLDOWN_MS
    ) {
      const stop = resistance * (1 - stopBufferPct / 100);
      await pushAlert(
        `${coin.label}: Breakout confirmed`,
        `${coin.label} broke above $${fmt(resistance)} (auto swing high, ${lookback}-candle), now $${fmt(price)}. ` +
        `RSI ${rsi.toFixed(0)}, EMA${emaFastP}>EMA${emaSlowP} uptrend, volume ${(lastVol / avgVol).toFixed(1)}x average. ` +
        `Long confirmation. Stop: below $${fmt(stop)}. Targets: ${targetsUp(breakoutConfirm, targetPcts)}.`,
        'chart_with_upwards_trend'
      );
      cs.lastBreakoutAlertAt = now;
    }
  }
}

async function main() {
  const state = loadState();
  for (const coin of config.coins) {
    await checkCoin(coin, state);
  }
  saveState(state);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

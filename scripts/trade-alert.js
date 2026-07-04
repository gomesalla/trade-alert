// Multi-Coin Short-Setup Alert
// Reads coins + levels from config.json — add/remove coins there, no code changes.
// Data: Binance public REST (data-api.binance.vision, CORS/API-key free)
// Push: ntfy.sh
// State: state.json (committed back by the workflow) — per-coin cooldown/hysteresis

const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');
const STATE_PATH = path.join(__dirname, '..', 'state.json');

const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const NTFY_TOPIC = config.ntfyTopic;
const COOLDOWN_MS = (config.cooldownHours || 6) * 60 * 60 * 1000;

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
    if (!state[symbol]) {
          state[symbol] = { touchedZoneHigh: false, lastRejectionAlertAt: 0, lastBreakdownAlertAt: 0 };
    }
    return state[symbol];
}

async function fetchJSON(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Fetch failed ${res.status}: ${url}`);
    return res.json();
}

async function getPrice(symbol) {
    const data = await fetchJSON(`https://data-api.binance.vision/api/v3/ticker/price?symbol=${symbol}`);
    return parseFloat(data.price);
}

async function getRSI(symbol, period = 14) {
    const klines = await fetchJSON(
          `https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=4h&limit=${period + 50}`
        );
    const closes = klines.map(k => parseFloat(k[4]));
    return wilderRSI(closes, period);
}

function wilderRSI(closes, period) {
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

async function pushAlert(title, message, tags) {
    await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
          method: 'POST',
          headers: { Title: title, Priority: 'high', Tags: tags },
          body: message,
    });
    console.log(`ALERT SENT: ${title} — ${message}`);
}

async function checkCoin(coin, state) {
    const cs = coinState(state, coin.symbol);
    const now = Date.now();

  let price, rsi;
    try {
          [price, rsi] = await Promise.all([getPrice(coin.symbol), getRSI(coin.symbol)]);
    } catch (err) {
          console.error(`${coin.label}: fetch error — ${err.message}`);
          return; // skip this coin this run, don't crash the others
    }

  console.log(`${coin.label} price=${price} rsi=${rsi.toFixed(1)} state=${JSON.stringify(cs)}`);

  if (price >= coin.rejectionZoneEnter) cs.touchedZoneHigh = true;

  // Rejection setup
  if (cs.touchedZoneHigh && price < coin.rejectionConfirmBelow &&
            now - cs.lastRejectionAlertAt > COOLDOWN_MS) {
        await pushAlert(
                `${coin.label}: Rejection at resistance`,
                `${coin.label} rejected at $${coin.rejectionZoneEnter} zone, now $${price} (RSI ${rsi.toFixed(0)}). ` +
                `${coin.direction} entry. Stop: above $${coin.stopRejection}. Targets: ${coin.targets}.`,
                'chart_with_downwards_trend'
              );
        cs.lastRejectionAlertAt = now;
        cs.touchedZoneHigh = false;
  }

  // Breakdown setup
  if (price < coin.breakdownConfirmBelow &&
            now - cs.lastBreakdownAlertAt > COOLDOWN_MS) {
        await pushAlert(
                `${coin.label}: Breakdown confirmed`,
                `${coin.label} broke below $${coin.breakdownLevel}, now $${price} (RSI ${rsi.toFixed(0)}). ` +
                `${coin.direction} confirmation. Stop: above $${coin.stopBreakdown}. Targets: ${coin.targets}.`,
                'chart_with_downwards_trend'
              );
        cs.lastBreakdownAlertAt = now;
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

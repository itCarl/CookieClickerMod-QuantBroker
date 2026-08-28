/**
 * Quant Broker - a stock market assistant for Cookie Clicker's Bank.
 *
 * The core idea, and the reason it differs from threshold bots: the market's
 * price distribution is nothing like a tight band around the resting value.
 * Measured over 200k ticks at bank level 10, good #0 spends 54% of its time
 * above 1.2x its resting value while good #15 spends 3.5% there. Any fixed
 * multiple of the resting value is therefore far too loose for some goods and
 * literally unreachable for others.
 *
 * So this bot does not guess levels. It learns each good's own price
 * distribution online with a stochastic quantile estimator, buys near the low
 * quantile and sells near the high one, and refuses any trade whose spread
 * does not clear broker overhead plus a required margin. Positions carry a
 * cost basis so a sale can never silently realise a loss.
 *
 * See README.md for the full rationale and the benchmark.
 */
(function () {
'use strict';

var MOD_ID   = 'quant broker';
var VERSION  = '1.1';
var PANEL_ID = 'quantBrokerPanel';

/* ------------------------------------------------------------------ *
 * Settings
 * ------------------------------------------------------------------ */

var DEFAULTS = {
	enabled:         true,   // master switch
	useHiddenState:  true,   // read good.d / good.dur (momentum + regime timer)
	autoBrokers:     true,   // hire brokers automatically
	buyQuantile:     0.34,   // buy at or below this quantile of the good's own prices
	sellQuantile:    0.66,   // sell at or above this quantile
	minMargin:       0.02,   // required margin over cost basis before selling
	maxDeployPct:    0.50,   // most of your cookies the bot may spend in one tick
	brokerBudgetPct: 0.02,   // a broker may cost at most this share of your cookies
	minOverhead:     0.005,  // stop hiring brokers once overhead is below this
	maxHoldTicks:    160,    // max consecutive ticks to ride momentum past the sell line
	learnRate:       0.0003, // quantile step size, as a share of the resting value
	warmupTicks:     20,     // ticks of observation before a good becomes tradable
	allowLoss:       false,  // enable the stop-loss (off: the bot never sells at a loss)
	stopLossPct:     0.35    // cut a position this far below its cost basis
};

var SETTINGS_META = [
	{key:'enabled',         type:'bool', label:'Assistant enabled'},
	{key:'autoBrokers',     type:'bool', label:'Auto-hire brokers'},
	{key:'useHiddenState',  type:'bool', label:'Use hidden market state (momentum + regime timer)'},
	{key:'allowLoss',       type:'bool', label:'Allow stop-loss selling'},
	{key:'buyQuantile',     type:'pct',  label:'Buy below this price quantile',    min:0.01,  max:0.60, step:0.01},
	{key:'sellQuantile',    type:'pct',  label:'Sell above this price quantile',   min:0.40,  max:0.99, step:0.01},
	{key:'minMargin',       type:'pct',  label:'Required margin before selling',   min:0,     max:1,    step:0.01},
	{key:'maxDeployPct',    type:'pct',  label:'Max cookies deployed per tick',    min:0.01,  max:1,    step:0.01},
	{key:'brokerBudgetPct', type:'pct',  label:'Broker budget (share of cookies)', min:0.001, max:0.5,  step:0.001},
	{key:'minOverhead',     type:'pct',  label:'Stop hiring below overhead',       min:0,     max:0.2,  step:0.005},
	{key:'stopLossPct',     type:'pct',  label:'Stop-loss threshold',              min:0.05,  max:0.9,  step:0.05},
	{key:'learnRate',       type:'pct',  label:'Quantile learning rate',           min:0.0002,max:0.05, step:0.0002},
	{key:'maxHoldTicks',    type:'int',  label:'Max ticks riding momentum',        min:0,     max:400,  step:5},
	{key:'warmupTicks',     type:'int',  label:'Warm-up ticks before trading',     min:0,     max:200,  step:5}
];

var S = {};
(function () { for (var k in DEFAULTS) S[k] = DEFAULTS[k]; })();

/* ------------------------------------------------------------------ *
 * State
 * ------------------------------------------------------------------ */

var stats     = {buys:0, sells:0, realizedS:0, realizedC:0, brokersHired:0};
var positions = {};   // goodId -> {units, costS, costC}
var quants    = {};   // goodId -> {lo, hi, n}  learned price quantiles
var holdTicks = {};   // goodId -> consecutive ticks held past the sell line
var view      = [];   // per-good display snapshot, rebuilt each market tick
var lastTick  = -1;
var lastBankLevel = -1;   // to detect bank level-ups and shift the quantiles
var overhead  = 1.2;
var showSettings = false;
var statusText   = 'waiting for the Stock Market';

var MODE_NAMES = ['stable', 'slow rise', 'slow fall', 'fast rise', 'fast fall', 'chaotic'];

// Trend is shown as a glyph rather than a word: an arrow per direction, doubled
// for the fast regimes, and a tilde for chaos. Escapes rather than literals so
// the file stays plain ASCII whatever encoding it is read with.
var MODE_GLYPH = ['\u2014', '\u2191', '\u2193', '\u2191\u2191', '\u2193\u2193', '~'];
var MODE_COLOR = ['#9a9a9a', '#5fd35f', '#ff6b6b', '#5fd35f', '#ff6b6b', '#f5a623'];

// Modest per-regime nudge on the learned levels. The quantiles already capture
// the unconditional distribution; this only leans into the current regime.
// allowBuy=false means we will only ever exit while that regime lasts.
var MODE_BIAS = [
	{buy:1.00, sell:1.00, allowBuy:true },  // 0 stable
	{buy:1.03, sell:1.06, allowBuy:true },  // 1 slow rise
	{buy:0.95, sell:0.99, allowBuy:true },  // 2 slow fall
	{buy:1.05, sell:1.12, allowBuy:true },  // 3 fast rise
	{buy:0.90, sell:0.97, allowBuy:false},  // 4 fast fall
	{buy:0.97, sell:1.05, allowBuy:true }   // 5 chaotic
];

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

function market() {
	var bank = Game.Objects['Bank'];
	if (!bank || !Game.isMinigameReady(bank)) return null;
	var m = bank.minigame;
	if (!m || !m.goodsById || !m.goodsById.length) return null;
	return m;
}

function overheadOf(m) { return 1 + 0.01 * (20 * Math.pow(0.95, m.brokers)); }

function rate() {
	var r = Game.cookiesPsRawHighest;
	return (typeof r === 'number' && isFinite(r) && r > 0) ? r : 0;
}

function pos(id) {
	var p = positions[id];
	if (!p) { p = positions[id] = {units:0, costS:0, costC:0}; }
	return p;
}

function basisPerUnit(id) {
	var p = positions[id];
	return (p && p.units > 0) ? p.costS / p.units : 0;
}

function fmtCookies(n) {
	var sign = n < 0 ? '-' : '', a = Math.abs(n);
	if (typeof Beautify === 'function') return sign + Beautify(a, 1);
	return sign + Math.round(a);
}

function fmtDollars(n) {
	var sign = n < 0 ? '-$' : '$', a = Math.abs(n);
	if (a >= 1e6 && typeof Beautify === 'function') return sign + Beautify(a, 1);
	return sign + a.toFixed(2);
}

/* ------------------------------------------------------------------ *
 * Learned price quantiles
 *
 * Stochastic quantile estimation: for target quantile p, stepping q by
 * +lr*p when the sample lands above it and by -lr*(1-p) when it lands below
 * settles exactly where P(price < q) = p. Two numbers per good, no history
 * buffer, adapts automatically to bank level and to the dragon aura's extra
 * volatility, and is small enough to keep in the save file.
 * ------------------------------------------------------------------ */

// Measured shape of the stationary price distribution (dev/probe.js, 200k ticks):
// for each quantile, price is close to linear in the good's resting value.
// Columns are [quantile, slope, intercept]. Used only as a cold start; the
// estimator takes over from there.
var QUANTILE_ANCHORS = [
	[0.05, 0.123,  0.27],
	[0.10, 0.275, -1.33],
	[0.25, 0.545, -2.66],
	[0.50, 0.681, 13.96],
	[0.75, 0.665, 43.60],
	[0.90, 0.604, 77.02],
	[0.95, 0.571, 97.45]
];

// Interpolates a starting estimate for an arbitrary quantile, so changing
// buyQuantile or sellQuantile still starts from a sensible place.
function seedQuantile(restingVal, p) {
	var a = QUANTILE_ANCHORS;
	if (p <= a[0][0])                 return Math.max(1, a[0][1] * restingVal + a[0][2]);
	if (p >= a[a.length - 1][0])      return Math.max(1, a[a.length - 1][1] * restingVal + a[a.length - 1][2]);
	for (var i = 1; i < a.length; i++) {
		if (p <= a[i][0]) {
			var t = (p - a[i - 1][0]) / (a[i][0] - a[i - 1][0]);
			var slope = a[i - 1][1] + (a[i][1] - a[i - 1][1]) * t;
			var inter = a[i - 1][2] + (a[i][2] - a[i - 1][2]) * t;
			return Math.max(1, slope * restingVal + inter);
		}
	}
	return restingVal;
}

function quant(id, restingVal) {
	var q = quants[id];
	if (!q) {
		var lo = seedQuantile(restingVal, S.buyQuantile);
		var hi = seedQuantile(restingVal, S.sellQuantile);
		q = quants[id] = {lo: lo, hi: Math.max(hi, lo * 1.05), n: 0};
	}
	return q;
}

// A bank level-up shifts every good's resting value by exactly +1 and the soft
// ceiling by +3, so the whole price distribution moves with it. Shifting the
// learned quantiles by the same amount keeps them valid immediately instead of
// making a slow estimator crawl to the new level over thousands of ticks.
function rescaleForBankLevel(bankLevel) {
	if (lastBankLevel === bankLevel) return;
	if (lastBankLevel !== -1) {
		var delta = bankLevel - lastBankLevel;
		for (var id in quants) {
			var q = quants[id];
			q.lo = Math.max(1, q.lo + delta);
			q.hi = Math.max(q.lo * 1.02, q.hi + delta);
		}
	}
	lastBankLevel = bankLevel;
}

function observe(good, restingVal) {
	var q = quant(good.id, restingVal);
	var lr = Math.max(0.05, restingVal * S.learnRate);
	var v = good.val;

	q.lo += lr * (v > q.lo ? S.buyQuantile  : S.buyQuantile  - 1);
	q.hi += lr * (v > q.hi ? S.sellQuantile : S.sellQuantile - 1);

	q.lo = Math.max(1, q.lo);
	q.hi = Math.max(q.lo * 1.02, q.hi);
	if (q.n < 1e9) q.n++;
	return q;
}

/* ------------------------------------------------------------------ *
 * Analysis
 * ------------------------------------------------------------------ */

function analyse(m, good, bankLevel) {
	var restingVal = 10 + 10 * good.id + (bankLevel - 1);
	var q          = observe(good, restingVal);
	var bias       = MODE_BIAS[good.mode] || MODE_BIAS[0];

	var buyLine  = q.lo * bias.buy;
	var sellLine = q.hi * bias.sell;

	// Overhead is paid on the way in and never recovered, so a spread that does
	// not clear overhead plus the required margin is not a trade, it is a fee.
	var hasEdge = (q.n >= S.warmupTicks) &&
	              (sellLine >= buyLine * overhead * (1 + S.minMargin));

	var maxStock  = m.getGoodMaxStock(good);
	var basis     = basisPerUnit(good.id);

	return {
		good: good, id: good.id, symbol: good.symbol, mode: good.mode,
		price: good.val, qLo: q.lo, qHi: q.hi, warm: (q.n >= S.warmupTicks),
		buyLine: buyLine, sellLine: sellLine,
		hasEdge: hasEdge, allowBuy: bias.allowBuy,
		maxStock: maxStock, freeSpace: Math.max(0, maxStock - good.stock),
		basis: basis, breakeven: basis * (1 + S.minMargin),
		restingVal: restingVal, roc: 0, strength: 0, action: 'hold', note: ''
	};
}

/* ------------------------------------------------------------------ *
 * Execution - all trades funnel through here so the cost basis stays honest
 * ------------------------------------------------------------------ */

function doBuy(m, good, units) {
	if (units < 1) return 0;
	var priceAt = good.val;
	var before  = good.stock;
	if (!m.buyGood(good.id, Math.floor(units))) return 0;

	var got = good.stock - before;
	if (got <= 0) return 0;

	var p = pos(good.id);
	p.units += got;
	p.costS += priceAt * overhead * got;
	p.costC += rate() * priceAt * overhead * got;
	stats.buys++;
	return got;
}

function doSell(m, good, units) {
	if (units < 1) return 0;
	var priceAt = good.val;
	var before  = good.stock;
	if (!m.sellGood(good.id, Math.floor(units))) return 0;

	var sold = before - good.stock;
	if (sold <= 0) return 0;

	var p = pos(good.id);
	var share = p.units > 0 ? Math.min(1, sold / p.units) : 1;
	var costS = p.costS * share;
	var costC = p.costC * share;

	p.units = Math.max(0, p.units - sold);
	p.costS = Math.max(0, p.costS - costS);
	p.costC = Math.max(0, p.costC - costC);
	if (p.units <= 0) { p.units = 0; p.costS = 0; p.costC = 0; }

	stats.realizedS += priceAt * sold - costS;
	stats.realizedC += rate() * priceAt * sold - costC;
	stats.sells++;
	return sold;
}

/**
 * The player can trade by hand and saves can be loaded out of sync, so the
 * tracked position is reconciled against the real stock before every decision.
 * Unexplained extra units are booked at the current price, which is the
 * conservative assumption for an assistant that refuses to sell below its basis.
 */
function reconcile(good) {
	var p = pos(good.id);
	if (p.units === good.stock) return;

	if (p.units > good.stock) {
		var share = p.units > 0 ? good.stock / p.units : 0;
		p.costS *= share;
		p.costC *= share;
		p.units = good.stock;
	} else {
		var extra = good.stock - p.units;
		p.costS += good.val * overhead * extra;
		p.costC += rate() * good.val * overhead * extra;
		p.units = good.stock;
	}
	if (p.units <= 0) { p.units = 0; p.costS = 0; p.costC = 0; }
}

function clearPositions() {
	positions = {};
	holdTicks = {};
}

/* ------------------------------------------------------------------ *
 * Brokers
 * ------------------------------------------------------------------ */

function hireBrokers(m) {
	if (!S.autoBrokers) return 0;

	var hired = 0, guard = 0;
	var maxBrokers = m.getMaxBrokers();

	while (m.brokers < maxBrokers && guard++ < 50) {
		// Each broker shaves 5% off the remaining overhead. Once overhead is
		// already negligible, the 20-minute price buys almost nothing.
		if (0.01 * (20 * Math.pow(0.95, m.brokers)) <= S.minOverhead) break;

		var price = m.getBrokerPrice();
		if (!(price > 0)) break;
		if (Game.cookies < price) break;
		if (price > Game.cookies * S.brokerBudgetPct) break;

		Game.Spend(price);
		m.brokers += 1;
		hired++;
	}

	if (hired > 0) {
		stats.brokersHired += hired;
		m.toRedraw = Math.max(m.toRedraw || 0, 1);
	}
	return hired;
}

/* ------------------------------------------------------------------ *
 * Market tick
 * ------------------------------------------------------------------ */

function runTick(m) {
	var bankLevel = Game.Objects['Bank'].level;
	var i, a;

	overhead = overheadOf(m);
	rescaleForBankLevel(bankLevel);
	for (i = 0; i < m.goodsById.length; i++) reconcile(m.goodsById[i]);

	if (rate() <= 0) {
		statusText = 'idle - no raw CpS to price goods against';
		view = [];
		return;
	}

	if (S.enabled) { hireBrokers(m); overhead = overheadOf(m); }

	// analyse() also advances the quantile estimators, so it runs every tick
	// even while paused - the bot keeps learning the market while you trade.
	var plans = [];
	for (i = 0; i < m.goodsById.length; i++) {
		plans.push(analyse(m, m.goodsById[i], bankLevel));
	}

	if (!S.enabled) {
		statusText = 'paused - still learning, not trading';
		view = plans;
		return;
	}

	// --- Sells first: they free up cookies for this tick's buys. ---
	for (i = 0; i < plans.length; i++) {
		a = plans[i];
		var good = a.good;
		if (good.stock <= 0 || good.last === 1) { holdTicks[a.id] = 0; continue; }

		var profitable = a.price >= a.breakeven;
		var atSellLine = a.price >= a.sellLine;
		var sellNow = false, why = '';

		if (profitable && atSellLine) {
			sellNow = true; why = 'target';

			// Ride the move for a few more ticks while it is still climbing,
			// rather than capping out at the first touch of the sell line.
			if (S.useHiddenState && good.d > 0 && (good.mode === 1 || good.mode === 3)) {
				var held = holdTicks[a.id] || 0;
				if (held < S.maxHoldTicks && good.dur > 2) {
					holdTicks[a.id] = held + 1;
					sellNow = false;
					a.action = 'ride';
					a.note   = 'riding +' + good.d.toFixed(2);
				}
			}
		}

		// A fast-rise or fast-fall regime about to expire has a 70% chance of
		// turning chaotic, so bank a profitable position before that roll.
		if (!sellNow && profitable && S.useHiddenState &&
		    (good.mode === 3 || good.mode === 4) && good.dur <= 2) {
			sellNow = true; why = 'regime end';
		}

		if (!sellNow && S.allowLoss && a.basis > 0 &&
		    a.price <= a.basis * (1 - S.stopLossPct)) {
			sellNow = true; why = 'stop-loss';
		}

		if (sellNow) {
			var sold = doSell(m, good, 10000);
			if (sold > 0) {
				holdTicks[a.id] = 0;
				a.action = 'sell';
				a.note   = why + ' x' + sold;
			}
		} else if (a.action !== 'ride') {
			holdTicks[a.id] = 0;
			if (good.stock > 0 && atSellLine && !profitable) a.note = 'underwater';
		}
	}

	// --- Buys: rank by return on capital, then spend a capped bankroll. ---
	var budget = Game.cookies * clamp(S.maxDeployPct, 0, 1);
	var candidates = [];

	for (i = 0; i < plans.length; i++) {
		a = plans[i];
		if (!a.warm)    { a.note = 'learning'; continue; }
		if (!a.hasEdge) { a.note = 'no edge';  continue; }
		if (!a.allowBuy || a.freeSpace <= 0 || a.good.last === 2) continue;
		if (a.price > a.buyLine) continue;

		// Do not catch a knife mid-fall unless the price is already very low.
		if (S.useHiddenState && a.good.d < -1 && a.price > a.qLo * 0.8) {
			a.note = 'falling ' + a.good.d.toFixed(2);
			continue;
		}

		// Expected return on the cookies this trade would tie up. Ranking by
		// this rather than by good order sends scarce capital to the best
		// opportunity instead of to whichever good happens to be listed first.
		var inCost = a.price * overhead;
		a.roc = inCost > 0 ? (a.sellLine - inCost) / inCost : 0;
		if (a.roc <= 0) { a.note = 'no edge'; continue; }

		// How deep below the buy line we are, used for position sizing.
		a.strength = clamp((a.buyLine - a.price) / Math.max(1e-6, a.buyLine * 0.5), 0, 1);
		candidates.push(a);
	}

	candidates.sort(function (x, y) { return y.roc - x.roc; });

	for (i = 0; i < candidates.length; i++) {
		a = candidates[i];
		var unitCost = rate() * a.price * overhead;
		if (!(unitCost > 0)) continue;

		var want = Math.ceil(a.freeSpace * (0.40 + 0.60 * a.strength));
		// 0.999 keeps the last unit affordable after floating-point drift.
		var affordable = Math.floor(Math.min(budget, Game.cookies * 0.999) / unitCost);
		var units = Math.min(want, affordable, a.freeSpace);
		if (units < 1) { a.note = 'no budget'; continue; }

		var bought = doBuy(m, a.good, units);
		if (bought > 0) {
			budget -= bought * unitCost;
			a.action = 'buy';
			a.note   = 'x' + bought + ' roc ' + Math.round(a.roc * 100) + '%';
			if (budget <= 0) break;
		}
	}

	// Refresh the derived numbers so the panel reflects post-trade state.
	for (i = 0; i < plans.length; i++) {
		plans[i].basis     = basisPerUnit(plans[i].id);
		plans[i].breakeven = plans[i].basis * (1 + S.minMargin);
	}

	view = plans;
	statusText = 'active - overhead ' + ((overhead - 1) * 100).toFixed(2) + '%';
	m.toRedraw = Math.max(m.toRedraw || 0, 1);
}

function liquidateAll(m) {
	var sold = 0;
	for (var i = 0; i < m.goodsById.length; i++) {
		var good = m.goodsById[i];
		if (good.stock > 0 && good.last !== 1) sold += doSell(m, good, 10000);
	}
	if (sold > 0) m.toRedraw = Math.max(m.toRedraw || 0, 1);
	return sold;
}

function unrealized(m) {
	var totalS = 0, totalC = 0;
	for (var i = 0; i < m.goodsById.length; i++) {
		var good = m.goodsById[i];
		var p = positions[good.id];
		if (!p || p.units <= 0) continue;
		totalS += good.val * p.units - p.costS;
		totalC += rate() * good.val * p.units - p.costC;
	}
	return {s:totalS, c:totalC};
}

/* ------------------------------------------------------------------ *
 * UI
 * ------------------------------------------------------------------ */

var CSS = [
	'#' + PANEL_ID + '{margin:6px 4px 4px 4px;padding:8px;border:1px solid #79c600;border-radius:4px;',
	'background:rgba(0,0,0,0.82);box-shadow:0 0 4px rgba(0,0,0,0.5) inset;color:#e8e8e8;font-size:12px;}',
	'#' + PANEL_ID + ' .qbRow{display:flex;flex-wrap:wrap;align-items:center;gap:10px;}',
	'#' + PANEL_ID + ' .qbTitle{font-weight:bold;color:#94cd50;letter-spacing:1px;}',
	'#' + PANEL_ID + ' .qbBtn{cursor:pointer;border:1px solid rgba(255,255,255,0.35);border-radius:3px;',
	'padding:1px 8px;font-weight:bold;font-size:11px;background:rgba(255,255,255,0.08);color:#fff;}',
	'#' + PANEL_ID + ' .qbBtn:hover{background:rgba(255,255,255,0.2);}',
	'#' + PANEL_ID + ' .qbBtn.qbOn{background:#94cd50;color:#000;border-color:#cfe9a8;}',
	'#' + PANEL_ID + ' .qbBtn.qbOff{background:#c23b3b;color:#fff;border-color:#f0a0a0;}',
	'#' + PANEL_ID + ' .qbStat{font-size:11px;color:#bbb;}',
	'#' + PANEL_ID + ' .qbStat b{color:#fff;}',
	'#' + PANEL_ID + ' .qbSep{border:0;height:1px;background:#4a4a4a;margin:6px 0;}',
	'#' + PANEL_ID + ' table{width:100%;border-collapse:collapse;font-family:monospace;font-size:11px;}',
	'#' + PANEL_ID + ' th{color:#8fae62;font-weight:normal;text-align:right;padding:1px 4px;border-bottom:1px solid #444;}',
	'#' + PANEL_ID + ' th:first-child,#' + PANEL_ID + ' td:first-child{text-align:left;}',
	'#' + PANEL_ID + ' td{text-align:right;padding:1px 4px;white-space:nowrap;}',
	'#' + PANEL_ID + ' td.qbTrend{text-align:center;font-weight:bold;font-size:13px;letter-spacing:-1px;}',
	'#' + PANEL_ID + ' tr.qbBuy td{color:#94cd50;}',
	'#' + PANEL_ID + ' tr.qbSell td{color:#ff6b6b;}',
	'#' + PANEL_ID + ' tr.qbRide td{color:#e8c95a;}',
	'#' + PANEL_ID + ' tr.qbIdle td{color:#9a9a9a;}',
	'#' + PANEL_ID + ' .qbSettings{display:none;padding:4px 2px;}',
	'#' + PANEL_ID + ' .qbSettings.qbShown{display:block;}',
	'#' + PANEL_ID + ' .qbSet{display:flex;align-items:center;gap:6px;padding:2px 0;font-size:11px;}',
	'#' + PANEL_ID + ' .qbSet label{flex:1;color:#ccc;}',
	'#' + PANEL_ID + ' .qbSet input[type=number]{width:70px;background:#111;color:#fff;',
	'border:1px solid #555;border-radius:2px;padding:1px 3px;font-family:monospace;}',
	'#' + PANEL_ID + ' .qbNote{font-size:10px;color:#888;font-style:italic;}'
].join('');

function injectCSS() {
	if (document.getElementById('quantBrokerCSS')) return;
	var st = document.createElement('style');
	st.id = 'quantBrokerCSS';
	st.textContent = CSS;
	document.head.appendChild(st);
}

function settingsHTML() {
	var html = '';
	for (var i = 0; i < SETTINGS_META.length; i++) {
		var meta = SETTINGS_META[i];
		html += '<div class="qbSet"><label for="qbSet-' + meta.key + '">' + meta.label + '</label>';
		if (meta.type === 'bool') {
			html += '<input type="checkbox" id="qbSet-' + meta.key + '" data-key="' + meta.key + '" data-kind="bool">';
		} else {
			var step = meta.type === 'pct' ? meta.step * 100 : meta.step;
			var min  = meta.type === 'pct' ? meta.min * 100  : meta.min;
			var max  = meta.type === 'pct' ? meta.max * 100  : meta.max;
			html += '<input type="number" id="qbSet-' + meta.key + '" data-key="' + meta.key +
				'" data-kind="' + meta.type + '" min="' + min + '" max="' + max + '" step="' + step + '">' +
				(meta.type === 'pct' ? '<span class="qbStat">%</span>' : '<span class="qbStat">ticks</span>');
		}
		html += '</div>';
	}
	html += '<div class="qbRow" style="margin-top:6px;">' +
		'<div class="qbBtn" data-act="defaults">Restore defaults</div>' +
		'<div class="qbBtn" data-act="resetStats">Reset stats</div>' +
		'<div class="qbBtn" data-act="relearn">Relearn quantiles</div>' +
		'<span class="qbNote">Hidden market state reads the momentum and regime timer behind each stock. ' +
		'Turn it off to trade only on what the price graph already shows you.</span>' +
		'</div>';
	return html;
}

function buildPanel(host, m) {
	injectCSS();

	var panel = document.createElement('div');
	panel.id = PANEL_ID;

	var head = '<div class="qbRow">' +
		'<span class="qbTitle">QUANT BROKER v' + VERSION + '</span>' +
		'<div class="qbBtn" data-act="toggle" id="qbToggle">-</div>' +
		'<div class="qbBtn" data-act="settings">Settings</div>' +
		'<div class="qbBtn" data-act="liquidate">Sell everything</div>' +
		'<span class="qbStat" id="qbStatus"></span>' +
		'</div>';

	var line = '<div class="qbRow" style="margin-top:4px;">' +
		'<span class="qbStat">Realised: <b id="qbRealC">-</b> cookies (<b id="qbRealS">-</b>)</span>' +
		'<span class="qbStat">Open: <b id="qbOpenC">-</b> cookies (<b id="qbOpenS">-</b>)</span>' +
		'<span class="qbStat">Trades: <b id="qbTrades">-</b></span>' +
		'<span class="qbStat">Brokers: <b id="qbBrokers">-</b></span>' +
		'</div>';

	var rows = '';
	for (var i = 0; i < m.goodsById.length; i++) {
		rows += '<tr id="qbRow-' + i + '" class="qbIdle">' +
			'<td id="qbC-' + i + '-sym"></td>' +
			'<td class="qbTrend" id="qbC-' + i + '-mode"></td>' +
			'<td id="qbC-' + i + '-price"></td>' +
			'<td id="qbC-' + i + '-buy"></td>' +
			'<td id="qbC-' + i + '-sell"></td>' +
			'<td id="qbC-' + i + '-stock"></td>' +
			'<td id="qbC-' + i + '-basis"></td>' +
			'<td id="qbC-' + i + '-pl"></td>' +
			'<td id="qbC-' + i + '-note" style="text-align:left;"></td>' +
			'</tr>';
	}

	var table = '<hr class="qbSep"><div style="max-height:220px;overflow-y:auto;">' +
		'<table><thead><tr>' +
		'<th>stock</th><th>trend</th><th>price</th><th>buy&nbsp;&lt;=</th><th>sell&nbsp;&gt;=</th>' +
		'<th>held</th><th>basis</th><th>P/L</th><th style="text-align:left;">&nbsp;note</th>' +
		'</tr></thead><tbody>' + rows + '</tbody></table></div>';

	panel.innerHTML = head + line +
		'<div class="qbSettings" id="qbSettingsBox"><hr class="qbSep">' + settingsHTML() + '</div>' +
		table;

	panel.addEventListener('click', onPanelClick);
	panel.addEventListener('change', onPanelChange);
	host.appendChild(panel);

	syncSettingsInputs();
	return panel;
}

function syncSettingsInputs() {
	if (typeof document === 'undefined') return;
	for (var i = 0; i < SETTINGS_META.length; i++) {
		var meta = SETTINGS_META[i];
		var el = document.getElementById('qbSet-' + meta.key);
		if (!el) continue;
		if (meta.type === 'bool') el.checked = !!S[meta.key];
		else if (meta.type === 'pct') el.value = (S[meta.key] * 100).toFixed(1).replace(/\.0$/, '');
		else el.value = S[meta.key];
	}
}

function onPanelChange(e) {
	var el = e.target;
	var key = el.getAttribute && el.getAttribute('data-key');
	if (!key || !(key in DEFAULTS)) return;

	var kind = el.getAttribute('data-kind');
	if (kind === 'bool') {
		S[key] = !!el.checked;
	} else {
		var meta = null;
		for (var i = 0; i < SETTINGS_META.length; i++) {
			if (SETTINGS_META[i].key === key) { meta = SETTINGS_META[i]; break; }
		}
		var raw = parseFloat(el.value);
		if (!isFinite(raw)) { syncSettingsInputs(); return; }
		var v = (kind === 'pct') ? raw / 100 : Math.round(raw);
		S[key] = meta ? clamp(v, meta.min, meta.max) : v;
		syncSettingsInputs();
	}
	refreshPanel();
}

function onPanelClick(e) {
	var el = e.target;
	var act = el.getAttribute && el.getAttribute('data-act');
	if (!act) return;

	if (act === 'toggle') {
		S.enabled = !S.enabled;
	} else if (act === 'settings') {
		showSettings = !showSettings;
	} else if (act === 'liquidate') {
		var m = market();
		if (m) {
			var sold = liquidateAll(m);
			Game.Notify('Quant Broker', sold > 0
				? ('Liquidated ' + sold + ' units.')
				: 'Nothing to liquidate right now.', [16, 5], 1);
		}
	} else if (act === 'defaults') {
		for (var k in DEFAULTS) S[k] = DEFAULTS[k];
		syncSettingsInputs();
	} else if (act === 'resetStats') {
		stats.buys = stats.sells = 0;
		stats.realizedS = stats.realizedC = 0;
		stats.brokersHired = 0;
	} else if (act === 'relearn') {
		quants = {};
		Game.Notify('Quant Broker', 'Price quantiles cleared - relearning.', [16, 5], 1);
	}
	refreshPanel();
}

// True for the one frame in which the panel had to be created, so the caller
// can populate it immediately instead of leaving placeholders until the next
// market tick (up to a minute away).
var panelJustBuilt = false;

function ensurePanel(m) {
	if (typeof document === 'undefined') return null;
	var panel = document.getElementById(PANEL_ID);
	if (panel && panel.isConnected) return panel;

	var host = document.getElementById('bankHeader');
	if (!host) return null;
	if (panel && panel.parentNode) panel.parentNode.removeChild(panel);
	panelJustBuilt = true;
	return buildPanel(host, m);
}

function setText(id, text) {
	var el = document.getElementById(id);
	if (el && el.textContent !== text) el.textContent = text;
}

// The glyph keeps its own colour via an inline style, which outranks the
// row-state colour rule, so the trend stays readable on a buying or selling row.
function setTrend(id, mode) {
	var el = document.getElementById(id);
	if (!el) return;
	var glyph = MODE_GLYPH[mode] || '?';
	if (el.textContent !== glyph) el.textContent = glyph;
	el.style.color = MODE_COLOR[mode] || '#9a9a9a';
	el.title = MODE_NAMES[mode] || '';
}

function refreshPanel() {
	var m = market();
	if (!m) return;
	var panel = ensurePanel(m);
	if (!panel) return;

	var toggle = document.getElementById('qbToggle');
	if (toggle) {
		toggle.textContent = S.enabled ? 'ON' : 'OFF';
		toggle.className = 'qbBtn ' + (S.enabled ? 'qbOn' : 'qbOff');
	}

	var box = document.getElementById('qbSettingsBox');
	if (box) box.className = 'qbSettings' + (showSettings ? ' qbShown' : '');

	var open = unrealized(m);
	setText('qbStatus', statusText);
	setText('qbRealC', fmtCookies(stats.realizedC));
	setText('qbRealS', fmtDollars(stats.realizedS));
	setText('qbOpenC', fmtCookies(open.c));
	setText('qbOpenS', fmtDollars(open.s));
	setText('qbTrades', stats.buys + ' buys / ' + stats.sells + ' sells');
	setText('qbBrokers', m.brokers + '/' + m.getMaxBrokers() +
		'  (+' + stats.brokersHired + ' auto)');

	for (var i = 0; i < m.goodsById.length; i++) {
		var row = document.getElementById('qbRow-' + i);
		if (!row) continue;

		var good = m.goodsById[i];
		if (!good.active) { row.style.display = 'none'; continue; }
		row.style.display = '';

		var a = null;
		for (var j = 0; j < view.length; j++) { if (view[j].id === i) { a = view[j]; break; } }

		if (!a) {
			row.className = 'qbIdle';
			setText('qbC-' + i + '-sym', good.symbol);
			setTrend('qbC-' + i + '-mode', good.mode);
			setText('qbC-' + i + '-price', '$' + good.val.toFixed(2));
			setText('qbC-' + i + '-buy', '-');
			setText('qbC-' + i + '-sell', '-');
			setText('qbC-' + i + '-stock', good.stock + '/' + m.getGoodMaxStock(good));
			setText('qbC-' + i + '-basis', '-');
			setText('qbC-' + i + '-pl', '-');
			setText('qbC-' + i + '-note', '');
			continue;
		}

		row.className = a.action === 'buy'  ? 'qbBuy'
		              : a.action === 'sell' ? 'qbSell'
		              : a.action === 'ride' ? 'qbRide' : 'qbIdle';

		var plTxt = '-';
		if (a.basis > 0) {
			var pl = (a.price / a.basis - 1) * 100;
			plTxt = (pl >= 0 ? '+' : '') + pl.toFixed(1) + '%';
		}

		setText('qbC-' + i + '-sym', a.symbol);
		setTrend('qbC-' + i + '-mode', a.mode);
		setText('qbC-' + i + '-price', '$' + a.price.toFixed(2));
		setText('qbC-' + i + '-buy', a.hasEdge ? '$' + a.buyLine.toFixed(2) : '--');
		setText('qbC-' + i + '-sell', '$' + Math.max(a.sellLine, a.breakeven).toFixed(2));
		setText('qbC-' + i + '-stock', a.good.stock + '/' + a.maxStock);
		setText('qbC-' + i + '-basis', a.basis > 0 ? '$' + a.basis.toFixed(2) : '-');
		setText('qbC-' + i + '-pl', plTxt);
		setText('qbC-' + i + '-note', a.note);
	}
}

/* ------------------------------------------------------------------ *
 * Persistence
 * ------------------------------------------------------------------ */

function saveString() {
	var packed = [];
	for (var id in positions) {
		var p = positions[id];
		if (!p || p.units <= 0) continue;
		packed.push([Number(id), p.units, Number(p.costS.toFixed(3)), Math.round(p.costC)]);
	}
	var learned = [];
	for (var qid in quants) {
		var q = quants[qid];
		learned.push([Number(qid), Number(q.lo.toFixed(2)), Number(q.hi.toFixed(2)), q.n]);
	}
	return JSON.stringify({
		v: 1,
		s: S,
		t: [stats.buys, stats.sells, Number(stats.realizedS.toFixed(3)),
		    Math.round(stats.realizedC), stats.brokersHired],
		p: packed,
		q: learned
	});
}

function loadString(str) {
	if (!str) return;
	var data;
	try { data = JSON.parse(str); } catch (e) { return; }
	if (!data || typeof data !== 'object') return;

	if (data.s) {
		for (var k in DEFAULTS) {
			if (typeof data.s[k] === typeof DEFAULTS[k]) S[k] = data.s[k];
		}
	}
	if (data.t && data.t.length >= 4) {
		stats.buys         = data.t[0] || 0;
		stats.sells        = data.t[1] || 0;
		stats.realizedS    = data.t[2] || 0;
		stats.realizedC    = data.t[3] || 0;
		stats.brokersHired = data.t[4] || 0;
	}
	positions = {};
	if (data.p && data.p.length) {
		for (var i = 0; i < data.p.length; i++) {
			var e = data.p[i];
			if (!e || e.length < 4) continue;
			positions[e[0]] = {units: e[1] || 0, costS: e[2] || 0, costC: e[3] || 0};
		}
	}
	quants = {};
	if (data.q && data.q.length) {
		for (var j = 0; j < data.q.length; j++) {
			var g = data.q[j];
			if (!g || g.length < 3) continue;
			quants[g[0]] = {lo: g[1] || 1, hi: g[2] || 2, n: g[3] || 0};
		}
	}
	holdTicks = {};
	syncSettingsInputs();
}

/* ------------------------------------------------------------------ *
 * Lifecycle
 * ------------------------------------------------------------------ */

function onLogic() {
	var m = market();
	if (!m) return;

	ensurePanel(m);
	if (panelJustBuilt) { panelJustBuilt = false; refreshPanel(); }

	// The market only moves once per M.secondsPerTick; M.ticks is the clock.
	// This also means reset()'s 15 synchronous warm-up ticks pass by unseen.
	if (m.ticks === lastTick) return;

	if (m.ticks < lastTick) {
		// The market was reset (ascension, hard reset, save load) - old cost
		// bases refer to stock that no longer exists. The learned quantiles
		// stay: the price process itself did not change.
		clearPositions();
	}
	lastTick = m.ticks;

	try {
		runTick(m);
	} catch (err) {
		statusText = 'error - see console';
		console.error('[Quant Broker] tick failed:', err);
	}
	refreshPanel();
}

function onReset() {
	clearPositions();
	lastTick = -1;
	lastBankLevel = -1;
	view = [];
	statusText = 'reset - waiting for the market';
}

Game.registerMod(MOD_ID, {
	init: function () {
		Game.registerHook('logic', onLogic);
		Game.registerHook('reset', onReset);
		console.log('[Quant Broker] v' + VERSION + ' ready.');
	},
	save: function () {
		try { return saveString(); } catch (e) { return ''; }
	},
	load: function (str) {
		try { loadString(str); } catch (e) { /* keep defaults */ }
	}
});

})();

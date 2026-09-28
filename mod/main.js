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
var VERSION  = '1.3';
var PANEL_ID = 'quantBrokerPanel';

// M.buyGood/M.sellGood treat n === 10000 as "as many as cookies allow" / "all
// of it". That is what we want when liquidating, and never what we want when
// buying, because it silently ignores our own per-tick budget.
var ALL_UNITS = 10000;

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
	stopLossPct:     0.35,   // cut a position this far below its cost basis

	// --- market-wide shock (the game's globD event) ---
	// Worth +11.8% over 8/8 seeds. Every default here comes from
	// dev/sweep_v12.js: relax 0.40 beats 0.25 and 0.70, two ticks of stance
	// beats one and three, and raising the deploy cap turned out to change the
	// result by exactly nothing while costing 30x the liquidity - so it does
	// not, and the cap you set is still the cap.
	shockDetect:     true,
	shockTicks:      2,      // ticks the shock stance lasts after a detection
	shockRelax:      0.40,   // raise the buy line by this much during a crash
	shockDeployMult: 1.0,    // multiplier on the per-tick deploy cap during a crash
	shockJump:       0.8,    // momentum change that counts as a kick, per good

	// --- price-process edges, both measured negative and both off ---
	// The mechanisms are real - the game damps upward drift above the soft
	// ceiling and yanks prices back up off the $5 floor - but acting on either
	// loses money. See README, "Things that did not work".
	ceilingRide:     false,  // shorten the momentum ride above the soft price ceiling
	ceilingRideTicks: 40,    // ride budget above the ceiling, when enabled
	floorGrab:       false,  // buy anything pinned against the $5 floor
	floorPrice:      6,      // "pinned" means at or below this price

	// --- adaptive band, measured negative and off ---
	adaptBand:       false,  // tighten the quantile band as broker overhead vanishes
	bandFloor:       0.35,   // band width at zero overhead, as a share of the configured one

	// --- CpS growth ---
	// Provably inert while the rate is flat, worth up to +5% while it climbs
	// fast. Small, but it is the only feature that can pay during the part of a
	// run where the dollar price is not the whole story.
	cpsHold:         true,   // hold longer while raw CpS is still climbing
	cpsHoldTicks:    20,     // horizon over which the CpS gain is credited
	cpsHoldMax:      0.50,   // cap on the resulting sell-line bonus

	// --- achievement mode ---
	achieveMode:     false,  // fill every warehouse to a floor instead of trading for profit
	achieveTarget:   500,    // units of every good to hold while it is on

	// Draw the fifteen-minute forecast into the game's own Dough Jones graph.
	chartForecast:   true
};

/**
 * What the panel actually offers.
 *
 * Everything in DEFAULTS is still a real setting and can still be injected
 * through the mod's load() hook, which is how dev/optimize.js and
 * dev/ablate_v12.js drive it. Only these are worth a player's attention: the
 * rest are not preferences, they are numbers that were solved for, and every
 * value other than the ones below made the assistant measurably worse.
 */
var SETTINGS_META = [
	{key:'enabled',        type:'bool', label:'Assistant enabled'},
	{key:'autoBrokers',    type:'bool', label:'Auto-hire brokers (they pay for themselves)'},
	{key:'useHiddenState', type:'bool', label:'Use hidden market state (momentum + regime timer)'},
	{key:'maxDeployPct',   type:'pct',  label:'Most of your cookies it may spend per tick',
		min:0.01, max:1, step:0.01},
	{key:'achieveMode',    type:'bool', label:'Achievement mode (stop trading, fill every warehouse)'},
	{key:'achieveTarget',  type:'int',  label:'Units of every good to hold in that mode',
		min:1, max:2000, step:50},
	{key:'chartForecast',  type:'bool', label:'Draw the fifteen-minute forecast into the graph'}
];

var S = {};
(function () { for (var k in DEFAULTS) S[k] = DEFAULTS[k]; })();

/* ------------------------------------------------------------------ *
 * State
 * ------------------------------------------------------------------ */

var stats     = {buys:0, sells:0, realizedS:0, realizedC:0, brokersHired:0, shocks:0};
var positions = {};   // goodId -> {units, costS, costC}
var quants    = {};   // goodId -> {lo, hi, n}  learned price quantiles
var holdTicks = {};   // goodId -> consecutive ticks held past the sell line
var view      = [];   // per-good display snapshot, rebuilt each market tick
var lastTick  = -1;
var lastBankLevel = -1;   // to detect bank level-ups and shift the quantiles
var overhead  = 1.2;
var showSettings = false;
var statusText   = 'waiting for the Stock Market';

// Momentum of each good as of the end of the previous market tick. A global
// shock is the only thing in the price process that moves many goods' momentum
// at once, so the tick-over-tick change in `d` is what gives it away.
var prevD  = {};
var shock  = {dir:0, ticksLeft:0, mag:0, hit:{}};

// A shock adds globD*(1 + U(0,4)) to every good it touches, so the smallest
// possible kick is |globD|, and ordinary tick-to-tick drift changes are an
// order of magnitude below that outside the chaotic regime. The threshold
// lives in DEFAULTS.shockJump; see dev/detector.js for how it was chosen.

// Samples of Game.cookiesPsRawHighest, tagged with the market tick they were
// taken on, used to estimate how fast the cookie value of a position is rising.
var rateHist = [];
var RATE_WINDOW = 40;

// Effective quantile targets after the overhead adaptation, recomputed each
// tick. The estimators are fed these rather than the raw settings, so they
// converge on the band actually being traded.
var effBuyQ = DEFAULTS.buyQuantile, effSellQ = DEFAULTS.sellQuantile;

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

function median(arr) {
	if (!arr.length) return 0;
	var s = arr.slice().sort(function (a, b) { return a - b; });
	var mid = s.length >> 1;
	return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// Above this price the game damps upward drift by 10% per tick
// (minigameMarket.js: `if (me.val > 100+3*(bankLevel-1) && me.d > 0) me.d *= 0.9`),
// so momentum above it is worth far less than momentum below it.
function ceilingOf(bankLevel) { return 100 + 3 * (bankLevel - 1); }

/**
 * Fractional growth of Game.cookiesPsRawHighest per market tick, measured over
 * the sample window. Goods are bought and sold at `cookiesPsRawHighest * val`,
 * so a position held across a CpS increase pays out more cookies than it cost
 * even at an unchanged dollar price. The rate never decreases, so this is >= 0.
 */
function rateGrowthPerTick() {
	if (rateHist.length < 2) return 0;
	var a = rateHist[0], b = rateHist[rateHist.length - 1];
	var dt = b.t - a.t;
	if (!(dt > 0) || !(a.r > 0) || !(b.r > 0) || b.r <= a.r) return 0;
	return Math.pow(b.r / a.r, 1 / dt) - 1;
}

function noteRate(tick) {
	var r = rate();
	if (!(r > 0)) return;
	rateHist.push({t: tick, r: r});
	while (rateHist.length > RATE_WINDOW) rateHist.shift();
}

/**
 * Broker overhead is the whole reason to demand a wide spread: it is paid on
 * the way in and never recovered. At 20% (no brokers) the configured band is
 * right; by the time brokers have taken it to 0.1% a trade is almost free, and
 * insisting on the same wide band just declines profitable business. Both
 * quantiles are therefore pulled toward the median as overhead vanishes.
 */
function effectiveQuantiles() {
	if (!S.adaptBand) return {lo: S.buyQuantile, hi: S.sellQuantile};
	var t = clamp((overhead - 1) / 0.20, 0, 1);          // 1 = no brokers, 0 = free
	var width = S.bandFloor + (1 - S.bandFloor) * t;
	return {
		lo: 0.5 - (0.5 - S.buyQuantile)  * width,
		hi: 0.5 + (S.sellQuantile - 0.5) * width
	};
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
		var lo = seedQuantile(restingVal, effBuyQ);
		var hi = seedQuantile(restingVal, effSellQ);
		q = quants[id] = {lo: lo, hi: Math.max(hi, lo * 1.05), n: 0};
	}
	return q;
}

/**
 * The estimator converges on whichever quantile it is fed, but only at the
 * learning rate - a few hundred ticks, or hours of play. When the target itself
 * moves (brokers hired, adaptation toggled) the levels are shifted by the
 * modelled distance between the old and new quantiles instead, exactly as a
 * bank level-up is handled, so the new band is live immediately.
 */
function rescaleForQuantileTarget(bankLevel) {
	var next = effectiveQuantiles();
	if (Math.abs(next.lo - effBuyQ) < 0.005 && Math.abs(next.hi - effSellQ) < 0.005) {
		effBuyQ = next.lo; effSellQ = next.hi;
		return;
	}
	for (var id in quants) {
		var q = quants[id];
		var restingVal = 10 + 10 * Number(id) + (bankLevel - 1);
		q.lo = Math.max(1, q.lo + (seedQuantile(restingVal, next.lo) - seedQuantile(restingVal, effBuyQ)));
		q.hi = Math.max(q.lo * 1.02,
			q.hi + (seedQuantile(restingVal, next.hi) - seedQuantile(restingVal, effSellQ)));
	}
	effBuyQ = next.lo;
	effSellQ = next.hi;
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

	q.lo += lr * (v > q.lo ? effBuyQ  : effBuyQ  - 1);
	q.hi += lr * (v > q.hi ? effSellQ : effSellQ - 1);

	q.lo = Math.max(1, q.lo);
	q.hi = Math.max(q.lo * 1.02, q.hi);
	if (q.n < 1e9) q.n++;
	return q;
}

/* ------------------------------------------------------------------ *
 * Market-wide shocks
 *
 * Once every ten ticks or so (twice that under Supreme Intellect) the game
 * draws a single globD ~ U(-1,1) and applies it to every good independently
 * with the same probability:
 *
 *     me.val -= (1 + me.d*rand^3*7) * globD;
 *     me.val -= globD * (1 + rand^3*7);
 *     me.d   += globD * (1 + rand*4);
 *     me.dur  = 0;
 *
 * Three consequences drive everything below. The sign is inverted from the
 * intuitive reading: globD > 0 pushes prices DOWN. The momentum kick is one to
 * five times globD, an order of magnitude larger than an ordinary tick, and it
 * points the opposite way to the price move - so a crash arrives with strong
 * positive drift already attached and the rebound is mechanical. And dur = 0
 * rerolls the regime, which makes `mode` and `dur` meaningless for exactly the
 * goods that were hit.
 *
 * The event itself is not exposed, but it is the only thing that moves many
 * goods' momentum in the same direction on the same tick, so it is recovered
 * cross-sectionally from the change in `d`.
 * ------------------------------------------------------------------ */

function detectShock(m) {
	if (!S.shockDetect || !S.useHiddenState) {
		shock.dir = 0; shock.ticksLeft = 0; shock.hit = {};
		return;
	}

	var up = 0, down = 0, hits = {}, kicks = [], i, g, dd, seen = 0;
	var jump = S.shockJump > 0 ? S.shockJump : 0.8;

	for (i = 0; i < m.goodsById.length; i++) {
		g = m.goodsById[i];
		if (prevD[g.id] === undefined) continue;
		seen++;
		dd = g.d - prevD[g.id];
		if (dd >= jump)       { up++;   hits[g.id] = 1; kicks.push(dd); }
		else if (dd <= -jump) { down++; hits[g.id] = 1; kicks.push(dd); }
	}

	var total = up + down;
	var dominant = Math.max(up, down);
	// Idiosyncratic jumps do happen - the chaotic regime rerolls d outright -
	// but they are independent across goods, so a genuine shock shows up as a
	// large, near-unanimous count rather than one or two goods moving.
	var quorum = Math.max(3, Math.ceil(seen / 3));

	if (seen >= 4 && total >= quorum && dominant >= total * 0.8) {
		shock.dir = (up >= down) ? 1 : -1;   // +1 = prices crashed, -1 = prices spiked
		shock.mag = clamp(Math.abs(median(kicks)) / 3, 0, 1);
		shock.ticksLeft = Math.max(1, Math.round(S.shockTicks));
		shock.hit = hits;
		stats.shocks++;
	} else if (shock.ticksLeft > 0) {
		shock.ticksLeft--;
		if (shock.ticksLeft <= 0) { shock.dir = 0; shock.mag = 0; shock.hit = {}; }
	}
}

function rememberMomentum(m) {
	for (var i = 0; i < m.goodsById.length; i++) prevD[m.goodsById[i].id] = m.goodsById[i].d;
}

function shockActive()   { return shock.ticksLeft > 0 && shock.dir !== 0; }
function inCrash()       { return shockActive() && shock.dir > 0; }
function inSpike()       { return shockActive() && shock.dir < 0; }
function wasHit(id)      { return shockActive() && !!shock.hit[id]; }

/* ------------------------------------------------------------------ *
 * Analysis
 * ------------------------------------------------------------------ */

function analyse(m, good, bankLevel, cpsBonus) {
	var restingVal = 10 + 10 * good.id + (bankLevel - 1);
	var q          = observe(good, restingVal);
	var bias       = MODE_BIAS[good.mode] || MODE_BIAS[0];
	var hit        = wasHit(good.id);

	var buyLine  = q.lo * bias.buy;
	var sellLine = q.hi * bias.sell;

	// A shock rerolled this good's regime, so the per-regime bias is reading a
	// mode that has existed for one tick and means nothing.
	if (hit) { buyLine = q.lo; sellLine = q.hi; }

	// Prices fell market-wide and the drift kick that came with it points back
	// up. Pay up for the dip rather than waiting for a line that was calibrated
	// on the unconditional distribution.
	if (hit && inCrash()) buyLine *= 1 + S.shockRelax * (0.5 + 0.5 * shock.mag);

	// Goods are priced in seconds of raw CpS at both ends, so a position held
	// across a CpS increase is worth more cookies than it cost at an unchanged
	// dollar price. While the rate is climbing, wait for a little more.
	if (cpsBonus > 0) sellLine *= 1 + cpsBonus;

	// Overhead is paid on the way in and never recovered, so a spread that does
	// not clear overhead plus the required margin is not a trade, it is a fee.
	var hasEdge = (q.n >= S.warmupTicks) &&
	              (sellLine >= buyLine * overhead * (1 + S.minMargin));

	var maxStock  = m.getGoodMaxStock(good);
	var basis     = basisPerUnit(good.id);

	// Below $5 the game yanks the price halfway back to 5 every single tick
	// and damps further downward drift, with a hard floor of $1. A good sitting
	// there is the closest thing in this market to a free option, and it does
	// not need a warmed-up estimator to recognise.
	var onFloor = S.floorGrab && good.val <= S.floorPrice &&
	              Math.max(q.hi, restingVal) >= good.val * overhead * (1 + S.minMargin);

	// The soft ceiling damps upward drift by 10% a tick, so a ride started
	// above it decays instead of paying. Taper the budget over the last
	// quarter of the way up and cut it hard past the line.
	// The soft ceiling damps upward drift by 10% a tick, so a ride started
	// above it decays instead of paying. Below it nothing is damped and the
	// full budget applies - tapering on the approach was measured to cost 4%,
	// because sell lines mostly sit just under the ceiling and the taper was
	// cutting the ordinary, profitable rides short.
	var ceiling = ceilingOf(bankLevel);
	var rideCap = (S.ceilingRide && good.val >= ceiling)
		? Math.min(S.maxHoldTicks, S.ceilingRideTicks)
		: S.maxHoldTicks;

	return {
		good: good, id: good.id, symbol: good.symbol, mode: good.mode,
		price: good.val, qLo: q.lo, qHi: q.hi, warm: (q.n >= S.warmupTicks),
		buyLine: buyLine, sellLine: sellLine,
		hasEdge: hasEdge, allowBuy: bias.allowBuy,
		maxStock: maxStock, freeSpace: Math.max(0, maxStock - good.stock),
		basis: basis, breakeven: basis * (1 + S.minMargin),
		restingVal: restingVal, roc: 0, strength: 0, action: 'hold', note: '',
		onFloor: onFloor, rideCap: rideCap, shocked: hit, ceiling: ceiling,
		// Direction is captured here rather than read at render time, so a
		// panel redraw after the stance expires cannot mislabel the row.
		shockDir: hit ? shock.dir : 0
	};
}

/* ------------------------------------------------------------------ *
 * Explaining itself
 *
 * Every row says which stage of the decision it reached and what would have to
 * happen next for it to act, so the panel reads as the assistant's reasoning
 * rather than as a log of things that already happened.
 * ------------------------------------------------------------------ */

var SELL_WHY = {
	'target':      'the price reached the learned sell line',
	'shock spike': 'a market-wide spike lifted it; the momentum kick that came with it points down',
	'regime end':  'its fast regime is about to expire, and there is a 70% chance the next one is chaotic',
	'stop-loss':   'the stop-loss fired (this is off by default, and measured to lose money)'
};

function pctAway(from, to) {
	if (!(from > 0)) return '';
	var d = (to / from - 1) * 100;
	return (d >= 0 ? '+' : '') + d.toFixed(0) + '%';
}

/**
 * Returns [short, long]. The short form is what fits in the cell and says only
 * what the numeric columns do not already show - price, both lines, holdings,
 * basis and P/L are all sitting right there. The long form is the tooltip.
 */
function planNote(a, target, cpsBonus) {
	var g = a.good;

	if (a.action === 'buy') {
		return [a.shortNote, a.longNote + '. Next: sell at or above $' + a.sellLine.toFixed(2) + '.'];
	}
	if (a.action === 'sell') {
		return [a.shortNote, a.longNote + '. Next: buy at or below $' + a.buyLine.toFixed(2) + '.'];
	}
	if (a.action === 'ride') {
		var held = holdTicks[a.id] || 0;
		return ['RIDE +' + g.d.toFixed(2) + ' ' + held + '/' + a.rideCap,
			'RIDE past the sell line while the price is still climbing on +' + g.d.toFixed(2) +
			' drift, ' + held + ' of ' + a.rideCap + ' ticks used' +
			(a.rideCap < S.maxHoldTicks
				? ' (shortened: $' + a.price.toFixed(2) + ' is above the soft ceiling of $' +
				  a.ceiling + ', where the game damps upward drift 10% a tick)' : '') +
			'. Sells when the drift turns or the budget runs out.'];
	}

	// Holding stock: the next decision is a sell.
	if (g.stock > 0) {
		if (target > 0 && g.stock <= target) {
			return ['FILL ' + g.stock + '/' + target,
				'FILL holding ' + g.stock + ' of the ' + target +
				' this good needs for the achievement, so it is not being traded.'];
		}
		if (a.price < a.breakeven) {
			return ['UNDER cost ' + pctAway(a.price, a.breakeven),
				'UNDER water: cost basis $' + a.basis.toFixed(2) + ' plus margin needs $' +
				a.breakeven.toFixed(2) + '. It will not sell at a loss.'];
		}
		var wall = Math.max(a.sellLine, a.breakeven);
		return ['HOLD sell ' + pctAway(a.price, wall),
			'HOLD in profit, waiting for $' + wall.toFixed(2) + '.' +
			(cpsBonus > 0 ? ' Sell line is +' + Math.round(cpsBonus * 100) +
				'% because raw CpS is climbing and holding through that is worth cookies.' : '')];
	}

	// Flat: the next decision is a buy, so name the gate that is closed.
	if (!a.warm) {
		var q = quants[a.id];
		var n = (q && q.n) || 0;
		return ['LEARN ' + n + '/' + S.warmupTicks,
			'LEARN: ' + n + ' of ' + S.warmupTicks +
			' ticks of price history observed before this good becomes tradable.'];
	}
	if (a.onFloor) {
		return ['FLOOR buying',
			'FLOOR: pinned at $' + a.price.toFixed(2) + ', where the game yanks the price halfway ' +
			'back to $5 every tick. Buying to capacity, exit around $' +
			Math.max(a.sellLine, a.qHi, a.restingVal).toFixed(2) + '.'];
	}
	if (!a.hasEdge) {
		return ['NOEDGE',
			'NOEDGE: the $' + a.buyLine.toFixed(2) + '-$' + a.sellLine.toFixed(2) +
			' spread does not clear ' + ((overhead - 1) * 100).toFixed(2) + '% broker overhead plus the ' +
			Math.round(S.minMargin * 100) + '% margin, so trading it would be paying a fee.'];
	}
	if (a.freeSpace <= 0) {
		return ['FULL ' + a.maxStock,
			'FULL: warehouse holds ' + a.maxStock + '. Buy more of the tied building, or upgrade ' +
			'your offices, to widen it.'];
	}
	if (!a.allowBuy && !(a.shocked && inCrash())) {
		return ['AVOID fast fall',
			'AVOID: a fast-fall regime is running (' + g.dur + ' ticks left). Exits only until it ends.'];
	}
	if (S.useHiddenState && g.d < -1 && a.price > a.qLo * 0.8) {
		return ['KNIFE ' + g.d.toFixed(2),
			'KNIFE: falling at ' + g.d.toFixed(2) + ' a tick. Waiting for $' +
			(a.qLo * 0.8).toFixed(2) + ' or for the fall to stall.'];
	}
	if (a.price > a.buyLine) {
		return ['WATCH buy ' + pctAway(a.price, a.buyLine),
			'WATCH: $' + a.price.toFixed(2) + ' now, buys at $' + a.buyLine.toFixed(2) + '.'];
	}
	if (a.shortNote) return [a.shortNote, a.longNote || a.shortNote];
	return ['READY', 'READY to buy at $' + a.buyLine.toFixed(2) +
		', waiting only on this tick\'s deploy budget.'];
}

/* ------------------------------------------------------------------ *
 * Execution - all trades funnel through here so the cost basis stays honest
 * ------------------------------------------------------------------ */

function doBuy(m, good, units) {
	if (units < 1) return 0;
	var priceAt = good.val;
	var before  = good.stock;

	// Asking for exactly ALL_UNITS would be read by the game as "spend whatever
	// the bank allows", which fills to warehouse capacity and walks straight
	// through our per-tick deploy cap. One unit less is the whole fix.
	var n = Math.floor(units);
	if (n === ALL_UNITS) n = ALL_UNITS - 1;

	if (!m.buyGood(good.id, n)) return 0;

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
	// The market was rebuilt, so last tick's momentum belongs to prices that no
	// longer exist and would read as a shock on the next comparison.
	prevD    = {};
	shock    = {dir:0, ticksLeft:0, mag:0, hit:{}};
	rateHist = [];
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
	rescaleForQuantileTarget(bankLevel);
	for (i = 0; i < m.goodsById.length; i++) reconcile(m.goodsById[i]);

	// Read the cross-section before anything else touches the market. Trades
	// have no price impact in this game, so ordering is not strictly required,
	// but the detector is about the tick that just happened.
	detectShock(m);
	noteRate(m.ticks);

	if (rate() <= 0) {
		statusText = 'idle - no raw CpS to price goods against';
		view = [];
		rememberMomentum(m);
		return;
	}

	if (S.enabled) { hireBrokers(m); overhead = overheadOf(m); }

	var cpsBonus = 0;
	if (S.cpsHold) {
		cpsBonus = clamp(rateGrowthPerTick() * S.cpsHoldTicks, 0, S.cpsHoldMax);
	}

	// analyse() also advances the quantile estimators, so it runs every tick
	// even while paused - the bot keeps learning the market while you trade.
	var plans = [];
	for (i = 0; i < m.goodsById.length; i++) {
		plans.push(analyse(m, m.goodsById[i], bankLevel, cpsBonus));
	}

	if (!S.enabled) {
		statusText = 'paused - still learning, not trading';
		view = plans;
		rememberMomentum(m);
		return;
	}

	var target = S.achieveMode ? Math.max(0, Math.round(S.achieveTarget)) : 0;

	// --- Sells first: they free up cookies for this tick's buys. ---
	for (i = 0; i < plans.length; i++) {
		a = plans[i];
		var good = a.good;
		if (good.stock <= 0 || good.last === 1) { holdTicks[a.id] = 0; continue; }

		// Achievement mode holds a floor of every good; only the surplus above
		// that floor is available to trade.
		var sellable = target > 0 ? Math.max(0, good.stock - target) : good.stock;
		if (sellable <= 0) {
			holdTicks[a.id] = 0;
			a.note = 'holding ' + good.stock + '/' + target;
			continue;
		}

		var profitable = a.price >= a.breakeven;
		var atSellLine = a.price >= a.sellLine;
		var sellNow = false, why = '';

		if (profitable && atSellLine) {
			sellNow = true; why = 'target';

			// Ride the move for a few more ticks while it is still climbing,
			// rather than capping out at the first touch of the sell line.
			// Not after a shock: the kick made `d` positive and rerolled the
			// regime, so both of those readings are about the shock, not a rally.
			if (S.useHiddenState && !a.shocked &&
			    good.d > 0 && (good.mode === 1 || good.mode === 3)) {
				var held = holdTicks[a.id] || 0;
				if (held < a.rideCap && good.dur > 2) {
					holdTicks[a.id] = held + 1;
					sellNow = false;
					a.action = 'ride';
				}
			}
		}

		// Prices jumped market-wide and the kick that came with it points down.
		// Take the gift; do not wait for a line calibrated on quiet markets.
		if (!sellNow && profitable && a.shocked && inSpike()) {
			sellNow = true; why = 'shock spike';
		}

		// A fast-rise or fast-fall regime about to expire has a 70% chance of
		// turning chaotic, so bank a profitable position before that roll.
		// Skipped for shocked goods, whose dur was just reset to a fresh draw.
		if (!sellNow && profitable && S.useHiddenState && !a.shocked &&
		    (good.mode === 3 || good.mode === 4) && good.dur <= 2) {
			sellNow = true; why = 'regime end';
		}

		if (!sellNow && S.allowLoss && a.basis > 0 &&
		    a.price <= a.basis * (1 - S.stopLossPct)) {
			sellNow = true; why = 'stop-loss';
		}

		if (sellNow) {
			var sold = doSell(m, good, sellable >= good.stock ? ALL_UNITS : sellable);
			if (sold > 0) {
				holdTicks[a.id] = 0;
				a.action = 'sell';
				a.shortNote = 'SELL x' + sold;
				a.longNote  = 'SELL ' + sold + ' units at $' + a.price.toFixed(2) + ' - ' + SELL_WHY[why];
			}
		} else if (a.action !== 'ride') {
			holdTicks[a.id] = 0;
		}
	}

	// --- Buys: rank by return on capital, then spend a capped bankroll. ---
	// A market-wide crash is the one moment worth breaking the cap for: the
	// prices are depressed across the board and the rebound is built into the
	// model rather than predicted.
	var deploy = clamp(S.maxDeployPct, 0, 1);
	if (inCrash()) deploy = clamp(deploy * Math.max(1, S.shockDeployMult), 0, 1);
	var budget = Game.cookies * deploy;
	var candidates = [];

	for (i = 0; i < plans.length; i++) {
		a = plans[i];
		if (a.freeSpace <= 0 || a.good.last === 2) continue;

		// Achievement mode buys whatever it takes to reach the floor, at any
		// price. It is not trying to make money; it is trying to hit a number.
		a.needed = target > 0 ? Math.max(0, Math.min(target - a.good.stock, a.freeSpace)) : 0;
		var forced = a.needed > 0;

		if (!forced && !a.onFloor) {
			if (!a.warm)    { a.note = 'learning'; continue; }
			if (!a.hasEdge) { a.note = 'no edge';  continue; }
			// A crash rerolled the regime, so a fast-fall reading is one tick
			// old and is not a reason to stand aside.
			if (!a.allowBuy && !(a.shocked && inCrash())) continue;
			if (a.price > a.buyLine) continue;

			// Do not catch a knife mid-fall unless the price is already very low.
			if (S.useHiddenState && a.good.d < -1 && a.price > a.qLo * 0.8) {
				a.note = 'falling ' + a.good.d.toFixed(2);
				continue;
			}
		}

		// Expected return on the cookies this trade would tie up. Ranking by
		// this rather than by good order sends scarce capital to the best
		// opportunity instead of to whichever good happens to be listed first.
		var inCost = a.price * overhead;
		var exit   = a.onFloor ? Math.max(a.sellLine, a.qHi, a.restingVal) : a.sellLine;
		a.roc = inCost > 0 ? (exit - inCost) / inCost : 0;
		if (!forced && a.roc <= 0) { a.note = 'no edge'; continue; }

		// How deep below the buy line we are, used for position sizing. A good
		// pinned on the floor, or a fill we are obliged to make, goes all in.
		a.strength = (a.onFloor || forced) ? 1
			: clamp((a.buyLine - a.price) / Math.max(1e-6, a.buyLine * 0.5), 0, 1);
		a.forced = forced;
		candidates.push(a);
	}

	// Obligations first, then the best return on capital.
	candidates.sort(function (x, y) {
		if (x.forced !== y.forced) return x.forced ? -1 : 1;
		return y.roc - x.roc;
	});

	for (i = 0; i < candidates.length; i++) {
		a = candidates[i];
		var unitCost = rate() * a.price * overhead;
		if (!(unitCost > 0)) continue;

		var want = a.forced ? a.needed
			: Math.ceil(a.freeSpace * (0.40 + 0.60 * a.strength));

		// An obligation is allowed the whole bank; a trade is not.
		var pool = a.forced ? Game.cookies * 0.999 : Math.min(budget, Game.cookies * 0.999);
		var affordable = Math.floor(pool / unitCost);
		var units = Math.min(want, affordable, a.freeSpace);
		if (units < 1) {
			a.shortNote = 'NOCASH';
			a.longNote  = 'NOCASH: wants ' + Math.round(want) + ' units but this tick\'s deploy ' +
			              'budget is spent. It will try again next tick.';
			continue;
		}

		var bought = doBuy(m, a.good, units);
		if (bought > 0) {
			if (!a.forced) budget -= bought * unitCost;
			a.action = 'buy';
			a.shortNote = 'BUY x' + bought +
				(a.forced ? '' : (a.shocked && inCrash()) ? ' dip' : ' ' + Math.round(a.roc * 100) + '%');
			a.longNote = 'BUY ' + bought + ' units at $' + a.price.toFixed(2) + ' - ' +
				(a.forced  ? 'achievement fill, now ' + a.good.stock + ' of ' + target
			   : a.onFloor ? 'pinned on the price floor, near-certain rebound'
			   : (a.shocked && inCrash())
			                ? 'buying a market-wide crash at a relaxed buy line; expected return ' +
			                  Math.round(a.roc * 100) + '%'
			   :              'below the buy line; expected return ' + Math.round(a.roc * 100) +
			                  '% on the cookies it ties up');
			if (!a.forced && budget <= 0) break;
		}
	}

	// Refresh the derived numbers so the panel reflects post-trade state, then
	// write the explanation of what each good is waiting for.
	for (i = 0; i < plans.length; i++) {
		plans[i].basis     = basisPerUnit(plans[i].id);
		plans[i].breakeven = plans[i].basis * (1 + S.minMargin);
		var pair = planNote(plans[i], target, cpsBonus);
		plans[i].note     = pair[0];
		plans[i].noteLong = pair[1];
	}

	view = plans;
	statusText = describeStance(cpsBonus, target);
	rememberMomentum(m);
	m.toRedraw = Math.max(m.toRedraw || 0, 1);
}

/**
 * One line describing the stance the assistant is trading in right now, shown
 * next to the ON/OFF button.
 */
function describeStance(cpsBonus, target) {
	var bits = ['overhead ' + ((overhead - 1) * 100).toFixed(2) + '%'];
	bits.push('band ' + Math.round(effBuyQ * 100) + '/' + Math.round(effSellQ * 100));
	if (cpsBonus > 0) bits.push('CpS rising, holding +' + Math.round(cpsBonus * 100) + '%');
	if (target > 0)   bits.push('achievement fill to ' + target);

	if (inCrash()) {
		return 'CRASH - buying the dip (' + shock.ticksLeft + ' ticks left, ' +
			'deploy ' + Math.round(clamp(S.maxDeployPct * S.shockDeployMult, 0, 1) * 100) + '%) | ' + bits.join(' | ');
	}
	if (inSpike()) {
		return 'SPIKE - selling into it (' + shock.ticksLeft + ' ticks left) | ' + bits.join(' | ');
	}
	return 'active | ' + bits.join(' | ');
}

function liquidateAll(m) {
	var sold = 0;
	for (var i = 0; i < m.goodsById.length; i++) {
		var good = m.goodsById[i];
		if (good.stock > 0 && good.last !== 1) sold += doSell(m, good, ALL_UNITS);
	}
	if (sold > 0) m.toRedraw = Math.max(m.toRedraw || 0, 1);
	return sold;
}

/**
 * Manual override: fill every warehouse now, ignoring the quantile band.
 *
 * Both ends of a trade are priced at Game.cookiesPsRawHighest, and that number
 * only ever goes up, so stock bought before a CpS jump is paid for at the old
 * rate and sold at the new one. Pressing this before buying a big upgrade
 * converts cookies into goods at today's price. The most undervalued goods are
 * filled first, so a partial fill still lands where the discount is.
 */
function fillWarehouses(m) {
	var bankLevel = Game.Objects['Bank'].level;
	var order = m.goodsById.slice().sort(function (x, y) {
		var rx = (10 + 10 * x.id + (bankLevel - 1)) / Math.max(0.01, x.val);
		var ry = (10 + 10 * y.id + (bankLevel - 1)) / Math.max(0.01, y.val);
		return ry - rx;
	});

	var bought = 0;
	for (var i = 0; i < order.length; i++) {
		var good = order[i];
		if (good.last === 2) continue;
		var space = m.getGoodMaxStock(good) - good.stock;
		if (space <= 0) continue;

		var unitCost = rate() * good.val * overheadOf(m);
		if (!(unitCost > 0)) continue;

		var units = Math.min(space, Math.floor((Game.cookies * 0.999) / unitCost));
		if (units < 1) continue;
		bought += doBuy(m, good, units);
	}
	if (bought > 0) m.toRedraw = Math.max(m.toRedraw || 0, 1);
	return bought;
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
	'#' + PANEL_ID + '{position:relative;z-index:120;margin:0;padding:8px 24px 10px 24px;',
	'background:rgba(0,0,0,0.82);color:#e8e8e8;font-size:14px;',
	'border-top:1px solid #79c600;box-shadow:0 0 8px rgba(0,0,0,0.6) inset;text-align:left;}',
	'#' + PANEL_ID + ' .qbRow{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin:4px 0;}',
	'#' + PANEL_ID + ' .qbTitle{font-weight:bold;color:#94cd50;letter-spacing:1px;}',
	'#' + PANEL_ID + ' .qbVer{font-weight:normal;font-size:10px;letter-spacing:0;opacity:0.55;margin-left:5px;}',
	'#' + PANEL_ID + ' .qbBtn{cursor:pointer;border:1px solid rgba(255,255,255,0.35);border-radius:3px;',
	'padding:1px 9px;font-weight:bold;font-size:13px;background:rgba(255,255,255,0.08);color:#fff;}',
	'#' + PANEL_ID + ' .qbBtn:hover{background:rgba(255,255,255,0.2);}',
	'#' + PANEL_ID + ' .qbBtn.qbOn{background:#94cd50;color:#000;border-color:#cfe9a8;}',
	'#' + PANEL_ID + ' .qbBtn.qbOff{background:#c23b3b;color:#fff;border-color:#f0a0a0;}',
	'#' + PANEL_ID + ' .qbStat{font-size:13px;color:#bbb;}',
	'#' + PANEL_ID + ' .qbLedger{display:flex;flex-direction:column;align-items:flex-start;gap:2px;}',
	// Fixed-width labels so the two figures line up under each other.
	'#' + PANEL_ID + ' .qbLabel{display:inline-block;min-width:62px;color:#8fae62;}',
	'#' + PANEL_ID + ' .qbStat b{color:#fff;}',
	'#' + PANEL_ID + ' .qbSep{border:0;height:1px;background:#3f3f3f;margin:6px 0;}',
	'#' + PANEL_ID + ' table{width:100%;border-collapse:collapse;font-family:monospace;font-size:13px;}',
	'#' + PANEL_ID + ' th{color:#8fae62;font-weight:normal;text-align:right;padding:3px 9px;border-bottom:1px solid #444;}',
	'#' + PANEL_ID + ' th:first-child,#' + PANEL_ID + ' td:first-child{text-align:left;}',
	'#' + PANEL_ID + ' td{text-align:right;padding:3px 9px;white-space:nowrap;}',
	'#' + PANEL_ID + ' [title]{cursor:help;}',
	// The trend glyph is one or two characters; give it exactly that much room
	// and hand the slack to the note column, which is where the reasoning goes.
	'#' + PANEL_ID + ' th.qbTrend,#' + PANEL_ID + ' td.qbTrend{text-align:center;font-weight:bold;',
	'font-size:14px;letter-spacing:-2px;padding:3px 4px;width:22px;min-width:22px;max-width:22px;}',
	'#' + PANEL_ID + ' th.qbNoteCol,#' + PANEL_ID + ' td.qbNoteCol{text-align:left;width:99%;',
	'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding-left:14px;}',
	'#' + PANEL_ID + ' td.qbNoteCol{color:#c8c8c8;}',
	'#' + PANEL_ID + ' .qbStage{display:inline-block;min-width:58px;font-weight:bold;opacity:0.9;}',
	'#' + PANEL_ID + ' .qbShock{margin-top:4px;padding:3px 6px;border-radius:3px;font-weight:bold;font-size:13px;}',
	'#' + PANEL_ID + ' .qbShockDown{background:rgba(194,59,59,0.25);color:#ffb3b3;border:1px solid #c23b3b;}',
	'#' + PANEL_ID + ' .qbShockUp{background:rgba(148,205,80,0.2);color:#cfe9a8;border:1px solid #94cd50;}',
	'#' + PANEL_ID + ' tr.qbBuy td{color:#94cd50;}',
	'#' + PANEL_ID + ' tr.qbSell td{color:#ff6b6b;}',
	'#' + PANEL_ID + ' tr.qbRide td{color:#e8c95a;}',
	'#' + PANEL_ID + ' tr.qbIdle td{color:#9a9a9a;}',
	// Goods the detected shock actually touched. The table is border-collapse,
	// so drawing the box on the cells is what puts a border round the row.
	'#' + PANEL_ID + ' tr.qbHitDown td{border-top:1px solid #c23b3b;border-bottom:1px solid #c23b3b;',
	'background:rgba(194,59,59,0.12);}',
	'#' + PANEL_ID + ' tr.qbHitDown td:first-child{border-left:1px solid #c23b3b;}',
	'#' + PANEL_ID + ' tr.qbHitDown td:last-child{border-right:1px solid #c23b3b;}',
	'#' + PANEL_ID + ' tr.qbHitUp td{border-top:1px solid #94cd50;border-bottom:1px solid #94cd50;',
	'background:rgba(148,205,80,0.12);}',
	'#' + PANEL_ID + ' tr.qbHitUp td:first-child{border-left:1px solid #94cd50;}',
	'#' + PANEL_ID + ' tr.qbHitUp td:last-child{border-right:1px solid #94cd50;}',
	'#' + PANEL_ID + ' .qbSettings{display:none;padding:4px 2px;}',
	'#' + PANEL_ID + ' .qbSettings.qbShown{display:block;}',
	'#' + PANEL_ID + ' .qbSet{display:flex;align-items:center;gap:6px;padding:2px 0;font-size:13px;}',
	'#' + PANEL_ID + ' .qbSet label{flex:1;color:#ccc;}',
	'#' + PANEL_ID + ' .qbSet input[type=number]{width:70px;background:#111;color:#fff;',
	'border:1px solid #555;border-radius:2px;padding:1px 3px;font-family:monospace;}',
	'#' + PANEL_ID + ' .qbNote{font-size:12px;color:#9a9a9a;max-width:640px;line-height:1.4;}'
].join('');

/* ------------------------------------------------------------------ *
 * Fifteen-minute forecast
 * ------------------------------------------------------------------ */

// A market tick is a minute (M.secondsPerTick), so fifteen minutes is
// fifteen ticks.
var FORECAST_TICKS = 15;
var FORECAST_PATHS = 200;

var forecastCache = {tick: -1, data: null};

/**
 * One tick of the game's own price process, applied to a lightweight copy of a
 * good. Transcribed from M.tick in minigameMarket.js: every draw is in the same
 * order and under the same condition, because the shape of this distribution is
 * the whole point of the forecast.
 *
 * Unlike the Grimoire's spells, nothing here is knowable in advance - the market
 * runs on ordinary unseeded randomness. So this does not predict the price; it
 * samples the distribution the price will be drawn from.
 */
function stepGood(g, restingVal, bankLevel, dragonBoost, globD, globP) {
	g.d *= 0.97 + 0.01 * dragonBoost;

	if (g.mode === 0)      { g.d *= 0.95; g.d += 0.05 * (Math.random() - 0.5); }
	else if (g.mode === 1) { g.d *= 0.99; g.d += 0.05 * (Math.random() - 0.1); }
	else if (g.mode === 2) { g.d *= 0.99; g.d -= 0.05 * (Math.random() - 0.1); }
	else if (g.mode === 3) { g.d += 0.15 * (Math.random() - 0.1); g.val += Math.random() * 5; }
	else if (g.mode === 4) { g.d -= 0.15 * (Math.random() - 0.1); g.val -= Math.random() * 5; }
	else if (g.mode === 5) { g.d += 0.3 * (Math.random() - 0.5); }

	g.val += (restingVal - g.val) * 0.01;

	if (globD !== 0 && Math.random() < globP) {
		g.val -= (1 + g.d * Math.pow(Math.random(), 3) * 7) * globD;
		g.val -= globD * (1 + Math.pow(Math.random(), 3) * 7);
		g.d += globD * (1 + Math.random() * 4);
		g.dur = 0;
	}

	g.val += Math.pow((Math.random() - 0.5) * 2, 11) * 3;
	g.d += 0.1 * (Math.random() - 0.5);
	if (Math.random() < 0.15) g.val += (Math.random() - 0.5) * 3;
	if (Math.random() < 0.03) g.val += (Math.random() - 0.5) * (10 + 10 * dragonBoost);
	if (Math.random() < 0.1) g.d += (Math.random() - 0.5) * (0.3 + 0.2 * dragonBoost);
	if (g.mode === 5) {
		if (Math.random() < 0.5) g.val += (Math.random() - 0.5) * 10;
		if (Math.random() < 0.2) g.d = (Math.random() - 0.5) * (2 + 6 * dragonBoost);
	}
	if (g.mode === 3 && Math.random() < 0.3) { g.d += (Math.random() - 0.5) * 0.1; g.val += (Math.random() - 0.7) * 10; }
	if (g.mode === 3 && Math.random() < 0.03) { g.mode = 4; }
	if (g.mode === 4 && Math.random() < 0.3) { g.d += (Math.random() - 0.5) * 0.1; g.val += (Math.random() - 0.3) * 10; }

	if (g.val > ceilingOf(bankLevel) && g.d > 0) g.d *= 0.9;

	g.val += g.d;
	if (g.val < 5) g.val += (5 - g.val) * 0.5;
	if (g.val < 5 && g.d < 0) g.d *= 0.95;
	g.val = Math.max(g.val, 1);

	g.dur--;
	if (g.dur <= 0) {
		g.dur = Math.floor(10 + Math.random() * (690 - 200 * dragonBoost));
		if (Math.random() < dragonBoost && Math.random() < 0.5) g.mode = 5;
		else if (Math.random() < 0.7 && (g.mode === 3 || g.mode === 4)) g.mode = 5;
		else {
			var pool = [0, 1, 1, 2, 2, 3, 4, 5];
			g.mode = pool[Math.floor(Math.random() * pool.length)];
		}
	}
}

/**
 * Runs the whole market forward FORECAST_TICKS ticks, FORECAST_PATHS times, and
 * returns per-good percentiles at each step.
 *
 * All sixteen goods are advanced together inside a path rather than one at a
 * time, because a shock (globD) hits the whole market on the same tick. Sampling
 * them independently would wash that out and make every band look narrower and
 * better behaved than the market really is.
 */
function buildForecast(m) {
	var bankLevel = m.parent ? m.parent.level : 1;
	var dragonBoost = (typeof Game !== 'undefined' && Game.auraMult)
		? Game.auraMult('Supreme Intellect') : 0;

	var n = m.goodsById.length;
	var samples = [];      // [good][step] -> array of prices
	var i, step, path;
	for (i = 0; i < n; i++) {
		samples[i] = [];
		for (step = 0; step < FORECAST_TICKS; step++) samples[i][step] = [];
	}

	for (path = 0; path < FORECAST_PATHS; path++) {
		var sim = [];
		for (i = 0; i < n; i++) {
			var src = m.goodsById[i];
			sim[i] = {val: src.val, d: src.d, mode: src.mode, dur: src.dur};
		}
		for (step = 0; step < FORECAST_TICKS; step++) {
			var globD = 0, globP = Math.random();
			if (Math.random() < 0.1 + 0.1 * dragonBoost) globD = (Math.random() - 0.5) * 2;
			for (i = 0; i < n; i++) {
				stepGood(sim[i], m.getRestingVal(i), bankLevel, dragonBoost, globD, globP);
				samples[i][step].push(sim[i].val);
			}
		}
	}

	var out = [];
	for (i = 0; i < n; i++) {
		var lo = [], mid = [], hi = [];
		for (step = 0; step < FORECAST_TICKS; step++) {
			var arr = samples[i][step];
			arr.sort(function (a, b) { return a - b; });
			lo.push(arr[Math.floor(arr.length * 0.10)]);
			mid.push(arr[Math.floor(arr.length * 0.50)]);
			hi.push(arr[Math.floor(arr.length * 0.90)]);
		}
		var last = FORECAST_TICKS - 1;
		var now = m.goodsById[i].val;
		// How often the path ends above where it is now - a plain read on
		// direction that does not depend on the size of the move.
		var up = 0, endArr = samples[i][last];
		for (path = 0; path < endArr.length; path++) if (endArr[path] > now) up++;
		out.push({lo: lo, mid: mid, hi: hi, pUp: up / endArr.length, now: now});
	}
	return out;
}

function forecast(m) {
	if (forecastCache.tick === m.ticks && forecastCache.data) return forecastCache.data;
	forecastCache.tick = m.ticks;
	forecastCache.data = buildForecast(m);
	return forecastCache.data;
}

/* ------------------------------------------------------------------ *
 * Drawing the forecast into the game's own graph
 * ------------------------------------------------------------------ */

var chartLayer = null;      // our canvas, laid over the Dough Jones graph
var chartShift = 0;         // pixels the game's graph is nudged left by

/**
 * The game's graph puts "now" at the right-hand edge and scrolls left, so there
 * is no room in it for anything in the future. Rather than overdraw the recent
 * past, the graph itself is nudged left by exactly the width the forecast
 * needs, and the freed strip on the right is ours. Same vertical scale, same
 * background, same palette - so it reads as one continuous chart with a seam
 * at "now".
 *
 *   x for history tick iR : width - span*iR      (the game's own mapping)
 *   x for forecast step k : (width - shift) + span*k
 *   y for a price         : height - val*M.graphScale
 */
function spanOf(m) {
	return Math.max(4, Math.ceil(m.graph.width / 65));
}

/**
 * A third button beside the game's own "Line style" and "Color mode", built
 * from the same class and inline style so it belongs there rather than looking
 * bolted on.
 */
function ensureChartButton() {
	if (typeof document === 'undefined') return;
	var existing = document.getElementById('quantBrokerForecastBtn');
	if (existing && existing.isConnected) {
		var want = S.chartForecast ? 'Forecast on' : 'Forecast off';
		if (existing.textContent !== want) existing.textContent = want;
		return;
	}
	var cols = document.getElementById('bankGraphCols');
	if (!cols || !cols.parentNode) return;

	var btn = document.createElement('div');
	btn.id = 'quantBrokerForecastBtn';
	btn.className = 'bankSimpleButton';
	btn.style.background = 'rgba(0,0,0,0.5)';
	btn.style.padding = '2px';
	btn.style.borderRadius = '4px';
	btn.textContent = S.chartForecast ? 'Forecast on' : 'Forecast off';
	btn.title = 'Draw the next fifteen minutes into the graph as dotted lines, with a shaded band ' +
		'for the range. The market is ordinary randomness, so this is the spread of what could ' +
		'happen rather than a prediction of what will.';
	btn.addEventListener('click', function () {
		S.chartForecast = !S.chartForecast;
		btn.textContent = S.chartForecast ? 'Forecast on' : 'Forecast off';
		var m = market();
		if (m) { try { drawChartForecast(m); } catch (e) { /* reported by onDraw */ } }
		safeUI('panel refresh', refreshPanel);
	});
	cols.parentNode.insertBefore(btn, cols.nextSibling);
}

function ensureChartLayer(m) {
	var box = document.getElementById('bankGraphBox');
	if (!box || !m.graph) return null;
	ensureChartButton();

	if (!S.chartForecast) {
		if (chartLayer && chartLayer.parentNode) {
			chartLayer.parentNode.removeChild(chartLayer);
			chartLayer = null;
			m.graph.style.marginLeft = '';
			chartShift = 0;
			var css = document.getElementById('quantBrokerChartCSS');
			if (css) css.parentNode.removeChild(css);
		}
		return null;
	}

	var shift = spanOf(m) * FORECAST_TICKS;
	if (shift !== chartShift) {
		chartShift = shift;
		m.graph.style.marginLeft = (-shift) + 'px';
		// The per-good price markers hang off the right edge of the box, so
		// they have to come with it. The game rewrites their transform every
		// frame, which is why this is a margin rather than a transform.
		var css = document.getElementById('quantBrokerChartCSS');
		if (!css) {
			css = document.createElement('style');
			css.id = 'quantBrokerChartCSS';
			document.head.appendChild(css);
		}
		css.textContent = '#bankGraphBox .bankGraphIcon{margin-right:' + shift + 'px;}';
	}

	if (chartLayer && chartLayer.isConnected) return chartLayer;

	chartLayer = document.createElement('canvas');
	chartLayer.id = 'quantBrokerChartLayer';
	chartLayer.style.position = 'absolute';
	chartLayer.style.left = '0';
	chartLayer.style.top = '0';
	chartLayer.style.pointerEvents = 'none';
	chartLayer.style.zIndex = '6';
	box.appendChild(chartLayer);
	return chartLayer;
}

function drawChartForecast(m) {
	var layer = ensureChartLayer(m);
	if (!layer || !m.graph) return;

	var W = m.graph.width, H = m.graph.height;
	if (layer.width !== W || layer.height !== H) { layer.width = W; layer.height = H; }

	var ctx = layer.getContext('2d');
	ctx.clearRect(0, 0, W, H);

	var data = forecastCache.data;
	var span = spanOf(m), shift = span * FORECAST_TICKS;
	var seam = W - shift;
	var scale = m.graphScale;
	var cols = m.cols || {bg:'#000', line1:'#222', line2:'#444', high:'#0f0', low:'#f00', highlight:'#fff'};

	// The strip is ours: paint it in the graph's own background and rule it
	// with the same grid, so the seam is the only thing that marks it out.
	ctx.fillStyle = cols.bg;
	ctx.fillRect(seam, 0, shift, H);
	for (var u = 0; u < H / scale; u += 2) {
		ctx.fillStyle = (u % 10 !== 0) ? cols.line1 : cols.line2;
		ctx.fillRect(seam, H - Math.floor(u * scale), shift, 1);
	}

	if (!data) return;

	function Y(v) { return Math.floor(H - v * scale) + 0.5; }
	function X(k) { return seam + span * k; }

	for (var i = 0; i < m.goodsById.length; i++) {
		var good = m.goodsById[i], f = data[i];
		if (!good || !f || good.hidden || !good.active) continue;

		var last = f.mid.length - 1;
		var rising = f.mid[last] >= good.val;
		var col = rising ? cols.high : cols.low;
		var hovered = (m.hoverOnGood === i);

		// The spread first, underneath, so the medians stay readable on top.
		ctx.globalAlpha = hovered ? 0.28 : 0.13;
		ctx.fillStyle = col;
		ctx.beginPath();
		ctx.moveTo(X(0), Y(good.val));
		for (var k = 0; k <= last; k++) ctx.lineTo(X(k + 1), Y(f.hi[k]));
		for (var k2 = last; k2 >= 0; k2--) ctx.lineTo(X(k2 + 1), Y(f.lo[k2]));
		ctx.lineTo(X(0), Y(good.val));
		ctx.closePath();
		ctx.fill();

		// The median, dotted, because none of this has happened yet.
		ctx.globalAlpha = 1;
		ctx.strokeStyle = col;
		ctx.lineWidth = hovered ? 4 : 2;
		ctx.setLineDash(hovered ? [5, 3] : [3, 3]);
		ctx.beginPath();
		ctx.moveTo(X(0), Y(good.val));
		for (var k3 = 0; k3 <= last; k3++) ctx.lineTo(X(k3 + 1), Y(f.mid[k3]));
		ctx.stroke();
		ctx.setLineDash([]);
	}

	// The seam, so it is never in doubt which side has already happened.
	ctx.globalAlpha = 1;
	ctx.fillStyle = cols.highlight;
	ctx.fillRect(seam, 0, 1, H);
	ctx.globalAlpha = 0.75;
	ctx.font = '10px monospace';
	ctx.textAlign = 'left';
	ctx.fillText('now', seam + 3, 11);
	ctx.textAlign = 'right';
	ctx.fillText('+15m', W - 2, 11);
	ctx.globalAlpha = 1;
}

function onDraw() {
	if (uiBroken) return;
	// The game redraws its graph on even frames; match it rather than painting
	// twice as often for nothing.
	if (typeof Game !== 'undefined' && Game.drawT % 2 !== 0) return;
	var m = market();
	if (!m) return;
	try {
		ensureChartButton();
		drawChartForecast(m);
	} catch (err) {
		uiBroken = true;
		console.error('[Quant Broker] drawing the forecast into the graph failed:', err);
	}
}

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
			var scale = meta.type === 'pct' ? 100 : 1;
			html += '<input type="number" id="qbSet-' + meta.key + '" data-key="' + meta.key +
				'" data-kind="' + meta.type + '" min="' + (meta.min * scale) + '" max="' + (meta.max * scale) +
				'" step="' + (meta.step * scale) + '">' +
				'<span class="qbStat">' + (meta.type === 'pct' ? '%' : 'units') + '</span>';
		}
		html += '</div>';
	}
	html += '<div class="qbRow" style="margin-top:6px;">' +
		'<div class="qbBtn" data-act="defaults">Restore defaults</div>' +
		'<div class="qbBtn" data-act="resetStats">Reset stats</div>' +
		'<div class="qbBtn" data-act="relearn">Relearn quantiles</div>' +
		'<span class="qbNote">Hidden market state reads the momentum and regime timer behind each stock. ' +
		'Turn it off to trade only on what the price graph already shows you. ' +
		'Everything else - the quantile band, the margin, the learning rate, the shock stance - ' +
		'was solved for against the game\'s own market model and is not exposed, because every ' +
		'other value tested was worse. See the README if you want the numbers.</span>' +
		'</div>';
	return html;
}

function buildPanel(host, m) {
	injectCSS();

	var panel = document.createElement('div');
	panel.id = PANEL_ID;

	var head = '<div class="qbRow">' +
		'<span class="qbTitle">QUANT BROKER<span class="qbVer">v' + VERSION + '</span></span>' +
		'<div class="qbBtn" data-act="toggle" id="qbToggle">-</div>' +
		'<div class="qbBtn" data-act="settings">Settings</div>' +
		'<div class="qbBtn" data-act="fill">Fill warehouses</div>' +
		'<div class="qbBtn" data-act="liquidate">Sell everything</div>' +
		'<span class="qbStat" id="qbStatus"></span>' +
		'</div>';

	// Realised and Open are the same measurement before and after a sale, so
	// they stack with aligned labels and read as a two-line ledger rather than
	// as two unrelated figures in a row of stats.
	var line = '<div class="qbRow" style="margin-top:4px;align-items:flex-start;">' +
		'<div class="qbLedger">' +
			'<div class="qbStat"><span class="qbLabel">Realised</span>' +
				'<b id="qbRealC">-</b> cookies (<b id="qbRealS">-</b>)</div>' +
			'<div class="qbStat"><span class="qbLabel">Open</span>' +
				'<b id="qbOpenC">-</b> cookies (<b id="qbOpenS">-</b>)</div>' +
		'</div>' +
		'<span class="qbStat">Trades: <b id="qbTrades">-</b></span>' +
		'<span class="qbStat">Brokers: <b id="qbBrokers">-</b></span>' +
		'<span class="qbStat">Shocks seen: <b id="qbShocks">-</b></span>' +
		'</div>' +
		'<div id="qbShockBar" style="display:none;"></div>';

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
			'<td class="qbNoteCol" id="qbC-' + i + '-note"></td>' +
			'</tr>';
	}

	var table = '<hr class="qbSep"><div style="max-height:220px;overflow-y:auto;">' +
		'<table><thead><tr>' +
		'<th>stock</th><th class="qbTrend"></th><th>price</th><th>buy&nbsp;&lt;=</th><th>sell&nbsp;&gt;=</th>' +
		'<th>held</th><th>basis</th><th>P/L</th>' +
		'<th class="qbNoteCol">reasoning</th>' +
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
		else if (meta.type === 'int') el.value = S[meta.key];
		else el.value = String(S[meta.key]);
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
		var v = (kind === 'pct') ? raw / 100 : (kind === 'int') ? Math.round(raw) : raw;
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
	} else if (act === 'fill') {
		var mf = market();
		if (mf) {
			var got = fillWarehouses(mf);
			Game.Notify('Quant Broker', got > 0
				? ('Filled ' + got + ' units at today\'s CpS rate.')
				: 'Nothing affordable to fill right now.', [16, 5], 1);
		}
	} else if (act === 'defaults') {
		for (var k in DEFAULTS) S[k] = DEFAULTS[k];
		syncSettingsInputs();
	} else if (act === 'resetStats') {
		stats.buys = stats.sells = 0;
		stats.realizedS = stats.realizedC = 0;
		stats.brokersHired = 0;
		stats.shocks = 0;
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

function setCellHTML(id, html, title) {
	var el = document.getElementById(id);
	if (!el) return;
	if (el.innerHTML !== html) el.innerHTML = html;
	if (title !== undefined && el.getAttribute('title') !== title) el.setAttribute('title', title);
}

/**
 * Text plus a colour, and optionally a tooltip. Written through the same
 * "only touch it if it changed" guard as everything else, because this runs
 * for sixteen rows every frame.
 */
function setColored(id, text, color, title) {
	var el = document.getElementById(id);
	if (!el) return;
	if (el.textContent !== text) el.textContent = text;
	if (el.style.color !== color) el.style.color = color;
	if (title !== undefined && el.getAttribute('title') !== title) el.setAttribute('title', title);
}

/**
 * A reasoning line is "STAGE  rest of the sentence". The stage word is split
 * out into its own fixed-width span so the explanations line up down the
 * column, and the whole line becomes the cell's tooltip because it is often
 * longer than the panel is wide.
 */
function setNote(id, text, longText) {
	var el = document.getElementById(id);
	if (!el) return;
	var sp = text.indexOf(' ');
	var stage = sp < 0 ? text : text.slice(0, sp);
	var rest = sp < 0 ? '' : text.slice(sp + 1);
	var html = '<span class="qbStage">' + stage + '</span>' + rest;
	if (el.innerHTML !== html) el.innerHTML = html;
	var title = longText || text;
	if (el.getAttribute('title') !== title) el.setAttribute('title', title);
}

/**
 * The trend glyph, coloured independently of the row so it stays readable, and
 * named on hover rather than spelled out - the column is one character wide.
 */
function setTrend(id, mode) {
	var el = document.getElementById(id);
	if (!el) return;
	var i = (mode >= 0 && mode < MODE_GLYPH.length) ? mode : 0;
	if (el.textContent !== MODE_GLYPH[i]) el.textContent = MODE_GLYPH[i];
	if (el.style.color !== MODE_COLOR[i]) el.style.color = MODE_COLOR[i];
	if (el.getAttribute('title') !== MODE_NAMES[i]) el.setAttribute('title', MODE_NAMES[i]);
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
	setText('qbShocks', String(stats.shocks));

	var bar = document.getElementById('qbShockBar');
	if (bar) {
		if (shockActive()) {
			var n = 0;
			for (var k in shock.hit) if (shock.hit[k]) n++;
			bar.style.display = '';
			bar.className = 'qbShock ' + (inCrash() ? 'qbShockDown' : 'qbShockUp');
			bar.textContent = inCrash()
				? ('MARKET-WIDE CRASH - ' + n + ' goods hit, strength ' + shock.mag.toFixed(2) +
				   '. The drift kick that came with it points back up, so the assistant is buying ' +
				   'the dip at a relaxed buy line for ' + shock.ticksLeft + ' more tick(s).')
				: ('MARKET-WIDE SPIKE - ' + n + ' goods hit, strength ' + shock.mag.toFixed(2) +
				   '. Momentum now points down, so profitable positions are being sold into it and ' +
				   'momentum rides are suspended for ' + shock.ticksLeft + ' more tick(s).');
		} else if (bar.style.display !== 'none') {
			bar.style.display = 'none';
			bar.textContent = '';
		}
	}

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
			setColored('qbC-' + i + '-stock', good.stock + '/' + m.getGoodMaxStock(good), '#7a7a7a');
			setText('qbC-' + i + '-basis', '-');
			setColored('qbC-' + i + '-pl', '-', '#7a7a7a');
			setNote('qbC-' + i + '-note', 'WAIT',
				'WAIT: no reading yet - the market has not ticked since the save was loaded.');
			continue;
		}

		row.className = (a.action === 'buy'  ? 'qbBuy'
		               : a.action === 'sell' ? 'qbSell'
		               : a.action === 'ride' ? 'qbRide' : 'qbIdle') +
		               (a.shockDir > 0 ? ' qbHitDown' : a.shockDir < 0 ? ' qbHitUp' : '');

		// P/L: green in profit, red under water, grey when nothing is held.
		var plTxt = '-', plColor = '#7a7a7a', plTitle = 'No position.';
		if (a.basis > 0) {
			var pl = (a.price / a.basis - 1) * 100;
			plTxt = (pl >= 0 ? '+' : '') + pl.toFixed(1) + '%';
			plColor = pl > 0.05 ? '#6ee06e' : pl < -0.05 ? '#ff6b6b' : '#c8c8c8';
			plTitle = 'Marked at $' + a.price.toFixed(2) + ' against a cost basis of $' +
				a.basis.toFixed(2) + '. Unrealised until it sells.';
		}

		// Held: grey when empty, green while there is room to keep buying,
		// amber as the warehouse fills, red once it is full and blocking.
		var fill = a.maxStock > 0 ? a.good.stock / a.maxStock : 0;
		var stockColor = a.good.stock <= 0 ? '#7a7a7a'
			: fill >= 1    ? '#ff6b6b'
			: fill >= 0.8  ? '#e8c95a'
			:                '#6ee06e';
		var stockTitle = a.good.stock <= 0
			? 'Holding none. Capacity ' + a.maxStock + '.'
			: 'Holding ' + a.good.stock + ' of a possible ' + a.maxStock +
			  ' (' + Math.round(fill * 100) + '% full)' +
			  (fill >= 1 ? ' - full, so it cannot buy more until it sells or you buy more of the ' +
			               'tied building.' : '.');

		setText('qbC-' + i + '-sym', a.symbol);
		setTrend('qbC-' + i + '-mode', a.mode);
		setText('qbC-' + i + '-price', '$' + a.price.toFixed(2));
		setText('qbC-' + i + '-buy', a.hasEdge ? '$' + a.buyLine.toFixed(2) : '--');
		setText('qbC-' + i + '-sell', '$' + Math.max(a.sellLine, a.breakeven).toFixed(2));
		setColored('qbC-' + i + '-stock', a.good.stock + '/' + a.maxStock, stockColor, stockTitle);
		setText('qbC-' + i + '-basis', a.basis > 0 ? '$' + a.basis.toFixed(2) : '-');
		setColored('qbC-' + i + '-pl', plTxt, plColor, plTitle);
		setNote('qbC-' + i + '-note', a.note, a.noteLong);
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
		    Math.round(stats.realizedC), stats.brokersHired, stats.shocks],
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
		stats.shocks       = data.t[5] || 0;
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

// Set once if the UI ever throws, so a broken panel degrades to "no panel"
// instead of retrying and spamming the console every frame.
var uiBroken = false;

function safeUI(what, fn) {
	if (uiBroken) return;
	try {
		fn();
	} catch (err) {
		uiBroken = true;
		console.error('[Quant Broker] ' + what + ' failed - the panel is disabled for this ' +
			'session, trading is unaffected. Please report this:', err);
	}
}

/**
 * The whole body is guarded. This hook runs inside Game.Logic(), so anything
 * that escapes it does not just break the assistant, it breaks the game's main
 * loop - and the trading decisions must survive a fault in the panel.
 */
function onLogic() {
	var m;
	try {
		m = market();
		if (!m) return;
	} catch (err) {
		return;
	}

	safeUI('panel setup', function () {
		ensurePanel(m);
		if (panelJustBuilt) { panelJustBuilt = false; refreshPanel(); }
	});

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
		forecast(m);          // one Monte Carlo per market tick, never per frame
	} catch (err) {
		console.error('[Quant Broker] forecast failed:', err);
		forecastCache.data = null;
	}

	try {
		runTick(m);
	} catch (err) {
		statusText = 'error - see console';
		console.error('[Quant Broker] tick failed:', err);
	}

	safeUI('panel refresh', refreshPanel);
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
		Game.registerHook('draw', onDraw);
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

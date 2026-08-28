/**
 * A faithful, seedable reimplementation of Cookie Clicker's stock market.
 *
 * Transcribed from resources/app/src/minigameMarket.js (game v2.053):
 * M.tick, M.buyGood, M.sellGood, M.getGoodMaxStock, M.getRestingVal,
 * M.getBrokerPrice, M.getMaxBrokers and M.reset, with Math.random() swapped
 * for a seeded PRNG so two bots can be run over identical price paths.
 *
 * Trades have no market impact in this game (buyGood/sellGood never touch
 * good.val or good.d), so the price path really is identical regardless of
 * what a bot does.
 */
'use strict';

const CFG = {
	GOOD_COUNT:      16,
	BANK_LEVEL:      10,
	OFFICE_LEVEL:    3,
	BUILDING_HIGH:   200,
	BUILDING_LEVEL:  5,
	GRANDMA_HIGH:    500,
	GRANDMA_LEVEL:   10,
	RATE:            1e9,          // cookiesPsRawHighest, held constant
	DRAGON_BOOST:    0
};
CFG.START_COOKIES   = CFG.RATE * 3600;  // one hour of banked CpS
CFG.INCOME_PER_TICK = CFG.RATE * 60;    // a market tick is 60 seconds

function mulberry32(a) {
	return function () {
		a |= 0; a = (a + 0x6D2B79F5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function buildWorld(seed, overrides) {
	const cfg = Object.assign({}, CFG, overrides || {});
	const rnd = mulberry32(seed);
	const choose = (arr) => arr[Math.floor(rnd() * arr.length)];

	const Game = {
		cookies: cfg.START_COOKIES,
		cookiesEarned: cfg.START_COOKIES,
		cookiesPsRawHighest: cfg.RATE,
		Objects: {},
		mods: {},
		modHooks: {logic: [], draw: [], reset: [], reincarnate: [], ticker: [],
		           cps: [], cookiesPerClick: [], click: [], create: [], check: []},
		Spend(n) { Game.cookies -= n; },
		Win() {},
		Notify() {},
		auraMult() { return 0; },
		isMinigameReady() { return true; },
		registerHook(hook, fn) { if (Game.modHooks[hook]) Game.modHooks[hook].push(fn); },
		runModHook(hook, p) { for (const fn of Game.modHooks[hook]) fn(p); },
		registerMod(id, mod) { Game.mods[id] = mod; if (mod.init) mod.init(); }
	};

	Game.Objects['Grandma'] = {highest: cfg.GRANDMA_HIGH, level: cfg.GRANDMA_LEVEL};

	const M = {
		brokers: 0,
		officeLevel: cfg.OFFICE_LEVEL,
		profit: 0,
		ticks: 0,
		toRedraw: 0,
		secondsPerTick: 60,
		goodsById: [],
		draw() {},
		checkGraphScale() {}
	};

	Game.Objects['Bank'] = {level: cfg.BANK_LEVEL, minigame: M, minigameLoaded: true, minigameUrl: 'x'};

	for (let i = 0; i < cfg.GOOD_COUNT; i++) {
		M.goodsById.push({
			id: i, symbol: 'G' + String(i).padStart(2, '0'),
			building: {highest: cfg.BUILDING_HIGH, level: cfg.BUILDING_LEVEL},
			stock: 0, mode: 0, dur: 0, prev: 0, val: 1, vals: [1], d: 0, last: 0,
			active: true, hidden: false
		});
	}

	M.getRestingVal  = (id) => 10 + 10 * id + (Game.Objects['Bank'].level - 1);
	M.getGoodPrice   = (good) => good.val;
	M.getMaxBrokers  = () => Math.ceil(Game.Objects['Grandma'].highest / 10 + Game.Objects['Grandma'].level);
	M.getBrokerPrice = () => Game.cookiesPsRawHighest * 60 * 20;

	M.getGoodMaxStock = function (good) {
		let bonus = 0;
		if (M.officeLevel > 0) bonus += 25;
		if (M.officeLevel > 1) bonus += 50;
		if (M.officeLevel > 2) bonus += 75;
		if (M.officeLevel > 3) bonus += 100;
		return Math.ceil(good.building.highest * (M.officeLevel > 4 ? 1.5 : 1) + bonus + good.building.level * 10);
	};

	M.buyGood = function (id, n) {
		const me = M.goodsById[id];
		const costInS = M.getGoodPrice(me);
		let cost = Game.cookiesPsRawHighest * costInS;
		const overhead = 1 + 0.01 * (20 * Math.pow(0.95, M.brokers));
		cost *= overhead;
		if (n === 10000) n = Math.floor(Game.cookies / cost);
		n = Math.min(n, M.getGoodMaxStock(me) - me.stock);
		if (n > 0 && me.last !== 2 && Game.cookies >= cost * n && me.stock + n <= M.getGoodMaxStock(me)) {
			M.profit -= costInS * overhead * n;
			Game.Spend(cost * n);
			me.stock += n;
			me.last = 1;
			me.prev = costInS;
			return true;
		}
		return false;
	};

	M.sellGood = function (id, n) {
		const me = M.goodsById[id];
		if (n === 10000) n = me.stock;
		n = Math.min(n, me.stock);
		if (n > 0 && me.last !== 1 && me.stock > 0) {
			const costInS = M.getGoodPrice(me);
			M.profit += costInS * n;
			Game.cookies += Game.cookiesPsRawHighest * costInS * n;
			Game.cookiesEarned = Math.max(Game.cookies, Game.cookiesEarned);
			me.stock -= n;
			me.last = 2;
			return true;
		}
		return false;
	};

	M.tick = function () {
		const dragonBoost = cfg.DRAGON_BOOST;
		let globD = 0; const globP = rnd();
		if (rnd() < 0.1 + 0.1 * dragonBoost) globD = (rnd() - 0.5) * 2;

		// Ground truth for dev/detector.js. The real game does not expose this;
		// it is recorded here only so the cross-sectional detector can be
		// scored against what actually happened.
		M.lastGlobD = globD;
		M.lastGlobHits = 0;
		for (let i = 0; i < M.goodsById.length; i++) {
			const me = M.goodsById[i];
			me.last = 0;
			me.d *= 0.97 + 0.01 * dragonBoost;

			if (me.mode === 0)      { me.d *= 0.95; me.d += 0.05 * (rnd() - 0.5); }
			else if (me.mode === 1) { me.d *= 0.99; me.d += 0.05 * (rnd() - 0.1); }
			else if (me.mode === 2) { me.d *= 0.99; me.d -= 0.05 * (rnd() - 0.1); }
			else if (me.mode === 3) { me.d += 0.15 * (rnd() - 0.1); me.val += rnd() * 5; }
			else if (me.mode === 4) { me.d -= 0.15 * (rnd() - 0.1); me.val -= rnd() * 5; }
			else if (me.mode === 5) { me.d += 0.3 * (rnd() - 0.5); }

			me.val += (M.getRestingVal(me.id) - me.val) * 0.01;

			if (globD !== 0 && rnd() < globP) {
				me.val -= (1 + me.d * Math.pow(rnd(), 3) * 7) * globD;
				me.val -= globD * (1 + Math.pow(rnd(), 3) * 7);
				me.d += globD * (1 + rnd() * 4);
				me.dur = 0;
				M.lastGlobHits++;
			}

			me.val += Math.pow((rnd() - 0.5) * 2, 11) * 3;
			me.d += 0.1 * (rnd() - 0.5);
			if (rnd() < 0.15) me.val += (rnd() - 0.5) * 3;
			if (rnd() < 0.03) me.val += (rnd() - 0.5) * (10 + 10 * dragonBoost);
			if (rnd() < 0.1)  me.d   += (rnd() - 0.5) * (0.3 + 0.2 * dragonBoost);
			if (me.mode === 5) {
				if (rnd() < 0.5) me.val += (rnd() - 0.5) * 10;
				if (rnd() < 0.2) me.d = (rnd() - 0.5) * (2 + 6 * dragonBoost);
			}
			if (me.mode === 3 && rnd() < 0.3)  { me.d += (rnd() - 0.5) * 0.1; me.val += (rnd() - 0.7) * 10; }
			if (me.mode === 3 && rnd() < 0.03) { me.mode = 4; }
			if (me.mode === 4 && rnd() < 0.3)  { me.d += (rnd() - 0.5) * 0.1; me.val += (rnd() - 0.3) * 10; }

			if (me.val > (100 + (Game.Objects['Bank'].level - 1) * 3) && me.d > 0) me.d *= 0.9;

			me.val += me.d;
			if (me.val < 5) me.val += (5 - me.val) * 0.5;
			if (me.val < 5 && me.d < 0) me.d *= 0.95;
			me.val = Math.max(me.val, 1);

			me.vals.unshift(me.val);
			if (me.vals.length > 65) me.vals.pop();

			me.dur--;
			if (me.dur <= 0) {
				me.dur = Math.floor(10 + rnd() * (690 - 200 * dragonBoost));
				if (rnd() < dragonBoost && rnd() < 0.5) me.mode = 5;
				else if (rnd() < 0.7 && (me.mode === 3 || me.mode === 4)) me.mode = 5;
				else me.mode = choose([0, 1, 1, 2, 2, 3, 4, 5]);
			}
		}
		M.ticks++;
	};

	M.reset = function () {
		M.brokers = 0; M.officeLevel = cfg.OFFICE_LEVEL; M.profit = 0; M.ticks = 0;
		for (const it of M.goodsById) {
			it.stock = 0;
			it.mode = choose([0, 1, 1, 2, 2, 3, 4, 5]);
			it.dur = Math.floor(10 + rnd() * 690);
			it.val = M.getRestingVal(it.id);
			it.d = rnd() * 0.2 - 0.1;
			it.vals = [it.val, it.val - it.d];
			it.last = 0; it.prev = 0;
		}
		for (let i = 0; i < 15; i++) M.tick();
	};

	M.reset();
	return {Game, M, cfg};
}

module.exports = {buildWorld, buildWorldForProbe: buildWorld, CFG, mulberry32};

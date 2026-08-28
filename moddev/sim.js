/**
 * Head-to-head benchmark for Cookie Clicker stock market bots.
 *
 * Both bots are loaded from their real main.js into a sandbox and run against
 * the game's own market model (dev/market.js) over identical seeded price
 * paths. Trades have no market impact in this game, so the price path is the
 * same for both and every difference in the result comes from the decisions.
 *
 *   node dev/sim.js [ticks] [runs]
 *   node dev/sim.js [ticks] [runs] --sweep
 */
'use strict';

const fs   = require('fs');
const vm   = require('vm');
const path = require('path');
const {buildWorld, CFG} = require('./market');

const MOD_DIR = path.resolve(__dirname, '..');
const OURS    = path.join(MOD_DIR, 'main.js');

// Optional comparison target: the main.js of any other market mod, including
// an older snapshot of this one.
//   node dev/sim.js 15000 10 --compare=dev/baseline_v11.js
// Whether it is stepped by the market tick or by the logic hook is detected
// from what it registers, so either style measures correctly.
const COMPARE = (() => {
	const arg = process.argv.find((a) => a.startsWith('--compare='));
	if (!arg) return null;
	const p = path.resolve(MOD_DIR, arg.slice('--compare='.length));
	return fs.existsSync(p) ? p : null;
})();

/* ---------------- sandboxing ---------------- */

function noopDocument() {
	return {
		getElementById: () => null,
		createElement: () => ({style: {}, appendChild() {}, addEventListener() {}}),
		head: {appendChild() {}},
		body: {appendChild() {}}
	};
}

function loadBot(file, world) {
	const code = fs.readFileSync(file, 'utf8');
	const sandbox = {
		Game: world.Game,
		document: noopDocument(),
		console: {log() {}, error(...a) { console.error(...a); }},
		Beautify: (n) => String(Math.round(n)),
		setTimeout: (fn) => { fn(); return 0; },
		l: () => null,
		PlaySound: () => {}
	};
	sandbox.window = sandbox;
	sandbox.globalThis = sandbox;
	vm.createContext(sandbox);
	vm.runInContext(code, sandbox, {filename: file});
	return sandbox;
}

/* ---------------- scoring ---------------- */

function netWorth(world) {
	let held = 0;
	for (const g of world.M.goodsById) held += world.Game.cookiesPsRawHighest * g.val * g.stock;
	return world.Game.cookies + held;
}

/**
 * @param settings optional override object injected through the mod's own
 *                 load() hook, which is how Quant Broker reads its config.
 */
function run(botFile, seed, ticks, driveViaHook, settings) {
	const world = buildWorld(seed);

	// Count real traded volume by wrapping the market's own trade entry points,
	// so both bots are measured the same way regardless of their internals.
	const tally = {buys: 0, sells: 0, unitsIn: 0, unitsOut: 0, spent: 0, gained: 0, stockTicks: 0, capTicks: 0};
	const rawBuy = world.M.buyGood, rawSell = world.M.sellGood;
	world.M.buyGood = function (id, n) {
		const before = world.M.goodsById[id].stock, cookiesBefore = world.Game.cookies;
		const ok = rawBuy.call(world.M, id, n);
		if (ok) {
			tally.buys++;
			tally.unitsIn += world.M.goodsById[id].stock - before;
			tally.spent += cookiesBefore - world.Game.cookies;
		}
		return ok;
	};
	world.M.sellGood = function (id, n) {
		const before = world.M.goodsById[id].stock, cookiesBefore = world.Game.cookies;
		const ok = rawSell.call(world.M, id, n);
		if (ok) {
			tally.sells++;
			tally.unitsOut += before - world.M.goodsById[id].stock;
			tally.gained += world.Game.cookies - cookiesBefore;
		}
		return ok;
	};

	loadBot(botFile, world);

	// Whether a bot needs the logic hook pumped is a property of the bot, not
	// something the caller should have to know: a hook-driven mod compared with
	// driveViaHook off simply never trades and silently scores zero.
	if (world.Game.modHooks.logic.length > 0) driveViaHook = true;

	if (settings) {
		const mod = world.Game.mods['quant broker'];
		if (mod && mod.load) mod.load(JSON.stringify({v: 1, s: settings}));
	}

	const baseline = netWorth(world) + CFG.INCOME_PER_TICK * ticks; // never trading

	let minCookies = Infinity;
	for (let t = 0; t < ticks; t++) {
		world.Game.cookies += CFG.INCOME_PER_TICK;
		world.M.tick();                                    // rival rides the patched tick
		if (driveViaHook) world.Game.runModHook('logic');  // ours runs off the logic hook
		if (world.Game.cookies < minCookies) minCookies = world.Game.cookies;
		for (const g of world.M.goodsById) {
			tally.stockTicks += g.stock;
			tally.capTicks   += world.M.getGoodMaxStock(g);
		}
	}

	return {
		net: netWorth(world) - baseline,
		profitS: world.M.profit,
		brokers: world.M.brokers,
		minCookies,
		baseline,
		tally,
		fill: tally.capTicks > 0 ? tally.stockTicks / tally.capTicks : 0
	};
}

/* ---------------- reporting ---------------- */

const fmt = (n) => {
	const sign = n < 0 ? '-' : '+';
	const a = Math.abs(n);
	for (const [v, u] of [[1e15, 'Q'], [1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']]) {
		if (a >= v) return sign + (a / v).toFixed(2) + u;
	}
	return sign + a.toFixed(0);
};
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;

function evaluate(file, hook, ticks, runs, settings) {
	const nets = [], profits = [], mins = [], brokers = [], fills = [], vols = [], trades = [];
	for (let s = 0; s < runs; s++) {
		const r = run(file, 1000 + s * 7919, ticks, hook, settings);
		nets.push(r.net); profits.push(r.profitS); mins.push(r.minCookies); brokers.push(r.brokers);
		fills.push(r.fill); vols.push(r.tally.unitsIn); trades.push(r.tally.buys + r.tally.sells);
	}
	return {nets, profits, mins, brokers, fills, vols, trades};
}

const TICKS = parseInt(process.argv[2] || '20000', 10);
const RUNS  = parseInt(process.argv[3] || '8', 10);
const SWEEP = process.argv.includes('--sweep');

console.log('Cookie Clicker stock market bot benchmark');
console.log('market model: game v2.053 | ' + TICKS + ' ticks/run (' +
	(TICKS / 60).toFixed(0) + 'h of market time) | ' + RUNS + ' seeds | ' +
	CFG.GOOD_COUNT + ' goods | bank lvl ' + CFG.BANK_LEVEL);
console.log('baseline = never trading. net = final net worth - baseline, in cookies.');
console.log('starting cookies ' + fmt(CFG.START_COOKIES) + ', income ' + fmt(CFG.INCOME_PER_TICK) + '/tick');
console.log('');

if (SWEEP) {
	// Axes to explore; every combination is run over the same seeds.
	const AXES = {
		maxDeployPct: [0.10, 0.25, 0.50, 0.75, 1.00]
	};

	const keys = Object.keys(AXES);
	let grid = [{}];
	for (const k of keys) {
		const next = [];
		for (const base of grid) for (const v of AXES[k]) next.push(Object.assign({}, base, {[k]: v}));
		grid = next;
	}

	const rows = [];
	for (const g of grid) {
		const r = evaluate(OURS, true, TICKS, RUNS, g);
		rows.push({g, net: mean(r.nets), min: mean(r.mins)});
	}
	rows.sort((a, b) => b.net - a.net);

	console.log(keys.map((k) => k.padStart(13)).join(' ') + '   net cookies    min balance');
	for (const row of rows) {
		console.log(
			keys.map((k) => String(row.g[k]).padStart(13)).join(' ') + '   ' +
			fmt(row.net).padStart(11) + '   ' + fmt(row.min).padStart(11)
		);
	}
	process.exit(0);
}

const contenders = [];
if (COMPARE) contenders.push({name: 'reference mod', file: COMPARE, hook: false, settings: null});
contenders.push({name: 'Quant Broker v1.2', file: OURS, hook: true, settings: null});

const results = {};
for (const c of contenders) {
	if (!fs.existsSync(c.file)) { console.log('skip (missing): ' + c.file); continue; }
	results[c.name] = evaluate(c.file, c.hook, TICKS, RUNS, c.settings);
}

for (const name in results) {
	const r = results[name];
	console.log(name);
	console.log('  net cookies vs never trading : ' + fmt(mean(r.nets)));
	console.log('    per seed                   : ' + r.nets.map(fmt).join(', '));
	console.log('  profitable seeds             : ' + r.nets.filter((n) => n > 0).length + '/' + r.nets.length);
	console.log('  market $ profit (game metric): ' + fmt(mean(r.profits)));
	console.log('  brokers hired                : ' + mean(r.brokers).toFixed(1));
	console.log('  lowest cookie balance        : ' + fmt(mean(r.mins)) +
		'   (' + (100 * mean(r.mins) / CFG.START_COOKIES).toFixed(2) + '% of the starting bank)');
	console.log('  warehouse fill (time-avg)    : ' + (100 * mean(r.fills)).toFixed(1) + '%');
	console.log('  units bought / trades        : ' + Math.round(mean(r.vols)) + ' / ' + Math.round(mean(r.trades)));
	console.log('');
}

const names = Object.keys(results);
if (names.length === 2) {
	const a = mean(results[names[0]].nets), b = mean(results[names[1]].nets);
	console.log('=> ' + names[1] + ' vs ' + names[0] + ': ' + fmt(b - a) + ' cookies (' +
		(b / a).toFixed(2) + 'x)');
}

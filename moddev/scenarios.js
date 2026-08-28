/**
 * Robustness check: both bots across very different game states, to make sure
 * the tuned defaults are not overfitted to one configuration.
 *
 *   node dev/scenarios.js [ticks] [runs]
 */
'use strict';

const fs   = require('fs');
const vm   = require('vm');
const path = require('path');
const {buildWorld, CFG} = require('./market');

const MOD_DIR = path.resolve(__dirname, '..');
const OURS    = path.join(MOD_DIR, 'main.js');

// Optional comparison target, same contract as dev/sim.js --compare=
const COMPARE = (() => {
	const arg = process.argv.find((a) => a.startsWith('--compare='));
	if (!arg) return null;
	const p = path.resolve(MOD_DIR, arg.slice('--compare='.length));
	return fs.existsSync(p) ? p : null;
})();

const TICKS = parseInt(process.argv[2] || '12000', 10);
const RUNS  = parseInt(process.argv[3] || '6', 10);

const SCENARIOS = [
	{name: 'early game  (bank lvl 1, tiny warehouses, no brokers affordable)',
	 cfg: {BANK_LEVEL: 1, OFFICE_LEVEL: 0, BUILDING_HIGH: 30, BUILDING_LEVEL: 0,
	       GRANDMA_HIGH: 60, GRANDMA_LEVEL: 1}},

	{name: 'mid game    (bank lvl 5, medium warehouses)',
	 cfg: {BANK_LEVEL: 5, OFFICE_LEVEL: 2, BUILDING_HIGH: 120, BUILDING_LEVEL: 3,
	       GRANDMA_HIGH: 250, GRANDMA_LEVEL: 5}},

	{name: 'late game   (bank lvl 10, big warehouses)',
	 cfg: {}},

	{name: 'end game    (bank lvl 15, maxed offices)',
	 cfg: {BANK_LEVEL: 15, OFFICE_LEVEL: 5, BUILDING_HIGH: 600, BUILDING_LEVEL: 10,
	       GRANDMA_HIGH: 900, GRANDMA_LEVEL: 15}},

	{name: 'dragon aura (Supreme Intellect: far more chaotic market)',
	 cfg: {DRAGON_BOOST: 1}},

	{name: 'cash poor   (starting bank of 5 minutes, not an hour)',
	 cfg: {START_COOKIES: CFG.RATE * 300}}
];

function noopDocument() {
	return {
		getElementById: () => null,
		createElement: () => ({style: {}, appendChild() {}, addEventListener() {}}),
		head: {appendChild() {}}, body: {appendChild() {}}
	};
}

function run(botFile, seed, ticks, hook, cfg) {
	const world = buildWorld(seed, cfg);
	const code = fs.readFileSync(botFile, 'utf8');
	const sandbox = {
		Game: world.Game, document: noopDocument(),
		console: {log() {}, error(...a) { console.error(...a); }},
		Beautify: (n) => String(Math.round(n)),
		setTimeout: (fn) => { fn(); return 0; }, l: () => null, PlaySound: () => {}
	};
	sandbox.window = sandbox; sandbox.globalThis = sandbox;
	vm.createContext(sandbox);
	vm.runInContext(code, sandbox, {filename: botFile});

	// Same auto-detection as dev/sim.js: a hook-driven mod stepped without the
	// hook simply never trades and silently scores zero.
	if (world.Game.modHooks.logic.length > 0) hook = true;

	const income = (cfg && cfg.INCOME_PER_TICK) || CFG.INCOME_PER_TICK;
	const worth = () => {
		let held = 0;
		for (const g of world.M.goodsById) held += world.Game.cookiesPsRawHighest * g.val * g.stock;
		return world.Game.cookies + held;
	};
	const baseline = worth() + income * ticks;

	let minCookies = Infinity;
	for (let t = 0; t < ticks; t++) {
		world.Game.cookies += income;
		world.M.tick();
		if (hook) world.Game.runModHook('logic');
		if (world.Game.cookies < minCookies) minCookies = world.Game.cookies;
	}
	return {net: worth() - baseline, minCookies, baseline, profitS: world.M.profit};
}

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const fmt  = (n) => {
	const sign = n < 0 ? '-' : '+', a = Math.abs(n);
	for (const [v, u] of [[1e15, 'Q'], [1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']]) {
		if (a >= v) return sign + (a / v).toFixed(2) + u;
	}
	return sign + a.toFixed(0);
};

console.log('Robustness across game states | ' + TICKS + ' ticks | ' + RUNS + ' seeds each\n');
console.log('scenario'.padEnd(60) + (COMPARE ? 'reference' : '     n/a') + '        quant      ratio   quant wins');

const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7);
for (const sc of SCENARIOS) {
	if (ONLY && !sc.name.includes(ONLY)) continue;
	const A = [], B = [], mins = [];
	let wins = 0;
	for (let s = 0; s < RUNS; s++) {
		const seed = 1000 + s * 7919;
		const ra = COMPARE ? run(COMPARE, seed, TICKS, false, sc.cfg) : {net: 0, minCookies: 0, profitS: 0};
		const rb = run(OURS,     seed, TICKS, true,  sc.cfg);
		A.push(ra.net); B.push(rb.net); mins.push(rb.minCookies);
		if (rb.net > ra.net) wins++;
		if (process.argv.includes('--verbose')) {
			console.log('    seed ' + seed + ': reference ' + fmt(ra.net) + ' ($' + ra.profitS.toFixed(0) +
				')  quant ' + fmt(rb.net) + ' ($' + rb.profitS.toFixed(0) + ')');
		}
	}
	const a = mean(A), b = mean(B);
	console.log(
		sc.name.padEnd(60) +
		fmt(a).padStart(9) + '  ' + fmt(b).padStart(11) + '  ' +
		(a !== 0 ? (b / a).toFixed(2) + 'x' : '   -').padStart(8) + '   ' +
		wins + '/' + RUNS
	);
}

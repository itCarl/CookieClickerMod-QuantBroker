/**
 * Strategy ablations. Each variant is a textual patch of the real main.js,
 * written to a temp file and benchmarked exactly like the shipping mod, so
 * nothing here can drift away from the code that actually runs.
 *
 *   node dev/experiments.js [ticks] [runs]
 */
'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const vm   = require('vm');
const {buildWorld, CFG} = require('./market');

const MOD_DIR = path.resolve(__dirname, '..');
const BASE    = fs.readFileSync(path.join(MOD_DIR, 'main.js'), 'utf8');

const TICKS = parseInt(process.argv[2] || '12000', 10);
const RUNS  = parseInt(process.argv[3] || '6', 10);

/* ---------------- variants ---------------- */

function patch(src, pairs) {
	let out = src;
	for (const [from, to] of pairs) {
		if (!out.includes(from)) throw new Error('patch target not found: ' + from.slice(0, 60));
		out = out.split(from).join(to);
	}
	return out;
}

const VARIANTS = [
	{name: 'baseline (shipping defaults)', pairs: []},
	{name: 'lr 0.002 + hold 20', pairs: [["learnRate:       0.01,", "learnRate:       0.002,"],["maxHoldTicks:    5,", "maxHoldTicks:    20,"]]},
	{name: 'lr 0.002 + hold 30', pairs: [["learnRate:       0.01,", "learnRate:       0.002,"],["maxHoldTicks:    5,", "maxHoldTicks:    30,"]]},
	{name: 'lr 0.002 + hold 45', pairs: [["learnRate:       0.01,", "learnRate:       0.002,"],["maxHoldTicks:    5,", "maxHoldTicks:    45,"]]},
	{name: 'lr 0.003 + hold 20', pairs: [["learnRate:       0.01,", "learnRate:       0.003,"],["maxHoldTicks:    5,", "maxHoldTicks:    20,"]]},
	{name: 'lr 0.003 + hold 30', pairs: [["learnRate:       0.01,", "learnRate:       0.003,"],["maxHoldTicks:    5,", "maxHoldTicks:    30,"]]},
	{name: 'lr 0.003 + hold 45', pairs: [["learnRate:       0.01,", "learnRate:       0.003,"],["maxHoldTicks:    5,", "maxHoldTicks:    45,"]]},
	{name: 'lr 0.004 + hold 20', pairs: [["learnRate:       0.01,", "learnRate:       0.004,"],["maxHoldTicks:    5,", "maxHoldTicks:    20,"]]},
	{name: 'lr 0.004 + hold 30', pairs: [["learnRate:       0.01,", "learnRate:       0.004,"],["maxHoldTicks:    5,", "maxHoldTicks:    30,"]]},
	{name: 'lr 0.004 + hold 45', pairs: [["learnRate:       0.01,", "learnRate:       0.004,"],["maxHoldTicks:    5,", "maxHoldTicks:    45,"]]},
];

/* ---------------- harness ---------------- */

function noopDocument() {
	return {
		getElementById: () => null,
		createElement: () => ({style: {}, appendChild() {}, addEventListener() {}}),
		head: {appendChild() {}}, body: {appendChild() {}}
	};
}

function runVariant(code, seed, ticks) {
	const world = buildWorld(seed);
	const sandbox = {
		Game: world.Game, document: noopDocument(),
		console: {log() {}, error(...a) { console.error(...a); }},
		Beautify: (n) => String(Math.round(n)),
		setTimeout: (fn) => { fn(); return 0; }, l: () => null, PlaySound: () => {}
	};
	sandbox.window = sandbox; sandbox.globalThis = sandbox;
	vm.createContext(sandbox);
	vm.runInContext(code, sandbox, {filename: 'variant.js'});

	const baseline = (() => {
		let held = 0;
		for (const g of world.M.goodsById) held += world.Game.cookiesPsRawHighest * g.val * g.stock;
		return world.Game.cookies + held + CFG.INCOME_PER_TICK * ticks;
	})();

	let minCookies = Infinity;
	for (let t = 0; t < ticks; t++) {
		world.Game.cookies += CFG.INCOME_PER_TICK;
		world.M.tick();
		world.Game.runModHook('logic');
		if (world.Game.cookies < minCookies) minCookies = world.Game.cookies;
	}

	let held = 0;
	for (const g of world.M.goodsById) held += world.Game.cookiesPsRawHighest * g.val * g.stock;
	return {net: world.Game.cookies + held - baseline, minCookies};
}

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const fmt  = (n) => {
	const sign = n < 0 ? '-' : '+', a = Math.abs(n);
	for (const [v, u] of [[1e15, 'Q'], [1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']]) {
		if (a >= v) return sign + (a / v).toFixed(3) + u;
	}
	return sign + a.toFixed(0);
};

console.log('Strategy ablations | ' + TICKS + ' ticks | ' + RUNS + ' seeds\n');

const rows = [];
for (const v of VARIANTS) {
	let code;
	try { code = patch(BASE, v.pairs); }
	catch (e) { console.log('SKIP ' + v.name + ': ' + e.message); continue; }

	const nets = [], mins = [];
	for (let s = 0; s < RUNS; s++) {
		const r = runVariant(code, 1000 + s * 7919, TICKS);
		nets.push(r.net); mins.push(r.minCookies);
	}
	rows.push({name: v.name, net: mean(nets), min: mean(mins)});
}

const base = rows.find((r) => r.name.startsWith('baseline'));
rows.sort((a, b) => b.net - a.net);

console.log('net cookies    vs baseline   min balance   variant');
for (const r of rows) {
	const delta = base ? ((r.net / base.net - 1) * 100) : 0;
	console.log(
		fmt(r.net).padStart(11) + '   ' +
		((delta >= 0 ? '+' : '') + delta.toFixed(1) + '%').padStart(11) + '   ' +
		fmt(r.min).padStart(11) + '   ' + r.name
	);
}

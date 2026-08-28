/**
 * Ablations for the 1.2 features.
 *
 * All of them are settings-driven, so unlike dev/ablate_new.js this does not
 * need to patch source: each variant is the shipping main.js configured
 * differently, injected through the mod's own load() hook.
 *
 * Two directions are reported, because they answer different questions:
 *   "+ feature"  - that feature alone, added to the 1.1 behaviour
 *   "- feature"  - that feature alone, removed from the full 1.2 set
 * A feature that helps on its own but hurts in combination shows up as the
 * difference between the two.
 *
 *   node dev/ablate_v12.js [ticks] [seeds]
 */
'use strict';

const fs   = require('fs');
const vm   = require('vm');
const path = require('path');

/*
 * The harness has to work from two places: inside the game tree (where it is
 * reached through a junction as moddev/<Mod>) and inside the git repo (where it
 * sits beside the mod as Code/moddev). The two have different relative layouts,
 * so nothing here assumes one - each path is looked up among the candidates and
 * the first that exists wins.
 */
function firstExisting(candidates, what) {
	for (var i = 0; i < candidates.length; i++) {
		if (fs.existsSync(candidates[i])) return candidates[i];
	}
	throw new Error('cannot find ' + what + ' - looked in:\n  ' + candidates.join('\n  '));
}

var GAME_DIR = 'C:/Program Files (x86)/Steam/steamapps/common/Cookie Clicker/resources/app';

function gameSrc(file) {
	return firstExisting([
		path.join(__dirname, '..', '..', 'src', file),   // moddev/<Mod> in the game tree
		path.join(GAME_DIR, 'src', file)                 // anywhere else
	], 'the game source ' + file);
}

function modMain(name) {
	return firstExisting([
		path.join(__dirname, '..', 'mod', 'main.js'),                        // in the repo
		path.join(__dirname, '..', '..', 'mods', 'local', name, 'main.js'),  // in the game tree
		path.join(GAME_DIR, 'mods', 'local', name, 'main.js')
	], name + '/main.js');
}

const {buildWorld, CFG} = require('./market');

const OURS  = modMain('QuantBroker');
const CODE  = fs.readFileSync(OURS, 'utf8');
const TICKS = parseInt(process.argv[2] || '15000', 10);
const SEEDS = parseInt(process.argv[3] || '10', 10);

// Everything new in 1.2 that changes a trading decision. achieveMode is not
// here: it deliberately abandons profit, so it is measured by dev/test.js
// reaching the target rather than by net cookies.
const FEATURES = ['shockDetect', 'ceilingRide', 'floorGrab', 'adaptBand', 'cpsHold'];

const OFF = {shockDetect: false, ceilingRide: false, floorGrab: false, adaptBand: false, cpsHold: false};
const ON  = {shockDetect: true,  ceilingRide: true,  floorGrab: true,  adaptBand: true,  cpsHold: true};

function noopDocument() {
	return {
		getElementById: () => null,
		createElement: () => ({style: {}, appendChild() {}, addEventListener() {}}),
		createTextNode: (t) => ({text: t}),
		head: {appendChild() {}}, body: {appendChild() {}}
	};
}

function run(seed, settings) {
	const world = buildWorld(seed);
	const sandbox = {
		Game: world.Game, document: noopDocument(),
		console: {log() {}, error(...a) { console.error(...a); }},
		Beautify: (n) => String(Math.round(n)),
		setTimeout: (fn) => { fn(); return 0; }, l: () => null, PlaySound: () => {}
	};
	sandbox.window = sandbox; sandbox.globalThis = sandbox;
	vm.createContext(sandbox);
	vm.runInContext(CODE, sandbox, {filename: OURS});

	const mod = world.Game.mods['quant broker'];
	mod.load(JSON.stringify({v: 1, s: settings}));

	const worth = () => {
		let held = 0;
		for (const g of world.M.goodsById) held += world.Game.cookiesPsRawHighest * g.val * g.stock;
		return world.Game.cookies + held;
	};
	const baseline = worth() + CFG.INCOME_PER_TICK * TICKS;

	let minCookies = Infinity;
	for (let t = 0; t < TICKS; t++) {
		world.Game.cookies += CFG.INCOME_PER_TICK;
		world.M.tick();
		world.Game.runModHook('logic');
		if (world.Game.cookies < minCookies) minCookies = world.Game.cookies;
	}

	const st = JSON.parse(mod.save()).t;
	return {net: worth() - baseline, min: minCookies, trades: st[0] + st[1], shocks: st[5] || 0};
}

function evaluate(settings) {
	const nets = [], mins = [], trades = [], shocks = [];
	for (let s = 0; s < SEEDS; s++) {
		const r = run(1000 + s * 7919, settings);
		nets.push(r.net); mins.push(r.min); trades.push(r.trades); shocks.push(r.shocks);
	}
	const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
	return {net: mean(nets), min: mean(mins), trades: mean(trades), shocks: mean(shocks), nets};
}

const fmt = (n) => {
	const sign = n < 0 ? '-' : '+';
	const a = Math.abs(n);
	for (const [v, u] of [[1e15, 'Q'], [1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']]) {
		if (a >= v) return sign + (a / v).toFixed(2) + u;
	}
	return sign + a.toFixed(0);
};

console.log('Quant Broker 1.2 feature ablation');
console.log(TICKS + ' ticks, ' + SEEDS + ' seeds, bank lvl ' + CFG.BANK_LEVEL);
console.log('');

const base = evaluate(Object.assign({}, OFF));
const full = evaluate(Object.assign({}, ON));
const ship = evaluate({});   // whatever DEFAULTS currently says

const row = (label, r, ref) => {
	const delta = ref ? ((r.net / ref.net - 1) * 100) : 0;
	const wins  = ref ? r.nets.filter((n, i) => n > ref.nets[i]).length : 0;
	console.log(
		label.padEnd(26) +
		fmt(r.net).padStart(10) +
		(ref ? ((delta >= 0 ? '+' : '') + delta.toFixed(1) + '%').padStart(9) : ''.padStart(9)) +
		(ref ? (wins + '/' + SEEDS).padStart(7) : ''.padStart(7)) +
		Math.round(r.trades).toString().padStart(9) +
		fmt(r.min).padStart(11)
	);
};

console.log('variant'.padEnd(26) + 'net'.padStart(10) + 'vs base'.padStart(9) +
	'wins'.padStart(7) + 'trades'.padStart(9) + 'min bal'.padStart(11));
row('1.1 behaviour (all off)', base, null);
for (const f of FEATURES) row('+ ' + f, evaluate(Object.assign({}, OFF, {[f]: true})), base);
console.log('');
row('every feature forced on', full, base);
for (const f of FEATURES) row('- ' + f, evaluate(Object.assign({}, ON, {[f]: false})), full);
console.log('');
row('SHIPPED DEFAULTS', ship, base);

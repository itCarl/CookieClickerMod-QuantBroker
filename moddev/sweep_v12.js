/**
 * Parameter sweeps for the 1.2 features, and the growing-CpS scenario the
 * standard benchmark deliberately cannot measure.
 *
 *   node dev/sweep_v12.js ride     [ticks] [seeds]   ceilingRideTicks
 *   node dev/sweep_v12.js deploy   [ticks] [seeds]   shockDeployMult / shockRelax / shockTicks
 *   node dev/sweep_v12.js early    [ticks] [seeds]   floorGrab where the floor actually binds
 *   node dev/sweep_v12.js cps      [ticks] [seeds]   cpsHold against a rising cookiesPsRawHighest
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

const OURS = modMain('QuantBroker');
const CODE = fs.readFileSync(OURS, 'utf8');

const MODE  = process.argv[2] || 'ride';
const TICKS = parseInt(process.argv[3] || '12000', 10);
const SEEDS = parseInt(process.argv[4] || '8', 10);

function noopDocument() {
	return {
		getElementById: () => null,
		createElement: () => ({style: {}, appendChild() {}, addEventListener() {}}),
		createTextNode: (t) => ({text: t}),
		head: {appendChild() {}}, body: {appendChild() {}}
	};
}

/**
 * @param rateGrowth per-tick growth applied to Game.cookiesPsRawHighest. The
 *        standard benchmark holds it constant so cookies and dollars stay
 *        proportional; the whole point of cpsHold is what happens when it does
 *        not, so it has to be modelled explicitly to be measured at all.
 */
function run(seed, settings, cfg, rateGrowth) {
	const world = buildWorld(seed, cfg);
	const sandbox = {
		Game: world.Game, document: noopDocument(),
		console: {log() {}, error(...a) { console.error(...a); }},
		Beautify: (n) => String(Math.round(n)),
		setTimeout: (fn) => { fn(); return 0; }, l: () => null, PlaySound: () => {}
	};
	sandbox.window = sandbox; sandbox.globalThis = sandbox;
	vm.createContext(sandbox);
	vm.runInContext(CODE, sandbox, {filename: OURS});
	world.Game.mods['quant broker'].load(JSON.stringify({v: 1, s: settings}));

	const worth = () => {
		let held = 0;
		for (const g of world.M.goodsById) held += world.Game.cookiesPsRawHighest * g.val * g.stock;
		return world.Game.cookies + held;
	};

	// The never-trading baseline has to be accumulated tick by tick once income
	// scales with a moving rate, otherwise the comparison is against the wrong
	// counterfactual.
	let baselineCookies = worth();
	let minCookies = Infinity;

	for (let t = 0; t < TICKS; t++) {
		if (rateGrowth) world.Game.cookiesPsRawHighest *= (1 + rateGrowth);
		const income = world.Game.cookiesPsRawHighest * 60;
		world.Game.cookies += income;
		baselineCookies += income;
		world.M.tick();
		world.Game.runModHook('logic');
		if (world.Game.cookies < minCookies) minCookies = world.Game.cookies;
	}

	const st = JSON.parse(world.Game.mods['quant broker'].save()).t;
	return {net: worth() - baselineCookies, min: minCookies, trades: st[0] + st[1]};
}

function evaluate(settings, cfg, rateGrowth) {
	const nets = [], mins = [], trades = [];
	for (let s = 0; s < SEEDS; s++) {
		const r = run(1000 + s * 7919, settings, cfg, rateGrowth);
		nets.push(r.net); mins.push(r.min); trades.push(r.trades);
	}
	const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
	return {net: mean(nets), min: mean(mins), trades: mean(trades), nets};
}

const fmt = (n) => {
	const sign = n < 0 ? '-' : '+';
	const a = Math.abs(n);
	for (const [v, u] of [[1e18, 'Sx'], [1e15, 'Q'], [1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']]) {
		if (a >= v) return sign + (a / v).toFixed(2) + u;
	}
	return sign + a.toFixed(0);
};

function table(title, rows, ref) {
	console.log(title);
	console.log('  ' + 'variant'.padEnd(28) + 'net'.padStart(11) + 'vs ref'.padStart(9) +
		'wins'.padStart(7) + 'trades'.padStart(9) + 'min bal'.padStart(11));
	for (const [label, r] of rows) {
		const d = ref && ref !== r ? ((r.net / ref.net - 1) * 100) : null;
		const w = ref && ref !== r ? r.nets.filter((n, i) => n > ref.nets[i]).length : null;
		console.log('  ' + label.padEnd(28) + fmt(r.net).padStart(11) +
			(d === null ? ''.padStart(9) : ((d >= 0 ? '+' : '') + d.toFixed(1) + '%').padStart(9)) +
			(w === null ? ''.padStart(7) : (w + '/' + SEEDS).padStart(7)) +
			Math.round(r.trades).toString().padStart(9) + fmt(r.min).padStart(11));
	}
	console.log('');
}

const OFF = {shockDetect: false, ceilingRide: false, floorGrab: false, adaptBand: false, cpsHold: false};

if (MODE === 'ride') {
	const base = evaluate(Object.assign({}, OFF), {}, 0);
	const rows = [['ceilingRide off', base]];
	for (const n of [5, 20, 40, 80]) {
		rows.push(['ceilingRideTicks ' + n,
			evaluate(Object.assign({}, OFF, {ceilingRide: true, ceilingRideTicks: n}), {}, 0)]);
	}
	table('ride budget above the soft ceiling (bank lvl ' + CFG.BANK_LEVEL + ')', rows, base);

} else if (MODE === 'deploy') {
	const base = evaluate(Object.assign({}, OFF), {}, 0);
	const rows = [['shockDetect off', base]];
	for (const mult of [1.0, 1.5, 2.0, 3.0]) {
		rows.push(['deployMult ' + mult.toFixed(1),
			evaluate(Object.assign({}, OFF, {shockDetect: true, shockDeployMult: mult}), {}, 0)]);
	}
	for (const relax of [0, 0.15, 0.25, 0.40]) {
		rows.push(['relax ' + relax.toFixed(2) + ' @mult 1.5',
			evaluate(Object.assign({}, OFF, {shockDetect: true, shockDeployMult: 1.5, shockRelax: relax}), {}, 0)]);
	}
	for (const tk of [1, 3, 6]) {
		rows.push(['shockTicks ' + tk + ' @mult 1.5',
			evaluate(Object.assign({}, OFF, {shockDetect: true, shockDeployMult: 1.5, shockTicks: tk}), {}, 0)]);
	}
	table('crash stance tuning', rows, base);

} else if (MODE === 'shock2') {
	// deployMult made no difference to net at all in the first sweep, so it is
	// pinned at 1.0 here: the cap stays honoured and the edge has to come from
	// the relaxed buy line and the suppressed regime rules instead.
	const base = evaluate(Object.assign({}, OFF), {}, 0);
	const rows = [['shockDetect off', base]];
	for (const relax of [0.25, 0.40, 0.55, 0.70]) {
		for (const tk of [1, 2, 3]) {
			rows.push(['relax ' + relax.toFixed(2) + ' ticks ' + tk,
				evaluate(Object.assign({}, OFF, {
					shockDetect: true, shockDeployMult: 1.0, shockRelax: relax, shockTicks: tk
				}), {}, 0)]);
		}
	}
	table('crash stance, deploy cap honoured', rows, base);

} else if (MODE === 'jump') {
	// dev/detector.js grades this on detection accuracy; this grades it on the
	// only thing that actually matters, which is cookies.
	const base = evaluate(Object.assign({}, OFF), {}, 0);
	const rows = [['shockDetect off', base]];
	for (const j of [0.3, 0.4, 0.6, 0.8, 1.2]) {
		rows.push(['shockJump ' + j.toFixed(1),
			evaluate(Object.assign({}, OFF, {shockDetect: true, shockJump: j}), {}, 0)]);
	}
	table('detection threshold, scored on P&L', rows, base);

} else if (MODE === 'early') {
	// Early game: small resting values and tiny warehouses, so the $5 floor is
	// a price a good actually reaches instead of a theoretical bound.
	const cfg = {BANK_LEVEL: 1, OFFICE_LEVEL: 0, BUILDING_HIGH: 30, BUILDING_LEVEL: 0,
	             GRANDMA_HIGH: 50, GRANDMA_LEVEL: 1};
	const base = evaluate(Object.assign({}, OFF), cfg, 0);
	const rows = [
		['floorGrab off', base],
		['floorGrab $6', evaluate(Object.assign({}, OFF, {floorGrab: true, floorPrice: 6}), cfg, 0)],
		['floorGrab $8', evaluate(Object.assign({}, OFF, {floorGrab: true, floorPrice: 8}), cfg, 0)],
		['floorGrab $12', evaluate(Object.assign({}, OFF, {floorGrab: true, floorPrice: 12}), cfg, 0)]
	];
	table('floor grab, early game (bank lvl 1, tiny warehouses)', rows, base);

	const base2 = evaluate(Object.assign({}, OFF), {}, 0);
	table('floor grab, late game (bank lvl ' + CFG.BANK_LEVEL + ')', [
		['floorGrab off', base2],
		['floorGrab $6', evaluate(Object.assign({}, OFF, {floorGrab: true, floorPrice: 6}), {}, 0)]
	], base2);

} else if (MODE === 'cps') {
	// +0.05%/tick is about a 2.0x rise over 1500 ticks - an ordinary stretch of
	// a run in which buildings and upgrades keep landing.
	for (const growth of [0, 0.0005, 0.002]) {
		const base = evaluate(Object.assign({}, OFF), {}, growth);
		const rows = [['cpsHold off', base]];
		for (const h of [10, 20, 60]) {
			rows.push(['cpsHoldTicks ' + h,
				evaluate(Object.assign({}, OFF, {cpsHold: true, cpsHoldTicks: h}), {}, growth)]);
		}
		table('raw CpS growth ' + (growth * 100).toFixed(2) + '%/tick', rows, base);
	}
}

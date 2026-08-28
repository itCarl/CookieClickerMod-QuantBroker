/**
 * Coordinate-descent search over the tunable settings, with a train/test seed
 * split so a win has to generalise before it is believed.
 *
 * Settings are injected through the mod's own load() hook, so the thing being
 * optimised is the shipping code, not a copy of the strategy.
 *
 *   node dev/optimize.js [ticks] [trainSeeds] [testSeeds]
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

const TICKS  = parseInt(process.argv[2] || '12000', 10);
const NTRAIN = parseInt(process.argv[3] || '8', 10);
const NTEST  = parseInt(process.argv[4] || '8', 10);

// Disjoint seed sets. Test seeds are never looked at during the search.
const TRAIN = Array.from({length: NTRAIN}, (_, i) => 1000 + i * 7919);
const TEST  = Array.from({length: NTEST},  (_, i) => 500000 + i * 6271);

const BASE = {
	buyQuantile: 0.17, sellQuantile: 0.88, minMargin: 0.05, maxDeployPct: 0.50,
	maxHoldTicks: 30, learnRate: 0.003, warmupTicks: 20
};

// value grids for each axis
const AXES = {
	buyQuantile:  [0.17, 0.22, 0.28, 0.34, 0.40, 0.46, 0.52],
	sellQuantile: [0.60, 0.66, 0.72, 0.78, 0.84, 0.90],
	minMargin:    [0.00, 0.05, 0.10, 0.18, 0.28],
	maxHoldTicks: [30, 60, 100, 160, 240, 400],
	learnRate:    [0.0003, 0.0006, 0.001, 0.002, 0.004]
	// maxDeployPct is deliberately excluded: it is a liquidity guarantee to the
	// player, not a profit knob, and the earlier sweep showed it costs nothing.
};

function noopDocument() {
	return {
		getElementById: () => null,
		createElement: () => ({style: {}, appendChild() {}, addEventListener() {}}),
		head: {appendChild() {}}, body: {appendChild() {}}
	};
}

function runOne(settings, seed) {
	const world = buildWorld(seed);
	const sandbox = {
		Game: world.Game, document: noopDocument(),
		console: {log() {}, error() {}},
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
	const baseline = worth() + CFG.INCOME_PER_TICK * TICKS;

	for (let t = 0; t < TICKS; t++) {
		world.Game.cookies += CFG.INCOME_PER_TICK;
		world.M.tick();
		world.Game.runModHook('logic');
	}
	return worth() - baseline;
}

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const score = (settings, seeds) => mean(seeds.map((s) => runOne(settings, s)));
const fmt = (n) => {
	const sign = n < 0 ? '-' : '+', a = Math.abs(n);
	for (const [v, u] of [[1e15, 'Q'], [1e12, 'T'], [1e9, 'B'], [1e6, 'M']]) {
		if (a >= v) return sign + (a / v).toFixed(3) + u;
	}
	return sign + a.toFixed(0);
};

console.log('Coordinate descent | ' + TICKS + ' ticks | train ' + NTRAIN +
	' seeds, test ' + NTEST + ' seeds (disjoint)\n');

let current = Object.assign({}, BASE);
let best = score(current, TRAIN);
console.log('start   train ' + fmt(best) + '   ' + JSON.stringify(current));

let improved = true, pass = 0;
while (improved && pass < 4) {
	improved = false; pass++;
	for (const key of Object.keys(AXES)) {
		let bestVal = current[key], bestScore = best;
		for (const v of AXES[key]) {
			if (v === current[key]) continue;
			const trial = Object.assign({}, current, {[key]: v});
			const s = score(trial, TRAIN);
			if (s > bestScore) { bestScore = s; bestVal = v; }
		}
		if (bestVal !== current[key]) {
			console.log('  pass ' + pass + ': ' + key + ' ' + current[key] + ' -> ' + bestVal +
				'   train ' + fmt(bestScore) + '  (' + ((bestScore / best - 1) * 100).toFixed(2) + '%)');
			current[key] = bestVal; best = bestScore; improved = true;
		}
	}
}

console.log('\nbest on train : ' + fmt(best));
console.log('settings      : ' + JSON.stringify(current));

const baseTrain = score(BASE, TRAIN);
const baseTest  = score(BASE, TEST);
const newTest   = score(current, TEST);

console.log('\n--- held-out validation (never used during the search) ---');
console.log('shipping defaults   train ' + fmt(baseTrain) + '   test ' + fmt(baseTest));
console.log('optimised           train ' + fmt(best)      + '   test ' + fmt(newTest));
console.log('\ntrain gain ' + ((best / baseTrain - 1) * 100).toFixed(2) + '%   ' +
	'TEST GAIN ' + ((newTest / baseTest - 1) * 100).toFixed(2) + '%');
console.log(newTest > baseTest
	? '=> generalises; worth adopting'
	: '=> does NOT generalise; the train gain was overfitting');

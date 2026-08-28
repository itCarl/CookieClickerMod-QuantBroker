/**
 * Ablations for the two robustness features added alongside the retuned
 * defaults, each measured in the situation it exists for.
 *
 *   1. rescaleForBankLevel  -> tested while the bank levels up mid-run
 *   2. seedQuantile anchors -> tested on cold starts (short runs)
 *
 *   node dev/ablate_new.js [seeds]
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
const BASE = fs.readFileSync(OURS, 'utf8');
const SEEDS = parseInt(process.argv[2] || '8', 10);

function patch(src, pairs) {
	let out = src;
	for (const [from, to] of pairs) {
		if (!out.includes(from)) throw new Error('patch target missing: ' + from.slice(0, 50));
		out = out.split(from).join(to);
	}
	return out;
}

// Disables the level-up shift, leaving the estimator to crawl there on its own.
const NO_RESCALE = [['	if (lastBankLevel !== -1) {', '	if (false) {']];

// Replaces the measured anchors with the old single hardcoded guess.
const OLD_SEED = [
	['seedQuantile(restingVal, S.buyQuantile)',  'Math.max(2, restingVal * 0.55 - 3)'],
	['seedQuantile(restingVal, S.sellQuantile)', 'Math.max(6, restingVal * 0.67 + 44)']
];

function noopDocument() {
	return {
		getElementById: () => null,
		createElement: () => ({style: {}, appendChild() {}, addEventListener() {}}),
		head: {appendChild() {}}, body: {appendChild() {}}
	};
}

function run(code, seed, ticks, levelUpEvery) {
	const cfg = levelUpEvery ? {BANK_LEVEL: 1} : {};
	const world = buildWorld(seed, cfg);
	const sandbox = {
		Game: world.Game, document: noopDocument(),
		console: {log() {}, error() {}},
		Beautify: (n) => String(Math.round(n)),
		setTimeout: (fn) => { fn(); return 0; }, l: () => null, PlaySound: () => {}
	};
	sandbox.window = sandbox; sandbox.globalThis = sandbox;
	vm.createContext(sandbox);
	vm.runInContext(code, sandbox, {filename: 'variant.js'});

	const worth = () => {
		let held = 0;
		for (const g of world.M.goodsById) held += world.Game.cookiesPsRawHighest * g.val * g.stock;
		return world.Game.cookies + held;
	};
	const baseline = worth() + CFG.INCOME_PER_TICK * ticks;

	for (let t = 0; t < ticks; t++) {
		if (levelUpEvery && t > 0 && t % levelUpEvery === 0) {
			const b = world.Game.Objects['Bank'];
			if (b.level < 15) b.level += 1;
		}
		world.Game.cookies += CFG.INCOME_PER_TICK;
		world.M.tick();
		world.Game.runModHook('logic');
	}
	return worth() - baseline;
}

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const fmt  = (n) => {
	const sign = n < 0 ? '-' : '+', a = Math.abs(n);
	for (const [v, u] of [[1e15, 'Q'], [1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']]) {
		if (a >= v) return sign + (a / v).toFixed(2) + u;
	}
	return sign + a.toFixed(0);
};

function compare(label, codeA, codeB, ticks, levelUpEvery) {
	const A = [], B = [];
	let winsA = 0;
	for (let i = 0; i < SEEDS; i++) {
		const seed = 1000 + i * 7919;
		const a = run(codeA, seed, ticks, levelUpEvery);
		const b = run(codeB, seed, ticks, levelUpEvery);
		A.push(a); B.push(b);
		if (a > b) winsA++;
	}
	const ma = mean(A), mb = mean(B);
	console.log(label);
	console.log('   with feature : ' + fmt(ma));
	console.log('   without      : ' + fmt(mb));
	console.log('   gain         : ' + ((ma / mb - 1) * 100).toFixed(2) + '%   wins ' + winsA + '/' + SEEDS);
	console.log('');
}

console.log('Ablations for the new robustness features | ' + SEEDS + ' seeds\n');

compare('seeded quantile anchors  (cold start, 400 ticks)',
	BASE, patch(BASE, OLD_SEED), 400, 0);

compare('seeded quantile anchors  (cold start, 1500 ticks)',
	BASE, patch(BASE, OLD_SEED), 1500, 0);

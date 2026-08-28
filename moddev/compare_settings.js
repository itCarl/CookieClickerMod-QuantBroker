/**
 * Compares two settings sets of this mod across varied game states.
 *
 * The optimiser searches at a fixed bank level, so a candidate can win there by
 * exploiting a stationary price distribution and then fall apart when the bank
 * levels up or the dragon aura widens the swings. This is that check.
 *
 *   node dev/compare_settings.js [ticks] [seeds]
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

const TICKS = parseInt(process.argv[2] || '12000', 10);
const SEEDS = parseInt(process.argv[3] || '6', 10);

const SHIPPING = null; // null = use the file's own defaults
// The previous shipping defaults, so "candidate" here is the OLD tuning and
// "shipping" is the new one: a ratio below 1.0 means the new defaults win.
const CANDIDATE = {
	buyQuantile: 0.17, sellQuantile: 0.88, minMargin: 0.05,
	maxHoldTicks: 30, learnRate: 0.003
};

const SCENARIOS = [
	{name: 'early game  (bank lvl 1)',
	 cfg: {BANK_LEVEL: 1, OFFICE_LEVEL: 0, BUILDING_HIGH: 30, BUILDING_LEVEL: 0,
	       GRANDMA_HIGH: 60, GRANDMA_LEVEL: 1}},
	{name: 'mid game    (bank lvl 5)',
	 cfg: {BANK_LEVEL: 5, OFFICE_LEVEL: 2, BUILDING_HIGH: 120, BUILDING_LEVEL: 3,
	       GRANDMA_HIGH: 250, GRANDMA_LEVEL: 5}},
	{name: 'late game   (bank lvl 10)', cfg: {}},
	{name: 'end game    (bank lvl 15)',
	 cfg: {BANK_LEVEL: 15, OFFICE_LEVEL: 5, BUILDING_HIGH: 600, BUILDING_LEVEL: 10,
	       GRANDMA_HIGH: 900, GRANDMA_LEVEL: 15}},
	{name: 'dragon aura (chaotic market)', cfg: {DRAGON_BOOST: 1}},
	{name: 'short run   (1500 ticks)', cfg: {}, ticks: 1500},
	{name: 'very short  (400 ticks)',  cfg: {}, ticks: 400}
];

function noopDocument() {
	return {
		getElementById: () => null,
		createElement: () => ({style: {}, appendChild() {}, addEventListener() {}}),
		head: {appendChild() {}}, body: {appendChild() {}}
	};
}

function run(settings, seed, cfg, ticks) {
	const world = buildWorld(seed, cfg);
	const sandbox = {
		Game: world.Game, document: noopDocument(),
		console: {log() {}, error() {}},
		Beautify: (n) => String(Math.round(n)),
		setTimeout: (fn) => { fn(); return 0; }, l: () => null, PlaySound: () => {}
	};
	sandbox.window = sandbox; sandbox.globalThis = sandbox;
	vm.createContext(sandbox);
	vm.runInContext(CODE, sandbox, {filename: OURS});
	if (settings) world.Game.mods['quant broker'].load(JSON.stringify({v: 1, s: settings}));

	const income = CFG.INCOME_PER_TICK;
	const worth = () => {
		let held = 0;
		for (const g of world.M.goodsById) held += world.Game.cookiesPsRawHighest * g.val * g.stock;
		return world.Game.cookies + held;
	};
	const baseline = worth() + income * ticks;
	for (let t = 0; t < ticks; t++) {
		world.Game.cookies += income;
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

console.log('shipping defaults vs candidate | ' + SEEDS + ' seeds each');
console.log('candidate: ' + JSON.stringify(CANDIDATE) + '\n');
console.log('scenario'.padEnd(32) + '     new          old      old/new   old wins');

for (const sc of SCENARIOS) {
	const ticks = sc.ticks || TICKS;
	const A = [], B = [];
	let wins = 0;
	for (let i = 0; i < SEEDS; i++) {
		const seed = 1000 + i * 7919;
		const a = run(SHIPPING, seed, sc.cfg, ticks);
		const b = run(CANDIDATE, seed, sc.cfg, ticks);
		A.push(a); B.push(b);
		if (b > a) wins++;
	}
	const a = mean(A), b = mean(B);
	console.log(
		sc.name.padEnd(32) + fmt(a).padStart(9) + '  ' + fmt(b).padStart(12) + '  ' +
		(a !== 0 ? (b / a).toFixed(3) + 'x' : '  -').padStart(9) + '   ' + wins + '/' + SEEDS
	);
}

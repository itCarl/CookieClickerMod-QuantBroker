/**
 * Scores the shock detector against ground truth.
 *
 * The game never tells a mod that a global shock happened; Quant Broker infers
 * it from the cross-section of momentum changes. dev/market.js records what
 * actually happened on each tick (M.lastGlobD, M.lastGlobHits), so the
 * inference can be graded directly instead of only through its P&L.
 *
 * A shock that touched only one or two goods is genuinely undetectable and
 * also not worth trading, so recall is reported both over all shock ticks and
 * over the ones that were broad enough to matter.
 *
 *   node dev/detector.js [ticks] [seeds]
 *   node dev/detector.js [ticks] [seeds] --sweep   grade several thresholds
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

const {buildWorld} = require('./market');

const OURS  = modMain('QuantBroker');
const CODE  = fs.readFileSync(OURS, 'utf8');
const TICKS = parseInt(process.argv[2] || '20000', 10);
const SEEDS = parseInt(process.argv[3] || '5', 10);

// The panel's status line is the only place the stance is published, so the
// detector is read the same way a player would see it.
function makeDOM() {
	const byId = new Map();
	const mk = () => {
		const el = {
			id: '', className: '', textContent: '', style: {}, isConnected: true,
			_attrs: {}, children: [],
			getAttribute(k) { return k in this._attrs ? this._attrs[k] : null; },
			setAttribute(k, v) { this._attrs[k] = v; },
			addEventListener() {},
			appendChild(c) { this.children.push(c); if (c.id) byId.set(c.id, c); return c; },
			removeChild(c) { return c; },
			set innerHTML(h) {
				this._h = h;
				const re = /<(\w+)([^>]*)\bid="([^"]+)"/g;
				let m;
				while ((m = re.exec(h))) { const c = mk(); c.id = m[3]; byId.set(c.id, c); }
			},
			get innerHTML() { return this._h || ''; }
		};
		return el;
	};
	const host = mk(); host.id = 'bankHeader'; byId.set('bankHeader', host);
	return {
		getElementById: (id) => byId.get(id) || null,
		createElement: mk,
		createTextNode: (t) => ({textContent: t}),
		head: mk(), body: mk()
	};
}

function run(seed, settings) {
	const world = buildWorld(seed);
	const document = makeDOM();
	const sandbox = {
		Game: world.Game, document,
		console: {log() {}, error(...a) { console.error(...a); }},
		Beautify: (n) => String(Math.round(n)),
		setTimeout: (fn) => { fn(); return 0; }, l: () => null, PlaySound: () => {}
	};
	sandbox.window = sandbox; sandbox.globalThis = sandbox;
	vm.createContext(sandbox);
	vm.runInContext(CODE, sandbox, {filename: OURS});
	if (settings) world.Game.mods['quant broker'].load(JSON.stringify({v: 1, s: settings}));

	const n = world.M.goodsById.length;
	const stat = {
		shockTicks: 0, broadTicks: 0,
		hitAll: 0, hitBroad: 0,
		falsePos: 0, quietTicks: 0,
		signRight: 0, signWrong: 0
	};

	// Only the tick a detection first fires on is graded; the stance then
	// persists for shockTicks, which is a policy choice, not a claim.
	let prevActive = false;

	for (let t = 0; t < TICKS; t++) {
		world.Game.cookies += 60 * world.Game.cookiesPsRawHighest;
		world.M.tick();

		const truthD = world.M.lastGlobD;
		const truthHits = world.M.lastGlobHits;
		const isShock = truthD !== 0 && truthHits > 0;
		const isBroad = isShock && truthHits >= Math.ceil(n / 3);

		world.Game.runModHook('logic');

		const status = document.getElementById('qbStatus');
		const txt = status ? status.textContent : '';
		const crash = /^CRASH/.test(txt), spike = /^SPIKE/.test(txt);
		const active = crash || spike;
		const fired = active && !prevActive;
		prevActive = active;

		if (isShock) {
			stat.shockTicks++;
			if (isBroad) stat.broadTicks++;
			if (fired) {
				stat.hitAll++;
				if (isBroad) stat.hitBroad++;
				// globD > 0 pushes prices DOWN, so a positive globD is a crash.
				if ((truthD > 0 && crash) || (truthD < 0 && spike)) stat.signRight++;
				else stat.signWrong++;
			}
		} else {
			stat.quietTicks++;
			if (fired) stat.falsePos++;
		}
	}
	return stat;
}

function score(settings) {
	const totals = {shockTicks: 0, broadTicks: 0, hitAll: 0, hitBroad: 0,
	                falsePos: 0, quietTicks: 0, signRight: 0, signWrong: 0};
	for (let s = 0; s < SEEDS; s++) {
		const r = run(1000 + s * 7919, settings);
		for (const k in totals) totals[k] += r[k];
	}
	return totals;
}

const pct = (a, b) => b > 0 ? (100 * a / b).toFixed(1) + '%' : 'n/a';

console.log('Shock detector accuracy');
console.log(TICKS + ' ticks x ' + SEEDS + ' seeds = ' + (TICKS * SEEDS) + ' market ticks');
console.log('');

if (process.argv.includes('--sweep')) {
	console.log('  ' + 'shockJump'.padEnd(11) + 'recall(broad)'.padStart(14) +
		'recall(all)'.padStart(12) + 'direction'.padStart(11) +
		'false pos'.padStart(11) + 'precision'.padStart(11));
	for (const j of [0.3, 0.4, 0.6, 0.8, 1.2, 1.6]) {
		const t = score({shockJump: j});
		console.log('  ' + String(j).padEnd(11) +
			pct(t.hitBroad, t.broadTicks).padStart(14) +
			pct(t.hitAll, t.shockTicks).padStart(12) +
			pct(t.signRight, t.signRight + t.signWrong).padStart(11) +
			String(t.falsePos).padStart(11) +
			pct(t.hitAll, t.hitAll + t.falsePos).padStart(11));
	}
	console.log('');
	console.log('  recall is graded on first fire only: a shock landing while the');
	console.log('  previous stance is still active counts as a miss.');
} else {
	const totals = score(null);
	console.log('  shock ticks (any goods hit) : ' + totals.shockTicks +
		'  (' + pct(totals.shockTicks, TICKS * SEEDS) + ' of ticks)');
	console.log('  of those, broad enough      : ' + totals.broadTicks);
	console.log('');
	console.log('  recall, broad shocks        : ' + pct(totals.hitBroad, totals.broadTicks));
	console.log('  recall, all shocks          : ' + pct(totals.hitAll, totals.shockTicks));
	console.log('  direction correct when fired: ' + pct(totals.signRight, totals.signRight + totals.signWrong));
	console.log('  false positives             : ' + totals.falsePos +
		'  (' + pct(totals.falsePos, totals.quietTicks) + ' of quiet ticks)');
	console.log('  precision                   : ' +
		pct(totals.hitAll, totals.hitAll + totals.falsePos));
}

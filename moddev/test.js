/**
 * Behavioural tests for Quant Broker.
 *
 * Includes a minimal DOM shim: enough of getElementById / textContent /
 * className / innerHTML for the panel code to be exercised, so a typo in an
 * element id fails here rather than in the game.
 *
 *   node dev/test.js
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

let passed = 0, failed = 0;
function check(name, cond, detail) {
	if (cond) { passed++; console.log('  ok   ' + name); }
	else { failed++; console.log('  FAIL ' + name + (detail ? '  -> ' + detail : '')); }
}
function section(t) { console.log('\n' + t); }

/* ---------------- minimal DOM shim ---------------- */

function makeDOM() {
	const byId = new Map();

	function makeEl(tag) {
		const el = {
			tagName: tag, id: '', className: '', textContent: '', value: '', checked: false,
			style: {}, children: [], parentNode: null, isConnected: false,
			_attrs: {}, _listeners: {},
			getAttribute(k) { return k in this._attrs ? this._attrs[k] : null; },
			setAttribute(k, v) { this._attrs[k] = v; },
			addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); },
			appendChild(child) {
				this.children.push(child);
				child.parentNode = this;
				child.isConnected = true;
				if (child.id) byId.set(child.id, child);
				return child;
			},
			removeChild(child) {
				this.children = this.children.filter((c) => c !== child);
				child.parentNode = null; child.isConnected = false;
				if (child.id) byId.delete(child.id);
				return child;
			},
			set innerHTML(html) {
				this._html = html;
				// Register every id in the markup as a reachable stub element.
				const re = /<(\w+)([^>]*)\bid="([^"]+)"([^>]*)>/g;
				let m;
				while ((m = re.exec(html))) {
					const child = makeEl(m[1]);
					child.id = m[3];
					const attrs = m[2] + ' ' + m[4];
					const ar = /\b(data-\w+|type)="([^"]*)"/g;
					let a;
					while ((a = ar.exec(attrs))) child._attrs[a[1]] = a[2];
					child.isConnected = true;
					child.parentNode = this;
					byId.set(child.id, child);
				}
			},
			get innerHTML() { return this._html || ''; },
			dispatch(type, target) {
				for (const fn of (this._listeners[type] || [])) fn({target});
			}
		};
		return el;
	}

	const document = {
		_byId: byId,
		createElement: makeEl,
		getElementById: (id) => byId.get(id) || null,
		head: makeEl('head'),
		body: makeEl('body')
	};
	document.registerHost = function (id) {
		const el = makeEl('div');
		el.id = id; el.isConnected = true;
		byId.set(id, el);
		return el;
	};
	return document;
}

function boot(cfg, opts) {
	opts = opts || {};
	const world = buildWorld(opts.seed || 4242, cfg);
	const document = opts.dom ? makeDOM() : {
		getElementById: () => null,
		createElement: () => ({style: {}, appendChild() {}, addEventListener() {}}),
		head: {appendChild() {}}, body: {appendChild() {}}
	};
	if (opts.dom) document.registerHost('bankHeader');

	const notes = [];
	const sandbox = {
		Game: world.Game, document,
		console: {log() {}, error(...a) { notes.push('ERR ' + a.join(' ')); }},
		Beautify: (n) => String(Math.round(n)),
		setTimeout: (fn) => { fn(); return 0; }, l: () => null, PlaySound: () => {}
	};
	world.Game.Notify = (t, d) => notes.push(t + ': ' + d);
	sandbox.window = sandbox; sandbox.globalThis = sandbox;
	vm.createContext(sandbox);
	vm.runInContext(CODE, sandbox, {filename: OURS});

	return {world, document, sandbox, notes, mod: world.Game.mods['quant broker']};
}

function step(world, n, income) {
	for (let i = 0; i < (n || 1); i++) {
		world.Game.cookies += (income === undefined ? CFG.INCOME_PER_TICK : income);
		world.M.tick();
		world.Game.runModHook('logic');
	}
}

/* ---------------- tests ---------------- */

section('registration');
{
	const t = boot();
	check('mod registers under the id from info.txt', !!t.mod);
	check('exposes save/load', typeof t.mod.save === 'function' && typeof t.mod.load === 'function');
	check('registers a logic hook', t.world.Game.modHooks.logic.length === 1);
	check('registers a reset hook', t.world.Game.modHooks.reset.length === 1);
}

section('lifecycle safety');
{
	// Bank present but minigame not ready yet.
	const t = boot();
	t.world.Game.isMinigameReady = () => false;
	let threw = null;
	try { step(t.world, 20); } catch (e) { threw = e; }
	check('does nothing while the minigame is not ready', !threw, threw && threw.message);
	check('no stock was touched', t.world.M.goodsById.every((g) => g.stock === 0));

	// Bank object missing entirely.
	const t2 = boot();
	delete t2.world.Game.Objects['Bank'];
	let threw2 = null;
	try { t2.world.Game.runModHook('logic'); } catch (e) { threw2 = e; }
	check('survives a missing Bank object', !threw2, threw2 && threw2.message);
}

section('no raw CpS yet');
{
	const t = boot();
	t.world.Game.cookiesPsRawHighest = 0;
	let threw = null;
	try { step(t.world, 50, 0); } catch (e) { threw = e; }
	check('does not divide by a zero cookie rate', !threw, threw && threw.message);
	check('makes no trades without a rate', t.world.M.goodsById.every((g) => g.stock === 0));
}

section('never realises a loss with allowLoss off');
{
	const t = boot();
	let prev = 0, dips = 0;
	for (let i = 0; i < 4000; i++) {
		step(t.world, 1);
		const realized = JSON.parse(t.mod.save()).t[2];
		if (realized < prev - 1e-6) dips++;
		prev = realized;
	}
	check('realised $ profit never decreases', dips === 0, dips + ' decreases');
	check('realised $ profit ended positive', prev > 0, 'ended ' + prev.toFixed(0));
}

section('cost basis survives manual trading');
{
	const t = boot();
	step(t.world, 400);

	// The player hand-buys a pile: those units must be absorbed into the position.
	const g = t.world.M.goodsById[5];
	const before = g.stock;
	g.stock += 100;
	step(t.world, 1);
	const p = JSON.parse(t.mod.save()).p.find((e) => e[0] === 5);
	check('reconciles player-added stock into the position',
		!!p && p[1] === before + 100, p ? 'units ' + p[1] + ' expected ' + (before + 100) : 'no position');

	// The player hand-sells everything. The assistant is free to re-buy in the
	// same tick, so what matters is that the STALE basis does not survive: any
	// position that exists afterwards must be priced at the current market.
	const staleBasis = p[2] / p[1];
	g.stock = 0;
	const priceNow = g.val;
	step(t.world, 1);
	const p2 = (JSON.parse(t.mod.save()).p || []).find((e) => e[0] === 5);
	if (!p2) {
		check('stale cost basis is dropped when the player sells off', true);
	} else {
		const freshBasis = p2[2] / p2[1];
		// a re-buy happens at that tick's price plus overhead (<=20%)
		const plausible = freshBasis >= priceNow * 0.5 && freshBasis <= g.val * 1.5;
		check('stale cost basis is dropped when the player sells off', plausible,
			'basis ' + freshBasis.toFixed(2) + ' vs stale ' + staleBasis.toFixed(2) +
			' / price ' + g.val.toFixed(2));
	}

	// The invariant behind all of it: tracked units must equal real stock after
	// every tick, whoever did the trading.
	const t2 = boot();
	let drift = 0;
	for (let i = 0; i < 600; i++) {
		if (i % 50 === 0) {                       // player meddles, then a tick runs
			const gg = t2.world.M.goodsById[i % t2.world.M.goodsById.length];
			gg.stock = Math.max(0, gg.stock - 7);
		}
		step(t2.world, 1);
		const packed = JSON.parse(t2.mod.save()).p || [];
		const tracked = {};
		for (const e of packed) tracked[e[0]] = e[1];
		for (const gg of t2.world.M.goodsById) {
			if ((tracked[gg.id] || 0) !== gg.stock) drift++;
		}
	}
	check('tracked units always equal real stock', drift === 0, drift + ' mismatches');
}

section('market reset clears positions');
{
	const t = boot();
	step(t.world, 600);
	const held = JSON.parse(t.mod.save()).p.length;
	check('held something before the reset', held > 0, 'held ' + held);

	t.world.M.reset();            // ascension: ticks go back to 15
	step(t.world, 1);
	const after = JSON.parse(t.mod.save()).p;
	check('positions cleared after the market resets', after.length === 0, 'still ' + after.length);
}

section('save / load round trip');
{
	const a = boot();
	step(a.world, 800);
	const blob = a.mod.save();
	check('save produces parseable JSON', (() => { try { JSON.parse(blob); return true; } catch (e) { return false; } })());
	check('save stays compact', blob.length < 4000, blob.length + ' bytes');

	const parsed = JSON.parse(blob);
	check('save carries learned quantiles', Array.isArray(parsed.q) && parsed.q.length > 0);

	const b = boot();
	b.mod.load(blob);
	const reblob = b.mod.save();
	const rp = JSON.parse(reblob);
	check('settings survive the round trip', JSON.stringify(rp.s) === JSON.stringify(parsed.s));
	check('stats survive the round trip', JSON.stringify(rp.t) === JSON.stringify(parsed.t));
	check('quantiles survive the round trip', JSON.stringify(rp.q) === JSON.stringify(parsed.q));

	b.mod.load('not json at all');
	check('garbage save data is ignored, not fatal', true);
	b.mod.load('');
	check('empty save data is ignored', true);
}

section('settings injection through load');
{
	const t = boot();
	t.mod.load(JSON.stringify({v: 1, s: {enabled: false}}));
	step(t.world, 300);
	check('disabled bot makes no trades', t.world.M.goodsById.every((g) => g.stock === 0));
	const saved = JSON.parse(t.mod.save());
	check('but it keeps learning while paused', saved.q.length > 0 && saved.q[0][3] > 100,
		saved.q.length ? 'n=' + saved.q[0][3] : 'no quantiles');
}

section('panel rendering');
{
	const t = boot(null, {dom: true});
	step(t.world, 120);

	const panel = t.document.getElementById('quantBrokerPanel');
	check('panel is injected into bankHeader', !!panel);
	check('stylesheet is injected once', !!t.document.getElementById('quantBrokerCSS'));

	const status = t.document.getElementById('qbStatus');
	check('status line is populated', !!status && status.textContent.length > 0,
		status ? JSON.stringify(status.textContent) : 'missing');

	const toggle = t.document.getElementById('qbToggle');
	check('toggle reads ON while enabled', !!toggle && toggle.textContent === 'ON',
		toggle ? toggle.textContent : 'missing');

	// Every table cell the refresh writes to must exist.
	let missing = [];
	for (let i = 0; i < t.world.M.goodsById.length; i++) {
		for (const c of ['sym', 'mode', 'price', 'buy', 'sell', 'stock', 'basis', 'pl', 'note']) {
			if (!t.document.getElementById('qbC-' + i + '-' + c)) missing.push('qbC-' + i + '-' + c);
		}
		if (!t.document.getElementById('qbRow-' + i)) missing.push('qbRow-' + i);
	}
	check('every row and cell id resolves', missing.length === 0, missing.slice(0, 3).join(', '));

	const sym = t.document.getElementById('qbC-0-sym');
	check('cells actually receive text', !!sym && sym.textContent.length > 0,
		sym ? JSON.stringify(sym.textContent) : 'missing');

	// Clicking the toggle must flip state and repaint immediately.
	panel.dispatch('click', {getAttribute: (k) => (k === 'data-act' ? 'toggle' : null)});
	check('toggle click flips to OFF', toggle.textContent === 'OFF', toggle.textContent);
	panel.dispatch('click', {getAttribute: (k) => (k === 'data-act' ? 'toggle' : null)});
	check('toggle click flips back to ON', toggle.textContent === 'ON', toggle.textContent);

	// Settings inputs exist and changing one is applied and clamped.
	const input = t.document.getElementById('qbSet-maxDeployPct');
	check('settings input exists', !!input);
	input.value = '900';   // 900% -> clamped to the meta max of 100%
	panel.dispatch('change', input);
	const s = JSON.parse(t.mod.save()).s;
	check('out-of-range setting is clamped', s.maxDeployPct === 1, 'got ' + s.maxDeployPct);

	// Tuned internals are still real settings and still injectable, they are
	// just not offered in the panel.
	check('tuned internals are not exposed in the UI',
		!t.document.getElementById('qbSet-learnRate') &&
		!t.document.getElementById('qbSet-shockRelax'));
	t.mod.load(JSON.stringify({v: 1, s: {learnRate: 0.01, shockRelax: 0.9}}));
	const s2 = JSON.parse(t.mod.save()).s;
	check('tuned internals remain injectable', s2.learnRate === 0.01 && s2.shockRelax === 0.9,
		s2.learnRate + ' / ' + s2.shockRelax);

	const box = t.document.getElementById('qbSettingsBox');
	panel.dispatch('click', {getAttribute: (k) => (k === 'data-act' ? 'settings' : null)});
	check('settings panel opens', /qbShown/.test(box.className), box.className);

	// Liquidate empties every position.
	step(t.world, 400);
	panel.dispatch('click', {getAttribute: (k) => (k === 'data-act' ? 'liquidate' : null)});
	check('liquidate sells every holding', t.world.M.goodsById.every((g) => g.stock === 0),
		'left ' + t.world.M.goodsById.filter((g) => g.stock > 0).length);

	check('panel code logged no errors', t.notes.filter((n) => n.startsWith('ERR')).length === 0,
		t.notes.filter((n) => n.startsWith('ERR'))[0]);
}

section('panel is re-injected if the bank UI is rebuilt');
{
	const t = boot(null, {dom: true});
	step(t.world, 60);
	const first = t.document.getElementById('quantBrokerPanel');
	check('panel exists initially', !!first);

	// The game rebuilds bankHeader: our panel is gone from the document.
	first.parentNode.removeChild(first);
	check('panel really removed', !t.document.getElementById('quantBrokerPanel'));

	step(t.world, 1);
	check('panel comes back on the next tick', !!t.document.getElementById('quantBrokerPanel'));
}

section('broker hiring');
{
	const t = boot();
	step(t.world, 3000);
	check('hires brokers when affordable', t.world.M.brokers > 0, 'brokers ' + t.world.M.brokers);
	check('never exceeds the game cap', t.world.M.brokers <= t.world.M.getMaxBrokers(),
		t.world.M.brokers + ' > ' + t.world.M.getMaxBrokers());

	const t2 = boot();
	t2.mod.load(JSON.stringify({v: 1, s: {autoBrokers: false}}));
	step(t2.world, 3000);
	check('respects autoBrokers off', t2.world.M.brokers === 0, 'brokers ' + t2.world.M.brokers);
}

section('never spends more cookies than allowed');
{
	// With shock trading off the cap is absolute.
	const t = boot();
	t.mod.load(JSON.stringify({v: 1, s: {maxDeployPct: 0.10, autoBrokers: false, shockDetect: false}}));
	let worstFrac = 0;
	for (let i = 0; i < 2000; i++) {
		const before = t.world.Game.cookies + CFG.INCOME_PER_TICK;
		step(t.world, 1);
		const spent = before - t.world.Game.cookies;
		if (spent > 0) worstFrac = Math.max(worstFrac, spent / before);
	}
	check('per-tick spend respects the deploy cap', worstFrac <= 0.1001,
		'worst ' + (worstFrac * 100).toFixed(2) + '%');
	check('cookies never went negative', t.world.Game.cookies >= 0, String(t.world.Game.cookies));

	// With it on, a crash may spend up to the multiplied cap and no more.
	const t2 = boot();
	t2.mod.load(JSON.stringify({v: 1, s: {
		maxDeployPct: 0.10, shockDeployMult: 2.0, autoBrokers: false, shockDetect: true
	}}));
	let worst2 = 0;
	for (let i = 0; i < 2000; i++) {
		const before = t2.world.Game.cookies + CFG.INCOME_PER_TICK;
		step(t2.world, 1);
		const spent = before - t2.world.Game.cookies;
		if (spent > 0) worst2 = Math.max(worst2, spent / before);
	}
	check('crash stance stays inside the multiplied cap', worst2 <= 0.2001,
		'worst ' + (worst2 * 100).toFixed(2) + '%');
	check('crash stance actually used more than the base cap', worst2 > 0.1001,
		'worst ' + (worst2 * 100).toFixed(2) + '% - shock path may not be firing');
}

/* ---------------- new in 1.2 ---------------- */

section('a broken panel never breaks the game');
{
	// Game.Logic() calls the logic hook. Anything that escapes it stops the
	// whole game, so a UI fault has to be contained and trading has to go on.
	const t = boot({}, {dom: true});
	step(t.world, 200);
	const before = JSON.parse(t.mod.save()).t;

	t.document.getElementById = () => { throw new Error('synthetic DOM failure'); };

	let threw = null;
	try { step(t.world, 300); } catch (e) { threw = e; }
	check('a DOM failure does not escape the logic hook', !threw, threw && threw.message);

	const after = JSON.parse(t.mod.save()).t;
	check('trading continues while the panel is broken',
		after[0] + after[1] > before[0] + before[1],
		before[0] + before[1] + ' -> ' + (after[0] + after[1]) + ' trades');
	check('the failure is reported once, not every frame',
		t.notes.filter((n) => /panel/.test(n)).length <= 1,
		t.notes.filter((n) => /panel/.test(n)).length + ' reports');
}

section('shock detection');
{
	// Establish a momentum baseline, then hand every good the signature of a
	// global crash: a large positive drift kick with the price knocked down.
	const t = boot({}, {dom: true});
	step(t.world, 300);
	for (const g of t.world.M.goodsById) { g.d += 3; g.val = Math.max(5, g.val * 0.55); }
	t.world.M.ticks++;
	t.world.Game.runModHook('logic');

	const status = t.document.getElementById('qbStatus');
	check('a market-wide crash is recognised', /CRASH/.test(status.textContent), status.textContent);
	check('the shock counter advanced', JSON.parse(t.mod.save()).t[5] > 0);

	const bar = t.document.getElementById('qbShockBar');
	check('the crash banner is shown', bar.style.display === '' && /CRASH/.test(bar.textContent));

	// The goods the shock touched are boxed so they can be picked out at a glance.
	const marked = t.world.M.goodsById
		.map((g, i) => t.document.getElementById('qbRow-' + i).className)
		.filter((c) => /qbHitDown/.test(c)).length;
	check('crashed rows are outlined', marked > 0, marked + ' rows marked');
	check('no row is marked as a spike during a crash',
		t.world.M.goodsById.every((g, i) =>
			!/qbHitUp/.test(t.document.getElementById('qbRow-' + i).className)));

	// The outline must clear when the stance expires, not linger on the table.
	step(t.world, 12);
	const stillMarked = t.world.M.goodsById
		.map((g, i) => t.document.getElementById('qbRow-' + i).className)
		.filter((c) => /qbHit(Down|Up)/.test(c)).length;
	check('outlines clear once the stance ends', stillMarked === 0, stillMarked + ' rows still marked');

	// The mirror image: a synchronised negative kick is a spike, not a crash.
	const t2 = boot({}, {dom: true});
	step(t2.world, 300);
	for (const g of t2.world.M.goodsById) { g.d -= 3; g.val = g.val * 1.6 + 10; }
	t2.world.M.ticks++;
	t2.world.Game.runModHook('logic');
	const status2 = t2.document.getElementById('qbStatus');
	check('a market-wide spike is recognised', /SPIKE/.test(status2.textContent), status2.textContent);

	// One good moving on its own is noise, not a shock.
	const t3 = boot({}, {dom: true});
	step(t3.world, 300);
	t3.world.M.goodsById[0].d += 4;
	t3.world.M.ticks++;
	t3.world.Game.runModHook('logic');
	const status3 = t3.document.getElementById('qbStatus');
	check('a single good moving is not a shock',
		!/CRASH|SPIKE/.test(status3.textContent), status3.textContent);

	// Detection must be off when the hidden state is not being read at all.
	const t4 = boot({}, {dom: true});
	t4.mod.load(JSON.stringify({v: 1, s: {useHiddenState: false}}));
	step(t4.world, 300);
	for (const g of t4.world.M.goodsById) { g.d += 3; g.val = Math.max(5, g.val * 0.55); }
	t4.world.M.ticks++;
	t4.world.Game.runModHook('logic');
	check('no shock trading without hidden state',
		!/CRASH/.test(t4.document.getElementById('qbStatus').textContent));
}

section('floor grab');
{
	const t = boot();
	t.mod.load(JSON.stringify({v: 1, s: {floorGrab: true, floorPrice: 6}}));
	step(t.world, 200);

	const g = t.world.M.goodsById[8];   // resting value 89: nowhere near the floor
	g.stock = 0;
	g.val = 3;
	g.last = 0;
	t.world.M.ticks++;
	t.world.Game.runModHook('logic');
	check('buys a good pinned against the $5 floor', g.stock > 0, 'stock ' + g.stock);

	// Below the buy line the ordinary path would fill it anyway, so the case
	// that isolates the feature is a good that has not warmed up yet: the
	// normal gate refuses on `warm`, and only the floor rule can override.
	const warm = {warmupTicks: 500};
	const tOn = boot();
	tOn.mod.load(JSON.stringify({v: 1, s: Object.assign({floorGrab: true}, warm)}));
	step(tOn.world, 30);
	const gOn = tOn.world.M.goodsById[8];
	gOn.stock = 0; gOn.val = 3; gOn.last = 0;
	tOn.world.M.ticks++;
	tOn.world.Game.runModHook('logic');

	const tOff = boot();
	tOff.mod.load(JSON.stringify({v: 1, s: Object.assign({floorGrab: false}, warm)}));
	step(tOff.world, 30);
	const gOff = tOff.world.M.goodsById[8];
	gOff.stock = 0; gOff.val = 3; gOff.last = 0;
	tOff.world.M.ticks++;
	tOff.world.Game.runModHook('logic');

	check('floor grab overrides the warm-up gate', gOn.stock > 0, 'stock ' + gOn.stock);
	check('floor grab can be turned off', gOff.stock === 0, 'stock ' + gOff.stock);
}

section('adaptive band');
{
	// The band is reported in the status line as buy/sell percentiles.
	const t = boot({GRANDMA_HIGH: 0, GRANDMA_LEVEL: 0}, {dom: true});
	t.mod.load(JSON.stringify({v: 1, s: {adaptBand: true, autoBrokers: false}}));
	step(t.world, 60);
	const wide = t.document.getElementById('qbStatus').textContent;

	const t2 = boot({}, {dom: true});
	t2.mod.load(JSON.stringify({v: 1, s: {adaptBand: true, autoBrokers: true}}));
	step(t2.world, 3000);
	const tight = t2.document.getElementById('qbStatus').textContent;

	const parse = (s) => { const m = /band (\d+)\/(\d+)/.exec(s); return m ? [+m[1], +m[2]] : null; };
	const a = parse(wide), b = parse(tight);
	check('band is reported', !!a && !!b, wide + ' | ' + tight);
	check('band tightens once brokers have killed the overhead',
		a && b && (b[1] - b[0]) < (a[1] - a[0]), JSON.stringify(a) + ' -> ' + JSON.stringify(b));

	const t3 = boot({}, {dom: true});
	t3.mod.load(JSON.stringify({v: 1, s: {adaptBand: false, autoBrokers: true}}));
	step(t3.world, 3000);
	const fixed = parse(t3.document.getElementById('qbStatus').textContent);
	check('adaptation can be turned off', fixed && fixed[0] === 34 && fixed[1] === 66,
		JSON.stringify(fixed));
}

section('CpS growth credit');
{
	const t = boot({}, {dom: true});
	t.mod.load(JSON.stringify({v: 1, s: {cpsHold: true}}));
	step(t.world, 100);
	check('no credit while the rate is flat',
		!/CpS rising/.test(t.document.getElementById('qbStatus').textContent));

	for (let i = 0; i < 40; i++) {
		t.world.Game.cookiesPsRawHighest *= 1.02;
		step(t.world, 1);
	}
	check('credit appears while raw CpS is climbing',
		/CpS rising/.test(t.document.getElementById('qbStatus').textContent),
		t.document.getElementById('qbStatus').textContent);

	const t2 = boot({}, {dom: true});
	t2.mod.load(JSON.stringify({v: 1, s: {cpsHold: false}}));
	for (let i = 0; i < 140; i++) {
		t2.world.Game.cookiesPsRawHighest *= 1.02;
		step(t2.world, 1);
	}
	check('credit can be turned off',
		!/CpS rising/.test(t2.document.getElementById('qbStatus').textContent));
}

section('achievement mode');
{
	const t = boot();
	t.mod.load(JSON.stringify({v: 1, s: {achieveMode: true, achieveTarget: 120}}));
	step(t.world, 600);

	const stocks = t.world.M.goodsById.map((g) => g.stock);
	const min = Math.min(...stocks);
	check('every good reaches the target', min >= 120, 'lowest holding ' + min);
	check('cookies never went negative', t.world.Game.cookies >= 0, String(t.world.Game.cookies));

	// It must not sell the floor away again once it is there.
	let dipped = 0;
	for (let i = 0; i < 600; i++) {
		step(t.world, 1);
		for (const g of t.world.M.goodsById) if (g.stock < 120) dipped++;
	}
	check('never sells below the target once reached', dipped === 0, dipped + ' dips');

	// Surplus above the target is still traded normally.
	const t2 = boot();
	t2.mod.load(JSON.stringify({v: 1, s: {achieveMode: true, achieveTarget: 50}}));
	step(t2.world, 800);
	const sells = JSON.parse(t2.mod.save()).t[1];
	check('still trades the surplus above the target', sells > 0, 'sells ' + sells);
}

section('the 10000-unit magic value');
{
	// M.buyGood reads n === 10000 as "spend whatever the bank allows", which
	// would blow straight through the deploy cap. No buy may ever ask for it.
	const t = boot();
	const raw = t.world.M.buyGood;
	let asked10k = 0;
	t.world.M.buyGood = function (id, n) { if (n === 10000) asked10k++; return raw.call(this, id, n); };
	t.mod.load(JSON.stringify({v: 1, s: {achieveMode: true, achieveTarget: 2000}}));
	step(t.world, 400);
	check('never asks buyGood for exactly 10000 units', asked10k === 0, asked10k + ' calls');
}

section('reasoning column');
{
	const t = boot({}, {dom: true});
	step(t.world, 400);
	const cells = t.world.M.goodsById.map((g, i) => t.document.getElementById('qbC-' + i + '-note'));
	const tips  = cells.map((c) => c.title || '');
	const shown = cells.map((c) => c.textContent || '');

	check('every visible good explains itself', tips.every((n) => n.length > 0),
		JSON.stringify(tips.slice(0, 2)));
	check('explanations carry a stage word',
		tips.every((n) => /^[A-Z]{4,6}\b/.test(n)), JSON.stringify(tips.slice(0, 2)));
	check('the tooltip says what it is waiting for',
		tips.some((n) => /waiting|Next:|needs|buys at/.test(n)), JSON.stringify(tips.slice(0, 2)));

	// The cell has to fit in a table column; the prose lives in the tooltip.
	const longest = shown.reduce((a, b) => (b.length > a.length ? b : a), '');
	check('the visible note stays short', longest.length <= 20,
		'longest is ' + longest.length + ' chars: "' + longest + '"');
	check('the tooltip carries the detail', tips.some((n) => n.length > 40),
		'longest tooltip ' + tips.reduce((a, b) => Math.max(a, b.length), 0));
}

section('column colouring');
{
	const t = boot({}, {dom: true});
	step(t.world, 600);

	const GREY = '#7a7a7a';
	let plOk = true, heldOk = true, sawHeld = false, sawEmpty = false, detail = '';

	for (let i = 0; i < t.world.M.goodsById.length; i++) {
		const g  = t.world.M.goodsById[i];
		const pl = t.document.getElementById('qbC-' + i + '-pl');
		const st = t.document.getElementById('qbC-' + i + '-stock');

		// P/L is grey exactly when there is no position, and otherwise its
		// colour agrees with the sign it is displaying.
		if (pl.textContent === '-') {
			if (pl.style.color !== GREY) { plOk = false; detail = 'flat row not grey'; }
		} else {
			const positive = pl.textContent.charAt(0) === '+';
			const green = pl.style.color === '#6ee06e';
			const red   = pl.style.color === '#ff6b6b';
			if (positive && red)   { plOk = false; detail = 'gain painted red: ' + pl.textContent; }
			if (!positive && green) { plOk = false; detail = 'loss painted green: ' + pl.textContent; }
		}

		// Held is grey when empty and coloured once something is held.
		if (g.stock <= 0) {
			sawEmpty = true;
			if (st.style.color !== GREY) { heldOk = false; detail = 'empty holding not grey'; }
		} else {
			sawHeld = true;
			if (st.style.color === GREY) { heldOk = false; detail = 'holding painted grey'; }
		}
	}

	check('P/L colour matches the sign it shows', plOk, detail);
	check('held colour distinguishes empty from stocked', heldOk, detail);
	check('the run actually exercised both held states', sawHeld && sawEmpty,
		'held ' + sawHeld + ' empty ' + sawEmpty);

	// A full warehouse is the state that blocks buying, so it gets its own colour.
	const g0 = t.world.M.goodsById[3];
	g0.stock = t.world.M.getGoodMaxStock(g0);
	t.world.M.ticks++;
	t.world.Game.runModHook('logic');
	const full = t.document.getElementById('qbC-3-stock');
	check('a full warehouse is flagged in red', full.style.color === '#ff6b6b',
		full.style.color + ' for ' + full.textContent);
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);

/**
 * Does the forecast actually get drawn into the Dough Jones graph, and does it
 * put the game's own graph back when switched off?
 *
 *   node chart.js
 *
 * The canvas here is a stub that records every drawing call, so the test can
 * assert on what was drawn - dotted lines, a band, a seam - rather than on
 * pixels.
 */
'use strict';

var fs = require('fs');
var path = require('path');

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

var vm = require('vm');

var MOD = modMain('QuantBroker');
var market = require('./market.js');

var passed = 0, failed = 0;
function ok(name, cond, detail) {
	if (cond) { passed++; console.log('  ok   ' + name); }
	else { failed++; console.log('  FAIL ' + name + (detail ? '   ' + detail : '')); }
}
function eq(name, got, want) {
	ok(name, got === want, 'got ' + JSON.stringify(got) + ', wanted ' + JSON.stringify(want));
}

function makeCtx(calls) {
	var ctx = {
		globalAlpha: 1, fillStyle: '', strokeStyle: '', lineWidth: 1, font: '', textAlign: '',
		dash: []
	};
	['clearRect', 'fillRect', 'beginPath', 'moveTo', 'lineTo', 'closePath', 'fill',
	 'stroke', 'fillText', 'drawImage'].forEach(function (fn) {
		ctx[fn] = function () { calls.push({fn: fn, args: [].slice.call(arguments), dash: ctx.dash.slice()}); };
	});
	ctx.setLineDash = function (d) { ctx.dash = d || []; calls.push({fn: 'setLineDash', args: [d]}); };
	return ctx;
}

function makeDOM(calls) {
	var byId = {};
	function el(id) {
		var e = {
			id: id || '', innerHTML: '', textContent: '', value: '', className: '',
			style: {}, children: [], isConnected: true, parentNode: null, width: 0, height: 0,
			classList: {add: function () {}, remove: function () {}, contains: function () { return false; }},
			// Inserting has to register the child by id, the way a real document
			// does - otherwise getElementById never finds anything the mod built.
			appendChild: function (c) { return adopt(this, c, null); },
			insertBefore: function (c, ref) { return adopt(this, c, ref); },
			removeChild: function (c) { c.parentNode = null; c.isConnected = false; return c; },
			_on: {},
			addEventListener: function (ev, fn) { (this._on[ev] || (this._on[ev] = [])).push(fn); },
			removeEventListener: function () {},
			click: function () { (this._on['click'] || []).forEach(function (f) { f({}); }); },
			setAttribute: function (k, v) { this[k] = v; },
			getAttribute: function (k) { return typeof this[k] === 'string' ? this[k] : null; },
			closest: function () { return null; },
            getBounds: function () { return {left: 0, right: 0, top: 0, bottom: 0}; },
			getContext: function () { return this._ctx || (this._ctx = makeCtx(calls)); }
		};
		return e;
	}
	function adopt(parent, child, ref) {
		var at = ref ? parent.children.indexOf(ref) : -1;
		if (at >= 0) parent.children.splice(at, 0, child);
		else parent.children.push(child);
		child.parentNode = parent;
		child.isConnected = true;
		if (child.id) byId[child.id] = child;
		return child;
	}

	// Everything the game looks up already sits in the document, so give the
	// stubs a shared parent - without one, code that inserts a sibling next to
	// an existing control has nowhere to put it.
	var root = el('root');
	function get(id) {
		if (!byId[id]) {
			var e = el(id);
			e.isConnected = false;
			e.parentNode = root;
			root.children.push(e);
			byId[id] = e;
		}
		return byId[id];
	}
	return {
		get: get, root: root,
		doc: {
			getElementById: get,
			createElement: function () { return el(''); },
			head: el('head'), body: el('body'), addEventListener: function () {}
		}
	};
}

function boot() {
	var calls = [];
	var dom = makeDOM(calls);
	var world = market.buildWorld(7);
	var Game = world.Game;
	var M = world.M;

	Game.drawT = 0;
	Game.mods = Game.mods || {};
	Game.hooks = {};
	Game.registerMod = function (id, mod) { Game.mods[id] = mod; };
	Game.registerHook = function (n, f) { (Game.hooks[n] || (Game.hooks[n] = [])).push(f); };

	// The pieces of the Bank's graph the mod reaches for.
	M.graph = dom.get('bankGraph');
	M.graph.width = 650;
	M.graph.height = 300;
	M.graphScale = 2;
	M.cols = {bg: '#000', line1: '#222', line2: '#444', high: '#0f0', low: '#f00', highlight: '#fff'};
	M.hoverOnGood = -1;
	M.goodsById.forEach(function (g) { g.active = true; g.hidden = false; });
	Game.Objects['Bank'].minigame = M;
	Game.Objects['Bank'].minigameLoaded = true;
	M.parent = Game.Objects['Bank'];

	var ctx = {
		Game: Game, Math: Math, document: dom.doc, window: {}, console: console,
		Date: Date, JSON: JSON, Array: Array, Object: Object, String: String,
		Number: Number, Boolean: Boolean, isFinite: isFinite, parseFloat: parseFloat,
		parseInt: parseInt, setTimeout: function () {}, clearTimeout: function () {},
		Beautify: function (n) { return String(Math.round(n)); },
		l: dom.get
	};
	ctx.globalThis = ctx;
	vm.createContext(ctx);
	vm.runInContext(fs.readFileSync(MOD, 'utf8'), ctx, {filename: 'QuantBroker/main.js'});

	var mod = Game.mods['quant broker'];
	mod.init();

	return {Game: Game, M: M, dom: dom, calls: calls, mod: mod,
		logic: function () { (Game.hooks['logic'] || []).forEach(function (f) { f(); }); },
		draw:  function () { (Game.hooks['draw'] || []).forEach(function (f) { f(); }); }};
}

console.log('\ndrawing the forecast into the Dough Jones graph\n');

var sb = boot();
// A few market ticks so the mod has a forecast to draw.
for (var i = 0; i < 5; i++) { sb.M.tick(); sb.logic(); }
sb.calls.length = 0;
sb.draw();

var box = sb.dom.get('bankGraphBox');
var layer = box.children.filter(function (c) { return c.id === 'quantBrokerChartLayer'; })[0];

ok('an overlay canvas is added to the graph box', !!layer);
eq('it matches the graph size', layer && layer.width + 'x' + layer.height, '650x300');

var HORIZON = 15;   // must match FORECAST_TICKS in the mod
var shift = Math.max(4, Math.ceil(650 / 65)) * HORIZON;
eq('the game graph is nudged left to make room', sb.M.graph.style.marginLeft, (-shift) + 'px');
ok('and the price markers come with it',
	/margin-right:\s*' + shift + 'px/.test(sb.dom.get('quantBrokerChartCSS').textContent) ||
	sb.dom.get('quantBrokerChartCSS').textContent.indexOf('margin-right:' + shift + 'px') >= 0,
	sb.dom.get('quantBrokerChartCSS').textContent);

ok('something was actually drawn', sb.calls.length > 0);

var dashed = sb.calls.filter(function (c) { return c.fn === 'stroke' && c.dash && c.dash.length > 0; });
ok('the forecast lines are dotted (' + dashed.length + ' dashed strokes)', dashed.length > 0);

var solidStrokes = sb.calls.filter(function (c) { return c.fn === 'stroke' && (!c.dash || !c.dash.length); });
eq('and nothing in the future is drawn solid', solidStrokes.length, 0);

var fills = sb.calls.filter(function (c) { return c.fn === 'fill'; });
ok('the uncertainty band is filled in (' + fills.length + ')', fills.length > 0);

var texts = sb.calls.filter(function (c) { return c.fn === 'fillText'; }).map(function (c) { return c.args[0]; });
ok('the seam is labelled', texts.indexOf('now') >= 0 && texts.indexOf('+15m') >= 0, texts.join(','));

// Everything must sit to the right of the seam - the past is not ours to redraw.
var seam = 650 - shift;
var strayed = sb.calls.filter(function (c) {
	if (c.fn !== 'moveTo' && c.fn !== 'lineTo') return false;
	return c.args[0] < seam - 0.001;
});
eq('nothing is drawn over the real history', strayed.length, 0);

// The toggle button, in the game's own row beside "Color mode".
var btn = sb.dom.get('quantBrokerForecastBtn');
ok('a toggle button was added', !!btn && btn.isConnected);
eq('using the game style', btn.className, 'bankSimpleButton');
var colsBtn = sb.dom.get('bankGraphCols');
ok('and it sits right after Color mode',
	colsBtn.parentNode && colsBtn.parentNode.children.indexOf(btn) ===
		colsBtn.parentNode.children.indexOf(colsBtn) + 1);
eq('it says what it is doing', btn.textContent, 'Forecast on');

// Pressing it must put the game's graph back exactly as it was.
btn.click();
eq('pressing it flips the label', btn.textContent, 'Forecast off');
sb.Game.drawT = 0;
sb.draw();
eq('and restores the graph position', sb.M.graph.style.marginLeft, '');
ok('and removes the overlay',
	box.children.filter(function (c) { return c.id === 'quantBrokerChartLayer' && c.isConnected; }).length === 0);

sb.calls.length = 0;
sb.Game.drawT = 0;
sb.draw();
eq('with it off, nothing is drawn at all', sb.calls.length, 0);

// And back on again.
btn.click();
sb.Game.drawT = 0;
sb.draw();
eq('pressing it again brings it back', sb.M.graph.style.marginLeft, (-shift) + 'px');
ok('and the overlay returns',
	box.children.filter(function (c) { return c.id === 'quantBrokerChartLayer' && c.isConnected; }).length === 1);

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);

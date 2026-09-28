/**
 * Renders the README's explanatory graphs as SVG, from the same simulated
 * market the tests use - nothing is drawn that the sim did not produce.
 *
 *   node graphs.js        -> writes ../docs/graphs/*.svg
 *
 * Palette (validated for CVD and contrast against the dark surface):
 * series green #6aa832, series red #c23b3b, ink #e8e8e8 / #9a9a9a,
 * grid #2a3527, surface #0f1a14.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const {buildWorld} = require('./market');

const OUT = path.join(__dirname, '..', 'docs', 'graphs');
fs.mkdirSync(OUT, {recursive: true});

const SURFACE = '#0f1a14';
const GRID    = '#2a3527';
const INK     = '#e8e8e8';
const MUTED   = '#9a9a9a';
const GREEN   = '#6aa832';
const RED     = '#c23b3b';

const W = 760, H = 300, PAD = {t: 34, r: 16, b: 40, l: 52};
const PW = W - PAD.l - PAD.r, PH = H - PAD.t - PAD.b;

function el(tag, attrs, body) {
	const a = Object.entries(attrs).map(([k, v]) => ` ${k}="${v}"`).join('');
	return body === undefined ? `<${tag}${a}/>` : `<${tag}${a}>${body}</${tag}>`;
}
function text(x, y, s, opts) {
	opts = opts || {};
	return el('text', {
		x, y, fill: opts.fill || MUTED,
		'font-family': 'Segoe UI, Helvetica, Arial, sans-serif',
		'font-size': opts.size || 11,
		'font-weight': opts.weight || 'normal',
		'text-anchor': opts.anchor || 'start'
	}, s);
}
function frame(title, inner) {
	return [
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" font-family="Segoe UI, Helvetica, Arial, sans-serif">`,
		el('rect', {width: W, height: H, rx: 6, fill: SURFACE}),
		text(PAD.l, 20, title, {fill: INK, size: 13, weight: 'bold'}),
		inner,
		'</svg>'
	].join('\n');
}
function yGrid(yTicks, fmt) {
	return yTicks.map(([v, y]) =>
		el('line', {x1: PAD.l, y1: y, x2: PAD.l + PW, y2: y, stroke: GRID, 'stroke-width': 1}) +
		text(PAD.l - 6, y + 4, fmt(v), {anchor: 'end'})
	).join('');
}
function scale(min, max, a, b) {
	return (v) => a + (v - min) / (max - min) * (b - a);
}

/* ---------- 1. price distribution + learned quantiles ---------- */
{
	const world = buildWorld(4242);
	const GOOD = 3; // SUG
	const vals = [];
	for (let i = 0; i < 20000; i++) { world.M.tick(); if (i > 500) vals.push(world.M.goodsById[GOOD].val); }
	vals.sort((x, y) => x - y);
	const q = (p) => vals[Math.floor(p * (vals.length - 1))];
	const p34 = q(0.34), p66 = q(0.66), med = q(0.5);

	const lo = 0, hi = Math.ceil(q(0.995) / 10) * 10;
	const BINS = 36;
	const hist = new Array(BINS).fill(0);
	for (const v of vals) {
		const b = Math.min(BINS - 1, Math.max(0, Math.floor((v - lo) / (hi - lo) * BINS)));
		hist[b]++;
	}
	const hmax = Math.max(...hist);
	const x = scale(lo, hi, PAD.l, PAD.l + PW);
	const y = scale(0, hmax, PAD.t + PH, PAD.t);

	const bw = PW / BINS;
	let bars = '';
	for (let b = 0; b < BINS; b++) {
		const bx = PAD.l + b * bw, by = y(hist[b]);
		const c = (lo + (b + 0.5) / BINS * (hi - lo));
		bars += el('rect', {
			x: bx + 1, y: by, width: bw - 2, height: PAD.t + PH - by, rx: 2,
			fill: c <= p34 ? GREEN : (c >= p66 ? RED : '#3d4a38')
		});
	}
	const vline = (v, color, label, dy) => {
		const vx = x(v);
		return el('line', {x1: vx, y1: PAD.t, x2: vx, y2: PAD.t + PH, stroke: color, 'stroke-width': 2, 'stroke-dasharray': '5 4'}) +
			el('rect', {x: vx - 4, y: PAD.t + dy - 9, width: 8, height: 8, rx: 2, fill: color}) +
			text(vx + 8, PAD.t + dy, label, {fill: INK});
	};
	const xTicks = [];
	for (let v = 0; v <= hi; v += 20) xTicks.push(text(x(v), PAD.t + PH + 16, '$' + v, {anchor: 'middle'}));

	const inner =
		yGrid([[0, y(0)], [hmax / 2, y(hmax / 2)], [hmax, y(hmax)]], (v) => Math.round(v)) +
		bars +
		vline(p34, GREEN, 'buy &lt;= P34 ($' + p34.toFixed(0) + ')', 14) +
		vline(p66, RED, 'sell &gt;= P66 ($' + p66.toFixed(0) + ')', 32) +
		vline(med, MUTED, 'median $' + med.toFixed(0), 50) +
		xTicks.join('') +
		text(PAD.l + PW, PAD.t + PH + 32, 'price of one good over 19,500 simulated ticks', {anchor: 'end'});
	fs.writeFileSync(path.join(OUT, 'quantiles.svg'), frame('One good\'s real price distribution, and where the assistant trades it', inner));
	console.log('quantiles.svg  P34=%s med=%s P66=%s', p34.toFixed(1), med.toFixed(1), p66.toFixed(1));
}

/* ---------- 2. a market-wide shock, tick by tick ---------- */
{
	const world = buildWorld(7);
	const M = world.M;
	const NGOODS = 3; // three goods make the "market-wide" point without clutter
	const buf = [];
	let shockAt = -1;
	let prev = null;
	for (let i = 0; i < 60000; i++) {
		M.tick();
		const all = M.goodsById.map((g) => g.val);
		buf.push(all.slice(0, NGOODS));
		// the shock the detector looks for: many goods lurching the same way in one tick
		if (prev && i > 200) {
			const dropped = all.filter((v, k) => v - prev[k] < -4).length;
			if (dropped >= 10) { shockAt = buf.length - 1; break; }
		}
		prev = all;
	}
	const PRE = 50, POST = 50;
	const win = buf.slice(shockAt - PRE, shockAt + POST);
	for (let i = 0; i < POST - 1; i++) { M.tick(); win.push(M.goodsById.slice(0, NGOODS).map((g) => g.val)); }

	const flat = win.flat();
	const lo = Math.floor(Math.min(...flat) / 10) * 10, hi = Math.ceil(Math.max(...flat) / 10) * 10;
	const x = scale(0, win.length - 1, PAD.l, PAD.l + PW);
	const y = scale(lo, hi, PAD.t + PH, PAD.t);

	const shockX = x(PRE);
	const series = ['#6aa832', '#4e79b0', '#b0894e']; // green + two neutrals, identity by label
	let lines = '';
	for (let s = 0; s < NGOODS; s++) {
		const d = win.map((row, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(row[s]).toFixed(1)).join(' ');
		lines += el('path', {d, fill: 'none', stroke: series[s], 'stroke-width': 2});
		lines += text(x(win.length - 1) - 4, y(win[win.length - 1][s]) - 6, world.M.goodsById[s].symbol || ('good ' + s), {anchor: 'end', fill: INK});
	}
	const inner =
		yGrid([[lo, y(lo)], [(lo + hi) / 2, y((lo + hi) / 2)], [hi, y(hi)]], (v) => '$' + Math.round(v)) +
		el('rect', {x: shockX - 1, y: PAD.t, width: 2, height: PH, fill: RED}) +
		el('rect', {x: shockX, y: PAD.t, width: x(PRE + 12) - shockX, height: PH, fill: RED, opacity: 0.10}) +
		lines +
		el('rect', {x: shockX + 6, y: PAD.t + 6, width: 8, height: 8, rx: 2, fill: RED}) +
		text(shockX + 18, PAD.t + 14, 'globD shock hits every good at once', {fill: INK}) +
		text(PAD.l, PAD.t + PH + 16, 'tick ' + (-PRE), {anchor: 'start'}) +
		text(shockX, PAD.t + PH + 16, 'shock', {anchor: 'middle'}) +
		text(PAD.l + PW, PAD.t + PH + 16, 'tick +' + (win.length - PRE), {anchor: 'end'});
	fs.writeFileSync(path.join(OUT, 'shock.svg'), frame('Why one good\'s dip is not a signal: shocks move the whole market', inner));
	console.log('shock.svg      shock at buffered tick %d, globD=%s', shockAt, M.lastGlobD.toFixed(2));
}

/* ---------- 3. the 15-minute forecast band ---------- */
{
	const warm = buildWorld(4242);
	for (let i = 0; i < 800; i++) warm.M.tick();
	const GOOD = 3;
	const snap = warm.M.goodsById.map((g) => ({val: g.val, d: g.d, mode: g.mode, dur: g.dur, last: g.last}));

	const HORIZON = 15, PATHS = 200;
	const paths = [];
	for (let p = 0; p < PATHS; p++) {
		const w = buildWorld(90000 + p);
		w.M.goodsById.forEach((g, i) => Object.assign(g, snap[i]));
		const row = [snap[GOOD].val];
		for (let t = 0; t < HORIZON; t++) { w.M.tick(); row.push(w.M.goodsById[GOOD].val); }
		paths.push(row);
	}
	// one more independent seed plays "what actually happened"
	const act = buildWorld(555);
	act.M.goodsById.forEach((g, i) => Object.assign(g, snap[i]));
	const actual = [snap[GOOD].val];
	for (let t = 0; t < HORIZON; t++) { act.M.tick(); actual.push(act.M.goodsById[GOOD].val); }

	const q = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.floor(p * (s.length - 1))]; };
	const p10 = [], p50 = [], p90 = [];
	for (let t = 0; t <= HORIZON; t++) {
		const col = paths.map((r) => r[t]);
		p10.push(q(col, 0.10)); p50.push(q(col, 0.50)); p90.push(q(col, 0.90));
	}
	let inside = 0, total = 0;
	for (let t = 1; t <= HORIZON; t++) { total++; if (actual[t] >= p10[t] && actual[t] <= p90[t]) inside++; }

	const flat = [...p10, ...p90, ...actual];
	const lo = Math.floor(Math.min(...flat)) - 2, hi = Math.ceil(Math.max(...flat)) + 2;
	const x = scale(0, HORIZON, PAD.l, PAD.l + PW);
	const y = scale(lo, hi, PAD.t + PH, PAD.t);
	const pathOf = (row, close) => row.map((v, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(v).toFixed(1)).join(' ') + (close || '');

	const band = pathOf(p90) + ' ' + p10.slice().reverse().map((v, i) => 'L' + x(HORIZON - i).toFixed(1) + ' ' + y(v).toFixed(1)).join(' ') + ' Z';
	const inner =
		yGrid([[lo, y(lo)], [(lo + hi) / 2, y((lo + hi) / 2)], [hi, y(hi)]], (v) => '$' + Math.round(v)) +
		el('path', {d: band, fill: GREEN, opacity: 0.18}) +
		el('path', {d: pathOf(p50), fill: 'none', stroke: GREEN, 'stroke-width': 2, 'stroke-dasharray': '6 4'}) +
		el('path', {d: pathOf(actual), fill: 'none', stroke: INK, 'stroke-width': 2}) +
		el('rect', {x: PAD.l + 8, y: PAD.t + 6, width: 8, height: 8, rx: 2, fill: GREEN, opacity: 0.5}) +
		text(PAD.l + 20, PAD.t + 14, '10-90% band of 200 simulated paths', {fill: INK}) +
		el('rect', {x: PAD.l + 8, y: PAD.t + 22, width: 8, height: 8, rx: 2, fill: GREEN}) +
		text(PAD.l + 20, PAD.t + 30, 'median path (drawn dotted in the game)', {fill: INK}) +
		el('rect', {x: PAD.l + 8, y: PAD.t + 38, width: 8, height: 8, rx: 2, fill: INK}) +
		text(PAD.l + 20, PAD.t + 46, 'what one real future did (' + inside + '/' + total + ' ticks inside the band)', {fill: INK}) +
		text(PAD.l, PAD.t + PH + 16, 'now', {anchor: 'start'}) +
		text(PAD.l + PW, PAD.t + PH + 16, '+15 min', {anchor: 'end'});
	fs.writeFileSync(path.join(OUT, 'forecast.svg'), frame('The 15-minute forecast: many futures, one band', inner));
	console.log('forecast.svg   %d/%d actual ticks inside the 10-90 band', inside, total);
}

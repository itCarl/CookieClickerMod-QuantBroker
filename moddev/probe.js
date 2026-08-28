/**
 * Measures the stationary price distribution of the stock market, per good,
 * so trade levels can be derived from what the market actually does instead of
 * from guessed multiples of the resting value.
 *
 *   node dev/probe.js [ticks]
 */
'use strict';

const path = require('path');
const {buildWorldForProbe} = require('./market');

const TICKS = parseInt(process.argv[2] || '200000', 10);

const world = buildWorldForProbe(20260820);
const M = world.M;

const samples = M.goodsById.map(() => []);
const ceiling = 100 + (world.Game.Objects['Bank'].level - 1) * 3;

for (let t = 0; t < TICKS; t++) {
	M.tick();
	for (let i = 0; i < M.goodsById.length; i++) samples[i].push(M.goodsById[i].val);
}

function pct(sorted, p) {
	const i = (sorted.length - 1) * p;
	const lo = Math.floor(i), hi = Math.ceil(i);
	return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

console.log('Stationary price distribution | bank level ' +
	world.Game.Objects['Bank'].level + ' | soft ceiling $' + ceiling + ' | ' + TICKS + ' ticks');
console.log('');
console.log('id  resting   p05    p10    p25    p50    p75    p90    p95   |  p50/rest  p90/rest  p10/rest');

for (let i = 0; i < samples.length; i++) {
	const s = samples[i].slice().sort((a, b) => a - b);
	const rest = M.getRestingVal(i);
	const q = (p) => pct(s, p);
	const f = (n) => n.toFixed(1).padStart(6);
	console.log(
		String(i).padStart(2) + '  ' + String(rest).padStart(6) + ' ' +
		f(q(0.05)) + ' ' + f(q(0.10)) + ' ' + f(q(0.25)) + ' ' + f(q(0.50)) + ' ' +
		f(q(0.75)) + ' ' + f(q(0.90)) + ' ' + f(q(0.95)) + '   |  ' +
		(q(0.50) / rest).toFixed(3).padStart(7) + '  ' +
		(q(0.90) / rest).toFixed(3).padStart(7) + '  ' +
		(q(0.10) / rest).toFixed(3).padStart(7)
	);
}

// What fixed multiple-of-resting-value levels imply, per good.
console.log('');
console.log('Reachability of fixed thresholds (share of ticks the price is beyond them):');
console.log('id  rest   buy<=0.70x   sell>=1.20x   sell>=1.40x   sell>=1.60x');
for (let i = 0; i < samples.length; i++) {
	const s = samples[i];
	const rest = M.getRestingVal(i);
	const share = (fn) => (100 * s.filter(fn).length / s.length).toFixed(2).padStart(6) + '%';
	console.log(
		String(i).padStart(2) + '  ' + String(rest).padStart(4) + '   ' +
		share((v) => v <= rest * 0.70) + '       ' +
		share((v) => v >= rest * 1.20) + '        ' +
		share((v) => v >= rest * 1.40) + '        ' +
		share((v) => v >= rest * 1.60)
	);
}

/**
 * Is the ten-minute forecast honestly calibrated?
 *
 * The panel draws a 10th-to-90th percentile band. If that label is true, the
 * price ten ticks later must land inside the band about 80% of the time, and
 * the median must be unbiased. Anything else and the band is decoration.
 *
 *   node forecast_check.js [samples]
 *
 * The forecast is run against dev/market.js - the transcription of the game's
 * own tick - and then the same world is advanced for real and compared.
 */
'use strict';

const {buildWorld, CFG, mulberry32} = require('./market.js');

const SAMPLES = parseInt(process.argv[2], 10) || 3000;
const HORIZON = 15;   // must match FORECAST_TICKS in the mod
const PATHS   = 200;

/**
 * The forecast, transcribed from the mod so the two cannot drift apart in
 * spirit. It advances a copy of the whole market, because a shock hits every
 * good on the same tick and sampling goods separately would hide that.
 */
function forecastWorld(world, rng) {
	const n = world.goodsById.length;
	const samples = [];
	for (let i = 0; i < n; i++) {
		samples[i] = [];
		for (let s = 0; s < HORIZON; s++) samples[i][s] = [];
	}

	for (let path = 0; path < PATHS; path++) {
		const sim = world.goodsById.map(g => ({val: g.val, d: g.d, mode: g.mode, dur: g.dur}));
		for (let step = 0; step < HORIZON; step++) {
			let globD = 0;
			const globP = rng();
			if (rng() < 0.1) globD = (rng() - 0.5) * 2;
			for (let i = 0; i < n; i++) stepGood(sim[i], world.getRestingVal(i), globD, globP, rng);
			for (let i = 0; i < n; i++) samples[i][step].push(sim[i].val);
		}
	}

	return samples.map(perGood => {
		const last = perGood[HORIZON - 1].slice().sort((a, b) => a - b);
		return {
			p10: last[Math.floor(last.length * 0.10)],
			p50: last[Math.floor(last.length * 0.50)],
			p90: last[Math.floor(last.length * 0.90)]
		};
	});
}

function stepGood(g, restingVal, globD, globP, rng) {
	g.d *= 0.97;
	if (g.mode === 0)      { g.d *= 0.95; g.d += 0.05 * (rng() - 0.5); }
	else if (g.mode === 1) { g.d *= 0.99; g.d += 0.05 * (rng() - 0.1); }
	else if (g.mode === 2) { g.d *= 0.99; g.d -= 0.05 * (rng() - 0.1); }
	else if (g.mode === 3) { g.d += 0.15 * (rng() - 0.1); g.val += rng() * 5; }
	else if (g.mode === 4) { g.d -= 0.15 * (rng() - 0.1); g.val -= rng() * 5; }
	else if (g.mode === 5) { g.d += 0.3 * (rng() - 0.5); }

	g.val += (restingVal - g.val) * 0.01;

	if (globD !== 0 && rng() < globP) {
		g.val -= (1 + g.d * Math.pow(rng(), 3) * 7) * globD;
		g.val -= globD * (1 + Math.pow(rng(), 3) * 7);
		g.d += globD * (1 + rng() * 4);
		g.dur = 0;
	}

	g.val += Math.pow((rng() - 0.5) * 2, 11) * 3;
	g.d += 0.1 * (rng() - 0.5);
	if (rng() < 0.15) g.val += (rng() - 0.5) * 3;
	if (rng() < 0.03) g.val += (rng() - 0.5) * 10;
	if (rng() < 0.1) g.d += (rng() - 0.5) * 0.3;
	if (g.mode === 5) {
		if (rng() < 0.5) g.val += (rng() - 0.5) * 10;
		if (rng() < 0.2) g.d = (rng() - 0.5) * 2;
	}
	if (g.mode === 3 && rng() < 0.3) { g.d += (rng() - 0.5) * 0.1; g.val += (rng() - 0.7) * 10; }
	if (g.mode === 3 && rng() < 0.03) { g.mode = 4; }
	if (g.mode === 4 && rng() < 0.3) { g.d += (rng() - 0.5) * 0.1; g.val += (rng() - 0.3) * 10; }

	if (g.val > (100 + (CFG.BANK_LEVEL - 1) * 3) && g.d > 0) g.d *= 0.9;
	g.val += g.d;
	if (g.val < 5) g.val += (5 - g.val) * 0.5;
	if (g.val < 5 && g.d < 0) g.d *= 0.95;
	g.val = Math.max(g.val, 1);

	g.dur--;
	if (g.dur <= 0) {
		g.dur = Math.floor(10 + rng() * 690);
		if (rng() < 0.7 && (g.mode === 3 || g.mode === 4)) g.mode = 5;
		else g.mode = [0, 1, 1, 2, 2, 3, 4, 5][Math.floor(rng() * 8)];
	}
}

let inBand = 0, total = 0, aboveMedian = 0;
let inBandByGood = [], totalByGood = [];
let absErr = 0, naiveAbsErr = 0;

for (let s = 0; s < SAMPLES; s++) {
	// buildWorld takes a seed NUMBER and makes its own PRNG - handing it a
	// function silently coerces to 0 and every sample becomes the same world.
	const world = buildWorld(1000 + s).M;
	// Let the market settle so the starting state is a realistic one, not the
	// artificial one a fresh world begins in.
	for (let i = 0; i < 60; i++) world.tick();

	const before = world.goodsById.map(g => g.val);
	const fc = forecastWorld(world, mulberry32(500000 + s));
	for (let i = 0; i < HORIZON; i++) world.tick();

	world.goodsById.forEach((g, i) => {
		const actual = g.val;
		total++;
		totalByGood[i] = (totalByGood[i] || 0) + 1;
		if (actual >= fc[i].p10 && actual <= fc[i].p90) {
			inBand++;
			inBandByGood[i] = (inBandByGood[i] || 0) + 1;
		}
		if (actual > fc[i].p50) aboveMedian++;
		absErr += Math.abs(actual - fc[i].p50);
		naiveAbsErr += Math.abs(actual - before[i]);   // "it will not move" as a baseline
	});
}

function pct(a, b) { return (100 * a / b).toFixed(1) + '%'; }

console.log('\n' + SAMPLES + ' forecasts, ' + HORIZON + ' ticks ahead, ' +
	PATHS + ' paths each, ' + total + ' good-observations\n');

console.log('  price landed inside the 10-90 band   ' + pct(inBand, total) +
	'   (a truthful band would say 80.0%)');
console.log('  price landed above the median        ' + pct(aboveMedian, total) +
	'   (an unbiased median would say 50.0%)');
console.log('');
console.log('  median absolute error                $' + (absErr / total).toFixed(2));
console.log('  same, if you just assumed no change  $' + (naiveAbsErr / total).toFixed(2));
const edge = (1 - absErr / naiveAbsErr) * 100;
console.log('  the forecast beats "no change" by    ' + edge.toFixed(1) + '%');

console.log('\n  coverage per good (should hover around 80%)');
let line = '   ';
for (let i = 0; i < totalByGood.length; i++) {
	line += ' ' + String(i).padStart(2) + ':' + pct(inBandByGood[i] || 0, totalByGood[i]).padStart(6);
	if (i % 4 === 3) { console.log(line); line = '   '; }
}
if (line.trim()) console.log(line);

const off = Math.abs(100 * inBand / total - 80);
console.log('\n' + (off < 3
	? 'The band is honest: coverage is within ' + off.toFixed(1) + ' points of its label.'
	: 'The band is MISCALIBRATED by ' + off.toFixed(1) + ' points - the label lies.'));
console.log('');

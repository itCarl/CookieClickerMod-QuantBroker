/**
 * Are the Bank's loans worth taking?
 *
 * The loan table is read straight out of the game's own minigameMarket.js
 * rather than copied, so this stays honest if Orteil retunes them.
 *
 *   node loans.js
 *
 * Each loan is a CpS multiplier for a while, followed by a forced worse
 * multiplier for longer (buffType 'loan N' then 'loan N interest', both
 * multCpS), plus an immediate downpayment taken as a share of your banked
 * cookies. You cannot re-take a loan while its interest is still running.
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


var SRC = gameSrc('minigameMarket.js');

/** Pull M.loanTypes out of the game source without executing the minigame. */
function readLoans() {
	var src = fs.readFileSync(SRC, 'utf8');
	var start = src.indexOf('M.loanTypes=[');
	if (start < 0) throw new Error('loan table not found - the game was updated');
	var end = src.indexOf('];', start);
	var block = src.slice(start, end);

	var loans = [];
	// Each row is: [name, boostMult, boostMinutes, penaltyMult, penaltyMinutes, downpayment, quote]
	var rowRe = /\[loc\("([^"]+)"\),([^,]+),([^,]+),([^,]+),([^,]+),([^,]+),/g;
	var m;
	while ((m = rowRe.exec(block))) {
		loans.push({
			name:      m[1],
			boostMult: eval(m[2]),
			boostMin:  eval(m[3]),
			penMult:   eval(m[4]),
			penMin:    eval(m[5]),
			down:      eval(m[6])
		});
	}
	return loans;
}

function hours(min) {
	if (min < 1) return (min * 60).toFixed(0) + 's';
	if (min < 60) return min.toFixed(0) + 'm';
	if (min < 60 * 24) return (min / 60).toFixed(min % 60 ? 1 : 0) + 'h';
	return (min / 60 / 24).toFixed(1) + 'd';
}

function pad(s, n) { s = String(s); while (s.length < n) s += ' '; return s; }
function padL(s, n) { s = String(s); while (s.length < n) s = ' ' + s; return s; }

var loans = readLoans();

console.log('\nThe loans, as the game defines them\n');
console.log(pad('', 18) + padL('boost', 8) + padL('for', 8) +
	padL('then', 8) + padL('for', 8) + padL('downpayment', 13));
loans.forEach(function (L) {
	console.log(pad(L.name, 18) +
		padL('x' + L.boostMult, 8) + padL(hours(L.boostMin), 8) +
		padL('x' + L.penMult, 8) + padL(hours(L.penMin), 8) +
		padL(Math.round(L.down * 100) + '% of bank', 13));
});

/*
 * Held to term at a flat CpS, a loan is worth
 *   (boost - 1) * boostMinutes  -  (1 - penalty) * penaltyMinutes
 * measured in "CpS-minutes": minutes of your ordinary production.
 */
console.log('\n\nHeld to term at a steady CpS, in minutes of ordinary production\n');
console.log(pad('', 18) + padL('gained', 12) + padL('paid back', 12) +
	padL('net', 12) + padL('verdict', 12));
loans.forEach(function (L) {
	var gain = (L.boostMult - 1) * L.boostMin;
	var loss = (1 - L.penMult) * L.penMin;
	var net = gain - loss;
	console.log(pad(L.name, 18) +
		padL('+' + gain.toFixed(1), 12) +
		padL('-' + loss.toFixed(1), 12) +
		padL((net >= 0 ? '+' : '') + net.toFixed(1), 12) +
		padL(net >= 0 ? 'worth it' : 'a loss', 12));
});

/*
 * The only way a loan pays while you keep playing is if your CpS during the
 * boost is higher than during the penalty - combos in the good window, quiet
 * in the bad one. This is how much higher it has to be.
 */
console.log('\n\nHow much richer the boost window must be than the penalty window\n');
console.log(pad('', 18) + padL('break-even ratio', 18) + '   what that means');
loans.forEach(function (L) {
	var ratio = ((1 - L.penMult) * L.penMin) / ((L.boostMult - 1) * L.boostMin);
	var note;
	if (ratio > 20) note = 'only reachable inside a big golden-cookie combo';
	else if (ratio > 2.7) note = 'sustained heavy comboing for the whole window';
	else note = 'hard, but not absurd, if you play the boost and idle the penalty';
	console.log(pad(L.name, 18) + padL(ratio.toFixed(1) + 'x average CpS', 18) + '   ' + note);
});

/*
 * Ascending clears buffs, so a loan taken shortly before a reset gives its
 * boost and its interest never arrives. That is what the "Debt evasion"
 * achievement rewards.
 */
console.log('\n\nIf you ascend before the interest lands\n');
console.log(pad('', 18) + padL('free production', 17) + '   cost');
loans.forEach(function (L) {
	var gain = (L.boostMult - 1) * L.boostMin;
	console.log(pad(L.name, 18) +
		padL('+' + gain.toFixed(0) + ' CpS-minutes', 17) + '   ' +
		Math.round(L.down * 100) + '% of your banked cookies');
});

var best = loans.slice().sort(function (a, b) {
	return (b.boostMult - 1) * b.boostMin - (a.boostMult - 1) * a.boostMin;
})[0];
console.log('\nBest pre-ascension pick: ' + best.name + ' (+' +
	((best.boostMult - 1) * best.boostMin).toFixed(0) + ' CpS-minutes for ' +
	Math.round(best.down * 100) + '% of a bank you are about to lose anyway).');

/*
 * The downpayment is a share of cookies in the bank, not of CpS - so its real
 * cost depends entirely on when you take it.
 */
console.log('\n\nWhat the downpayment actually costs, at 1 hour of CpS banked\n');
console.log(pad('', 18) + padL('bank full', 16) + padL('just spent it all', 20));
loans.forEach(function (L) {
	// A bank holding one hour of production, versus a bank at 1% of that.
	var full = L.down * 60;
	var empty = L.down * 60 * 0.01;
	console.log(pad(L.name, 18) +
		padL('-' + full.toFixed(1) + ' CpS-min', 16) +
		padL('-' + empty.toFixed(2) + ' CpS-min', 20));
});
console.log('\nTake a loan right after a big purchase and the downpayment rounds to nothing.');

/*
 * Stretch Time's backfire shortens every running buff by 20%, capped at ten
 * minutes - including a loan's interest. With Grandma's Grimoire able to read
 * whether the next cast backfires, that is a deliberate move rather than luck.
 */
console.log('\n\nCutting the interest short with a deliberate Stretch Time backfire\n');
loans.forEach(function (L) {
	var remaining = L.penMin, casts = 0;
	while (remaining > 0.01 && casts < 200) {
		remaining -= Math.min(10, remaining * 0.2);
		casts++;
	}
	var loss = (1 - L.penMult) * L.penMin;
	console.log(pad(L.name, 18) +
		padL(casts + ' backfires', 14) + ' to clear ' + hours(L.penMin) +
		' of interest (' + loss.toFixed(0) + ' CpS-minutes)');
});
console.log('\nEach backfire takes 20% off every running buff, capped at 10 minutes, so do it');
console.log('only while nothing good is running.');
console.log('');

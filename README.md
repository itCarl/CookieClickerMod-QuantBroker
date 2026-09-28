# Quant Broker

A stock market assistant for Cookie Clicker's Bank minigame that learns what each good is worth and never sells at a loss.

![Release](https://img.shields.io/github/v/release/itCarl/cookie-clicker-quant-broker) ![CI](https://github.com/itCarl/cookie-clicker-quant-broker/actions/workflows/release.yml/badge.svg) ![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)

## About

Most market mods trade every good at a fixed multiple of its resting value. The
game's real price distribution is wide, not centred on the resting value, and
different for each of the sixteen goods, so one multiple cannot fit them all.

Quant Broker does not use fixed multiples. It:

- **learns each good's price quantiles online** - two numbers per good, no
  history buffer - and buys low in that distribution and sells high;
- **tracks a cost basis** for every position, so a sale below what you paid
  (plus overhead and margin) cannot happen - it never realises a loss;
- **detects the market's hidden shock events** cross-sectionally and trades
  the crashes and spikes they cause;
- **draws a 15-minute Monte Carlo forecast** into the Dough Jones graph as
  dotted medians with a shaded 10-90 band.

Against a fixed-threshold reference it earns +28% net cookies, winning on 10 of
10 seeds, from a quarter of the traded volume.

## Features

- Per-good online quantile estimation that re-calibrates on bank level-ups and
  under the Supreme Intellect dragon aura.
- Cost basis per position; no sale below `basis * (1 + margin)`.
- Spread check: a good is only traded when the sell line clears broker
  overhead plus the margin.
- Capital rationing: buy candidates ranked by expected return and filled from a
  per-tick budget (default 50% of your cookies), so the bank stays liquid for
  buildings.
- Market-wide shock detection: 100% precision, direction never once wrong in
  100,000 graded ticks.
- Calibrated 15-minute forecast drawn into the game's own graph.
- Auto-hire brokers to cut overhead.
- Achievement mode: holds a floor of every good for `Rookie numbers`,
  `No nobility in poverty` and `Full warehouses`.
- **Fill warehouses** and **Sell everything** buttons.
- Per-row reasoning column explaining what the assistant is doing and why.
- Reconciles against manual trades and handles ascension cleanly.
- No globals, no monkey-patching; driven by the documented `logic` mod hook.

## Installation

**Steam Workshop:** subscribe at
https://steamcommunity.com/sharedfiles/filedetails/?id=3786776073

**Manual:** download `QuantBroker.zip` from the
[GitHub Releases](https://github.com/itCarl/cookie-clicker-quant-broker/releases)
page and unzip it into:

```
<Cookie Clicker>/resources/app/mods/local/QuantBroker/
```

Restart the game and enable the mod under **Options -> Mods**. If you already
run another market mod, turn that one off - two assistants trading the same
market will fight.

## How it works

**Quantiles.** For a target quantile `p`, nudging an estimate up by `lr*p` when
a sample lands above it and down by `lr*(1-p)` when it lands below converges
where `P(price < q) = p`. The assistant buys below the 34th percentile, sells
above the 66th, and keeps riding a position while it is still climbing.

**Cost basis.** Every buy records what it paid, including overhead; every sell
settles against it. The market mean-reverts toward the resting value, so
holding a loser costs only warehouse space - enabling a stop-loss measured
-3.3%.

**Shocks.** Roughly once every ten ticks the game applies one draw to the whole
market, kicking many goods' momentum in the same direction on the same tick.
The event is not exposed to mods, so it is recovered cross-sectionally: when at
least a third of the goods jump in momentum by more than 0.8 and 80% agree on
direction, it is a shock. On a crash the buy line relaxes by 40% for two ticks
and the stale regime state of the hit goods is ignored; on a spike, profitable
positions are sold into it.

**Forecast.** A Monte Carlo run of the next 15 minutes of market ticks is drawn
into the Dough Jones graph as dotted medians with a shaded 10-90 band.
`moddev/forecast_check.js` checks that the band is honestly calibrated.

**Robustness.** Settings, stats, cost bases and learned quantiles persist as
about 2 KB of JSON. The mod never calls `buyGood` with exactly 10,000 units
(the game reads that as "as many as the bank allows"). Source is ASCII-only,
because the game injects mod scripts without a declared charset.

## Development

```
mod/        what the game loads, and all that ships to the Workshop
moddev/     the test harness - never loaded, never shipped
```

The game publishes a mod by zipping its folder whole, so anything beside
`main.js` is uploaded to every subscriber. The harness and the repository's
`.git` directory live outside `mod/` for that reason.

Run the tests:

```
cd moddev && node test.js
```

The tests do not run against a model of the game - `moddev/market.js` loads
Cookie Clicker's own minigame source into a sandbox with a seeded PRNG and DOM
stubs. That source is not in this repository, so the tests need the game's
files from a local Steam install. The full suite takes about 80 minutes.

| Script | What it answers |
|---|---|
| `moddev/test.js` | behavioural tests |
| `moddev/forecast_check.js` | is the 15-minute forecast honestly calibrated? |
| `moddev/chart.js` | the forecast drawn into the game's graph |
| `moddev/loans.js` | are the Bank's loans ever worth taking? |
| `moddev/sim.js` | the trading benchmark |

## License

Distributed under the MIT License. See [`LICENSE`](LICENSE) for details.

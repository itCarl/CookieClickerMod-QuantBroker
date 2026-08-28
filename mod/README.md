# Quant Broker

A stock market assistant for Cookie Clicker's Bank minigame. It watches the
Dough Jones Index, learns what each good is actually worth, and trades it for
you — without draining the cookie bank you need for buildings.

Install: the folder sits in `mods/local/QuantBroker`. Restart the game and
enable it under **Options → Mods**. If you already run another market mod,
turn that one off — two assistants trading the same market will fight.

---

## The problem with fixed thresholds

The obvious way to automate this market is to price every good off a multiple
of its resting value (`10 + 10*id + bankLevel - 1`): buy at `0.70x`, sell at
`1.20x`, and so on. It is the approach almost every market mod takes, and it
does not survive contact with the game's actual price process.

Measuring 200,000 market ticks against the game's own `minigameMarket.js`
(`node dev/probe.js`) at bank level 10:

```
id  resting   p10    p25    p50    p75    p90     share of ticks >= 1.20x resting
 0       19    3.9    7.7   26.9   56.2   88.5                             54.36%
 4       59    5.3   20.1   49.2   82.6  113.5                             33.02%
 8       99   14.0   42.1   77.8  109.4  131.9                             18.48%
12      139   31.4   68.6  108.3  136.1  156.6                              6.12%
15      169   45.2   89.5  129.0  156.0  179.1                              3.49%
```

The distribution is enormous — good #0 trades between roughly `$4` and `$89`
across its 10th–90th percentiles — and it is *not* centred on the resting
value. The soft price ceiling (`100 + 3*(bankLevel-1)`) and the `$5` floor
squash every good toward the same absolute band, so the resting value is a weak
anchor that gets weaker as the good's index rises.

One multiple therefore cannot fit all sixteen goods. A sell line at `1.20x`
resting is loose for good #0, reached over half the time, and close to
unreachable for good #15 at 3.5%. Push it to `1.40x` or `1.60x` for the
trending regimes and good #15 reaches them on 0.94% and 0.18% of ticks — the
position is simply never sold.

There is a second, more expensive failure. The natural way to handle a bearish
trend is a panic-sell rule shaped like this:

```js
// sell as soon as the trend turns bearish and the price is still "high enough"
if ((mode === SLOW_FALL || mode === FAST_FALL) && stock > 0 && val > baseValue * 0.60)
```

If the buy line is `0.70x` and buying costs `val * overhead`, a position entered
at that line cost `0.84x`. Selling it at `0.61x` is a guaranteed loss, taken on
purpose, every time. Nothing in that rule can notice, because nothing records
what was paid.

## What Quant Broker does instead

**It learns each good's price distribution online.** For a target quantile `p`,
nudging an estimate up by `lr*p` when a sample lands above it and down by
`lr*(1-p)` when it lands below converges exactly where `P(price < q) = p`. Two
numbers per good, no history buffer, and it re-calibrates itself when your bank
levels up or when the Supreme Intellect dragon aura makes the market wilder. It
buys below the 34th percentile and sells above the 66th, then keeps riding a
position while it is still climbing.

**It tracks a cost basis per position.** Every buy records what it paid,
including overhead; every sell settles against it. A sale below
`basis * (1 + margin)` cannot happen. In a mean-reverting market that is close
to strictly correct: the price always drifts back toward the resting value, so
holding costs nothing but warehouse space.

**It checks the spread is worth paying for.** Broker overhead
(`1 + 0.20 * 0.95^brokers`) is paid on the way in and never recovered, so a good
only becomes tradable when `sellLine >= buyLine * overhead * (1 + margin)`.

**It rations capital.** Buy candidates are ranked by expected return on the
cookies the trade would tie up and filled best-first from a per-tick budget,
instead of walking the goods in index order and letting the first one drain the
bank.

**It trades the market's crashes.** See the next section — this is where most
of the 1.2 gain comes from.

---

## Market-wide shocks

Once every ten ticks or so, `M.tick` draws one number and applies it to the
whole market at once:

```js
var globD = 0; var globP = Math.random();
if (Math.random() < 0.1 + 0.1*dragonBoost) globD = (Math.random()-0.5)*2;
...
if (globD != 0 && Math.random() < globP) {
    me.val -= (1 + me.d*Math.pow(Math.random(),3)*7) * globD;
    me.val -= globD * (1 + Math.pow(Math.random(),3)*7);
    me.d   += globD * (1 + Math.random()*4);
    me.dur  = 0;
}
```

Three things about that are worth trading:

- **The sign is inverted.** `globD > 0` pushes prices *down*.
- **The momentum kick points the other way, and it is huge.** A crash arrives
  with `d` raised by one to five, an order of magnitude above an ordinary
  tick's drift change, so the rebound is built into the model rather than
  predicted.
- **`dur = 0` rerolls the regime.** For exactly the goods that were hit, `mode`
  and `dur` describe a regime one tick old and mean nothing.

The event is not exposed to mods, but it is the only thing that moves many
goods' momentum in the same direction on the same tick, so it is recovered
cross-sectionally: count the goods whose `d` jumped by more than 0.8 since the
last tick, and call it a shock when the count reaches a third of the market and
at least 80% of the jumps agree on direction. Idiosyncratic jumps do happen —
the chaotic regime rerolls `d` outright — but they are independent across goods
and do not form a quorum.

On a detection the assistant relaxes its buy line by 40% for two ticks and
stops trusting `mode`, `dur` and `d` for the goods that were hit: no momentum
riding, no "regime about to end" sell. On a spike it does the mirror image and
sells profitable positions into it.

Worth **+11.8%**, winning on 8 of 8 seeds, and the deploy cap is not touched to
get it (see below).

### Is the inference any good?

`dev/market.js` records what actually happened each tick, so the guess can be
graded rather than merely believed. `node dev/detector.js 20000 5`, over 100,000
market ticks:

```
shock ticks (any goods hit)  : 9347   (9.3% of ticks, as the 10% draw predicts)
of those, broad enough       : 6421

recall, broad shocks         : 61.2%
recall, all shocks           : 42.6%
direction correct when fired : 100.0%
false positives              : 0      (0.0% of 90,653 quiet ticks)
precision                    : 100.0%
```

It never fires on a quiet market and it has never once had the direction
backwards. What it misses are the small-`globD` shocks whose momentum kick
lands under the threshold — and those are precisely the ones not worth trading,
which the P&L sweep confirms: lowering the threshold to 0.6 raises broad recall
to 67.8% at still-zero false positives, and *loses* 0.9% of net cookies, because
the extra detections are weak dislocations that only buy mediocre entries.

```
node dev/sweep_v12.js jump 12000 8

shockJump 0.3   +15.09Q   +9.4%     5742 trades
shockJump 0.4   +15.19Q  +10.1%     5617
shockJump 0.6   +15.31Q  +10.9%     5333
shockJump 0.8   +15.43Q  +11.8%     5038   <- shipped
shockJump 1.2   +15.32Q  +11.0%     4421
```

Recall is not the objective; cookies are.

---

## Benchmark

`dev/sim.js` loads a mod's real `main.js` into a sandbox and runs it against a
transcription of the game's own market model (`dev/market.js`, taken from
`minigameMarket.js` v2.053 with a seeded PRNG). Trades have no market impact in
this game, so two assistants see byte-identical price paths and every difference
in the outcome comes from the decisions.

Baseline is *never trading at all*: starting cookies plus passive income. "net"
is final net worth — cookies plus stock marked at the closing price — minus that.

Against a fixed-threshold reference implementation of the design described
above:

```
15,000 ticks (250 h of market time), 10 seeds, bank level 10

                                    fixed thresholds    Quant Broker
net cookies vs never trading                 +13.46Q         +17.28Q    1.28x
profitable seeds                               10/10           10/10
units bought                               1,095,388         242,144    4.5x less
trades executed                                5,891           3,280    1.8x fewer
lowest cookie balance                        13.65 M         65.41 B    4,790x more
warehouse fill (time-average)                  47.0%           49.3%
```

Quant Broker won on **all ten seeds**, earning 28% more from a quarter of the
traded volume.

### 1.2 against 1.1

`node dev/sim.js 15000 10 --compare=dev/baseline_v11.js`

```
                                             v1.1            v1.2
net cookies vs never trading              +17.28Q         +19.31Q    1.12x
per-seed wins                                              10/10
market $ profit                            17.21M          19.27M
lowest cookie balance                      65.41B          66.35B
trades executed                              3,280           6,344
```

All of that difference is shock trading. Everything else added in 1.2 either
measured as nothing or measured negative - see below.

The liquidity row is the one that matters in play. The usual shortcut is to call
`buyGood(id, 10000)`, and in the game's code `n == 10000` means *"as many as
cookies allow"* — which runs your bank down to nothing and keeps it there. The
lowest balance across those runs was 13.65 million cookies out of a 3.6-trillion
starting bank; you cannot buy a building while that is running. Quant Broker
deploys at most 50% of your cookies per tick, and the sweep says that costs
nothing at all:

```
maxDeployPct    net cookies    lowest balance
       10%         +13.80Q         708.49 B
       25%         +13.81Q         204.26 B
       50%         +13.80Q          66.52 B
       75%         +13.80Q          22.68 B
      100%         +13.81Q         398.64 M
```

### Across game states

```
12,000 ticks, 8 seeds each                fixed thresholds       v1.1     ratio   wins
early game  (bank lvl 1, tiny warehouses)         +469.05T   +949.66T    2.02x    8/8
mid game    (bank lvl 5)                            +4.97Q     +7.56Q    1.52x    8/8
late game   (bank lvl 10)                          +10.68Q    +13.80Q    1.29x    8/8
end game    (bank lvl 15, maxed offices)           +36.33Q    +43.25Q    1.19x    8/8
dragon aura (Supreme Intellect)                   +231.23T    +15.50Q   67.04x    8/8
cash poor   (5 min starting bank)                  +10.66Q    +13.79Q    1.29x    8/8
```

`node dev/scenarios.js 12000 8 --compare=dev/baseline_v11.js` puts 1.2 against
1.1 in the same six states. It wins all six, and 47 of 48 individual seeds:

```
                                                      v1.1       v1.2    ratio   wins
early game  (bank lvl 1, tiny warehouses)         +949.66T   +977.33T    1.03x    7/8
mid game    (bank lvl 5)                            +7.56Q     +8.25Q    1.09x    8/8
late game   (bank lvl 10)                          +13.80Q    +15.43Q    1.12x    8/8
end game    (bank lvl 15, maxed offices)           +43.25Q    +48.69Q    1.13x    8/8
dragon aura (Supreme Intellect)                    +15.50Q    +16.58Q    1.07x    8/8
cash poor   (5 min starting bank)                  +13.79Q    +15.40Q    1.12x    8/8
```

The gain is smallest early, where warehouses are too small for a crash entry to
be worth much, and largest once there is capacity to put behind one.

The edge is largest exactly where fixed thresholds are worst: early, when
resting values are small and the price floor dominates, and under the Supreme
Intellect aura, which widens the market's swings. In that last scenario the
fixed-threshold run posts a **negative** market profit on 4 of 10 seeds — the
panic-sell rule firing constantly in a chaotic market and realising the loss
each time. Quant Broker returns a steady `+$13–15M` on every seed.

Reproduce any of it:

```
node dev/probe.js          # measure the market's price distribution
node dev/sim.js 15000 10   # benchmark; add --compare=<path/to/other/main.js>
node dev/detector.js       # grade the shock detector against ground truth
node dev/detector.js 15000 4 --sweep   # ... across detection thresholds
node dev/ablate_v12.js     # every 1.2 feature, alone and in combination
node dev/sweep_v12.js ride|deploy|shock2|jump|early|cps   # 1.2 parameter sweeps
node dev/scenarios.js      # across game states, same --compare= option
node dev/experiments.js    # strategy ablations
node dev/test.js           # 80 behavioural tests
node dev/optimize.js       # coordinate descent with a train/test seed split
node dev/compare_settings.js  # two settings sets across game states
node dev/ablate_new.js     # ablations for the robustness features
python dev/ascii_guard.py  # keep main.js free of non-ASCII bytes
```

### What each piece is worth

From `dev/experiments.js` (12,000 ticks, 6 seeds), each variant measured against
the shipping defaults:

```
 -3.3%   turning the stop-loss on
 -5.1%   never riding momentum past the sell line
 -5.9%   removing the falling-knife filter
-14.2%   also buying during a Fast Fall regime
```

Every tunable default was then re-derived by `dev/optimize.js`, a coordinate
descent over disjoint train and test seed sets. The search improved the training
score by 14.6% and the **held-out** score by 13.7%, so the gain is real rather
than a fit to the benchmark. The retuned assistant beats the previous defaults
in every game state tested except a very fresh save under 400 ticks, where the
two are within noise.

The stop-loss line is worth dwelling on: enabling it *loses* 3.3%. In a market
that mean-reverts to a known resting value, cutting a loser is close to always
wrong. That is why `allowLoss` defaults to off, and why refusing to sell below
cost is the single largest correctness win in the whole design.

### Things that did not work

`node dev/ablate_v12.js 12000 8`, each feature alone against the 1.1 behaviour:

```
1.1 behaviour (all off)      +13.80Q                     2626 trades   66.52B min
+ shockDetect                +15.43Q   +11.8%    8/8     5038          67.50B
+ ceilingRide                +13.77Q    -0.2%    1/8     2626          66.52B
+ floorGrab                  +13.77Q    -0.2%    1/8     2603          62.18B
+ adaptBand                  +13.33Q    -3.4%    0/8     3954          64.26B
+ cpsHold                    +13.80Q    +0.0%    0/8     2626          66.52B
```

Three plausible-sounding edges are implemented, measured, and shipped **off**.
The mechanisms are all real; acting on them is what loses money.

**The soft price ceiling** (`ceilingRide`). Above `100 + 3*(bankLevel-1)` the
game damps upward drift by 10% a tick, so a momentum ride started up there
decays instead of paying. True, and useless: sell lines mostly sit just under
the ceiling, so any rule that shortens rides near it cuts the ordinary
profitable ones. Tapering the budget over the approach cost 4.1%; a hard switch
at the line itself is a rounding error at every budget tested (`node
dev/sweep_v12.js ride`).

**The $5 floor** (`floorGrab`). Below $5 the price is yanked halfway back to 5
every tick with a hard floor of $1, which really is close to a free option. But
filling capacity down there ties up warehouse space and budget in a good whose
exit is also low, and the 1%/tick pull back to resting is slow. It is
marginally negative late (-0.2%) and *worse* early where the floor binds most
(-0.7% at $6, -3.7% at $12), which is the opposite of the prediction (`node
dev/sweep_v12.js early`).

**Overhead-adaptive band** (`adaptBand`). The idea: brokers take overhead from
20% to 0.1%, so a trade becomes nearly free and the wide quantile band is
needlessly picky. Wrong premise. Overhead is not what makes the band pay - the
shape of the price distribution is. Tightening it raised turnover by half and
lost 3.4% alone and 12.7% in combination. This was the worst idea of the batch.

**CpS growth credit** (`cpsHold`) is shipped on, but honestly: it is provably
inert while `cookiesPsRawHighest` is flat, which is the only regime the
standard benchmark models. Against a rate that actually climbs
(`node dev/sweep_v12.js cps`) it is worth +0.0% at 0.05%/tick and +0.7% to
+5.3% at 0.20%/tick, on 3-4 of 6 seeds. That is weak evidence for a real
mechanism, so it stays on at a short horizon where it cannot hurt.

The crash stance is the one that paid, and its parameters were swept too
(`node dev/sweep_v12.js shock2`): a 40% buy-line relaxation beats 25% and 70%,
two ticks of stance beats one and three. Raising the per-tick deploy cap during
a crash changed net cookies by **exactly nothing** while dropping the lowest
cookie balance from 67.9B to 2.2B, so `shockDeployMult` ships at 1.0 and the
cap you set stays the cap.

---

## How it is built

Choices that are about robustness rather than profit:

- **Startup.** Polls `Game.isMinigameReady()` every logic frame, so it starts
  whenever the Bank becomes available — not on a one-shot timer that misses if
  the minigame has not finished loading.
- **Tick driver.** Uses the documented `logic` mod hook and watches `M.ticks`.
  No monkey-patching of `bank.tick` or any other game internal.
- **Persistence.** Settings, stats, cost bases and learned quantiles are saved
  as compact JSON, about 2 KB.
- **No globals.** One IIFE, delegated event listeners, no `onclick=` attributes.
- **Cheap redraws.** The panel's DOM is built once and only changed text is
  rewritten; `toRedraw` is set once per tick the way the game does it.
- **Survives a UI rebuild.** If the bank panel is regenerated, the assistant
  re-injects its own panel on the next frame.
- **Handles manual trading.** Tracked positions are reconciled against real
  stock every tick, so trading by hand does not corrupt the cost basis.
- **Handles ascension.** Cost bases are cleared on reset and whenever the tick
  counter runs backwards; the learned quantiles are kept, since the price
  process itself has not changed. The cached momentum is cleared too - stale
  `d` values from a market that no longer exists would read as a shock on the
  next comparison.
- **Never asks for exactly 10,000 units.** In `M.buyGood`, `n == 10000` means
  "as many as the bank allows", which fills to warehouse capacity and walks
  straight through the per-tick deploy cap. Every buy is clamped below it, and
  `dev/test.js` asserts the call is never made.
- **Survives a bank level-up.** A level-up shifts every resting value by +1 and
  the ceiling by +3, so the learned quantiles are shifted by the same amount
  immediately rather than being left to crawl there. Measured +0.5% over a run
  where the bank climbs from level 1 to 15, and an exact no-op when it does not.
- **Cold-starts from measured data.** New goods seed their quantiles by
  interpolating the distribution measured in `dev/probe.js`, for whatever
  quantiles you have configured. Worth +4.4% over the first 1500 ticks.
- **Fails visibly, not silently.** Tick logic is wrapped; an error shows in the
  panel instead of killing the hook.
- **ASCII-only source.** The game's `index.html` declares no `<meta charset>`
  and injects mod scripts via `createElement('script')`, so every non-ASCII
  character in `main.js` is written as a `\uXXXX` escape. `dev/ascii_guard.py`
  enforces it.

---

## Settings

Open the Bank, then **Settings** in the Quant Broker panel.

Six of them, because the rest are not preferences — they are numbers that were
solved for, and every other value tested made the assistant worse. Putting them
on screen would only invite you to lose money with them.

| Setting | Default | What it does |
|---|---|---|
| Assistant enabled | on | Master switch. While off it keeps learning the market but places no trades. |
| Auto-hire brokers | on | Hires brokers to cut overhead. They pay for themselves quickly. |
| Use hidden market state | on | Reads each good's momentum and regime timer rather than price alone. Worth about 11%, and shock detection needs it. Turn it off to trade only on what the price graph already shows you. |
| Most of your cookies per tick | 50% | Hard cap on what may be spent in one market tick. The one real trade-off you own: net cookies barely move across the whole range, your lowest balance moves enormously. |
| Achievement mode | off | Stops trading for profit and holds a floor of every good instead, for `Rookie numbers` (100), `No nobility in poverty` (500) and `Full warehouses` (1000). It will not sell below the floor once reached, and trades only the surplus above it. |
| Units to hold in that mode | 500 | The floor. |

Everything else — the quantile band, the required margin, the learning rate, the
warm-up, the broker budget, the stop-loss, the shock stance, and the three
measured-negative features above — lives in `DEFAULTS` in `main.js`. They are
still real settings and can still be injected through the mod's `load()` hook,
which is how `dev/optimize.js` and `dev/ablate_v12.js` drive them.

**Fill warehouses** buys every good to capacity right now, cheapest-relative-to-
resting first, ignoring the band. Both ends of a trade are priced at
`Game.cookiesPsRawHighest`, and that number only ever goes up, so stock bought
before a big CpS jump is paid for at the old rate and sold at the new one. Press
it before buying something that will move your CpS a lot.

**Sell everything** liquidates every position at the current price — useful
before ascending, since the market resets and unsold stock is simply gone.

## Reading the panel

Each row is one good: symbol, trend, price, the learned buy and sell lines,
holdings against warehouse capacity, your average cost, unrealised P/L, and
then the widest column on the panel — what the assistant is thinking about it.

The trend column is one glyph wide, coloured independently of the row so it
stays readable, and named on hover:

| | |
|---|---|
| `—` grey | stable |
| `↑` green | slow rise |
| `↑↑` green | fast rise |
| `↓` red | slow fall |
| `↓↓` red | fast fall |
| `~` amber | chaotic |

### The reasoning column

Every row says which stage of the decision it reached and, where there is one,
how far the price still has to move. The cell stays short enough to fit the
column; **hover it for the full sentence**, including why.

| Cell | Means |
|---|---|
| `LEARN 12/20` | still building price history; not tradable yet |
| `WATCH buy -49%` | flat; the price has to fall 49% to reach the buy line |
| `KNIFE -1.42` | falling too fast to catch; waiting for it to stall |
| `AVOID fast fall` | a fast-fall regime is running; exits only until it ends |
| `NOEDGE` | the spread does not clear overhead plus the margin |
| `FULL 400` | warehouse full; buy more of the tied building to widen it |
| `HOLD sell +16%` | in profit; needs another 16% to reach the sell line |
| `UNDER cost +7%` | below cost basis by 7%; it will not sell at a loss |
| `RIDE +1.58 13/160` | past the sell line, still climbing, 13 of 160 ride ticks used |
| `NOCASH` | wants to buy but this tick's deploy budget is spent |
| `BUY x120 34%` | bought 120 units at an expected 34% return |
| `BUY x120 dip` | bought into a detected market-wide crash |
| `SELL x80` | sold; hover for which rule fired |
| `FILL 300/500` | achievement mode is holding this one and not trading it |

Green rows bought this tick, red sold, amber are riding. **P/L** is green in
profit and red under water, grey when nothing is held. **Held** is grey when
empty, green while there is room to keep buying, amber past 80% of capacity,
and red when the warehouse is full and therefore blocking further buys.

When a market-wide shock is detected a banner appears above the table naming
the direction, how many goods were hit, the estimated strength, and how many
ticks the stance has left to run.

### The two profit figures

The header carries two, because they answer different questions. The `$` figure
is the game's own market profit. The **cookie** figure is what the trades were
actually worth: goods are priced in seconds of your highest raw CpS, so a
position bought while your CpS was low and sold after it grew pays out far more
cookies than it cost, even at a flat `$` price.

**Realised** is profit already booked by completed sales. **Open** is
mark-to-market on what you are still holding — current price times units, minus
what those units cost — so it is what would be added to Realised if everything
were liquidated right now.


## Notes and caveats

- **Steam achievements.** `info.txt` sets `AllowSteamAchievs: 1`, so
  achievements keep unlocking. An auto-trader is arguably not "a good honest mod
  that does not incredibly unbalance the game" in the sense the modding readme
  means; set it to `0` if you would rather block them.
- The benchmark holds `cookiesPsRawHighest` constant so cookies and `$` stay
  proportional and the comparison is clean. In a real run your CpS grows, which
  favours holding and therefore favours this assistant's lower turnover — but
  the size of that effect depends on your own progression, so it is deliberately
  not claimed as part of the measured result above.
- `dev/` is tooling, not part of the mod. The game only loads `info.txt`,
  `main.js` and `thumbnail.png`.
- The market model in `dev/market.js` is a transcription of game v2.053. If
  `minigameMarket.js` changes, re-check it before trusting new numbers.

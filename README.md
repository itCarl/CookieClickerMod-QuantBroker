# Quant Broker

Cookie Clicker stock market assistant. Learns each good's own price distribution online instead of trading fixed multiples of the resting value, tracks a cost basis so it never sells at a loss, detects the market's shock events, and draws a calibrated 15-minute forecast into the game's own graph.

Cookie Clicker Bank / stock market minigame. Version 1.2.

- Learns each good's price quantiles online - two numbers per good, no history buffer.
- Tracks a cost basis, so a sale below what you paid cannot happen.
- Recovers the game's hidden market-wide shock events cross-sectionally: 100% precision, direction never once wrong.
- Draws the next 15 minutes into the Dough Jones graph as dotted medians with a shaded 10-90 band.
- +28% net cookies against a fixed-threshold reference, winning on 10 of 10 seeds, from a quarter of the traded volume.

## Layout

```
mod/        what the game loads, and all that ships to the Workshop
moddev/     the test harness - never loaded, never shipped
```

The split matters: the game publishes a mod by zipping its folder whole
(`resources/app/start.js`), so anything sitting beside `main.js` is uploaded to
every subscriber. The harness lives outside `mod/` so that cannot happen, and
the repository's own `.git` directory is outside it for the same reason.

## Installing

`mod/` is what goes into `Cookie Clicker/resources/app/mods/local/QuantBroker`. On
the machine this was developed on that path is a directory junction pointing
here, so the game and the repository share one copy and an edit is live
immediately.

Restart the game and enable the mod under **Options -> Mods**.

## Testing

```
cd moddev
node test.js
```

The tests. They do not run against a model of the game - `moddev/market.js`
loads Cookie Clicker's own minigame source into a sandbox with a seeded PRNG and
stubs for the DOM, so a passing test is testing the real thing.

| Script | What it answers |
|---|---|
| `moddev/test.js` | behavioural tests |
| `moddev/forecast_check.js` | is the 15-minute forecast honestly calibrated? |
| `moddev/chart.js` | the forecast drawn into the game's graph |
| `moddev/loans.js` | are the Bank's loans ever worth taking? |
| `moddev/sim.js` | the trading benchmark |

The harness resolves its paths for both locations, so the tests run from the
repository and from inside the game tree.

## A note on history

This repository starts at the version above. The mod existed before it, but that
work was never under version control, so there is nothing earlier to import -
the first commit is the state as it shipped, not a reconstruction.

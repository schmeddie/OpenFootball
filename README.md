# OpenFootball

A browser-based football match simulator built on the FC 27 player database (`players.csv`).

Pick two teams and a formation for each. The app fills in the starting XI and the bench from
each squad, then plays a text-commentary match. Every duel, pass, shot and save is
resolved from the players' attributes.

## Running it

The app is plain HTML/CSS/JS with no build step. It needs to be served over HTTP, so that the browser lets it load
`players.csv` and run simulations on all CPU cores:

- **Windows:** double-click `start.bat`. It starts a small local web server using PowerShell, which comes with
  Windows, so nothing needs installing, and opens the app in your browser. Keep the window open while you use it.
- **Mac/Linux:** run `./start.sh` (needs Python 3), or `python3 -m http.server 8000` and open http://localhost:8000.

If you open `index.html` directly from disk instead, the app asks you to choose `players.csv` manually and the
Supercomputer runs on a single core.

## Features

- **Team picker**: all 754 club/league squads, filterable by league, sorted by squad rating, with a random-team option.
- **Automatic lineups**: ten formations. Each player gets a rating for every position, weighted from their
  attributes and anchored to their card overall. There's a penalty for playing unfamiliar positions. The XI is
  chosen to maximise total position fit, and the bench gets a keeper plus cover for each line.
  "Best" formation is chosen automatically when a team is picked. Click any two players to swap them.
- **Match engine** (`js/engine.js`): simulated minute by minute.
  - Possession comes from each side's passing and ball retention against the opposition's pressing.
  - Attacks are through balls, dribbles, crosses and long shots. Each one is chosen based on the squad's strengths
    and resolved as attacker-vs-defender duels.
  - Shots are resolved as finisher vs goalkeeper, with an xG value per chance.
  - Also included: fouls, cards, penalties, free kicks, corners, injuries, fatigue (stamina) and AI substitutions.
  - PlayStyles and PlayStyles+ add bonuses to the relevant skills.
- **Ratings**: live 1–10 player ratings built from each player's actions. The match report has full player stats,
  team stats, xG and a Player of the Match.
- **Seeds**: every match is reproducible. Enter the seed shown at full time to replay it.

## Supercomputer mode

The **Supercomputer** tab replays the same competition thousands of times and reports how often each outcome happens.

| Mode | Simulates | Reports |
|---|---|---|
| Head-to-head | The fixture set up on the Match tab, with your lineups. Optionally a knockout tie with extra time and penalties. | Win/draw/loss %, fair odds, scoreline heatmap, average stats, anytime-scorer % and average rating per player |
| League season | Any set of teams (a real league, or a mix from anywhere), playing home and away or once | Average points and position, title / top-N / relegation %, a finishing-position grid per team, Golden Boot odds, a sample season |
| Knockout cup | Any number of teams with a random or seeded draw, byes if needed, extra time and penalties | Chance of reaching each round, most likely finals, top-scorer odds |

How it works:

- **Independent runs.** Each run (one match, season or tournament) gets its own seed, derived from the job seed and
  the run number. The same seed always gives the same results, however the work is split.
- **Parallel workers.** Runs are handed out in small batches to Web Workers, one per CPU core less one, capped at 8.
  Each worker returns counters (wins, points, finishing positions, goals per player and so on). The page merges them
  and redraws the results as they arrive, so you see provisional numbers converge while it runs. You can cancel at
  any point and keep the partial results.
- **Fast mode.** Bulk matches skip commentary and the event log. Player skill composites are cached. A match takes
  about 2 ms of CPU, so 1,000 Premier League seasons (380,000 matches) take around 1–2 minutes on an 8-core machine.
- **Fixed lineups.** Teams use their best auto-picked formation, XI and bench, or your custom lineup if the team is
  set up on the Match tab. There's no fatigue carried between matches, no squad rotation and no injuries lasting
  beyond a match.

Workers need the page to be served over HTTP. Opened from `file://`, the simulations run on the main thread instead.
This is slower, but it works.

## Rest of season

The Supercomputer's **Rest of season** mode takes a football-data.co.uk results file for the current season (for
example the Premier League's `E0.csv`). It can also take a fixtures file, which may be football-data's `fixtures.csv`
covering every league; only the matching division is used. It:

- starts from the real table, keeping the points already won,
- simulates only the games still to play, using the squads' FC 27 players,
- reports predicted final points with a likely range, title / top-N / relegation odds and a finishing-position grid,
- gives home/draw/away odds, the likeliest score and average goals for every remaining game, filterable by team.

Without a fixtures file, the remaining games are worked out from which home/away pairings haven't been played yet.
The files you load are remembered in the browser.

A **form adjustment** (on by default) nudges each team's strength up or down by how much it has out- or under-played
its ratings so far. It's measured from **shots and shots on target, for and against**, compared with what the engine
expected from the same games, then shrunk towards zero while few games have been played. Shots are used rather than
points because points are dominated by luck over a handful of games.

Retro-tested on 2025-26 by predicting from a point in the season and scoring against what actually happened
(per-game RPS, lower is better):

| Predicting from | Ratings only | + form from points | **+ form from shots (default)** | Bookmakers (closing odds) |
|---|---|---|---|---|
| Matchday 5 | 0.2113 | 0.2187 | **0.2078** | 0.2067 |
| Matchday 10 | 0.2126 | 0.2181 | **0.2082** | 0.2040 |
| Halfway | 0.2241 | 0.2269 | **0.2101** | 0.2089 |

Average error in each team's final points: from matchday 5, 7.7 → 7.4 (bookmakers 6.3); from halfway, 5.4 → 4.2
(bookmakers 4.0). Shot-based form closes half to nine-tenths of the gap to the betting market, while points-based form
makes predictions worse every time.

Caveats:
- **One season, about ten settings tried.** The chosen setting may be slightly flattered by the choice. The simplest
  consistent option (equal weight on shots and shots on target, weight 1) was picked rather than the best-scoring one
  at any single checkpoint.
- **Partly tuned on the same data.** The engine was tuned on the first half of 2025-26, so the matchday-5 and
  matchday-10 tests reuse some of those games. The halfway test does not.

```sh
node scripts/rest-of-season.js --results E0.csv [--fixtures fixtures.csv] --form shotmix:1   # predict from real results
node scripts/rest-of-season.js --results E0.csv --upto 50 --form none,points:1,shotmix:1 # retro-test a finished season
node scripts/rest-of-season.js --results E0.csv --sensitivity                              # re-measure form signal scales
```

## Accuracy (backtest)

`scripts/backtest.js` replays every fixture of a real season (`E0.csv` is the 2025-26 Premier League, from
football-data.co.uk). It plays each fixture 400 times to get home/draw/away probabilities, then scores them against
the real results, the bookmakers' closing odds and two naive baselines. The scores are ranked probability score (RPS)
and log loss, where lower is better, plus the share of results picked correctly.

The engine's tuning knobs (`OF.Match.TUNING` in `js/engine.js`) were fitted on the **first half** of the season
only. Results on the **second half**, which the tuning never saw:

| Model | RPS ↓ | Log loss ↓ | Picks right |
|---|---|---|---|
| Bookmakers (closing odds) | 0.2089 | 1.048 | 45.3% |
| **Match engine (tuned)** | **0.2202** | **1.081** | **40.0%** |
| Always predict the season average | 0.2245 | 1.090 | 39.5% |
| Coin flip | 0.2269 | 1.099 | 39.5% |
| Match engine (before tuning) | 0.2333 | 1.132 | 40.5% |

Before tuning, the engine was badly overconfident and scored worse than a coin flip. After tuning it beats both naive
baselines on unseen matches but is still clearly behind the betting market. Over the whole season it matches the real
outcome mix (44/25/31% home/draw/away vs 43/27/30% real) and goals (2.65 vs 2.75 per match). Ranked by expected
points, its table has a rank correlation of 0.73 with the real one (the bookmakers manage 0.77).

Caveats:
- **Hindsight in the ratings.** FC 27 ratings were published after this season, so they partly reflect it. That
  flatters the engine.
- **Squads have moved on.** The ratings describe the squads after the summer 2026 transfers, not the 2025-26 ones.
- **One season is a small sample.** 190 held-out matches is enough to see big effects, not small ones.

```sh
node scripts/backtest.js                                  # full report: scores, calibration, expected-points table
node scripts/backtest.js --half 2 --sims 400              # held-out half only
node scripts/backtest.js --half 1 --summary --set duel=32,homeAdvantage=5   # one-line result for parameter sweeps
```

## Command line

```sh
node scripts/simulate.js "Real Madrid" "FC Barcelona"          # one match with commentary
node scripts/simulate.js "Chelsea|Premier League" "Arsenal" 42 # "|League" disambiguates, 42 = seed
node scripts/simulate.js --calibrate 500                       # aggregate stats across random matches
node scripts/season.js "Premier League" --runs 1000            # predict a season: title / top 4 / relegation odds
```

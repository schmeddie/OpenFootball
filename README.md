# OpenFootball

A browser-based football match simulator built on the FC 27 player database (`players.csv`).

Pick two teams and a formation for each. The app fills in the starting XI and the bench from
each squad, then plays a text-commentary match. Every duel, pass, shot and save is
resolved from the players' attributes.

## Running it

The app is plain HTML/CSS/JS with no build step. Serve the folder over HTTP so the browser can load `players.csv`:

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

If you open `index.html` directly from disk, the app asks you to choose `players.csv` manually.

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

## Command line

```sh
node scripts/simulate.js "Real Madrid" "FC Barcelona"          # one match with commentary
node scripts/simulate.js "Chelsea|Premier League" "Arsenal" 42 # "|League" disambiguates, 42 = seed
node scripts/simulate.js --calibrate 500                       # aggregate stats across random matches
```

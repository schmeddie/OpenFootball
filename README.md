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

## Command line

```sh
node scripts/simulate.js "Real Madrid" "FC Barcelona"          # one match with commentary
node scripts/simulate.js "Chelsea|Premier League" "Arsenal" 42 # "|League" disambiguates, 42 = seed
node scripts/simulate.js --calibrate 500                       # aggregate stats across random matches
```

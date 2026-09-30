#!/usr/bin/env node
// Predict a league season by simulating it many times (the Supercomputer
// tab's league mode, from the command line, spread across CPU cores).
//
//   node scripts/season.js                               # Premier League, 1000 seasons
//   node scripts/season.js "EFL Championship" --runs 500 --top 2 --releg 3
//   node scripts/season.js --set duel=32                 # override engine tuning
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

const root = path.join(__dirname, '..');
for (const f of ['util', 'csv', 'players', 'formations', 'commentary', 'engine', 'sim']) require(path.join(root, 'js', `${f}.js`));
const OF = globalThis.OF;

if (!isMainThread) {
  Object.assign(OF.Match.TUNING, workerData.tuning);
  const agg = OF.sim.createAgg();
  for (let i = workerData.start; i < workerData.end; i++) {
    OF.sim.simulateRun(workerData.job, i, agg);
    parentPort.postMessage({ type: 'tick' });
  }
  parentPort.postMessage({ type: 'done', agg });
  return;
}

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const league = args[0] && !args[0].startsWith('--') ? args[0] : 'Premier League';
const runs = parseInt(opt('runs', '1000'), 10);
const tuning = Object.fromEntries((opt('set', '') || '').split(',').filter(Boolean).map((kv) => kv.split('=')).map(([k, v]) => [k, Number(v)]));
const options = { format: 'double', topPlaces: parseInt(opt('top', '4'), 10), relegation: parseInt(opt('releg', '3'), 10), homeAdvantage: true };

const db = OF.players.buildDatabase(OF.parseCSV(fs.readFileSync(path.join(root, 'players.csv'), 'utf8')));
const teams = db.teams.filter((t) => t.league === league);
if (teams.length < 2) {
  console.error(`No league called "${league}". Leagues: ${db.leagues.join(', ')}`);
  process.exit(1);
}
const cfgs = teams.map((team) => {
  const f = OF.formations.bestFormation(team);
  const xi = OF.formations.pickStartingXI(team, f);
  const t = { key: team.key, name: team.name, league: team.league, gender: team.gender, rating: team.rating };
  return { team: t, formation: f, xi, bench: OF.formations.pickBench(team, xi) };
});
const job = { mode: 'league', teams: cfgs, options, seed: parseInt(opt('seed', '2627'), 10) };

const nWorkers = Math.max(1, Math.min(os.cpus().length, 8, runs));
const t0 = Date.now();
let ticks = 0;
Promise.all(Array.from({ length: nWorkers }, (_, w) => new Promise((resolve, reject) => {
  const start = Math.floor((runs * w) / nWorkers);
  const end = Math.floor((runs * (w + 1)) / nWorkers);
  const worker = new Worker(__filename, { workerData: { job, start, end, tuning } });
  worker.on('message', (m) => {
    if (m.type === 'tick') {
      ticks++;
      if (process.stderr.isTTY) process.stderr.write(`\r${ticks}/${runs} seasons`);
    } else resolve(m.agg);
  });
  worker.on('error', reject);
}))).then((parts) => {
  if (process.stderr.isTTY) process.stderr.write('\n');
  const agg = parts.reduce((a, b) => OF.sim.mergeAgg(a, b), OF.sim.createAgg());
  report(agg, (Date.now() - t0) / 1000);
});

function report(agg, secs) {
  const n = agg.runs;
  const size = teams.length;
  const pct = (x) => (x ? `${((x / n) * 100).toFixed(1)}%` : '-');
  console.log(`\n${league}: ${n.toLocaleString()} simulated seasons (${agg.matches.toLocaleString()} matches, ${secs.toFixed(0)}s)\n`);
  console.log(` #  Team                 OVR   Pts    GD    Title    Top ${options.topPlaces}   Relegated  Likeliest`);
  const rows = Object.values(agg.teams).sort((a, b) => b.pts - a.pts);
  rows.forEach((t, i) => {
    const best = t.finish.indexOf(Math.max(...t.finish)) + 1;
    console.log(`${String(i + 1).padStart(2)}  ${t.name.padEnd(20)} ${String(t.rating).padStart(3)}  ${(t.pts / n).toFixed(1).padStart(5)}  ${((t.gf - t.ga) / n).toFixed(1).padStart(5)}  ${pct(t.title).padStart(7)}  ${pct(t.top).padStart(7)}  ${pct(t.releg).padStart(9)}   ${best}`);
  });
  const place = agg.placePts.map((p) => p / n);
  console.log(`\nTable shape (average points by finishing place)`);
  console.log(`  1st ${place[0].toFixed(1)}  4th ${place[3].toFixed(1)}  ${size - 3}th ${place[size - 4].toFixed(1)}  last ${place[size - 1].toFixed(1)}  spread (sd) ${(agg.ptsSdSum / n).toFixed(1)}`);
  const scorers = Object.values(agg.players).sort((a, b) => b.goals - a.goals).slice(0, 5);
  console.log(`\nGolden Boot: ${scorers.map((p) => `${p.name} ${(p.goals / n).toFixed(1)} (${pct(p.topScorer)})`).join(' · ')}`);
}

#!/usr/bin/env node
// Predict the rest of a season from the real results so far.
//
//   node scripts/rest-of-season.js --results "E0 (1).csv" [--fixtures fixtures.csv] [--runs 1000]
//
// Retro-test on a finished season: pretend only the first N games have been
// played, predict the rest, then score against what really happened:
//
//   node scripts/rest-of-season.js --results E0.csv --upto 50 --update 0,0.1,0.2
//
// --update k scales the per-team strength adjustment from over/under-
// performing the ratings so far (0 = ratings only). A comma list compares values.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

const root = path.join(__dirname, '..');
for (const f of ['util', 'csv', 'players', 'formations', 'commentary', 'engine', 'sim', 'teamnames', 'season']) require(path.join(root, 'js', `${f}.js`));
const OF = globalThis.OF;

if (!isMainThread) {
  Object.assign(OF.Match.TUNING, workerData.tuning);
  const agg = OF.sim.createAgg();
  for (let i = workerData.start; i < workerData.end; i++) OF.sim.simulateRun(workerData.job, i, agg);
  parentPort.postMessage(agg);
  return;
}

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const RUNS = parseInt(opt('runs', '1000'), 10);
const UPTO = opt('upto', null);
const K_LIST = String(opt('update', '0')).split(',').map(Number);
const tuning = Object.fromEntries((opt('set', '') || '').split(',').filter(Boolean).map((kv) => kv.split('=')).map(([k, v]) => [k, Number(v)]));

const db = OF.players.buildDatabase(OF.parseCSV(fs.readFileSync(path.join(root, 'players.csv'), 'utf8')));
let resultRows = OF.parseCSV(fs.readFileSync(path.resolve(root, opt('results', 'E0.csv')), 'utf8')).filter((r) => r.HomeTeam);
let fixtureRows = opt('fixtures', null) ? OF.parseCSV(fs.readFileSync(path.resolve(root, opt('fixtures')), 'utf8')).filter((r) => r.HomeTeam) : null;
let truthRows = null;
if (UPTO !== null) {
  // Retro test: the games after N become "fixtures" and the truth to score against.
  truthRows = resultRows.slice(parseInt(UPTO, 10));
  fixtureRows = truthRows;
  resultRows = resultRows.slice(0, parseInt(UPTO, 10));
}
const season = OF.season.buildSeason(db, resultRows, fixtureRows);
if (season.unknown.length) console.warn(`Couldn't match: ${season.unknown.join(', ')}`);
const n = season.teams.length;

const cfgs = season.teams.map((team) => {
  const f = OF.formations.bestFormation(team);
  const xi = OF.formations.pickStartingXI(team, f);
  return { team: { key: team.key, name: team.name, league: team.league, gender: team.gender, rating: team.rating }, formation: f, xi, bench: OF.formations.pickBench(team, xi) };
});

function runPool(job, runs) {
  const w = Math.max(1, Math.min(os.cpus().length, 8, runs));
  return Promise.all(Array.from({ length: w }, (_, k) => new Promise((resolve, reject) => {
    const worker = new Worker(__filename, { workerData: { job, start: Math.floor((runs * k) / w), end: Math.floor((runs * (k + 1)) / w), tuning } });
    worker.on('message', resolve);
    worker.on('error', reject);
  }))).then((parts) => parts.reduce((a, b) => OF.sim.mergeAgg(a, b), OF.sim.createAgg()));
}

const baseOptions = { format: 'double', topPlaces: 4, relegation: 3, homeAdvantage: true };
const name = (i) => season.teams[i].name;

(async () => {
  const t0 = Date.now();
  // Phase 1: how many points did the ratings "expect" from the games already played?
  let strengths = null;
  const needUpdate = K_LIST.some((k) => k !== 0) && season.played.length;
  let phase1 = null;
  if (needUpdate) {
    const runs1 = 200;
    phase1 = { runs: runs1, agg: await runPool({ mode: 'league', teams: cfgs, options: baseOptions, fixtures: season.played.map((g) => [g.i, g.j]), seed: 1 }, runs1) };
  }
  const results = [];
  for (const k of K_LIST) {
    strengths = k && phase1 ? OF.season.strengthsFromResults(n, season.played, phase1.agg.fxOut, phase1.runs, k) : null;
    const job = {
      mode: 'league', teams: cfgs, options: baseOptions, seed: 2627,
      start: season.table, fixtures: season.remaining.map((f) => [f.i, f.j]),
      strengths: strengths ? strengths.map((s) => s.strength) : null,
    };
    const agg = await runPool(job, RUNS);
    results.push({ k, agg, strengths });
  }
  const secs = (Date.now() - t0) / 1000;
  console.log(`\n${season.played.length} games played, ${season.remaining.length} to go · ${RUNS.toLocaleString()} simulations of the rest of the season · ${secs.toFixed(0)}s`);
  if (truthRows) retroReport(results);
  else predictionReport(results[results.length - 1]);
})();

function predictionReport({ agg, strengths }) {
  const R = agg.runs;
  const pct = (x) => (x ? `${((x / R) * 100).toFixed(1)}%` : '-');
  console.log('\n #  Team                 Now  Pld   Final pts   Title    Top 4   Relegated');
  const rows = Object.entries(agg.teams).map(([key, t]) => ({ ...t, idx: season.teams.findIndex((x) => x.key === key) }))
    .sort((a, b) => b.pts - a.pts);
  rows.forEach((t, i) => {
    const now = season.table[t.idx];
    console.log(`${String(i + 1).padStart(2)}  ${t.name.padEnd(20)} ${String(now.pts).padStart(3)}  ${String(now.p).padStart(3)}   ${(t.pts / R).toFixed(1).padStart(8)}  ${pct(t.title).padStart(7)}  ${pct(t.top).padStart(7)}  ${pct(t.releg).padStart(9)}`);
  });
  console.log('\nNext fixtures');
  season.remaining.slice(0, 10).forEach((f, k) => {
    const o = agg.fxOut.slice(k * 5, k * 5 + 5).map((c) => c / R);
    const top = Object.entries(agg.fxScores[k]).sort((a, b) => b[1] - a[1])[0][0];
    const d = f.date ? f.date.toISOString().slice(0, 10) : '';
    console.log(`  ${d.padEnd(11)}${name(f.i).padStart(18)} v ${name(f.j).padEnd(18)} ${(o[0] * 100).toFixed(0).padStart(3)}% / ${(o[1] * 100).toFixed(0).padStart(2)}% / ${(o[2] * 100).toFixed(0).padStart(2)}%   likeliest ${top}`);
  });
  if (strengths) {
    console.log('\nStrength adjustments from results so far:');
    console.log('  ' + strengths.map((s, i) => `${name(i)} ${((s.strength - 1) * 100).toFixed(1)}%`).join(' · '));
  }
}

function retroReport(results) {
  // Real outcome of every remaining game, in the same order as season.remaining.
  const truth = OF.season.buildSeason(db, resultRows.concat(truthRows), null);
  const idxOf = (t) => truth.teams.indexOf(season.teams[t]);
  const byPair = new Map(truth.played.map((g) => [`${g.i}-${g.j}`, g]));
  const outcomes = season.remaining.map((f) => byPair.get(`${idxOf(f.i)}-${idxOf(f.j)}`));
  const finalPts = season.teams.map((t, i) => truth.table[idxOf(i)].pts);
  const rps = (p, o) => {
    const y = [o === 'H' ? 1 : 0, o === 'D' ? 1 : 0, o === 'A' ? 1 : 0];
    return 0.5 * ((p[0] - y[0]) ** 2 + (p[0] + p[1] - y[0] - y[1]) ** 2);
  };
  const avg = (a) => a.reduce((s, x) => s + x, 0) / a.length;
  const spearman = (pred) => {
    const rank = (arr) => {
      const order = arr.map((v, i) => [v, i]).sort((a, b) => b[0] - a[0]);
      const r = new Array(arr.length);
      order.forEach(([, i], k) => (r[i] = k + 1));
      return r;
    };
    const a = rank(pred);
    const b = rank(finalPts);
    const d2 = a.reduce((s, x, i) => s + (x - b[i]) ** 2, 0);
    return 1 - (6 * d2) / (n * (n * n - 1));
  };
  const topSet = (pts, k) => new Set(pts.map((v, i) => [v, i]).sort((a, b) => b[0] - a[0]).slice(0, k).map(([, i]) => i));
  const realTop4 = topSet(finalPts, 4);
  const realBottom3 = new Set(finalPts.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]).slice(0, 3).map(([, i]) => i));

  const lines = [];
  const add = (label, perGame, predPts, probs) => {
    const errs = predPts.map((p, i) => Math.abs(p - finalPts[i]));
    lines.push({ label, rps: perGame, mae: avg(errs), rho: spearman(predPts), probs });
  };
  for (const { k, agg } of results) {
    const R = agg.runs;
    const perGame = avg(season.remaining.map((f, j) => rps([agg.fxOut[j * 5] / R, agg.fxOut[j * 5 + 1] / R, agg.fxOut[j * 5 + 2] / R], outcomes[j].res)));
    const pred = season.teams.map((t) => agg.teams[t.key].pts / R);
    // Brier score over "finishes top 4" and "relegated" for every team.
    const brier = avg(season.teams.map((t, i) => ((agg.teams[t.key].top || 0) / R - (realTop4.has(i) ? 1 : 0)) ** 2
      + ((agg.teams[t.key].releg || 0) / R - (realBottom3.has(i) ? 1 : 0)) ** 2)) / 2;
    add(k ? `Engine, form adjustment k=${k}` : 'Engine (ratings only)', perGame, pred, brier);
  }
  // Bookmakers: real points so far + expected points from closing odds.
  const book = season.table.map((r) => r.pts);
  season.remaining.forEach((f) => {
    const b = f.book || [1 / 3, 1 / 3, 1 / 3];
    book[f.i] += 3 * b[0] + b[1];
    book[f.j] += 3 * b[2] + b[1];
  });
  add('Bookmakers (closing odds)', avg(season.remaining.map((f, j) => rps(f.book || [1 / 3, 1 / 3, 1 / 3], outcomes[j].res))), book, null);
  // Naive: keep collecting points at the current rate.
  const games = 2 * (n - 1);
  add('Current points per game × games', null, season.table.map((r) => (r.p ? (r.pts / r.p) * games : 0)), null);

  console.log(`\nRetro test: predictions made after ${season.played.length} games, scored against the real outcome of the other ${season.remaining.length}\n`);
  console.log('Model                               Per-game RPS ↓   Final pts error ↓   Table rank corr ↑   Top4/releg Brier ↓');
  for (const l of lines) {
    console.log(`${l.label.padEnd(36)}${l.rps === null ? '       -' : l.rps.toFixed(4).padStart(8)}          ${l.mae.toFixed(1).padStart(6)} pts            ${l.rho.toFixed(3)}             ${l.probs === null ? '-' : l.probs.toFixed(3)}`);
  }
}

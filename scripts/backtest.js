#!/usr/bin/env node
// Backtest the match engine against real results.
//
//   node scripts/backtest.js                      # E0.csv, 400 sims per fixture
//   node scripts/backtest.js --sims 1000 --results E0.csv --half 2
//
// For every fixture in a football-data.co.uk results file (E0.csv = Premier
// League) the engine plays the match many times to get home/draw/away
// probabilities, which are scored against what actually happened and against
// the bookmakers' closing odds. --half 1|2 limits it to the first or second
// half of the season (tune on one half, check on the other).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

const root = path.join(__dirname, '..');

// football-data.co.uk team names -> "club|league" keys in players.csv.
const NAME_MAP = {
  Arsenal: 'Arsenal|Premier League',
  'Aston Villa': 'Aston Villa|Premier League',
  Bournemouth: 'AFC Bournemouth|Premier League',
  Brentford: 'Brentford|Premier League',
  Brighton: 'Brighton|Premier League',
  Burnley: 'Burnley|EFL Championship',
  Chelsea: 'Chelsea|Premier League',
  'Crystal Palace': 'Crystal Palace|Premier League',
  Everton: 'Everton|Premier League',
  Fulham: 'Fulham|Premier League',
  Leeds: 'Leeds United|Premier League',
  Liverpool: 'Liverpool|Premier League',
  'Man City': 'Manchester City|Premier League',
  'Man United': 'Man Utd|Premier League',
  Newcastle: 'Newcastle Utd|Premier League',
  "Nott'm Forest": "Nott'm Forest|Premier League",
  Sunderland: 'Sunderland|Premier League',
  Tottenham: 'Spurs|Premier League',
  'West Ham': 'West Ham|EFL Championship',
  Wolves: 'Wolves|EFL Championship',
  Ipswich: 'Ipswich|Premier League',
  Coventry: 'Coventry City|Premier League',
  Hull: 'Hull City|Premier League',
  Leicester: 'Leicester City|EFL Championship',
  Southampton: 'Southampton|EFL Championship',
};

function loadEngine() {
  for (const f of ['util', 'csv', 'players', 'formations', 'commentary', 'engine']) require(path.join(root, 'js', `${f}.js`));
  const OF = globalThis.OF;
  const db = OF.players.buildDatabase(OF.parseCSV(fs.readFileSync(path.join(root, 'players.csv'), 'utf8')));
  const cache = new Map();
  const setup = (key) => {
    if (!cache.has(key)) {
      const team = db.teamsByKey.get(key);
      if (!team) throw new Error(`Team not found in players.csv: ${key}`);
      const f = OF.formations.bestFormation(team);
      const xi = OF.formations.pickStartingXI(team, f);
      cache.set(key, { team, formation: f, xi, bench: OF.formations.pickBench(team, xi) });
    }
    return cache.get(key);
  };
  return { OF, setup };
}

// ---- Worker: simulate a slice of fixtures --------------------------------------
if (!isMainThread) {
  const { OF, setup } = loadEngine();
  Object.assign(OF.Match.TUNING, workerData.tuning);
  const out = [];
  for (const fx of workerData.fixtures) {
    const home = setup(NAME_MAP[fx.home]);
    const away = setup(NAME_MAP[fx.away]);
    const c = { h: 0, d: 0, a: 0, hg: 0, ag: 0 };
    for (let s = 0; s < workerData.sims; s++) {
      const m = new OF.Match({ home, away, seed: OF.util.hashSeed(`${fx.idx}:${s}`), fast: true });
      m.runToEnd();
      const [x, y] = [m.sides[0].score, m.sides[1].score];
      c.hg += x;
      c.ag += y;
      if (x > y) c.h++;
      else if (x < y) c.a++;
      else c.d++;
    }
    out.push({ idx: fx.idx, ...c });
    parentPort.postMessage({ type: 'tick' });
  }
  parentPort.postMessage({ type: 'done', out });
  return;
}

// ---- Main -----------------------------------------------------------------------
const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const SIMS = parseInt(opt('sims', '400'), 10);
const RESULTS = path.resolve(root, opt('results', 'E0.csv'));
const HALF = opt('half', null);
const JSON_OUT = opt('json', null);
// --set duel=30,formSd=0.04 overrides engine tuning for this run.
const TUNING = Object.fromEntries((opt('set', '') || '').split(',').filter(Boolean).map((kv) => {
  const [k, v] = kv.split('=');
  return [k.trim(), Number(v)];
}));
const QUIET = args.includes('--summary');

for (const f of ['util', 'csv']) require(path.join(root, 'js', `${f}.js`));
const OF = globalThis.OF;

const rows = OF.parseCSV(fs.readFileSync(RESULTS, 'utf8')).filter((r) => r.HomeTeam && r.FTR);
let fixtures = rows.map((r, idx) => {
  // Closing odds, preferring the market average, then Pinnacle, then opening.
  const odds = [['AvgCH', 'AvgCD', 'AvgCA'], ['PSCH', 'PSCD', 'PSCA'], ['AvgH', 'AvgD', 'AvgA'], ['B365H', 'B365D', 'B365A']]
    .map((ks) => ks.map((k) => parseFloat(r[k])))
    .find((o) => o.every((x) => x > 1));
  let book = null;
  if (odds) {
    const inv = odds.map((o) => 1 / o);
    const s = inv[0] + inv[1] + inv[2];
    book = inv.map((x) => x / s); // strip the bookmaker margin
  }
  return {
    idx, date: r.Date, home: r.HomeTeam, away: r.AwayTeam,
    hg: parseInt(r.FTHG, 10), ag: parseInt(r.FTAG, 10), res: r.FTR, book,
  };
});
const missing = [...new Set(fixtures.flatMap((f) => [f.home, f.away]))].filter((t) => !NAME_MAP[t]);
if (missing.length) {
  console.error(`No players.csv mapping for: ${missing.join(', ')}. Add them to NAME_MAP.`);
  process.exit(1);
}
if (HALF) {
  const mid = Math.floor(fixtures.length / 2);
  fixtures = HALF === '1' ? fixtures.slice(0, mid) : fixtures.slice(mid);
}

const nWorkers = Math.max(1, Math.min(os.cpus().length, 8));
const slices = Array.from({ length: nWorkers }, () => []);
fixtures.forEach((f, i) => slices[i % nWorkers].push(f));
let ticks = 0;
const t0 = Date.now();
Promise.all(slices.map((slice) => new Promise((resolve, reject) => {
  const w = new Worker(__filename, { workerData: { fixtures: slice, sims: SIMS, tuning: TUNING } });
  w.on('message', (m) => {
    if (m.type === 'tick') {
      ticks++;
      if (process.stderr.isTTY) process.stderr.write(`\r${ticks}/${fixtures.length} fixtures`);
    } else resolve(m.out);
  });
  w.on('error', reject);
}))).then((parts) => {
  if (process.stderr.isTTY) process.stderr.write('\n');
  const sim = new Map(parts.flat().map((r) => [r.idx, r]));
  report(fixtures, sim, (Date.now() - t0) / 1000);
}).catch((e) => {
  console.error(e);
  process.exit(1);
});

function report(fixtures, sim, secs) {
  const N = fixtures.length;
  // Laplace-smoothed probabilities so an outcome the engine never produced
  // doesn't give an infinite log loss.
  const engineP = (f) => {
    const s = sim.get(f.idx);
    return [(s.h + 1) / (SIMS + 3), (s.d + 1) / (SIMS + 3), (s.a + 1) / (SIMS + 3)];
  };
  const outcome = (f) => (f.res === 'H' ? 0 : f.res === 'D' ? 1 : 2);
  const base = [0, 1, 2].map((k) => fixtures.filter((f) => outcome(f) === k).length / N);

  const models = {
    'Match engine': engineP,
    'Bookmakers (closing)': (f) => f.book,
    'Always the season average': () => base,
    'Coin flip (1/3 each)': () => [1 / 3, 1 / 3, 1 / 3],
  };

  const score = (pf) => {
    let rps = 0;
    let brier = 0;
    let ll = 0;
    let hit = 0;
    let n = 0;
    for (const f of fixtures) {
      const p = pf(f);
      if (!p) continue;
      const o = outcome(f);
      const y = [0, 1, 2].map((k) => (k === o ? 1 : 0));
      // Ranked probability score: respects that H-D-A are ordered.
      rps += 0.5 * ((p[0] - y[0]) ** 2 + (p[0] + p[1] - y[0] - y[1]) ** 2);
      brier += (p[0] - y[0]) ** 2 + (p[1] - y[1]) ** 2 + (p[2] - y[2]) ** 2;
      ll -= Math.log(Math.max(1e-6, p[o]));
      if (p.indexOf(Math.max(...p)) === o) hit++;
      n++;
    }
    return { n, rps: rps / n, brier: brier / n, logLoss: ll / n, accuracy: hit / n };
  };

  const pct = (x) => `${(x * 100).toFixed(1)}%`;
  if (QUIET) {
    // One line per run, for parameter sweeps.
    const s = score(engineP);
    const mix = [0, 1, 2].map((k) => fixtures.reduce((acc, f) => acc + engineP(f)[k], 0) / N);
    const goals = fixtures.reduce((acc, f) => acc + (sim.get(f.idx).hg + sim.get(f.idx).ag) / SIMS, 0) / N;
    console.log(`${JSON.stringify(TUNING).padEnd(60)} RPS ${s.rps.toFixed(4)}  LL ${s.logLoss.toFixed(4)}  acc ${pct(s.accuracy)}  H/D/A ${mix.map(pct).join('/')}  goals ${goals.toFixed(2)}`);
    return;
  }
  console.log(`\nBacktest: ${N} fixtures${HALF ? ` (half ${HALF})` : ''} × ${SIMS} simulations = ${(N * SIMS).toLocaleString()} matches in ${secs.toFixed(0)}s\n`);
  console.log('Model                          RPS ↓    Brier ↓  LogLoss ↓  Picks right');
  const scores = {};
  for (const [name, pf] of Object.entries(models)) {
    const s = (scores[name] = score(pf));
    console.log(`${name.padEnd(30)} ${s.rps.toFixed(4)}   ${s.brier.toFixed(4)}   ${s.logLoss.toFixed(4)}    ${pct(s.accuracy)}`);
  }

  // Is the engine-vs-bookies gap real or luck? Paired bootstrap over fixtures.
  const rpsOf = (p, f) => {
    const o = outcome(f);
    const y = [0, 1, 2].map((k) => (k === o ? 1 : 0));
    return 0.5 * ((p[0] - y[0]) ** 2 + (p[0] + p[1] - y[0] - y[1]) ** 2);
  };
  const paired = fixtures.filter((f) => f.book).map((f) => rpsOf(engineP(f), f) - rpsOf(f.book, f));
  if (paired.length) {
    const rng = OF.util.makeRng(1);
    const means = [];
    for (let b = 0; b < 4000; b++) {
      let sum = 0;
      for (let i = 0; i < paired.length; i++) sum += paired[Math.floor(rng() * paired.length)];
      means.push(sum / paired.length);
    }
    means.sort((x, y) => x - y);
    const diff = paired.reduce((a, b) => a + b, 0) / paired.length;
    const lo = means[Math.floor(0.025 * means.length)];
    const hi = means[Math.floor(0.975 * means.length)];
    const verdict = hi < 0 ? 'engine better' : lo > 0 ? 'bookies better' : 'not distinguishable at this sample size';
    console.log(`\nEngine minus bookies RPS: ${diff >= 0 ? '+' : ''}${diff.toFixed(4)}  (95% CI ${lo.toFixed(4)} to ${hi.toFixed(4)}: ${verdict})`);
  }

  // Outcome mix and goals.
  const avgP = [0, 1, 2].map((k) => fixtures.reduce((s, f) => s + engineP(f)[k], 0) / N);
  const simGoals = fixtures.reduce((s, f) => s + (sim.get(f.idx).hg + sim.get(f.idx).ag) / SIMS, 0) / N;
  const realGoals = fixtures.reduce((s, f) => s + f.hg + f.ag, 0) / N;
  console.log(`\nOutcome mix       engine H ${pct(avgP[0])} D ${pct(avgP[1])} A ${pct(avgP[2])}   real H ${pct(base[0])} D ${pct(base[1])} A ${pct(base[2])}`);
  console.log(`Goals per match   engine ${simGoals.toFixed(2)}   real ${realGoals.toFixed(2)}`);

  // Calibration: when the engine says X%, does it happen X% of the time?
  console.log('\nCalibration (all three outcomes pooled)');
  console.log('Engine says    Happened   Bookies say  Happened   (n engine / n bookies)');
  const bins = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 1.01];
  const calib = (pf) => bins.slice(0, -1).map((lo, b) => {
    let n = 0;
    let hit = 0;
    let sumP = 0;
    for (const f of fixtures) {
      const p = pf(f);
      if (!p) continue;
      for (let k = 0; k < 3; k++) {
        if (p[k] >= lo && p[k] < bins[b + 1]) {
          n++;
          sumP += p[k];
          if (outcome(f) === k) hit++;
        }
      }
    }
    return { lo, hi: bins[b + 1], n, meanP: n ? sumP / n : 0, freq: n ? hit / n : 0 };
  });
  const ce = calib(engineP);
  const cb = calib((f) => f.book);
  ce.forEach((c, i) => {
    const b = cb[i];
    const label = `${Math.round(c.lo * 100)}-${Math.min(100, Math.round(c.hi * 100))}%`.padEnd(9);
    console.log(`${label}${c.n ? pct(c.meanP).padStart(6) : '     -'} → ${c.n ? pct(c.freq).padStart(6) : '     -'}    ${b.n ? pct(b.meanP).padStart(6) : '     -'} → ${b.n ? pct(b.freq).padStart(6) : '     -'}   (${c.n} / ${b.n})`);
  });

  // Season table: expected points vs actual points.
  const teams = {};
  const t = (name) => (teams[name] = teams[name] || { name, pts: 0, gf: 0, ga: 0, xpts: 0, bxpts: 0, n: 0 });
  for (const f of fixtures) {
    const p = engineP(f);
    const b = f.book || [0, 0, 0];
    const h = t(f.home);
    const a = t(f.away);
    h.n++;
    a.n++;
    h.gf += f.hg; h.ga += f.ag; a.gf += f.ag; a.ga += f.hg;
    if (f.res === 'H') h.pts += 3;
    else if (f.res === 'A') a.pts += 3;
    else { h.pts++; a.pts++; }
    h.xpts += 3 * p[0] + p[1];
    a.xpts += 3 * p[2] + p[1];
    h.bxpts += 3 * b[0] + b[1];
    a.bxpts += 3 * b[2] + b[1];
  }
  const list = Object.values(teams).sort((x, y) => y.pts - x.pts || (y.gf - y.ga) - (x.gf - x.ga));
  const rank = (arr, key) => {
    const sorted = arr.slice().sort((x, y) => y[key] - x[key]);
    return new Map(sorted.map((r, i) => [r.name, i + 1]));
  };
  const rReal = rank(list, 'pts');
  const rEng = rank(list, 'xpts');
  const rBook = rank(list, 'bxpts');
  const spearman = (ra, rb) => {
    const n = list.length;
    const d2 = list.reduce((s, r) => s + (ra.get(r.name) - rb.get(r.name)) ** 2, 0);
    return 1 - (6 * d2) / (n * (n * n - 1));
  };
  const mae = (key) => list.reduce((s, r) => s + Math.abs(r[key] - r.pts), 0) / list.length;
  console.log('\nTeam            Real pts   Engine xPts (rank)   Bookies xPts (rank)');
  for (const r of list) {
    console.log(`${r.name.padEnd(15)} ${String(r.pts).padStart(5)}     ${r.xpts.toFixed(1).padStart(6)} (${String(rEng.get(r.name)).padStart(2)})        ${r.bxpts.toFixed(1).padStart(6)} (${String(rBook.get(r.name)).padStart(2)})`);
  }
  console.log(`\nRank correlation with the real table (Spearman): engine ${spearman(rReal, rEng).toFixed(3)}, bookies ${spearman(rReal, rBook).toFixed(3)}`);
  console.log(`Average points error per team:                  engine ${mae('xpts').toFixed(1)}, bookies ${mae('bxpts').toFixed(1)}`);

  if (JSON_OUT) {
    fs.writeFileSync(JSON_OUT, JSON.stringify({
      sims: SIMS, half: HALF, scores, outcomeMix: { engine: avgP, real: base }, goals: { engine: simGoals, real: realGoals },
      calibration: { engine: ce, bookies: cb },
      table: list.map((r) => ({ ...r, rankEngine: rEng.get(r.name), rankBook: rBook.get(r.name) })),
      fixtures: fixtures.map((f) => ({ ...f, engine: engineP(f) })),
    }, null, 1));
  }
}

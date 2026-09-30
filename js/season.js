// Season state from real data: results so far (+ optional fixture list) ->
// teams, real table, played games and the fixtures still to come.
(function (root) {
  const OF = (root.OF = root.OF || {});

  function parseDate(s) {
    const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec((s || '').trim());
    if (!m) return null;
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return new Date(Date.UTC(y, Number(m[2]) - 1, Number(m[1])));
  }

  // Closing odds (market average, then Pinnacle, then opening) -> margin-free probabilities.
  function bookProbs(r) {
    const sets = [['AvgCH', 'AvgCD', 'AvgCA'], ['PSCH', 'PSCD', 'PSCA'], ['AvgH', 'AvgD', 'AvgA'], ['B365H', 'B365D', 'B365A'], ['PSH', 'PSD', 'PSA']];
    for (const ks of sets) {
      const o = ks.map((k) => parseFloat(r[k]));
      if (o.every((x) => x > 1)) {
        const inv = o.map((x) => 1 / x);
        const s = inv[0] + inv[1] + inv[2];
        return inv.map((x) => x / s);
      }
    }
    return null;
  }

  const isPlayed = (r) => r.FTHG !== undefined && r.FTHG !== '' && r.FTAG !== '' && !isNaN(parseInt(r.FTHG, 10));

  // resultRows / fixtureRows: parsed CSV rows. Returns { teams, played,
  // remaining, table, unknown } with team indices into `teams` (db teams).
  function buildSeason(db, resultRows, fixtureRows, league = 'Premier League') {
    // football-data's fixtures.csv covers every league: keep only the
    // division(s) that appear in the results file.
    const divs = new Set(resultRows.map((r) => r.Div).filter(Boolean));
    if (fixtureRows && divs.size) fixtureRows = fixtureRows.filter((r) => !r.Div || divs.has(r.Div));
    const names = [];
    const seen = new Set();
    for (const r of resultRows.concat(fixtureRows || [])) {
      for (const nm of [r.HomeTeam, r.AwayTeam]) {
        if (nm && !seen.has(nm)) {
          seen.add(nm);
          names.push(nm);
        }
      }
    }
    const unknown = [];
    const teams = [];
    const index = new Map();
    for (const nm of names) {
      const t = OF.resolveTeam(db, nm, league);
      if (!t) {
        unknown.push(nm);
        continue;
      }
      if (!teams.includes(t)) teams.push(t);
      index.set(nm, teams.indexOf(t));
    }
    const played = [];
    const playedPairs = new Set();
    for (const r of resultRows) {
      if (!isPlayed(r) || !index.has(r.HomeTeam) || !index.has(r.AwayTeam)) continue;
      const i = index.get(r.HomeTeam);
      const j = index.get(r.AwayTeam);
      const hg = parseInt(r.FTHG, 10);
      const ag = parseInt(r.FTAG, 10);
      const num = (k) => (r[k] === undefined || r[k] === '' ? NaN : Number(r[k]));
      played.push({
        i, j, hg, ag, res: hg > ag ? 'H' : hg < ag ? 'A' : 'D', date: parseDate(r.Date), book: bookProbs(r),
        hs: num('HS'), as: num('AS'), hst: num('HST'), ast: num('AST'),
      });
      playedPairs.add(`${i}-${j}`);
    }
    // Remaining fixtures: from the fixture list if given (skipping anything
    // already played), otherwise every home/away pairing not yet played.
    let remaining = [];
    if (fixtureRows && fixtureRows.length) {
      for (const r of fixtureRows) {
        if (!index.has(r.HomeTeam) || !index.has(r.AwayTeam)) continue;
        const i = index.get(r.HomeTeam);
        const j = index.get(r.AwayTeam);
        if (playedPairs.has(`${i}-${j}`)) continue;
        playedPairs.add(`${i}-${j}`);
        remaining.push({ i, j, date: parseDate(r.Date), time: r.Time || '', book: bookProbs(r) });
      }
      remaining.sort((a, b) => (a.date || 0) - (b.date || 0));
    } else {
      for (let i = 0; i < teams.length; i++) {
        for (let j = 0; j < teams.length; j++) {
          if (i !== j && !playedPairs.has(`${i}-${j}`)) remaining.push({ i, j, date: null, time: '', book: null });
        }
      }
    }
    return { teams, played, remaining, table: tableFrom(teams.length, played), unknown };
  }

  function tableFrom(n, played) {
    const t = Array.from({ length: n }, () => ({ pts: 0, gf: 0, ga: 0, w: 0, d: 0, l: 0, p: 0 }));
    for (const g of played) {
      const h = t[g.i];
      const a = t[g.j];
      h.p++; a.p++;
      h.gf += g.hg; h.ga += g.ag; a.gf += g.ag; a.ga += g.hg;
      if (g.res === 'H') { h.pts += 3; h.w++; a.l++; }
      else if (g.res === 'A') { a.pts += 3; a.w++; h.l++; }
      else { h.pts++; a.pts++; h.d++; a.d++; }
    }
    return t;
  }

  // Form signals, per game from one team's point of view: what really
  // happened, and what the engine expected (from fxOut tallies of the same
  // fixture, see OF.sim.FX). Shot-based signals are much less noisy than points.
  const METRICS = {
    points: {
      label: 'pts',
      real: (g, home) => (g.res === (home ? 'H' : 'A') ? 3 : g.res === 'D' ? 1 : 0),
      exp: (o, home) => (home ? 3 * o[0] + o[1] : 3 * o[2] + o[1]),
    },
    goals: {
      label: 'goal diff',
      real: (g, home) => (home ? g.hg - g.ag : g.ag - g.hg),
      exp: (o, home) => (home ? o[3] - o[4] : o[4] - o[3]),
    },
    shots: {
      label: 'shot diff',
      real: (g, home) => (home ? g.hs - g.as : g.as - g.hs),
      exp: (o, home) => (home ? o[5] - o[6] : o[6] - o[5]),
    },
    sot: {
      label: 'on-target diff',
      real: (g, home) => (home ? g.hst - g.ast : g.ast - g.hst),
      exp: (o, home) => (home ? o[7] - o[8] : o[8] - o[7]),
    },
  };

  // How far each signal moves per game when a team's strength multiplier
  // rises by 1.0 (i.e. 100%), measured with
  // `node scripts/rest-of-season.js --results E0.csv --sensitivity`.
  const SENS = { points: 9.7, goals: 14.6, shots: 78.4, sot: 52.9 };

  // Per-team ability multipliers from over/under-performance so far.
  // fxOut holds tallies from simulating the already-played games `runs`
  // times. A team's surplus per game (real minus expected, centred on the
  // league) is shrunk by `prior` phantom games, converted to a strength
  // change via SENS, and scaled by `weight` (0 = ignore form).
  function strengthsFromResults(n, played, fxOut, runs, { metric = 'points', weight = 1, prior = 10 } = {}) {
    if (metric === 'shotmix') {
      // Average of the shots and shots-on-target adjustments.
      const a = strengthsFromResults(n, played, fxOut, runs, { metric: 'shots', weight, prior });
      const b = strengthsFromResults(n, played, fxOut, runs, { metric: 'sot', weight, prior });
      return a.map((x, t) => ({
        strength: (x.strength + b[t].strength) / 2, real: b[t].real, expected: b[t].expected,
        games: b[t].games, metric, label: 'on-target diff', shots: x,
      }));
    }
    const M = METRICS[metric];
    const X = OF.sim.FX;
    const real = new Array(n).fill(0);
    const exp = new Array(n).fill(0);
    const games = new Array(n).fill(0);
    played.forEach((g, idx) => {
      const o = fxOut.slice(idx * X, idx * X + X).map((c) => c / runs);
      for (const [t, home] of [[g.i, true], [g.j, false]]) {
        const r = M.real(g, home);
        if (!Number.isFinite(r)) continue; // file has no shots columns for this game
        real[t] += r;
        exp[t] += M.exp(o, home);
        games[t]++;
      }
    });
    const surplus = real.map((r, t) => (r - exp[t]) / (games[t] + prior));
    const withGames = surplus.filter((x, t) => games[t]);
    const mean = withGames.length ? withGames.reduce((a, b) => a + b, 0) / withGames.length : 0;
    return real.map((r, t) => ({
      strength: games[t] ? 1 + (weight * (surplus[t] - mean)) / SENS[metric] : 1,
      real: r, expected: exp[t], games: games[t], metric, label: M.label,
    }));
  }

  OF.season = { buildSeason, tableFrom, strengthsFromResults, parseDate, bookProbs, METRICS, SENS };
})(typeof globalThis !== 'undefined' ? globalThis : this);

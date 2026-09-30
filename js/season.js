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
      played.push({ i, j, hg, ag, res: hg > ag ? 'H' : hg < ag ? 'A' : 'D', date: parseDate(r.Date), book: bookProbs(r) });
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

  // Per-team ability multipliers from over/under-performance so far.
  // fxOut: per played game [h, d, a, hg, ag] counts from simulating those
  // same games `runs` times. Each team's points above expectation per game
  // is shrunk towards zero by `prior` phantom games, then scaled by k.
  function strengthsFromResults(n, played, fxOut, runs, k, prior = 10) {
    const real = new Array(n).fill(0);
    const exp = new Array(n).fill(0);
    const games = new Array(n).fill(0);
    played.forEach((g, idx) => {
      const [h, d, a] = [fxOut[idx * 5], fxOut[idx * 5 + 1], fxOut[idx * 5 + 2]].map((c) => c / runs);
      exp[g.i] += 3 * h + d;
      exp[g.j] += 3 * a + d;
      real[g.i] += g.res === 'H' ? 3 : g.res === 'D' ? 1 : 0;
      real[g.j] += g.res === 'A' ? 3 : g.res === 'D' ? 1 : 0;
      games[g.i]++;
      games[g.j]++;
    });
    return real.map((r, t) => ({
      strength: 1 + (k * (r - exp[t])) / (games[t] + prior),
      real: r, expected: exp[t], games: games[t],
    }));
  }

  OF.season = { buildSeason, tableFrom, strengthsFromResults, parseDate, bookProbs };
})(typeof globalThis !== 'undefined' ? globalThis : this);

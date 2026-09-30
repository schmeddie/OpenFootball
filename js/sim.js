// "Supercomputer" mode: run a head-to-head, a league season or a knockout cup
// thousands of times and collate the results.
//
// Every run is independent and seeded from (job seed, run index), so the same
// job gives identical results no matter how the runs are split across workers.
// Aggregates are plain nested objects of counters; mergeAgg() sums two of them,
// which is how worker results are combined on the main thread.
(function (root) {
  const OF = (root.OF = root.OF || {});
  const { makeRng, hashSeed } = OF.util;

  // ---- Aggregates ---------------------------------------------------------------
  function createAgg() {
    return { runs: 0, matches: 0 };
  }

  // Descriptive fields that must be copied, not summed, when merging.
  const META = new Set(['name', 'fullName', 'team', 'teamKey', 'pos', 'ovr', 'league', 'rating', 'names', 'sampleJson']);

  // Counters add, arrays add element-wise, objects merge recursively, and
  // descriptive fields (META, strings) are copied if missing.
  function mergeAgg(a, b) {
    for (const k in b) {
      const v = b[k];
      if (META.has(k)) {
        if (a[k] === undefined) a[k] = v;
      } else if (typeof v === 'number') a[k] = (a[k] || 0) + v;
      else if (Array.isArray(v)) {
        const t = a[k] || (a[k] = []);
        for (let i = 0; i < v.length; i++) t[i] = (t[i] || 0) + (v[i] || 0);
      } else if (v && typeof v === 'object') mergeAgg(a[k] || (a[k] = {}), v);
      else if (a[k] === undefined) a[k] = v;
    }
    return a;
  }

  const inc = (obj, key, by = 1) => (obj[key] = (obj[key] || 0) + by);

  function playMatch(job, home, away, seed, opts = {}) {
    const m = new OF.Match({
      home, away, seed,
      fast: true,
      homeAdvantage: opts.homeAdvantage !== undefined ? opts.homeAdvantage : job.options.homeAdvantage !== false,
      knockout: !!opts.knockout,
    });
    m.runToEnd();
    return m;
  }

  // Per-player totals across all runs (keyed by player id).
  function addPlayers(agg, m) {
    const players = agg.players || (agg.players = {});
    const reports = m.playerReport();
    reports.forEach((list, side) => {
      for (const r of list) {
        const e = players[r.player.id] || (players[r.player.id] = {
          name: r.name, fullName: r.player.fullName, team: m.sides[side].name, teamKey: m.sides[side].team.key,
          pos: r.player.pos, ovr: r.player.ovr,
        });
        inc(e, 'apps');
        inc(e, 'mins', r.minutes);
        inc(e, 'goals', r.st.goals);
        inc(e, 'assists', r.st.assists);
        inc(e, 'ratingSum', r.rating);
        if (r.st.goals) inc(e, 'scoredIn');
      }
    });
    return reports;
  }

  // Record who finished top of the scoring charts in one run (ties share it).
  function awardTopScorer(agg, goalsById) {
    let best = 0;
    for (const id in goalsById) best = Math.max(best, goalsById[id]);
    if (!best) return;
    const winners = Object.keys(goalsById).filter((id) => goalsById[id] === best);
    for (const id of winners) inc(agg.players[id], 'topScorer', 1 / winners.length);
  }

  // ---- Head-to-head ---------------------------------------------------------------
  function runH2H(job, runIndex, agg, rng) {
    const [home, away] = job.teams;
    const knockout = !!job.options.knockout;
    const m = playMatch(job, home, away, rng.int(0, 2 ** 31), { knockout });
    const [h, a] = m.sides;
    agg.matches++;
    const r = agg.res || (agg.res = [0, 0, 0]);
    if (h.score > a.score) r[0]++;
    else if (h.score === a.score) r[1]++;
    else r[2]++;
    if (knockout) {
      const adv = agg.advance || (agg.advance = [0, 0]);
      adv[m.winner()]++;
      if (m.half > 2) inc(agg, 'extraTime');
      if (m.shootout) inc(agg, 'shootouts');
    }
    const add = (k, x, y) => {
      const t = agg[k] || (agg[k] = [0, 0]);
      t[0] += x;
      t[1] += y;
    };
    add('goals', h.score, a.score);
    add('xg', h.stats.xg, a.stats.xg);
    add('shots', h.stats.shots, a.stats.shots);
    add('sot', h.stats.sot, a.stats.sot);
    add('poss', h.stats.possessionPct, a.stats.possessionPct);
    add('cleanSheets', a.score === 0 ? 1 : 0, h.score === 0 ? 1 : 0);
    add('cards', h.stats.yellows + h.stats.reds * 2, a.stats.yellows + a.stats.reds * 2);
    if (h.score && a.score) inc(agg, 'btts');
    if (h.score + a.score > 2) inc(agg, 'over25');
    const scores = agg.scores || (agg.scores = {});
    inc(scores, `${h.score}-${a.score}`);
    addPlayers(agg, m);
    const motm = m.manOfTheMatch();
    inc(agg.players[motm.player.id], 'motm');
  }

  // ---- League -----------------------------------------------------------------------
  function runLeague(job, runIndex, agg, rng) {
    const teams = job.teams;
    const n = teams.length;
    const double = job.options.format !== 'single';
    const table = teams.map((t, i) => ({ i, pts: 0, gf: 0, ga: 0, w: 0, d: 0, l: 0 }));
    const seasonGoals = {};
    const fixtures = [];
    for (let x = 0; x < n; x++) {
      for (let y = x + 1; y < n; y++) {
        if (double) fixtures.push([x, y], [y, x]);
        else fixtures.push((x + y) % 2 ? [x, y] : [y, x]); // meet once, alternate home side
      }
    }
    for (const [i, j] of fixtures) {
      {
        const m = playMatch(job, teams[i], teams[j], rng.int(0, 2 ** 31));
        agg.matches++;
        const [h, a] = m.sides;
        const th = table[i];
        const ta = table[j];
        th.gf += h.score; th.ga += a.score;
        ta.gf += a.score; ta.ga += h.score;
        if (h.score > a.score) { th.pts += 3; th.w++; ta.l++; }
        else if (h.score < a.score) { ta.pts += 3; ta.w++; th.l++; }
        else { th.pts++; ta.pts++; th.d++; ta.d++; }
        const reports = addPlayers(agg, m);
        for (const list of reports) for (const r of list) if (r.st.goals) inc(seasonGoals, r.player.id, r.st.goals);
      }
    }
    // Rank: points, goal difference, goals scored, then a coin toss.
    for (const t of table) t.tie = rng();
    table.sort((x, y) => y.pts - x.pts || (y.gf - y.ga) - (x.gf - x.ga) || y.gf - x.gf || x.tie - y.tie);
    const top = job.options.topPlaces || 0;
    const rel = job.options.relegation || 0;
    const tagg = agg.teams || (agg.teams = {});
    table.forEach((row, pos) => {
      const t = teams[row.i].team;
      const e = tagg[t.key] || (tagg[t.key] = { name: t.name, league: t.league, rating: t.rating, finish: new Array(n).fill(0) });
      e.finish[pos]++;
      inc(e, 'pts', row.pts);
      inc(e, 'gf', row.gf);
      inc(e, 'ga', row.ga);
      inc(e, 'w', row.w);
      inc(e, 'd', row.d);
      inc(e, 'l', row.l);
      if (pos === 0) inc(e, 'title');
      if (pos < top) inc(e, 'top');
      if (pos >= n - rel) inc(e, 'releg');
    });
    // Points needed: what the champion and the first team outside the top places got.
    inc(agg, 'championPts', table[0].pts);
    if (rel && n - rel - 1 >= 0) inc(agg, 'safetyPts', table[n - rel - 1].pts);
    awardTopScorer(agg, seasonGoals);
    if (runIndex === 0) {
      agg.sampleJson = JSON.stringify(table.map((r) => ({ name: teams[r.i].team.name, pts: r.pts, w: r.w, d: r.d, l: r.l, gf: r.gf, ga: r.ga })));
    }
  }

  // ---- Knockout cup ---------------------------------------------------------------
  // Standard bracket so seeds 1 and 2 can only meet in the final.
  function bracketOrder(size) {
    let order = [1];
    while (order.length < size) {
      const n = order.length * 2 + 1;
      order = order.flatMap((s) => [s, n - s]);
    }
    return order;
  }

  function cupRounds(nTeams) {
    let size = 1;
    while (size < nTeams) size *= 2;
    const names = [];
    for (let left = size; left >= 2; left /= 2) {
      names.push(left === 2 ? 'Final' : left === 4 ? 'Semi-final' : left === 8 ? 'Quarter-final' : `Round of ${left}`);
    }
    names.push('Winner');
    return { size, names };
  }

  function runCup(job, runIndex, agg, rng) {
    const { size, names } = cupRounds(job.teams.length);
    // Seed order: by rating, or shuffled every run for a random draw.
    let seeded = job.teams.slice().sort((x, y) => y.team.rating - x.team.rating);
    if (job.options.draw !== 'seeded') {
      for (let i = seeded.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [seeded[i], seeded[j]] = [seeded[j], seeded[i]];
      }
    }
    // Seeds beyond the number of entrants are byes.
    let slots = bracketOrder(size).map((s) => seeded[s - 1] || null);
    const tagg = agg.teams || (agg.teams = {});
    const reach = (cfg, round) => {
      const t = cfg.team;
      const e = tagg[t.key] || (tagg[t.key] = { name: t.name, league: t.league, rating: t.rating, reach: new Array(names.length).fill(0) });
      e.reach[round]++;
    };
    const goals = {};
    let round = 0;
    for (const c of slots) if (c) reach(c, 0);
    while (slots.length > 1) {
      const next = [];
      for (let k = 0; k < slots.length; k += 2) {
        const a = slots[k];
        const b = slots[k + 1];
        if (!a || !b) {
          next.push(a || b);
          continue;
        }
        const m = playMatch(job, a, b, rng.int(0, 2 ** 31), { knockout: true, homeAdvantage: false });
        agg.matches++;
        const reports = addPlayers(agg, m);
        for (const list of reports) for (const r of list) if (r.st.goals) inc(goals, r.player.id, r.st.goals);
        next.push(m.winner() === 0 ? a : b);
        if (slots.length === 2) {
          const key = [a.team.key, b.team.key].sort().join('||');
          const f = (agg.finals || (agg.finals = {}))[key] || (agg.finals[key] = { names: [a.team.name, b.team.name].sort().join(' vs ') });
          inc(f, 'n');
        }
      }
      slots = next;
      round++;
      for (const c of slots) if (c) reach(c, round);
    }
    awardTopScorer(agg, goals);
  }

  const RUNNERS = { h2h: runH2H, league: runLeague, cup: runCup };

  function simulateRun(job, runIndex, agg) {
    const rng = makeRng(hashSeed(`${job.seed}:${runIndex}`));
    RUNNERS[job.mode](job, runIndex, agg, rng);
    agg.runs++;
  }

  // Matches played per run (for progress / time estimates).
  function matchesPerRun(job) {
    const n = job.teams.length;
    if (job.mode === 'h2h') return 1;
    if (job.mode === 'league') return job.options.format === 'single' ? (n * (n - 1)) / 2 : n * (n - 1);
    return Math.max(1, n - 1);
  }

  OF.sim = { createAgg, mergeAgg, simulateRun, matchesPerRun, cupRounds };
})(typeof globalThis !== 'undefined' ? globalThis : this);

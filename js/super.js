// Supercomputer mode UI: build a job, farm runs out to Web Workers (or the
// main thread as a fallback), merge the aggregates and render them live.
(function () {
  const OF = window.OF;
  const F = OF.formations;
  const $ = (sel, el = document) => el.querySelector(sel);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtInt = (n) => Math.round(n).toLocaleString();
  const MS_PER_MATCH = 1.9; // rough single-core cost, refined from the last run
  // Form adjustment for rest-of-season mode (see js/season.js). Retro-tested
  // on 2025-26: form measured from shots and shots on target improved
  // predictions from matchday 5, 10 and halfway; form from points made them
  // worse every time. So shots are the default and points are offered only
  // for comparison.
  const FORM_OPTIONS = {
    shotmix: { metric: 'shotmix', weight: 1, label: 'Shots & shots on target (recommended)' },
    points: { metric: 'points', weight: 1, label: 'Points (not recommended)' },
    off: null,
  };
  const FORM_RUNS = 200;
  const FIXTURE_PAGE = 40;

  const sc = {
    db: null,
    mode: 'h2h',
    lists: { league: [], cup: [] }, // chosen teams per mode
    builder: { league: '', gender: "Men's Football" },
    options: {
      h2h: { homeAdvantage: true, knockout: false },
      league: { format: 'double', topPlaces: 4, relegation: 3, homeAdvantage: true },
      cup: { draw: 'random' },
      rest: { topPlaces: 4, relegation: 3, homeAdvantage: true, form: 'shotmix' },
    },
    // Rest-of-season inputs (CSV text is remembered in this browser).
    rest: { results: null, fixtures: null, state: null, team: '', showAll: false },
    lastRun: null,
    autoCfg: new Map(),
    run: null, // active run state
    msPerMatch: MS_PER_MATCH,
  };

  const cores = () => Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1));

  document.addEventListener('of:db', (e) => {
    sc.db = e.detail;
    const pl = sc.db.teams.filter((t) => t.league === 'Premier League');
    sc.lists.league = pl.length ? pl : sc.db.teams.filter((t) => t.league === sc.db.teams[0].league);
    sc.lists.cup = sc.db.teams.filter((t) => t.gender === "Men's Football").slice(0, 16);
    for (const kind of ['results', 'fixtures']) {
      try {
        const saved = JSON.parse(localStorage.getItem(`of-rest-${kind}`) || 'null');
        if (saved) sc.rest[kind] = saved;
      } catch (err) { /* storage unavailable */ }
    }
    rebuildSeason();
    bind();
    renderConfig();
  });

  // ---- Rest-of-season data ------------------------------------------------------
  function rebuildSeason() {
    const r = sc.rest;
    r.state = null;
    r.error = '';
    if (!r.results) return;
    try {
      const results = OF.parseCSV(r.results.text).filter((x) => x.HomeTeam);
      const fixtures = r.fixtures ? OF.parseCSV(r.fixtures.text).filter((x) => x.HomeTeam) : null;
      const st = OF.season.buildSeason(sc.db, results, fixtures);
      if (!st.played.length) r.error = 'No played matches found. Is this a football-data.co.uk style CSV with FTHG/FTAG columns?';
      else r.state = st;
    } catch (err) {
      r.error = `Couldn't read that file: ${err.message}`;
    }
  }

  async function loadRestFile(kind, file) {
    const text = await file.text();
    sc.rest[kind] = { name: file.name, text };
    try {
      localStorage.setItem(`of-rest-${kind}`, JSON.stringify(sc.rest[kind]));
    } catch (err) { /* too big or storage blocked: fine, it just won't be remembered */ }
    rebuildSeason();
    renderConfig();
  }
  document.addEventListener('of:super-shown', () => renderConfig());

  // ---- Team configs ------------------------------------------------------------
  // Teams set up on the Match tab keep their custom formation/XI; everyone
  // else gets the auto-picked best formation, XI and bench.
  function teamConfig(team) {
    const custom = OF.app.sides().find((s) => s && s.team.key === team.key);
    if (custom) return packCfg(team, custom.formation, custom.xi, custom.subs.slice(0, 7));
    let cfg = sc.autoCfg.get(team.key);
    if (!cfg) {
      const f = F.bestFormation(team);
      const xi = F.pickStartingXI(team, f);
      cfg = packCfg(team, f, xi, F.pickBench(team, xi));
      sc.autoCfg.set(team.key, cfg);
    }
    return cfg;
  }

  // Strip the full squad from the team so the job is cheap to post to workers.
  function packCfg(team, formation, xi, bench) {
    return {
      team: { key: team.key, name: team.name, league: team.league, gender: team.gender, rating: team.rating },
      formation, xi, bench,
    };
  }

  // ---- Config UI -------------------------------------------------------------------
  function bind() {
    $('#sc-mode').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b || sc.run) return;
      sc.mode = b.dataset.mode;
      document.querySelectorAll('#sc-mode button').forEach((x) => x.classList.toggle('active', x === b));
      $('#sc-results').innerHTML = '';
      $('#sc-progress').classList.add('hidden');
      renderConfig();
    });
    $('#sc-run-presets').addEventListener('click', (e) => {
      const b = e.target.closest('[data-runs]');
      if (!b) return;
      $('#sc-runs').value = b.dataset.runs;
      updateEstimate();
    });
    $('#sc-runs').addEventListener('input', updateEstimate);
    $('#sc-go').addEventListener('click', startRun);
    $('#sc-cancel').addEventListener('click', () => stopRun(true));

    const teamsCard = $('#sc-teams');
    teamsCard.addEventListener('change', (e) => {
      const act = e.target.dataset.act;
      if ((act === 'rest-results' || act === 'rest-fixtures') && e.target.files[0]) {
        loadRestFile(act === 'rest-results' ? 'results' : 'fixtures', e.target.files[0]);
        return;
      }
      if (act === 'b-league') sc.builder.league = e.target.value;
      else if (act === 'b-gender') sc.builder.gender = e.target.value;
      else return;
      renderConfig();
    });
    teamsCard.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b || sc.run) return;
      const list = sc.lists[sc.mode];
      const act = b.dataset.act;
      if (act === 'add') {
        const t = sc.db.teamsByKey.get($('[data-act="b-team"]', teamsCard).value);
        if (t && !list.includes(t)) list.push(t);
      } else if (act === 'add-league') {
        for (const t of builderTeams()) if (!list.includes(t)) list.push(t);
      } else if (act === 'top') {
        const n = Math.max(2, Math.min(256, parseInt($('[data-act="top-n"]', teamsCard).value, 10) || 16));
        sc.lists[sc.mode] = builderTeams().slice(0, n);
      } else if (act === 'clear') {
        sc.lists[sc.mode] = [];
      } else if (act === 'remove') {
        sc.lists[sc.mode] = list.filter((t) => t.key !== b.dataset.key);
      } else if (act === 'rest-clear') {
        const kind = b.dataset.kind;
        sc.rest[kind] = null;
        try {
          localStorage.removeItem(`of-rest-${kind}`);
        } catch (err) { /* ignore */ }
        rebuildSeason();
      } else if (act === 'swap') {
        OF.app.swapSides();
      } else if (act === 'edit') {
        OF.app.showView('match');
        return;
      } else {
        return;
      }
      renderConfig();
    });
    // Fixture list controls in rest-of-season results.
    $('#sc-results').addEventListener('change', (e) => {
      if (e.target.dataset.act !== 'fx-team') return;
      sc.rest.team = e.target.value;
      if (sc.lastRun) renderResults(sc.lastRun, !sc.run);
    });
    $('#sc-results').addEventListener('click', (e) => {
      const b = e.target.closest('[data-act="fx-all"]');
      if (!b) return;
      sc.rest.showAll = !sc.rest.showAll;
      if (sc.lastRun) renderResults(sc.lastRun, !sc.run);
    });
    $('#sc-options').addEventListener('change', (e) => {
      const k = e.target.dataset.opt;
      if (!k) return;
      const o = sc.options[sc.mode];
      o[k] = e.target.type === 'checkbox' ? e.target.checked : e.target.type === 'number' ? Number(e.target.value) : e.target.value;
      updateEstimate();
    });
  }

  function builderTeams() {
    return sc.db.teams.filter((t) =>
      (!sc.builder.league || t.league === sc.builder.league) && (!sc.builder.gender || t.gender === sc.builder.gender));
  }

  function renderConfig() {
    if (!sc.db) return;
    const card = $('#sc-teams');
    if (sc.mode === 'h2h') {
      const [h, a] = OF.app.sides();
      const side = (s, label) => `
        <div class="h2h-team">
          <span class="side-tag side-${label === 'Home' ? 0 : 1}">${label}</span>
          <strong>${esc(s.team.name)}</strong>
          <span class="muted">${esc(s.team.league)} · ${esc(s.formation)} · XI rated ${F.unitRatings(s.xi).overall}</span>
        </div>`;
      card.innerHTML = `
        <h2>Fixture</h2>
        <div class="h2h-pair">${side(h, 'Home')}<button class="btn small ghost" data-act="swap" title="Swap home and away">⇄</button>${side(a, 'Away')}</div>
        <p class="muted small-text">This uses the teams, formations and lineups from the Match tab, including any swaps you made.</p>
        <button class="btn small" data-act="edit">Change teams on the Match tab</button>`;
    } else if (sc.mode === 'rest') {
      card.innerHTML = renderRestConfig();
    } else {
      const list = sc.lists[sc.mode];
      const bTeams = builderTeams();
      card.innerHTML = `
        <div class="card-head"><h2>${sc.mode === 'league' ? 'League teams' : 'Cup entrants'} <span class="muted">(${list.length})</span></h2>
          <button class="btn small ghost" data-act="clear">Clear</button></div>
        <div class="builder">
          <select data-act="b-gender" aria-label="Filter by men's or women's football">
            <option value="">All</option>
            <option ${sc.builder.gender === "Men's Football" ? 'selected' : ''} value="Men's Football">Men's</option>
            <option ${sc.builder.gender === "Women's Football" ? 'selected' : ''} value="Women's Football">Women's</option>
          </select>
          <select data-act="b-league" aria-label="League">
            <option value="">All leagues</option>
            ${sc.db.leagues.map((l) => `<option ${l === sc.builder.league ? 'selected' : ''}>${esc(l)}</option>`).join('')}
          </select>
          <select data-act="b-team" aria-label="Team">
            ${bTeams.map((t) => `<option value="${esc(t.key)}">${esc(t.name)} · ${t.rating}${sc.builder.league ? '' : ` (${esc(t.league)})`}</option>`).join('')}
          </select>
          <button class="btn small" data-act="add">Add team</button>
        </div>
        <div class="builder">
          <button class="btn small" data-act="add-league" ${sc.builder.league ? '' : 'disabled'}>Add whole league</button>
          <span class="muted">or replace with the top</span>
          <input data-act="top-n" type="number" min="2" max="256" value="${sc.mode === 'cup' ? 16 : 20}" aria-label="Number of teams">
          <button class="btn small" data-act="top">by rating</button>
        </div>
        <div class="team-chips">${list
          .slice()
          .sort((x, y) => y.rating - x.rating)
          .map((t) => `<span class="team-chip" title="${esc(t.league)}">${esc(t.name)} <b>${t.rating}</b>
            <button data-act="remove" data-key="${esc(t.key)}" aria-label="Remove ${esc(t.name)}">×</button></span>`)
          .join('') || '<span class="muted">No teams yet. Add a whole league or pick teams above.</span>'}</div>`;
    }
    renderOptions();
    updateEstimate();
    setLocked(!!sc.run);
  }

  // Freeze the setup while a run is in progress.
  function setLocked(locked) {
    document.querySelectorAll('#sc-mode button, #sc-teams button, #sc-teams select, #sc-teams input, #sc-options select, #sc-options input, #sc-runs, #sc-seed, #sc-run-presets button')
      .forEach((el) => (el.disabled = locked));
  }

  function renderOptions() {
    const o = sc.options[sc.mode];
    let html = '';
    if (sc.mode === 'h2h') {
      html = `
        <label class="check"><input type="checkbox" data-opt="homeAdvantage" ${o.homeAdvantage ? 'checked' : ''}> Home advantage</label>
        <label class="check"><input type="checkbox" data-opt="knockout" ${o.knockout ? 'checked' : ''}> Knockout tie (extra time + penalties)</label>`;
    } else if (sc.mode === 'rest') {
      html = `
        <div class="opt-grid two">
          <div class="field"><label>Top places</label><input type="number" min="0" max="20" data-opt="topPlaces" value="${o.topPlaces}"></div>
          <div class="field"><label>Relegation places</label><input type="number" min="0" max="20" data-opt="relegation" value="${o.relegation}"></div>
        </div>
        <label class="check"><input type="checkbox" data-opt="homeAdvantage" ${o.homeAdvantage ? 'checked' : ''}> Home advantage</label>
        <div class="field"><label>Adjust for form so far</label><select data-opt="form">
          ${Object.entries(FORM_OPTIONS).map(([k, v]) => `<option value="${k}" ${o.form === k ? 'selected' : ''}>${v ? v.label : 'Off: ratings only'}</option>`).join('')}
        </select></div>
        <p class="muted small-text">Nudges each team up or down by how much it has out- or under-played its ratings, judged by
          shots and shots on target for and against, which are much less luck-driven than points. Tested on 2025-26, this closed
          half to nine-tenths of the gap to the bookmakers; judging form by points made predictions worse.</p>`;
    } else if (sc.mode === 'league') {
      html = `
        <div class="opt-grid">
          <div class="field"><label>Format</label><select data-opt="format">
            <option value="double" ${o.format === 'double' ? 'selected' : ''}>Home and away</option>
            <option value="single" ${o.format === 'single' ? 'selected' : ''}>Play once</option>
          </select></div>
          <div class="field"><label>Top places</label><input type="number" min="0" max="20" data-opt="topPlaces" value="${o.topPlaces}"></div>
          <div class="field"><label>Relegation places</label><input type="number" min="0" max="20" data-opt="relegation" value="${o.relegation}"></div>
        </div>
        <label class="check"><input type="checkbox" data-opt="homeAdvantage" ${o.homeAdvantage ? 'checked' : ''}> Home advantage</label>`;
    } else {
      html = `
        <div class="field"><label>Draw</label><select data-opt="draw">
          <option value="random" ${o.draw === 'random' ? 'selected' : ''}>Random draw every run</option>
          <option value="seeded" ${o.draw === 'seeded' ? 'selected' : ''}>Seeded bracket by rating</option>
        </select></div>
        <p class="muted small-text">Single-leg ties at neutral venues, with extra time and penalties. If the number of entrants isn't a power of two, some teams get byes.</p>`;
    }
    $('#sc-options').innerHTML = html;
  }

  function currentRuns() {
    return Math.max(1, Math.min(1000000, parseInt(String($('#sc-runs').value).replace(/[^\d]/g, ''), 10) || 0));
  }

  function jobTeamsCount() {
    if (sc.mode === 'rest') return sc.rest.state ? sc.rest.state.teams.length : 0;
    return sc.mode === 'h2h' ? 2 : sc.lists[sc.mode].length;
  }

  function updateEstimate() {
    if (!sc.db) return;
    const n = jobTeamsCount();
    const st = sc.rest.state;
    const rest = sc.mode === 'rest';
    const fake = rest
      ? { mode: 'league', view: 'rest', teams: new Array(n), options: {}, fixtures: st ? st.remaining : [] }
      : { mode: sc.mode, teams: new Array(n), options: sc.options[sc.mode] };
    const runs = currentRuns();
    let matches = runs * OF.sim.matchesPerRun(fake);
    if (rest && st && FORM_OPTIONS[sc.options.rest.form]) matches += FORM_RUNS * st.played.length;
    const secs = (matches * sc.msPerMatch) / 1000 / cores();
    const unit = unitFor(fake);
    let problem = sc.mode !== 'h2h' && n < 2 ? 'Add at least two teams.' : '';
    if (rest && !st) problem = 'Load a results file first.';
    else if (rest && !st.remaining.length) problem = 'No fixtures left to play.';
    $('#sc-estimate').innerHTML = problem
      ? `<span class="warn">${problem}</span>`
      : `${fmtInt(runs)} ${unit} = <b>${fmtInt(matches)}</b> matches · about ${fmtDuration(secs)} on ${cores()} worker${cores() > 1 ? 's' : ''}`;
    $('#sc-go').disabled = !!problem;
  }

  function fmtDuration(s) {
    if (s < 1) return 'a second';
    if (s < 60) return `${Math.round(s)}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m ${String(Math.round(s % 60)).padStart(2, '0')}s`;
    return `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`;
  }

  // ---- Running ---------------------------------------------------------------------
  function buildJob() {
    const seedStr = $('#sc-seed').value.trim();
    const seed = seedStr ? (/^\d+$/.test(seedStr) ? Number(seedStr) : OF.util.hashSeed(seedStr)) : Math.floor(Math.random() * 1e9);
    let teams;
    if (sc.mode === 'h2h') {
      const [h, a] = OF.app.sides();
      if (h.team.key === a.team.key) {
        alert('Pick two different teams on the Match tab.');
        return null;
      }
      teams = [packCfg(h.team, h.formation, h.xi, h.subs.slice(0, 7)), packCfg(a.team, a.formation, a.xi, a.subs.slice(0, 7))];
    } else if (sc.mode === 'rest') {
      const st = sc.rest.state;
      if (!st || st.teams.length < 2) return null;
      const o = sc.options.rest;
      // A league job that starts from the real table and plays only what's left.
      return {
        mode: 'league', view: 'rest', teams: st.teams.map(teamConfig), seed,
        options: { format: 'double', topPlaces: o.topPlaces, relegation: o.relegation, homeAdvantage: o.homeAdvantage },
        start: st.table, fixtures: st.remaining.map((f) => [f.i, f.j]),
      };
    } else {
      teams = sc.lists[sc.mode].map(teamConfig);
      if (teams.length < 2) return null;
    }
    return { mode: sc.mode, teams, options: { ...sc.options[sc.mode] }, seed };
  }

  async function startRun() {
    if (sc.run) return;
    const job = buildJob();
    if (!job) return;
    const run = (sc.run = sc.lastRun = {
      job, total: currentRuns(), perRun: OF.sim.matchesPerRun(job),
      done: 0, agg: OF.sim.createAgg(),
      started: performance.now(),
      workers: 0, mainThread: false, stop: null, renderTimer: null, phase: '',
      season: job.view === 'rest' ? sc.rest.state : null,
    });
    $('#sc-go').classList.add('hidden');
    $('#sc-cancel').classList.remove('hidden');
    $('#sc-progress').classList.remove('hidden');
    setLocked(true);
    $('#sc-results').innerHTML = '';
    tickProgress();
    try {
      const form = job.view === 'rest' ? FORM_OPTIONS[sc.options.rest.form] : null;
      if (form && run.season.played.length) {
        // Phase 1: what the ratings expected from the games already played.
        run.phase = `Measuring form: replaying the ${run.season.played.length} games already played`;
        const pjob = { mode: 'league', teams: job.teams, options: job.options, seed: job.seed, fixtures: run.season.played.map((g) => [g.i, g.j]) };
        const p = await runPool(run, pjob, FORM_RUNS, null);
        if (sc.run !== run) return;
        run.strengths = OF.season.strengthsFromResults(job.teams.length, run.season.played, p.fxOut, p.runs, form);
        job.strengths = run.strengths.map((x) => x.strength);
        run.phase = '';
        run.started = performance.now();
      }
      const agg = await runPool(run, job, run.total, (partial, done) => {
        run.agg = partial;
        run.done = done;
        scheduleRender(run);
      });
      if (sc.run !== run) return;
      run.agg = agg;
      run.done = run.total;
      finishRun(run);
    } catch (err) {
      if (sc.run === run) fail(run, err.message || String(err));
    }
  }

  // Run `total` runs of `job` across Web Workers (falling back to the main
  // thread on file:// pages) and resolve with the merged aggregate.
  function runPool(run, job, total, onProgress) {
    return new Promise((resolve, reject) => {
      const perRun = OF.sim.matchesPerRun(job);
      // Batches of roughly 300 matches keep workers busy and progress smooth.
      const batch = Math.max(1, Math.min(Math.ceil(total / cores()), Math.round(300 / perRun)));
      let agg = OF.sim.createAgg();
      let next = 0;
      let done = 0;
      let workers = [];
      let finished = false;
      let fellBack = false;
      const stop = () => {
        finished = true;
        workers.forEach((w) => w.terminate());
        workers = [];
      };
      run.stop = stop;
      const merge = (msg) => {
        if (finished) return;
        OF.sim.mergeAgg(agg, msg.agg);
        done += msg.end - msg.start;
        if (done >= total) {
          stop();
          resolve(agg);
        } else if (onProgress) onProgress(agg, done);
      };
      const dispatch = (w) => {
        if (next >= total) return;
        const start = next;
        next = Math.min(total, next + batch);
        w.postMessage({ type: 'batch', start, end: next });
      };
      const onMainThread = () => {
        if (fellBack) return;
        fellBack = true;
        workers.forEach((w) => w.terminate());
        workers = [];
        run.mainThread = true;
        run.workers = 0;
        agg = OF.sim.createAgg();
        next = 0;
        done = 0;
        const step = () => {
          if (finished) return;
          const t0 = performance.now();
          const part = OF.sim.createAgg();
          const start = next;
          // Work in ~40ms slices so the page stays responsive.
          while (next < total && performance.now() - t0 < 40) OF.sim.simulateRun(job, next++, part);
          merge({ agg: part, start, end: next });
          if (!finished) setTimeout(step, 0);
        };
        setTimeout(step, 0);
      };
      if (run.mainThread) return onMainThread();
      try {
        const n = Math.min(cores(), Math.ceil(total / batch));
        for (let i = 0; i < n; i++) {
          const w = new Worker('js/sim-worker.js');
          w.onmessage = (e) => {
            merge(e.data);
            if (!finished) dispatch(w);
          };
          w.onerror = (e) => {
            e.preventDefault();
            // Workers are blocked on file:// pages: fall back to the main thread.
            if (done === 0) onMainThread();
            else {
              stop();
              reject(new Error(e.message || 'Worker error'));
            }
          };
          w.postMessage({ type: 'job', job });
          workers.push(w);
        }
        run.workers = workers.length;
        workers.forEach(dispatch);
      } catch (err) {
        onMainThread();
      }
    });
  }

  function scheduleRender(run) {
    if (run.renderTimer) return;
    run.renderTimer = setTimeout(() => {
      run.renderTimer = null;
      if (sc.run === run) renderResults(run, false);
    }, 350);
  }

  function unitFor(job) {
    if (job.view === 'rest') return 'simulations';
    return job.mode === 'h2h' ? 'matches' : job.mode === 'league' ? 'seasons' : 'tournaments';
  }

  function tickProgress() {
    const run = sc.run;
    if (!run) return;
    if (run.phase) {
      $('#sc-bar').style.width = '0%';
      $('#sc-progress-text').innerHTML = `<b>${esc(run.phase)}…</b>`;
    } else {
      const elapsed = (performance.now() - run.started) / 1000;
      const matches = run.agg.matches;
      const rate = elapsed > 0 ? matches / elapsed : 0;
      const left = rate > 0 ? ((run.total - run.done) * run.perRun) / rate : 0;
      $('#sc-bar').style.width = `${(run.done / run.total) * 100}%`;
      $('#sc-progress-text').innerHTML = `
        <b>${fmtInt(run.done)}</b> / ${fmtInt(run.total)} ${unitFor(run.job)}
        <span>${fmtInt(matches)} matches simulated</span>
        <span>${fmtInt(rate)} matches/s</span>
        <span>${run.mainThread ? 'main thread (open via a web server to use workers)' : `${run.workers} workers`}</span>
        <span>${run.done ? `~${fmtDuration(left)} left` : 'starting…'}</span>`;
    }
    if (run.done < run.total) setTimeout(tickProgress, 250);
  }

  function finishRun(run) {
    const secs = (performance.now() - run.started) / 1000;
    const cpuMs = (secs * 1000 * Math.max(1, run.workers)) / Math.max(1, run.agg.matches);
    if (run.agg.matches > 200) sc.msPerMatch = run.mainThread ? (secs * 1000) / run.agg.matches : cpuMs;
    clearTimeout(run.renderTimer);
    sc.run = null;
    resetButtons();
    $('#sc-bar').style.width = '100%';
    $('#sc-progress-text').innerHTML = `<b>Done.</b> <span>${fmtInt(run.total)} ${unitFor(run.job)}</span><span>${fmtInt(run.agg.matches)} matches</span><span>${fmtDuration(secs)}</span><span>seed ${run.job.seed}</span>`;
    renderResults(run, true);
    updateEstimate();
  }

  function stopRun(cancelled) {
    const run = sc.run;
    if (!run) return;
    if (run.stop) run.stop();
    clearTimeout(run.renderTimer);
    sc.run = null;
    resetButtons();
    if (cancelled && run.done) {
      $('#sc-progress-text').innerHTML = `<b>Cancelled</b> after ${fmtInt(run.done)} runs. Results below are from those runs.`;
      renderResults(run, true);
    } else if (cancelled) {
      $('#sc-progress').classList.add('hidden');
    }
  }

  function fail(run, message) {
    stopRun(false);
    $('#sc-progress').classList.remove('hidden');
    $('#sc-progress-text').innerHTML = `<span class="warn">Simulation failed: ${esc(message)}</span>`;
  }

  function resetButtons() {
    $('#sc-go').classList.remove('hidden');
    $('#sc-cancel').classList.add('hidden');
    renderConfig();
  }

  // ---- Results -------------------------------------------------------------------
  const pct = (x, n) => (n ? x / n : 0);
  function fmtPct(p) {
    if (!p) return '–';
    if (p < 0.001) return '<0.1%';
    if (p > 0.999 && p < 1) return '>99.9%';
    return `${(p * 100).toFixed(1)}%`;
  }
  // Sequential single-hue cell: stronger fill = more likely.
  const heat = (p, max = 1) => `background:color-mix(in srgb, var(--seq) ${Math.round(Math.min(1, p / max) * 68)}%, transparent)`;
  const teamLabel = (name, league, showLeague) => `${esc(name)}${showLeague ? ` <span class="muted small-text">${esc(league)}</span>` : ''}`;

  function renderResults(run, final) {
    const { agg, job } = run;
    if (!agg.runs) return;
    const badge = final ? '' : `<span class="provisional">Provisional · ${Math.round((run.done / run.total) * 100)}% done</span>`;
    let html = '';
    if (job.view === 'rest') html = renderRest(run);
    else if (job.mode === 'h2h') html = renderH2H(agg, job);
    else if (job.mode === 'league') html = renderLeague(agg, job);
    else html = renderCup(agg, job);
    $('#sc-results').innerHTML = `<div class="sc-results-head">${badge}</div>${html}`;
  }

  function playerRows(agg, filterFn, sortFn, limit, cols) {
    const list = Object.values(agg.players || {}).filter(filterFn).sort(sortFn).slice(0, limit);
    return list.map((p, i) => `<tr><td>${i + 1}</td><td class="l"><b>${esc(p.name)}</b> <span class="muted small-text">${esc(p.pos)} · ${p.ovr}</span><div class="muted small-text">${esc(p.team)}</div></td>${cols.map((c) => `<td>${c(p)}</td>`).join('')}</tr>`).join('');
  }

  function renderH2H(agg, job) {
    const n = agg.runs;
    const [home, away] = job.teams.map((t) => t.team);
    const [hw, d, aw] = agg.res;
    const probs = [pct(hw, n), pct(d, n), pct(aw, n)];
    const odds = (p) => (p ? (1 / p).toFixed(2) : '–');
    const ko = job.options.knockout;
    const avg = (k, i) => (agg[k][i] / n);
    const tiles = [
      [`${esc(home.name)} win`, probs[0], 'side-0'],
      ['Draw', probs[1], 'draw'],
      [`${esc(away.name)} win`, probs[2], 'side-1'],
    ];
    // Scoreline grid, capped at 5+ goals.
    const cap = 5;
    const grid = Array.from({ length: cap + 1 }, () => new Array(cap + 1).fill(0));
    for (const k in agg.scores) {
      const [x, y] = k.split('-').map(Number);
      grid[Math.min(cap, x)][Math.min(cap, y)] += agg.scores[k];
    }
    const gmax = Math.max(...grid.flat()) / n;
    const common = Object.entries(agg.scores).sort((a, b) => b[1] - a[1]).slice(0, 6);
    const stat = (label, a, b, fmt = (v) => v.toFixed(2)) => `<tr><td>${fmt(a)}</td><th>${label}</th><td>${fmt(b)}</td></tr>`;
    const minApps = n * 0.1;
    return `
      <div class="card">
        <h2>Result probabilities <span class="muted">over ${fmtInt(n)} matches (90 minutes)</span></h2>
        <div class="tiles">${tiles.map(([label, p, cls]) => `
          <div class="tile"><span class="tile-label"><i class="dot ${cls}"></i>${label}</span><b>${fmtPct(p)}</b><span class="muted">fair odds ${odds(p)}</span></div>`).join('')}
        </div>
        <div class="wdl-bar" role="img" aria-label="Home ${fmtPct(probs[0])}, draw ${fmtPct(probs[1])}, away ${fmtPct(probs[2])}">
          <div class="side-0" style="flex:${probs[0]}" title="${esc(home.name)} win ${fmtPct(probs[0])}"></div>
          <div class="draw" style="flex:${probs[1]}" title="Draw ${fmtPct(probs[1])}"></div>
          <div class="side-1" style="flex:${probs[2]}" title="${esc(away.name)} win ${fmtPct(probs[2])}"></div>
        </div>
        ${ko ? `<p class="ko-line"><b>To go through:</b> ${esc(home.name)} ${fmtPct(pct(agg.advance[0], n))} · ${esc(away.name)} ${fmtPct(pct(agg.advance[1], n))}
          <span class="muted">· extra time in ${fmtPct(pct(agg.extraTime || 0, n))} · penalties in ${fmtPct(pct(agg.shootouts || 0, n))}</span></p>` : ''}
      </div>
      <div class="sc-grid">
        <div class="card">
          <h2>Average match</h2>
          <table class="vs-table">
            <thead><tr><th>${esc(home.name)}</th><th></th><th>${esc(away.name)}</th></tr></thead>
            <tbody>
              ${stat('Goals', avg('goals', 0), avg('goals', 1))}
              ${stat('Expected goals', avg('xg', 0), avg('xg', 1))}
              ${stat('Shots', avg('shots', 0), avg('shots', 1), (v) => v.toFixed(1))}
              ${stat('On target', avg('sot', 0), avg('sot', 1), (v) => v.toFixed(1))}
              ${stat('Possession', avg('poss', 0), avg('poss', 1), (v) => `${v.toFixed(0)}%`)}
              ${stat('Clean sheet', pct(agg.cleanSheets[0], n), pct(agg.cleanSheets[1], n), fmtPct)}
            </tbody>
          </table>
          <p class="muted small-text">Both teams score ${fmtPct(pct(agg.btts || 0, n))} · Over 2.5 goals ${fmtPct(pct(agg.over25 || 0, n))}</p>
          <h3 class="sub-h">Most likely scores</h3>
          <ol class="score-list">${common.map(([s, c]) => `<li><b>${s}</b><span>${fmtPct(c / n)}</span></li>`).join('')}</ol>
        </div>
        <div class="card">
          <h2>Scoreline probabilities</h2>
          <div class="score-grid" style="--cols:${cap + 2}">
            <div class="sg-corner"><span>${esc(home.name)} ↓</span><span>${esc(away.name)} →</span></div>
            ${Array.from({ length: cap + 1 }, (_, j) => `<div class="sg-head">${j === cap ? `${cap}+` : j}</div>`).join('')}
            ${grid.map((row, i) => `<div class="sg-head">${i === cap ? `${cap}+` : i}</div>${row.map((c, j) => {
              const p = c / n;
              return `<div class="sg-cell" style="${heat(p, gmax)}" title="${esc(home.name)} ${i === cap ? `${cap}+` : i}–${j === cap ? `${cap}+` : j} ${esc(away.name)}: ${fmtPct(p)}">${p >= 0.005 ? (p * 100).toFixed(1) : ''}</div>`;
            }).join('')}`).join('')}
          </div>
          <p class="muted small-text">Cell values are % of matches. Rows are ${esc(home.name)} goals, columns are ${esc(away.name)} goals.</p>
        </div>
      </div>
      <div class="card">
        <h2>Players</h2>
        <div class="table-wrap"><table class="sc-table">
          <thead><tr><th>#</th><th class="l">Player</th><th title="Scores at least once">Anytime scorer</th><th>Goals / match</th><th>Assists / match</th><th>Avg rating</th><th title="Player of the match">POTM</th></tr></thead>
          <tbody>${playerRows(agg, (p) => p.apps >= minApps, (a, b) => b.goals / b.apps - a.goals / a.apps || b.ratingSum / b.apps - a.ratingSum / a.apps, 15, [
            (p) => fmtPct(pct(p.scoredIn || 0, p.apps)),
            (p) => (p.goals / p.apps).toFixed(2),
            (p) => (p.assists / p.apps).toFixed(2),
            (p) => (p.ratingSum / p.apps).toFixed(2),
            (p) => fmtPct(pct(p.motm || 0, n)),
          ])}</tbody>
        </table></div>
      </div>`;
  }

  function renderLeague(agg, job) {
    const n = agg.runs;
    const teams = Object.values(agg.teams).sort((a, b) => b.pts - a.pts);
    const size = teams.length;
    const top = job.options.topPlaces || 0;
    const rel = job.options.relegation || 0;
    const mixedLeagues = new Set(teams.map((t) => t.league)).size > 1;
    const posMax = Math.max(...teams.flatMap((t) => t.finish)) / n;
    const expPos = (t) => t.finish.reduce((s, c, i) => s + c * (i + 1), 0) / n;
    const mode = (t) => t.finish.indexOf(Math.max(...t.finish)) + 1;
    const zone = (i) => (i === 0 ? 'z-title' : i < top ? 'z-top' : i >= size - rel ? 'z-rel' : '');
    const sample = agg.sampleJson ? JSON.parse(agg.sampleJson) : null;
    return `
      <div class="card">
        <h2>Predicted table <span class="muted">over ${fmtInt(n)} seasons</span></h2>
        <p class="muted small-text">Champions average ${(agg.championPts / n).toFixed(1)} pts${rel ? ` · the team just above the drop averages ${(agg.safetyPts / n).toFixed(1)} pts` : ''}.
          Hover over the position grid to see exact odds.</p>
        <div class="table-wrap"><table class="sc-table league-table">
          <thead><tr><th>#</th><th class="l">Team</th><th>OVR</th><th>Pts</th><th>GD</th><th>W–D–L</th><th>Avg pos</th>
            <th>Title</th>${top > 1 ? `<th>Top ${top}</th>` : ''}${rel ? '<th>Relegated</th>' : ''}
            <th class="l">Finishing position (1 → ${size})</th></tr></thead>
          <tbody>${teams.map((t, i) => `<tr>
            <td>${i + 1}</td>
            <td class="l"><b>${teamLabel(t.name, t.league, mixedLeagues)}</b></td>
            <td>${t.rating}</td>
            <td><b>${(t.pts / n).toFixed(1)}</b></td>
            <td>${((t.gf - t.ga) / n >= 0 ? '+' : '') + ((t.gf - t.ga) / n).toFixed(1)}</td>
            <td class="muted">${(t.w / n).toFixed(1)}–${(t.d / n).toFixed(1)}–${(t.l / n).toFixed(1)}</td>
            <td>${expPos(t).toFixed(1)}</td>
            <td class="pcell" style="${heat(pct(t.title || 0, n))}">${fmtPct(pct(t.title || 0, n))}</td>
            ${top > 1 ? `<td class="pcell" style="${heat(pct(t.top || 0, n))}">${fmtPct(pct(t.top || 0, n))}</td>` : ''}
            ${rel ? `<td class="pcell rel" style="${heat(pct(t.releg || 0, n))}">${fmtPct(pct(t.releg || 0, n))}</td>` : ''}
            <td class="l"><div class="pos-strip" style="--n:${size}">${t.finish.map((c, k) => `<i class="${zone(k)}" style="${heat(c / n, posMax)}" title="${esc(t.name)}: finishes ${ordinal(k + 1)} in ${fmtPct(c / n)} of seasons"></i>`).join('')}</div>
              <span class="muted small-text">most often ${ordinal(mode(t))}</span></td>
          </tr>`).join('')}</tbody>
        </table></div>
      </div>
      <div class="sc-grid">
        <div class="card">
          <h2>Golden Boot</h2>
          <div class="table-wrap"><table class="sc-table">
            <thead><tr><th>#</th><th class="l">Player</th><th>Goals / season</th><th>Avg rating</th><th title="Finishes as (joint) top scorer">Wins boot</th></tr></thead>
            <tbody>${playerRows(agg, () => true, (a, b) => b.goals - a.goals, 12, [
              (p) => (p.goals / n).toFixed(1),
              (p) => (p.ratingSum / p.apps).toFixed(2),
              (p) => fmtPct(pct(p.topScorer || 0, n)),
            ])}</tbody>
          </table></div>
        </div>
        ${sample ? `<div class="card">
          <h2>One simulated season <span class="muted">(run #1)</span></h2>
          <div class="table-wrap"><table class="sc-table compact">
            <thead><tr><th>#</th><th class="l">Team</th><th>W</th><th>D</th><th>L</th><th>GD</th><th>Pts</th></tr></thead>
            <tbody>${sample.map((r, i) => `<tr class="${zone(i)}"><td>${i + 1}</td><td class="l">${esc(r.name)}</td><td>${r.w}</td><td>${r.d}</td><td>${r.l}</td><td>${r.gf - r.ga >= 0 ? '+' : ''}${r.gf - r.ga}</td><td><b>${r.pts}</b></td></tr>`).join('')}</tbody>
          </table></div>
        </div>` : ''}
      </div>`;
  }

  function renderCup(agg, job) {
    const n = agg.runs;
    const { names } = OF.sim.cupRounds(job.teams.length);
    const last = names.length - 1;
    const teams = Object.values(agg.teams).sort((a, b) => b.reach[last] - a.reach[last] || b.reach[last - 1] - a.reach[last - 1]);
    const mixedLeagues = new Set(teams.map((t) => t.league)).size > 1;
    const finals = Object.values(agg.finals || {}).sort((a, b) => b.n - a.n).slice(0, 8);
    // Skip the first column when everyone starts there.
    const cols = names.map((name, i) => ({ name, i })).filter((c) => c.i > 0);
    return `
      <div class="card">
        <h2>Chance of reaching each round <span class="muted">over ${fmtInt(n)} tournaments</span></h2>
        <div class="table-wrap"><table class="sc-table">
          <thead><tr><th>#</th><th class="l">Team</th><th>OVR</th>${cols.map((c) => `<th>${c.name === 'Winner' ? 'Wins cup' : esc(c.name)}</th>`).join('')}</tr></thead>
          <tbody>${teams.map((t, k) => `<tr><td>${k + 1}</td><td class="l"><b>${teamLabel(t.name, t.league, mixedLeagues)}</b></td><td>${t.rating}</td>
            ${cols.map((c) => {
              const p = pct(t.reach[c.i], n);
              return `<td class="pcell ${c.name === 'Winner' ? 'win' : ''}" style="${heat(p)}">${fmtPct(p)}</td>`;
            }).join('')}</tr>`).join('')}</tbody>
        </table></div>
      </div>
      <div class="sc-grid">
        <div class="card">
          <h2>Most likely finals</h2>
          <ol class="score-list wide">${finals.map((f) => `<li><b>${esc(f.names)}</b><span>${fmtPct(f.n / n)}</span></li>`).join('') || '<li class="muted">No finals yet</li>'}</ol>
        </div>
        <div class="card">
          <h2>Top scorers</h2>
          <div class="table-wrap"><table class="sc-table">
            <thead><tr><th>#</th><th class="l">Player</th><th>Goals / cup</th><th>Avg rating</th><th title="Finishes as (joint) top scorer">Top scorer</th></tr></thead>
            <tbody>${playerRows(agg, () => true, (a, b) => b.goals - a.goals, 12, [
              (p) => (p.goals / n).toFixed(2),
              (p) => (p.ratingSum / p.apps).toFixed(2),
              (p) => fmtPct(pct(p.topScorer || 0, n)),
            ])}</tbody>
          </table></div>
        </div>
      </div>`;
  }

  // ---- Rest of season ---------------------------------------------------------------
  function renderRestConfig() {
    const r = sc.rest;
    const st = r.state;
    const fmtDate = (d) => (d ? d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '');
    const fileRow = (kind, label, detail) => `
      <div class="file-row">
        <div class="file-info"><b>${label}</b><span class="muted small-text">${detail}</span></div>
        <label class="btn small file-btn">${r[kind] ? 'Replace' : 'Choose file'}<input type="file" accept=".csv,text/csv" data-act="rest-${kind}"></label>
        ${r[kind] ? `<button class="btn small ghost" data-act="rest-clear" data-kind="${kind}">Remove</button>` : ''}
      </div>`;
    const dates = st ? st.played.map((g) => g.date).filter(Boolean).sort((a, b) => a - b) : [];
    const resultsDetail = r.results
      ? `${esc(r.results.name)}${st ? ` · ${st.played.length} games${dates.length ? `, ${fmtDate(dates[0])} – ${fmtDate(dates[dates.length - 1])}` : ''}` : ''}`
      : 'football-data.co.uk CSV, e.g. E0.csv for the Premier League';
    const fixturesDetail = r.fixtures
      ? `${esc(r.fixtures.name)}${st ? ` · ${st.remaining.length} games still to play` : ''}`
      : st ? `Optional. Without it, the ${st.remaining.length} remaining games are worked out from who hasn't played whom yet (no dates).` : 'Optional: adds dates and order to the remaining games.';
    let tableHtml = '';
    if (st) {
      const rows = st.teams.map((t, i) => ({ t, ...st.table[i] }))
        .sort((a, b) => b.pts - a.pts || (b.gf - b.ga) - (a.gf - a.ga) || b.gf - a.gf);
      tableHtml = `<details class="current-table"><summary>Current table (from the results file)</summary>
        <div class="table-wrap"><table class="sc-table compact">
          <thead><tr><th>#</th><th class="l">Team</th><th>P</th><th>W</th><th>D</th><th>L</th><th>GD</th><th>Pts</th></tr></thead>
          <tbody>${rows.map((x, i) => `<tr><td>${i + 1}</td><td class="l">${esc(x.t.name)}</td><td>${x.p}</td><td>${x.w}</td><td>${x.d}</td><td>${x.l}</td><td>${x.gf - x.ga >= 0 ? '+' : ''}${x.gf - x.ga}</td><td><b>${x.pts}</b></td></tr>`).join('')}</tbody>
        </table></div></details>`;
    }
    return `
      <h2>Rest of the season</h2>
      <p class="muted small-text">Banks the real results so far, then simulates only the games still to play, using each squad's FC 27 players.</p>
      <div class="file-rows">
        ${fileRow('results', 'Results so far', resultsDetail)}
        ${fileRow('fixtures', 'Remaining fixtures', fixturesDetail)}
      </div>
      ${r.error ? `<p class="warn">${esc(r.error)}</p>` : ''}
      ${st && st.unknown.length ? `<p class="warn">Couldn't match these teams to the player database: ${st.unknown.map(esc).join(', ')}</p>` : ''}
      ${tableHtml}`;
  }

  const signed = (v) => {
    const r = Math.round(v * 10) / 10;
    return `${r > 0 ? '+' : ''}${Number.isInteger(r) ? r : r.toFixed(1)}`;
  };

  function quantile(hist, total, q) {
    let acc = 0;
    for (let i = 0; i < hist.length; i++) {
      acc += hist[i] || 0;
      if (acc >= q * total) return i;
    }
    return hist.length - 1;
  }

  function renderRest(run) {
    const { agg, job, season: st } = run;
    const n = agg.runs;
    const size = job.teams.length;
    const top = job.options.topPlaces || 0;
    const rel = job.options.relegation || 0;
    const zone = (i) => (i === 0 ? 'z-title' : i < top ? 'z-top' : i >= size - rel ? 'z-rel' : '');
    const rows = job.teams.map((cfg, i) => ({ i, cfg, now: st.table[i], t: agg.teams[cfg.team.key] }))
      .filter((r) => r.t)
      .sort((a, b) => b.t.pts - a.t.pts);
    const posMax = Math.max(...rows.flatMap((r) => r.t.finish)) / n;
    const mode = (t) => t.finish.indexOf(Math.max(...t.finish)) + 1;
    const table = `
      <div class="card">
        <h2>Predicted final table <span class="muted">from ${fmtInt(n)} simulations of the last ${st.remaining.length} games</span></h2>
        <p class="muted small-text">"Now" is the real table. Final points include the points already won. The likely range covers 80% of simulations.</p>
        <div class="table-wrap"><table class="sc-table league-table">
          <thead><tr><th>#</th><th class="l">Team</th><th>Now</th><th>Final pts</th><th>Likely range</th>
            <th>Title</th>${top > 1 ? `<th>Top ${top}</th>` : ''}${rel ? '<th>Relegated</th>' : ''}
            <th class="l">Finishing position (1 → ${size})</th></tr></thead>
          <tbody>${rows.map((r, k) => {
            const t = r.t;
            return `<tr>
              <td>${k + 1}</td>
              <td class="l"><b>${esc(t.name)}</b> <span class="muted small-text">${t.rating}</span></td>
              <td>${r.now.pts} <span class="muted small-text">(${r.now.p} pl)</span></td>
              <td><b>${(t.pts / n).toFixed(1)}</b></td>
              <td class="muted">${quantile(t.ptsHist || [], n, 0.1)}–${quantile(t.ptsHist || [], n, 0.9)}</td>
              <td class="pcell" style="${heat(pct(t.title || 0, n))}">${fmtPct(pct(t.title || 0, n))}</td>
              ${top > 1 ? `<td class="pcell" style="${heat(pct(t.top || 0, n))}">${fmtPct(pct(t.top || 0, n))}</td>` : ''}
              ${rel ? `<td class="pcell" style="${heat(pct(t.releg || 0, n))}">${fmtPct(pct(t.releg || 0, n))}</td>` : ''}
              <td class="l"><div class="pos-strip" style="--n:${size}">${t.finish.map((c, p) => `<i class="${zone(p)}" style="${heat(c / n, posMax)}" title="${esc(t.name)}: finishes ${ordinal(p + 1)} in ${fmtPct(c / n)} of simulations"></i>`).join('')}</div>
                <span class="muted small-text">most often ${ordinal(mode(t))}</span></td>
            </tr>`;
          }).join('')}</tbody>
        </table></div>
      </div>`;

    let form = '';
    if (run.strengths) {
      const list = run.strengths.map((x, i) => ({ ...x, name: job.teams[i].team.name })).sort((a, b) => b.strength - a.strength);
      form = `<div class="card">
        <h2>Form adjustment</h2>
        <p class="muted small-text">${run.strengths[0].metric === 'shotmix'
          ? 'Each team\'s real shots and shots on target, for and against, compared with what its ratings expected from the same games (shots-on-target difference shown)'
          : `Each team's real ${esc(run.strengths[0].label)} compared with what its ratings expected from the same games`},
          turned into a strength change and shrunk towards zero while the sample is small.</p>
        <div class="form-chips">${list.map((x) => `<span class="team-chip">${esc(x.name)} <b class="${x.strength >= 1 ? 'up' : 'down'}">${x.strength >= 1 ? '+' : ''}${((x.strength - 1) * 100).toFixed(1)}%</b>
          <span class="muted small-text">${x.games ? `${signed(x.real)} ${esc(x.label)} vs ${signed(x.expected)} expected` : 'no shot data'}</span></span>`).join('')}</div>
      </div>`;
    }

    // Fixture predictions.
    const names = job.teams.map((c) => c.team.name);
    const hasDates = st.remaining.some((f) => f.date);
    const hasBook = st.remaining.some((f) => f.book);
    const filter = sc.rest.team;
    let list = st.remaining.map((f, k) => ({ f, k })).filter(({ f }) => filter === '' || names[f.i] === filter || names[f.j] === filter);
    const total = list.length;
    if (!sc.rest.showAll) list = list.slice(0, FIXTURE_PAGE);
    const weekOf = (d) => {
      const x = new Date(d);
      x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7));
      return x;
    };
    let lastWeek = '';
    const bodyRows = list.map(({ f, k }) => {
      const X = OF.sim.FX;
      const o = [0, 1, 2].map((q) => (agg.fxOut[k * X + q] || 0) / n);
      const gh = (agg.fxOut[k * X + 3] || 0) / n;
      const ga = (agg.fxOut[k * X + 4] || 0) / n;
      const scores = agg.fxScores[k] ? Object.entries(agg.fxScores[k]).sort((a, b) => b[1] - a[1]) : [];
      const likely = scores.length ? `${scores[0][0]} <span class="muted small-text">${fmtPct(scores[0][1] / n)}</span>` : '';
      let head = '';
      if (hasDates && f.date) {
        const wk = weekOf(f.date).toISOString().slice(0, 10);
        if (wk !== lastWeek) {
          lastWeek = wk;
          head = `<tr class="fx-week"><td colspan="${hasBook ? 7 : 6}">Week of ${weekOf(f.date).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })}</td></tr>`;
        }
      }
      const b = f.book;
      return `${head}<tr>
        <td class="muted small-text">${f.date ? f.date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }) : ''}${f.time ? ` ${esc(f.time)}` : ''}</td>
        <td class="r"><b>${esc(names[f.i])}</b></td>
        <td class="fx-odds">
          <div class="wdl-bar mini" role="img" aria-label="Home ${fmtPct(o[0])}, draw ${fmtPct(o[1])}, away ${fmtPct(o[2])}">
            <div class="side-0" style="flex:${o[0]}"></div><div class="draw" style="flex:${o[1]}"></div><div class="side-1" style="flex:${o[2]}"></div>
          </div>
          <div class="fx-nums"><span>${Math.round(o[0] * 100)}%</span><span>${Math.round(o[1] * 100)}%</span><span>${Math.round(o[2] * 100)}%</span></div>
        </td>
        <td class="l"><b>${esc(names[f.j])}</b></td>
        <td>${likely}</td>
        <td class="muted">${gh.toFixed(1)}–${ga.toFixed(1)}</td>
        ${hasBook ? `<td class="muted small-text">${b ? `${Math.round(b[0] * 100)} / ${Math.round(b[1] * 100)} / ${Math.round(b[2] * 100)}` : ''}</td>` : ''}
      </tr>`;
    }).join('');
    const fixtures = `
      <div class="card">
        <div class="card-head">
          <h2>Match predictions <span class="muted">(${total} games)</span></h2>
          <select data-act="fx-team" aria-label="Show one team's fixtures">
            <option value="">All teams</option>
            ${names.slice().sort().map((nm) => `<option ${nm === filter ? 'selected' : ''}>${esc(nm)}</option>`).join('')}
          </select>
        </div>
        ${hasDates ? '' : '<p class="muted small-text">No fixtures file loaded, so the order of these games is unknown. Load one to get dates.</p>'}
        <div class="table-wrap"><table class="sc-table fx-table">
          <thead><tr><th class="l">Date</th><th class="r">Home</th><th>Home / Draw / Away</th><th class="l">Away</th><th>Likeliest score</th><th title="Average goals">Avg goals</th>${hasBook ? '<th title="Bookmaker odds in the fixtures file, margin removed">Bookies H/D/A</th>' : ''}</tr></thead>
          <tbody>${bodyRows}</tbody>
        </table></div>
        ${total > FIXTURE_PAGE ? `<button class="btn small" data-act="fx-all">${sc.rest.showAll ? 'Show fewer' : `Show all ${total}`}</button>` : ''}
      </div>`;
    return table + form + fixtures;
  }

  function ordinal(k) {
    const s = ['th', 'st', 'nd', 'rd'];
    const v = k % 100;
    return k + (s[(v - 20) % 10] || s[v] || s[0]);
  }
})();

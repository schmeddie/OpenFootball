// UI: team/formation picking, lineup editing, live match playback, report.
(function () {
  const OF = window.OF;
  const F = OF.formations;
  const $ = (sel, el = document) => el.querySelector(sel);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const BENCH_SIZE = 7;
  const state = {
    db: null,
    sides: [null, null], // { league, team, formation, auto, xi, subs }
    selected: null, // { side, kind: 'xi'|'sub', index }
    match: null,
    timer: null,
    paused: false,
    ratingTab: 0,
  };

  // ---- Loading ------------------------------------------------------------------
  async function init() {
    try {
      const res = await fetch('players.csv');
      if (!res.ok) throw new Error(res.statusText);
      loadCSV(await res.text());
    } catch (e) {
      $('#db-status').textContent = 'Player database not loaded';
      $('#loader').classList.remove('hidden');
    }
    $('#csv-file').addEventListener('change', async (e) => {
      const f = e.target.files[0];
      if (f) loadCSV(await f.text());
    });
  }

  function loadCSV(text) {
    const t0 = performance.now();
    state.db = OF.players.buildDatabase(OF.parseCSV(text));
    const ms = Math.round(performance.now() - t0);
    $('#db-status').textContent = `${state.db.players.length.toLocaleString()} players · ${state.db.teams.length} teams`;
    $('#db-status').title = `Parsed in ${ms} ms`;
    $('#loader').classList.add('hidden');
    $('#setup').classList.remove('hidden');
    const saved = loadPrefs();
    const defaults = ['Real Madrid|LALIGA EA SPORTS', 'FC Barcelona|LALIGA EA SPORTS'];
    for (const i of [0, 1]) {
      const key = (saved && saved[i]) || defaults[i];
      const team = state.db.teamsByKey.get(key) || state.db.teams[i];
      setTeam(i, team, saved && saved.formations && saved.formations[i]);
    }
    bindSetup();
  }

  function loadPrefs() {
    try {
      return JSON.parse(localStorage.getItem('of-prefs') || 'null');
    } catch (e) {
      return null;
    }
  }

  function savePrefs() {
    try {
      localStorage.setItem('of-prefs', JSON.stringify({
        0: state.sides[0].team.key,
        1: state.sides[1].team.key,
        formations: state.sides.map((s) => (s.auto ? null : s.formation)),
      }));
    } catch (e) { /* storage unavailable */ }
  }

  // ---- Team setup -------------------------------------------------------------
  function setTeam(i, team, formation) {
    const auto = !formation || !F.FORMATIONS[formation];
    const f = auto ? F.bestFormation(team) : formation;
    // Keep an "All leagues" filter; otherwise follow the team's league.
    const prev = state.sides[i] ? state.sides[i].league : team.league;
    state.sides[i] = { league: prev === '' ? '' : team.league, team, formation: f, auto };
    autoLineup(i);
  }

  function autoLineup(i) {
    const s = state.sides[i];
    s.xi = F.pickStartingXI(s.team, s.formation);
    const bench = F.pickBench(s.team, s.xi, BENCH_SIZE);
    const used = new Set(s.xi.map((x) => x.player.id).concat(bench.map((p) => p.id)));
    s.subs = bench.concat(s.team.players.filter((p) => !used.has(p.id)));
    state.selected = null;
    renderPanel(i);
  }

  // Keep the chosen players when switching formation: re-slot the current XI.
  function changeFormation(i, f) {
    const s = state.sides[i];
    s.auto = false;
    s.formation = f;
    const current = { name: s.team.name, players: s.xi.map((x) => x.player) };
    s.xi = F.pickStartingXI(current, f);
    state.selected = null;
    renderPanel(i);
    savePrefs();
  }

  function renderPanel(i) {
    const s = state.sides[i];
    const panel = document.querySelector(`.team-panel[data-side="${i}"]`);
    const db = state.db;
    const teams = db.teams.filter((t) => !s.league || t.league === s.league);
    const units = F.unitRatings(s.xi);
    const formOpts = Object.keys(F.FORMATIONS)
      .map((f) => `<option value="${f}" ${f === s.formation ? 'selected' : ''}>${f}</option>`)
      .join('');
    panel.innerHTML = `
      <div class="panel-head">
        <span class="side-tag side-${i}">${i === 0 ? 'Home' : 'Away'}</span>
        <button class="btn small ghost" data-act="random">Random team</button>
      </div>
      <div class="pickers">
        <div class="field">
          <label>League</label>
          <select data-act="league">
            <option value="">All leagues</option>
            ${db.leagues.map((l) => `<option ${l === s.league ? 'selected' : ''}>${esc(l)}</option>`).join('')}
          </select>
        </div>
        <div class="field grow">
          <label>Team</label>
          <select data-act="team">
            ${teams.map((t) => `<option value="${esc(t.key)}" ${t === s.team ? 'selected' : ''}>${esc(t.name)} · ${t.rating}${s.league ? '' : ` (${esc(t.league)})`}</option>`).join('')}
          </select>
        </div>
        <div class="field">
          <label>Formation</label>
          <select data-act="formation">${formOpts}</select>
        </div>
      </div>
      <div class="unit-row">
        ${unit('OVR', units.overall)}${unit('ATT', units.attack)}${unit('MID', units.midfield)}${unit('DEF', units.defence)}${unit('GK', units.goalkeeper)}
        <button class="btn small ghost" data-act="auto" title="Re-pick the best XI and bench for this formation">Auto-pick</button>
      </div>
      <div class="lineup">
        <div class="pitch">${pitchMarkings()}${s.xi.map((slot, k) => marker(i, slot, k)).join('')}</div>
        <div class="squad">
          <h3>Bench</h3>
          <ul>${s.subs.slice(0, BENCH_SIZE).map((p, k) => squadRow(i, p, k)).join('')}</ul>
          <h3>Reserves</h3>
          <ul class="reserves">${s.subs.slice(BENCH_SIZE).map((p, k) => squadRow(i, p, k + BENCH_SIZE)).join('') || '<li class="muted">None</li>'}</ul>
        </div>
      </div>`;
  }

  const unit = (label, v) => `<div class="unit"><span>${label}</span><b class="${ovrClass(v)}">${v}</b></div>`;

  function pitchMarkings() {
    return '<div class="pm-half"></div><div class="pm-circle"></div><div class="pm-box top"></div><div class="pm-box bottom"></div>';
  }

  function marker(i, slot, k) {
    const p = slot.player;
    const r = p.posRatings[slot.role];
    const sel = state.selected && state.selected.side === i && state.selected.kind === 'xi' && state.selected.index === k;
    const oop = r < p.ovr - 3;
    return `<button class="marker ${sel ? 'selected' : ''} side-${i}" style="left:${slot.x}%;bottom:${slot.y}%"
      data-kind="xi" data-index="${k}" title="${esc(p.fullName)} · ${p.pos} ${p.ovr} → ${slot.role} ${r}">
      <span class="m-dot ${oop ? 'oop' : ''}">${r}</span>
      <span class="m-name">${esc(p.name)}</span>
      <span class="m-role">${slot.role}</span>
    </button>`;
  }

  function squadRow(i, p, k) {
    const sel = state.selected && state.selected.side === i && state.selected.kind === 'sub' && state.selected.index === k;
    return `<li><button class="squad-row ${sel ? 'selected' : ''}" data-kind="sub" data-index="${k}" title="${esc(p.fullName)}${p.alts.length ? ` · also ${p.alts.join(', ')}` : ''}">
      <span class="pos pos-${F.groupOf(p.pos) || 'MID'}">${p.pos}</span>
      <span class="nm">${esc(p.name)}</span>
      <span class="ovr ${ovrClass(p.ovr)}">${p.ovr}</span>
    </button></li>`;
  }

  function ovrClass(v) {
    if (v >= 85) return 'q-elite';
    if (v >= 78) return 'q-high';
    if (v >= 70) return 'q-mid';
    if (v >= 62) return 'q-low';
    return 'q-poor';
  }

  function handleLineupClick(i, kind, index) {
    const s = state.sides[i];
    const sel = state.selected;
    if (!sel || sel.side !== i) {
      state.selected = { side: i, kind, index };
      if (sel && sel.side !== i) renderPanel(sel.side);
      renderPanel(i);
      return;
    }
    if (sel.kind === kind && sel.index === index) {
      state.selected = null;
      renderPanel(i);
      return;
    }
    const get = (k, idx) => (k === 'xi' ? s.xi[idx].player : s.subs[idx]);
    const put = (k, idx, p) => {
      if (k === 'xi') s.xi[idx] = { ...s.xi[idx], player: p };
      else s.subs[idx] = p;
    };
    const a = get(sel.kind, sel.index);
    const b = get(kind, index);
    put(sel.kind, sel.index, b);
    put(kind, index, a);
    state.selected = null;
    renderPanel(i);
  }

  function bindSetup() {
    document.querySelectorAll('.team-panel').forEach((panel) => {
      const i = Number(panel.dataset.side);
      panel.addEventListener('change', (e) => {
        const act = e.target.dataset.act;
        const s = state.sides[i];
        if (act === 'league') {
          s.league = e.target.value;
          const first = state.db.teams.find((t) => !s.league || t.league === s.league);
          if (s.league && s.team.league !== s.league) setTeam(i, first);
          else renderPanel(i);
        } else if (act === 'team') {
          setTeam(i, state.db.teamsByKey.get(e.target.value));
        } else if (act === 'formation') {
          changeFormation(i, e.target.value);
        }
        savePrefs();
      });
      panel.addEventListener('click', (e) => {
        const btn = e.target.closest('button');
        if (!btn) return;
        if (btn.dataset.act === 'random') {
          const s = state.sides[i];
          const pool = state.db.teams.filter((t) => !s.league || t.league === s.league);
          setTeam(i, pool[Math.floor(Math.random() * pool.length)]);
          savePrefs();
        } else if (btn.dataset.act === 'auto') {
          autoLineup(i);
        } else if (btn.dataset.kind) {
          handleLineupClick(i, btn.dataset.kind, Number(btn.dataset.index));
        }
      });
    });
    $('#kickoff').addEventListener('click', startMatch);
  }

  // ---- Match --------------------------------------------------------------------
  function startMatch() {
    const [h, a] = state.sides;
    if (h.team === a.team) {
      alert('Pick two different teams.');
      return;
    }
    const seedStr = $('#seed').value.trim();
    const seed = seedStr ? (/^\d+$/.test(seedStr) ? Number(seedStr) : OF.util.hashSeed(seedStr)) : Math.floor(Math.random() * 1e9);
    const cfg = (s) => ({ team: s.team, formation: s.formation, xi: s.xi, bench: s.subs.slice(0, BENCH_SIZE) });
    state.match = new OF.Match({ home: cfg(h), away: cfg(a), seed, homeAdvantage: $('#home-adv').checked });
    state.lastSeed = seed;
    state.paused = false;
    $('#setup').classList.add('hidden');
    $('#match').classList.remove('hidden');
    $('#final').classList.add('hidden');
    $('#report').classList.add('hidden');
    $('#rematch').classList.add('hidden');
    $('#pause').classList.remove('hidden');
    $('#skip').classList.remove('hidden');
    $('#live-speed').classList.remove('hidden');
    $('#feed').innerHTML = '';
    const m = state.match;
    $('#sb-home').textContent = h.team.name;
    $('#sb-away').textContent = a.team.name;
    $('#sb-home-meta').textContent = `${h.formation} · ${F.unitRatings(h.xi).overall} OVR`;
    $('#sb-away-meta').textContent = `${a.formation} · ${F.unitRatings(a.xi).overall} OVR`;
    const tabs = document.querySelectorAll('#rating-tabs .tab');
    tabs[0].textContent = h.team.name;
    tabs[1].textContent = a.team.name;
    const speed = Number($('#speed').value);
    if (speed > 0) $('#live-speed').value = String(speed);
    updateLive(m);
    window.scrollTo({ top: 0, behavior: 'smooth' });
    if (speed === 0) finishInstantly();
    else schedule();
  }

  function schedule() {
    clearTimeout(state.timer);
    const m = state.match;
    if (!m || m.finished || state.paused) return;
    state.timer = setTimeout(() => {
      tick();
      schedule();
    }, Number($('#live-speed').value));
  }

  function tick() {
    const m = state.match;
    const evs = m.step();
    for (const ev of evs) addFeed(ev, m);
    updateLive(m);
    if (m.finished) onFullTime();
  }

  function finishInstantly() {
    clearTimeout(state.timer);
    const m = state.match;
    const frag = [];
    while (!m.finished) frag.push(...m.step());
    for (const ev of frag) addFeed(ev, m);
    updateLive(m);
    onFullTime();
  }

  const KEY_TYPES = new Set(['goal', 'red', 'yellow', 'penalty', 'sub', 'injury', 'halftime', 'fulltime', 'kickoff']);
  const ICONS = { goal: '⚽', yellow: '🟨', red: '🟥', sub: '🔁', injury: '✚', penalty: '◎', save: '🧤', halftime: '⏸', fulltime: '⏹', kickoff: '▶' };

  function addFeed(ev, m) {
    const li = document.createElement('li');
    const key = KEY_TYPES.has(ev.type) || ev.big;
    li.className = `ev ev-${ev.type} ${ev.side === null ? 'neutral' : `side-${ev.side}`} ${key ? 'key' : 'minor'}`;
    li.innerHTML = `<span class="ev-min">${esc(ev.minute)}'</span><span class="ev-icon">${ICONS[ev.type] || ''}</span><span class="ev-text">${esc(ev.text)}</span>`;
    const feed = $('#feed');
    feed.insertBefore(li, feed.firstChild);
    if (ev.type === 'goal') {
      const b = $('.scoreboard');
      b.classList.remove('flash');
      void b.offsetWidth;
      b.classList.add('flash');
    }
  }

  function updateLive(m) {
    const [h, a] = m.sides;
    $('#sb-hs').textContent = h.score;
    $('#sb-as').textContent = a.score;
    $('#sb-clock').textContent = m.finished ? 'FT' : `${m.minuteLabel()}'`;
    $('#sb-progress').style.width = `${Math.min(100, ((m.half === 1 ? Math.min(m.minute, 45) : 45 + Math.min(m.minute - 45, 45)) / 90) * 100)}%`;
    for (const side of [0, 1]) {
      const list = m.goals.filter((g) => g.side === side).map((g) => `<li>${esc(g.scorer)} ${esc(g.minute)}'${g.kind === 'penalty' ? ' (pen)' : ''}</li>`);
      const reds = m.sides[side].all.filter((r) => r.sentOff).map((r) => `<li class="red-note">🟥 ${esc(r.p.name)}</li>`);
      $(side === 0 ? '#sb-home-scorers' : '#sb-away-scorers').innerHTML = list.concat(reds).join('');
    }
    renderStats(m);
    renderLiveRatings(m);
  }

  function renderStats(m) {
    const [h, a] = m.sides;
    const [ph, pa] = m.possessionPct();
    const acc = (s) => (s.stats.passes ? Math.round((s.stats.passOk / s.stats.passes) * 100) : 0);
    const rows = [
      ['Possession', ph, pa, (v) => `${v}%`],
      ['Shots', h.stats.shots, a.stats.shots],
      ['On target', h.stats.sot, a.stats.sot],
      ['Expected goals', h.stats.xg, a.stats.xg, (v) => v.toFixed(2)],
      ['Big chances', h.stats.bigChances, a.stats.bigChances],
      ['Passes', h.stats.passes, a.stats.passes],
      ['Pass accuracy', acc(h), acc(a), (v) => `${v}%`],
      ['Tackles won', h.stats.tackles, a.stats.tackles],
      ['Saves', h.stats.saves, a.stats.saves],
      ['Corners', h.stats.corners, a.stats.corners],
      ['Fouls', h.stats.fouls, a.stats.fouls],
      ['Offsides', h.stats.offsides, a.stats.offsides],
      ['Yellow cards', h.stats.yellows, a.stats.yellows],
      ['Red cards', h.stats.reds, a.stats.reds],
    ];
    $('#stats').innerHTML = rows.map(([label, x, y, fmt = (v) => v]) => {
      const tot = x + y;
      const px = tot ? (x / tot) * 100 : 50;
      return `<div class="stat">
        <div class="stat-vals"><b class="${x > y ? 'lead' : ''}">${fmt(x)}</b><span>${label}</span><b class="${y > x ? 'lead' : ''}">${fmt(y)}</b></div>
        <div class="stat-bar"><div class="sb-h" style="width:${px}%"></div><div class="sb-a" style="width:${100 - px}%"></div></div>
      </div>`;
    }).join('');
  }

  function ratingClass(r) {
    if (r >= 8) return 'r-great';
    if (r >= 7) return 'r-good';
    if (r >= 6.3) return 'r-ok';
    if (r >= 5.5) return 'r-meh';
    return 'r-bad';
  }

  function renderLiveRatings(m) {
    const side = m.sides[state.ratingTab];
    const rows = side.all
      .filter((r) => r.minuteOn !== null)
      .map((r) => {
        const rating = m.liveRating(r);
        const icons = [
          '⚽'.repeat(r.st.goals),
          r.st.assists ? `<span class="assist">A${r.st.assists > 1 ? r.st.assists : ''}</span>` : '',
          r.yellow && !r.sentOff ? '🟨' : '',
          r.sentOff ? '🟥' : '',
          r.injured ? '✚' : '',
          r.subbedOn ? `<span class="subin">▲${r.minuteOn}'</span>` : '',
          r.subbedOff ? `<span class="subout">▼${r.minuteOff}'</span>` : '',
        ].join('');
        return `<li class="${r.onPitch ? '' : 'off'}">
          <span class="pos pos-${r.group || 'MID'}">${r.role}</span>
          <span class="nm">${esc(r.p.name)} <span class="icons">${icons}</span></span>
          <span class="energy" title="Energy ${Math.round(r.energy)}%"><i class="${r.energy >= 75 ? 'e-high' : r.energy >= 55 ? 'e-mid' : 'e-low'}" style="width:${r.energy}%"></i></span>
          <span class="rating ${ratingClass(rating)}">${rating.toFixed(1)}</span>
        </li>`;
      });
    $('#live-ratings').innerHTML = `<ul class="rating-list">${rows.join('')}</ul>`;
  }

  function onFullTime() {
    clearTimeout(state.timer);
    const m = state.match;
    $('#pause').classList.add('hidden');
    $('#skip').classList.add('hidden');
    $('#live-speed').classList.add('hidden');
    $('#rematch').classList.remove('hidden');
    renderFinal(m);
    renderReport(m);
  }

  function renderFinal(m) {
    const [h, a] = m.sides;
    const motm = m.manOfTheMatch();
    const result = h.score === a.score ? 'Draw' : `${(h.score > a.score ? h : a).name} win`;
    const st = motm.st;
    const bits = [
      st.goals ? `${st.goals} goal${st.goals > 1 ? 's' : ''}` : '',
      st.assists ? `${st.assists} assist${st.assists > 1 ? 's' : ''}` : '',
      st.saves ? `${st.saves} saves` : '',
      st.tackles + st.interceptions >= 4 ? `${st.tackles + st.interceptions} tackles + interceptions` : '',
      st.keyPasses >= 2 ? `${st.keyPasses} key passes` : '',
      st.dribblesOk >= 2 ? `${st.dribblesOk} successful dribbles` : '',
    ].filter(Boolean).join(' · ');
    $('#final').innerHTML = `
      <div class="final-result">
        <span class="final-label">Full time</span>
        <strong>${esc(h.name)} ${h.score} – ${a.score} ${esc(a.name)}</strong>
        <span class="muted">${esc(result)} · xG ${h.stats.xg.toFixed(2)} – ${a.stats.xg.toFixed(2)} · seed ${state.lastSeed}</span>
      </div>
      <div class="motm">
        <span class="final-label">Player of the match</span>
        <strong>${esc(motm.player.fullName)}</strong>
        <span class="muted">${esc(m.sides[motm.side].name)} · ${esc(motm.pos)} · ${bits || 'all-round display'}</span>
        <span class="rating big ${ratingClass(motm.rating)}">${motm.rating.toFixed(1)}</span>
      </div>`;
    $('#final').classList.remove('hidden');
  }

  function renderReport(m) {
    const report = m.playerReport();
    const pct = (x, y) => (y ? `${Math.round((x / y) * 100)}%` : '–');
    const table = (list, side) => {
      const s = m.sides[side];
      const u = F.unitRatings(state.sides[side].xi);
      const teamRating = list.reduce((acc, r) => acc + r.rating * Math.max(r.minutes, 1), 0) / list.reduce((acc, r) => acc + Math.max(r.minutes, 1), 0);
      return `<div class="report-team">
        <div class="report-head">
          <h3><span class="side-tag side-${side}">${side === 0 ? 'Home' : 'Away'}</span> ${esc(s.name)}</h3>
          <div class="muted">${esc(s.formation)} · Pre-match OVR ${u.overall} (ATT ${u.attack} · MID ${u.midfield} · DEF ${u.defence} · GK ${u.goalkeeper}) · Team performance <b class="rating ${ratingClass(teamRating)}">${teamRating.toFixed(2)}</b></div>
        </div>
        <div class="table-wrap"><table>
          <thead><tr>
            <th class="l">Player</th><th>Pos</th><th>OVR</th><th title="Minutes">Min</th><th title="Goals">G</th><th title="Assists">A</th>
            <th title="Shots (on target)">Sh</th><th title="Expected goals">xG</th><th title="Key passes">KP</th><th title="Passes completed / attempted">Passes</th>
            <th title="Successful dribbles / attempted">Drb</th><th title="Tackles won">Tkl</th><th title="Interceptions">Int</th><th title="Clearances + blocks">Clr</th>
            <th title="Saves">Sv</th><th title="Fouls committed">Fls</th><th>Rating</th>
          </tr></thead>
          <tbody>${list.map((r) => `<tr class="${r.subOn !== null ? 'sub' : ''}">
            <td class="l">${esc(r.name)}${r.yellow && !r.sentOff ? ' 🟨' : ''}${r.sentOff ? ' 🟥' : ''}${r.injured ? ' ✚' : ''}${r.subOn !== null ? ` <span class="subin">▲${r.subOn}'</span>` : ''}${r.subOff !== null ? ` <span class="subout">▼${r.subOff}'</span>` : ''}</td>
            <td>${r.pos}</td><td>${r.ovr}</td><td>${r.minutes}</td><td>${r.st.goals || ''}</td><td>${r.st.assists || ''}</td>
            <td>${r.st.shots ? `${r.st.shots} (${r.st.sot})` : ''}</td><td>${r.st.xg ? r.st.xg.toFixed(2) : ''}</td><td>${r.st.keyPasses || ''}</td>
            <td>${r.st.passes ? `${r.st.passOk}/${r.st.passes} <span class="muted">${pct(r.st.passOk, r.st.passes)}</span>` : ''}</td>
            <td>${r.st.dribbles ? `${r.st.dribblesOk}/${r.st.dribbles}` : ''}</td><td>${r.st.tackles || ''}</td><td>${r.st.interceptions || ''}</td>
            <td>${r.st.clearances + r.st.blocks || ''}</td><td>${r.st.saves || ''}</td><td>${r.st.fouls || ''}</td>
            <td><span class="rating ${ratingClass(r.rating)}">${r.rating.toFixed(1)}</span></td>
          </tr>`).join('')}</tbody>
        </table></div>
      </div>`;
    };
    $('#report').innerHTML = `<h2>Match report</h2>${report.map((list, i) => table(list, i)).join('')}`;
    $('#report').classList.remove('hidden');
  }

  // ---- Match controls ---------------------------------------------------------
  $('#pause').addEventListener('click', () => {
    state.paused = !state.paused;
    $('#pause').textContent = state.paused ? 'Resume' : 'Pause';
    if (!state.paused) schedule();
  });
  $('#skip').addEventListener('click', finishInstantly);
  $('#live-speed').addEventListener('change', schedule);
  $('#back').addEventListener('click', () => {
    clearTimeout(state.timer);
    state.match = null;
    $('#match').classList.add('hidden');
    $('#setup').classList.remove('hidden');
    $('#pause').textContent = 'Pause';
  });
  $('#rematch').addEventListener('click', () => {
    $('#seed').value = '';
    $('#pause').textContent = 'Pause';
    startMatch();
  });
  $('#key-only').addEventListener('change', (e) => $('#feed').classList.toggle('key-only', e.target.checked));
  $('#rating-tabs').addEventListener('click', (e) => {
    const b = e.target.closest('.tab');
    if (!b) return;
    state.ratingTab = Number(b.dataset.side);
    document.querySelectorAll('#rating-tabs .tab').forEach((t) => t.classList.toggle('active', t === b));
    if (state.match) renderLiveRatings(state.match);
  });

  init();
})();

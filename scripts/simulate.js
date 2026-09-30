#!/usr/bin/env node
// Run the match engine from the command line.
//
//   node scripts/simulate.js "Real Madrid" "FC Barcelona"      # one match with commentary
//   node scripts/simulate.js --calibrate 500                   # aggregate stats over random matches
//
// Team names match the start of the club name (case-insensitive); add
// "|League" to disambiguate, e.g. "Deportivo Alavés|Liga F Moeve".
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
for (const f of ['util', 'csv', 'players', 'formations', 'commentary', 'engine']) {
  require(path.join(root, 'js', `${f}.js`));
}
const OF = globalThis.OF;

const db = OF.players.buildDatabase(OF.parseCSV(fs.readFileSync(path.join(root, 'players.csv'), 'utf8')));

function findTeam(q) {
  const [club, league] = q.toLowerCase().split('|');
  const t = db.teams.find((t) => t.name.toLowerCase() === club && (!league || t.league.toLowerCase() === league))
    || db.teams.find((t) => t.name.toLowerCase().startsWith(club) && (!league || t.league.toLowerCase().startsWith(league)));
  if (!t) throw new Error(`No team matching "${q}"`);
  return t;
}

function setup(team, formation) {
  const f = formation || OF.formations.bestFormation(team);
  const xi = OF.formations.pickStartingXI(team, f);
  return { team, formation: f, xi, bench: OF.formations.pickBench(team, xi) };
}

const args = process.argv.slice(2);
if (args[0] === '--calibrate') {
  const N = parseInt(args[1] || '300', 10);
  const rng = OF.util.makeRng(12345);
  const pool = db.teams.filter((t) => t.gender === "Men's Football");
  const acc = { goals: 0, shots: 0, sot: 0, xg: 0, corners: 0, fouls: 0, yellows: 0, reds: 0, passes: 0, passOk: 0, offsides: 0, draws: 0, homeWins: 0 };
  const byGap = {};
  const ratings = [];
  for (let i = 0; i < N; i++) {
    const h = rng.pick(pool);
    const a = rng.pick(pool);
    if (h === a) { i--; continue; }
    const m = new OF.Match({ home: setup(h), away: setup(a), seed: i + 1 });
    m.runToEnd();
    const [sh, sa] = m.sides;
    acc.goals += sh.score + sa.score;
    for (const s of m.sides) for (const k of ['shots', 'sot', 'xg', 'corners', 'fouls', 'yellows', 'reds', 'passes', 'passOk', 'offsides']) acc[k] += s.stats[k];
    if (sh.score === sa.score) acc.draws++;
    if (sh.score > sa.score) acc.homeWins++;
    const gap = Math.round((h.rating - a.rating) / 5) * 5;
    const g = (byGap[gap] = byGap[gap] || { n: 0, w: 0, d: 0, gf: 0, ga: 0, shots: 0, xg: 0 });
    g.shots += sh.stats.shots + sa.stats.shots;
    g.xg += sh.stats.xg + sa.stats.xg;
    g.n++;
    g.gf += sh.score;
    g.ga += sa.score;
    if (sh.score > sa.score) g.w++;
    else if (sh.score === sa.score) g.d++;
    for (const r of m.playerReport().flat()) if (r.minutes >= 45) ratings.push(r.rating);
  }
  const per = (k) => (acc[k] / N).toFixed(2);
  console.log(`Matches: ${N}`);
  console.log(`Goals/match ${per('goals')}  shots ${per('shots')}  on target ${per('sot')}  xG ${per('xg')}`);
  console.log(`Corners ${per('corners')}  fouls ${per('fouls')}  yellows ${per('yellows')}  reds ${per('reds')}  offsides ${per('offsides')}`);
  console.log(`Passes ${per('passes')}  accuracy ${((acc.passOk / acc.passes) * 100).toFixed(1)}%`);
  console.log(`Home win ${((acc.homeWins / N) * 100).toFixed(1)}%  draws ${((acc.draws / N) * 100).toFixed(1)}%`);
  console.log('Rating gap (home - away) -> home W/D/L %, avg score');
  for (const gap of Object.keys(byGap).map(Number).sort((x, y) => x - y)) {
    const g = byGap[gap];
    if (g.n < 5) continue;
    const pct = (x) => Math.round((x / g.n) * 100);
    console.log(`  ${String(gap).padStart(4)}: n=${String(g.n).padStart(4)}  ${pct(g.w)}/${pct(g.d)}/${pct(g.n - g.w - g.d)}  ${(g.gf / g.n).toFixed(2)}-${(g.ga / g.n).toFixed(2)}  shots ${(g.shots / g.n).toFixed(1)}  xG ${(g.xg / g.n).toFixed(2)}`);
  }
  ratings.sort((x, y) => x - y);
  const q = (p) => ratings[Math.floor(p * (ratings.length - 1))];
  console.log(`Player ratings: min ${q(0)}  p10 ${q(0.1)}  median ${q(0.5)}  p90 ${q(0.9)}  max ${q(1)}`);
} else {
  const home = findTeam(args[0] || 'Real Madrid');
  const away = findTeam(args[1] || 'FC Barcelona');
  const seed = args[2] ? parseInt(args[2], 10) : Math.floor(Math.random() * 1e9);
  const m = new OF.Match({ home: setup(home, args[3]), away: setup(away, args[4]), seed });
  for (const ev of m.runToEnd()) {
    if (ev.type === 'flavour' || ev.type === 'turnover') continue;
    console.log(`${ev.minute.padStart(5)}'  ${ev.text}`);
  }
  console.log();
  const stat = (k, f = (x) => x) => `${String(f(m.sides[0].stats[k])).padStart(6)}  ${k.padEnd(12)}${f(m.sides[1].stats[k])}`;
  console.log(`${m.sides[0].name} vs ${m.sides[1].name} (seed ${seed})`);
  console.log(`${String(m.sides[0].stats.possessionPct).padStart(6)}  possession  ${m.sides[1].stats.possessionPct}`);
  for (const k of ['shots', 'sot', 'corners', 'fouls', 'passes', 'saves']) console.log(stat(k));
  console.log(stat('xg', (x) => x.toFixed(2)));
  for (const side of m.playerReport()) {
    console.log();
    for (const r of side) console.log(`  ${r.rating.toFixed(1)}  ${r.pos.padEnd(4)} ${r.name}${r.st.goals ? `  ⚽x${r.st.goals}` : ''}${r.st.assists ? `  A${r.st.assists}` : ''}`);
  }
  const motm = m.manOfTheMatch();
  console.log(`\nPlayer of the match: ${motm.name} (${motm.rating.toFixed(1)})`);
}

// Formations, automatic starting XI / bench selection, and team ratings.
(function (root) {
  const OF = (root.OF = root.OF || {});
  const { avg, blend } = OF.util;

  // x: 0 (left touchline) .. 100 (right); y: 0 (own goal) .. 100 (opponent goal).
  const FORMATIONS = {
    '4-4-2': [
      ['GK', 50, 8], ['LB', 12, 25], ['CB', 37, 20], ['CB', 63, 20], ['RB', 88, 25],
      ['LM', 12, 55], ['CM', 37, 50], ['CM', 63, 50], ['RM', 88, 55], ['ST', 37, 82], ['ST', 63, 82],
    ],
    '4-3-3': [
      ['GK', 50, 8], ['LB', 12, 25], ['CB', 37, 20], ['CB', 63, 20], ['RB', 88, 25],
      ['CM', 25, 50], ['CDM', 50, 42], ['CM', 75, 50], ['LW', 15, 78], ['ST', 50, 85], ['RW', 85, 78],
    ],
    '4-2-3-1': [
      ['GK', 50, 8], ['LB', 12, 25], ['CB', 37, 20], ['CB', 63, 20], ['RB', 88, 25],
      ['CDM', 35, 42], ['CDM', 65, 42], ['LM', 15, 65], ['CAM', 50, 65], ['RM', 85, 65], ['ST', 50, 86],
    ],
    '4-1-2-1-2': [
      ['GK', 50, 8], ['LB', 12, 25], ['CB', 37, 20], ['CB', 63, 20], ['RB', 88, 25],
      ['CDM', 50, 38], ['CM', 28, 52], ['CM', 72, 52], ['CAM', 50, 65], ['ST', 35, 84], ['ST', 65, 84],
    ],
    '4-1-4-1': [
      ['GK', 50, 8], ['LB', 12, 25], ['CB', 37, 20], ['CB', 63, 20], ['RB', 88, 25],
      ['CDM', 50, 38], ['LM', 12, 60], ['CM', 37, 56], ['CM', 63, 56], ['RM', 88, 60], ['ST', 50, 85],
    ],
    '4-3-2-1': [
      ['GK', 50, 8], ['LB', 12, 25], ['CB', 37, 20], ['CB', 63, 20], ['RB', 88, 25],
      ['CM', 25, 47], ['CM', 50, 44], ['CM', 75, 47], ['CF', 33, 70], ['CF', 67, 70], ['ST', 50, 86],
    ],
    '3-5-2': [
      ['GK', 50, 8], ['CB', 25, 20], ['CB', 50, 18], ['CB', 75, 20],
      ['CDM', 37, 42], ['CDM', 63, 42], ['LM', 10, 55], ['CAM', 50, 64], ['RM', 90, 55], ['ST', 37, 84], ['ST', 63, 84],
    ],
    '3-4-3': [
      ['GK', 50, 8], ['CB', 25, 20], ['CB', 50, 18], ['CB', 75, 20],
      ['LM', 10, 50], ['CM', 37, 48], ['CM', 63, 48], ['RM', 90, 50], ['LW', 18, 78], ['ST', 50, 86], ['RW', 82, 78],
    ],
    '5-3-2': [
      ['GK', 50, 8], ['LWB', 8, 32], ['CB', 28, 20], ['CB', 50, 18], ['CB', 72, 20], ['RWB', 92, 32],
      ['CM', 28, 50], ['CM', 50, 46], ['CM', 72, 50], ['ST', 37, 82], ['ST', 63, 82],
    ],
    '5-2-1-2': [
      ['GK', 50, 8], ['LWB', 8, 32], ['CB', 28, 20], ['CB', 50, 18], ['CB', 72, 20], ['RWB', 92, 32],
      ['CM', 35, 48], ['CM', 65, 48], ['CAM', 50, 64], ['ST', 37, 84], ['ST', 63, 84],
    ],
  };

  const GROUP = {
    GK: 'GK', CB: 'DEF', LB: 'DEF', RB: 'DEF', LWB: 'DEF', RWB: 'DEF',
    CDM: 'MID', CM: 'MID', CAM: 'MID', LM: 'MID', RM: 'MID',
    LW: 'ATT', RW: 'ATT', CF: 'ATT', ST: 'ATT',
  };

  const groupOf = (role) => GROUP[role];

  function slotsFor(formation) {
    return FORMATIONS[formation].map(([role, x, y], i) => ({ idx: i, role, x, y, group: GROUP[role] }));
  }

  // Assign players to formation slots maximising the summed position ratings.
  // Greedy fill (hardest slots first) followed by pairwise-swap hill climbing,
  // which is near-optimal for 11 slots and quick enough to run on every change.
  function pickStartingXI(team, formation) {
    const slots = slotsFor(formation);
    const pool = team.players.slice();
    const assign = new Array(slots.length).fill(null);
    const used = new Set();
    const order = slots
      .map((s) => s.idx)
      .sort((a, b) => {
        const best = (s) => Math.max(...pool.map((p) => p.posRatings[slots[s].role]));
        const scarcity = (s) => (slots[s].role === 'GK' ? -1000 : 0) - best(s);
        return scarcity(a) - scarcity(b);
      });
    for (const si of order) {
      let best = null;
      for (const p of pool) {
        if (used.has(p.id)) continue;
        if (!best || p.posRatings[slots[si].role] > best.posRatings[slots[si].role]) best = p;
      }
      assign[si] = best;
      used.add(best.id);
    }
    // Hill climb: swap two slots, or swap a starter for an unused player.
    let improved = true;
    let guard = 0;
    while (improved && guard++ < 50) {
      improved = false;
      for (let i = 0; i < slots.length; i++) {
        for (let j = i + 1; j < slots.length; j++) {
          const cur = assign[i].posRatings[slots[i].role] + assign[j].posRatings[slots[j].role];
          const sw = assign[j].posRatings[slots[i].role] + assign[i].posRatings[slots[j].role];
          if (sw > cur) {
            [assign[i], assign[j]] = [assign[j], assign[i]];
            improved = true;
          }
        }
        for (const p of pool) {
          if (used.has(p.id)) continue;
          if (p.posRatings[slots[i].role] > assign[i].posRatings[slots[i].role]) {
            used.delete(assign[i].id);
            assign[i] = p;
            used.add(p.id);
            improved = true;
          }
        }
      }
    }
    return slots.map((s, i) => ({ ...s, player: assign[i] }));
  }

  // Seven substitutes: a keeper, then cover for each line, then best available.
  function pickBench(team, xi, size = 7) {
    const used = new Set(xi.map((s) => s.player.id));
    const rest = team.players.filter((p) => !used.has(p.id));
    const bench = [];
    const take = (pred) => {
      const cand = rest
        .filter((p) => !bench.includes(p) && pred(p))
        .sort((a, b) => b.ovr - a.ovr)[0];
      if (cand) bench.push(cand);
    };
    take((p) => p.pos === 'GK');
    const def = (p) => ['CB', 'LB', 'RB'].includes(p.pos);
    const mid = (p) => ['CDM', 'CM', 'CAM', 'LM', 'RM'].includes(p.pos);
    const att = (p) => ['ST', 'LW', 'RW'].includes(p.pos);
    take(def); take(mid); take(att);
    take(def); take(mid); take(att);
    while (bench.length < size) {
      const before = bench.length;
      take((p) => p.pos !== 'GK');
      if (bench.length === before) break;
    }
    return bench.slice(0, size);
  }

  function lineupRating(xi) {
    return avg(xi.map((s) => s.player.posRatings[s.role]));
  }

  // Try every formation and return the one with the strongest XI.
  function bestFormation(team) {
    let best = null;
    for (const f of Object.keys(FORMATIONS)) {
      const r = lineupRating(pickStartingXI(team, f));
      if (!best || r > best.r + 0.05) best = { f, r };
    }
    return best.f;
  }

  // Headline unit ratings (shown in the UI and used by the engine as a base).
  function unitRatings(xi) {
    const eff = (s) => s.player.posRatings[s.role];
    const g = (grp) => xi.filter((s) => s.group === grp);
    const attackers = xi.filter((s) => s.group === 'ATT' || s.role === 'CAM' || s.role === 'LM' || s.role === 'RM');
    const attack = avg(attackers.map((s) =>
      blend(s.player.a, { finishing: 3, positioning: 2, dribbling: 2, ballControl: 1, accel: 1, shotPower: 1 }) * 0.5 + eff(s) * 0.5));
    const mids = g('MID');
    const midfield = avg(mids.map(eff));
    const defenders = g('DEF').concat(xi.filter((s) => s.role === 'CDM'));
    const defence = avg(defenders.map((s) =>
      blend(s.player.a, { awareness: 3, standTackle: 3, interceptions: 2, strength: 1, heading: 1 }) * 0.5 + eff(s) * 0.5));
    const gk = xi.find((s) => s.role === 'GK');
    return {
      overall: Math.round(lineupRating(xi)),
      attack: Math.round(attack),
      midfield: Math.round(midfield),
      defence: Math.round(defence),
      goalkeeper: gk ? gk.player.posRatings.GK : 0,
    };
  }

  OF.formations = { FORMATIONS, slotsFor, groupOf, pickStartingXI, pickBench, lineupRating, bestFormation, unitRatings };
})(typeof globalThis !== 'undefined' ? globalThis : this);

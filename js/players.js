// Turns raw CSV rows into player objects, computes how well each player fits
// every position, and groups players into teams (club + league).
(function (root) {
  const OF = (root.OF = root.OF || {});
  const { blend, clamp } = OF.util;

  // CSV column -> short attribute key used by the engine.
  const ATTR_MAP = {
    attacking_crossing: 'crossing',
    attacking_finishing: 'finishing',
    attacking_heading_accuracy: 'heading',
    attacking_short_passing: 'shortPass',
    attacking_volleys: 'volleys',
    skill_dribbling: 'dribbling',
    skill_curve: 'curve',
    skill_fk_accuracy: 'fk',
    skill_long_passing: 'longPass',
    skill_ball_control: 'ballControl',
    movement_acceleration: 'accel',
    movement_sprint_speed: 'sprint',
    movement_agility: 'agility',
    movement_reactions: 'reactions',
    movement_balance: 'balance',
    power_shot_power: 'shotPower',
    power_jumping: 'jumping',
    power_stamina: 'stamina',
    power_strength: 'strength',
    power_long_shots: 'longShots',
    mentality_aggression: 'aggression',
    mentality_interceptions: 'interceptions',
    mentality_positioning: 'positioning',
    mentality_vision: 'vision',
    mentality_penalties: 'penalties',
    mentality_composure: 'composure',
    defending_awareness: 'awareness',
    defending_standing_tackle: 'standTackle',
    defending_sliding_tackle: 'slideTackle',
    goalkeeping_diving: 'gkDiving',
    goalkeeping_handling: 'gkHandling',
    goalkeeping_kicking: 'gkKicking',
    goalkeeping_positioning: 'gkPositioning',
    goalkeeping_reflexes: 'gkReflexes',
  };

  // Attribute weightings per position, loosely modelled on how FC position
  // ratings are derived. Weights are normalised by blend(), so they needn't sum to 1.
  const POS_WEIGHTS = {
    GK: { gkDiving: 21, gkHandling: 21, gkKicking: 5, gkPositioning: 21, gkReflexes: 21, reactions: 11 },
    CB: { sprint: 2, jumping: 3, strength: 10, reactions: 5, aggression: 7, interceptions: 13, ballControl: 4, heading: 10, shortPass: 5, awareness: 14, standTackle: 17, slideTackle: 10 },
    FB: { accel: 5, sprint: 7, stamina: 8, reactions: 8, interceptions: 12, ballControl: 8, crossing: 9, heading: 4, shortPass: 7, awareness: 11, standTackle: 11, slideTackle: 10 },
    WB: { accel: 4, sprint: 6, stamina: 10, reactions: 8, interceptions: 12, ballControl: 8, crossing: 12, dribbling: 4, shortPass: 10, awareness: 7, standTackle: 8, slideTackle: 11 },
    CDM: { shortPass: 14, longPass: 10, interceptions: 14, awareness: 14, standTackle: 12, slideTackle: 5, ballControl: 10, reactions: 7, vision: 4, strength: 6, stamina: 6, aggression: 5 },
    CM: { shortPass: 17, longPass: 13, vision: 13, ballControl: 14, dribbling: 7, reactions: 8, interceptions: 5, positioning: 6, standTackle: 5, stamina: 6, longShots: 4 },
    CAM: { shortPass: 16, vision: 14, ballControl: 15, dribbling: 13, positioning: 9, reactions: 7, finishing: 7, longShots: 5, shotPower: 5, agility: 3, accel: 4 },
    WM: { crossing: 10, dribbling: 15, ballControl: 13, shortPass: 11, vision: 7, accel: 7, sprint: 6, stamina: 5, reactions: 7, positioning: 8, finishing: 6, longPass: 5 },
    W: { crossing: 9, dribbling: 16, ballControl: 14, finishing: 10, positioning: 9, shortPass: 9, vision: 6, accel: 7, sprint: 6, agility: 3, reactions: 7, longShots: 4 },
    CF: { finishing: 11, positioning: 13, heading: 2, shotPower: 5, reactions: 9, dribbling: 14, ballControl: 15, longShots: 4, accel: 5, sprint: 5, shortPass: 9, vision: 8 },
    ST: { finishing: 18, positioning: 13, heading: 10, shotPower: 10, reactions: 8, dribbling: 7, ballControl: 10, volleys: 2, longShots: 3, accel: 4, sprint: 5, strength: 5, shortPass: 5 },
  };

  // Every slot role a formation may use -> the weighting profile it relies on.
  const ROLE_PROFILE = {
    GK: 'GK', CB: 'CB', LB: 'FB', RB: 'FB', LWB: 'WB', RWB: 'WB',
    CDM: 'CDM', CM: 'CM', CAM: 'CAM', LM: 'WM', RM: 'WM', LW: 'W', RW: 'W', CF: 'CF', ST: 'ST',
  };

  // Positions a player is "familiar" with when their card lists a related one.
  const RELATED = {
    GK: [],
    CB: ['CDM'],
    LB: ['LWB', 'LM', 'CB'],
    RB: ['RWB', 'RM', 'CB'],
    LWB: ['LB', 'LM'],
    RWB: ['RB', 'RM'],
    CDM: ['CM', 'CB'],
    CM: ['CDM', 'CAM'],
    CAM: ['CM', 'CF'],
    LM: ['LW', 'LWB'],
    RM: ['RW', 'RWB'],
    LW: ['LM', 'LF'],
    RW: ['RM', 'RF'],
    CF: ['ST', 'CAM'],
    ST: ['CF'],
  };

  // Slot roles map onto a card position for familiarity purposes.
  const ROLE_AS_CARD = { LWB: 'LB', RWB: 'RB', CF: 'ST' };

  function toInt(v) {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : 0;
  }

  function ageFrom(birthdate, refDate) {
    if (!birthdate) return null;
    const b = new Date(birthdate);
    const r = new Date(refDate || '2026-09-12');
    if (isNaN(b)) return null;
    let age = r.getFullYear() - b.getFullYear();
    const m = r.getMonth() - b.getMonth();
    if (m < 0 || (m === 0 && r.getDate() < b.getDate())) age--;
    return age;
  }

  function parsePlaystyles(str) {
    if (!str) return [];
    return str
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => ({ name: s.replace(/\+$/, ''), plus: s.endsWith('+') }));
  }

  function buildPlayer(row) {
    const a = {};
    for (const col in ATTR_MAP) a[ATTR_MAP[col]] = toInt(row[col]);
    const pos = row.position;
    a.pace = toInt(row.pace);
    const playstyles = parsePlaystyles(row.playstyles);
    const ps = {};
    for (const s of playstyles) ps[s.name] = s.plus ? 2 : 1;
    const shortName = row.common_name || row.last_name || row.first_name;
    const p = {
      id: row.player_id,
      name: shortName,
      fullName: row.common_name || [row.first_name, row.last_name].filter(Boolean).join(' '),
      firstName: row.first_name,
      pos,
      alts: (row.alternate_positions || '').split(/\s+/).filter(Boolean),
      club: row.club,
      league: row.league,
      nation: row.nationality,
      gender: row.gender,
      foot: row.preferred_foot,
      skillMoves: toInt(row.skill_moves),
      weakFoot: toInt(row.weak_foot),
      age: ageFrom(row.birthdate, row.snapshot_date),
      ovr: toInt(row.overall_rating),
      face: {
        pac: toInt(row.pace), sho: toInt(row.shooting), pas: toInt(row.passing),
        dri: toInt(row.dribbling), def: toInt(row.defending), phy: toInt(row.physicality),
      },
      playstyles,
      ps, // lookup: playstyle name -> 1 (regular) or 2 (PlayStyle+)
      a,
    };
    p.posRatings = computePositionRatings(p);
    return p;
  }

  function rawRoleRating(p, role) {
    return blend(p.a, POS_WEIGHTS[ROLE_PROFILE[role]]);
  }

  // Rating for every slot role. The player's natural position is anchored to
  // their card overall; other roles are shifted by the same offset, then
  // penalised by how unfamiliar the role is.
  function computePositionRatings(p) {
    const natRole = ROLE_PROFILE[p.pos] ? p.pos : 'CM';
    const offset = p.ovr - rawRoleRating(p, natRole);
    const out = {};
    for (const role in ROLE_PROFILE) {
      const card = ROLE_AS_CARD[role] || role;
      let r = rawRoleRating(p, role) + offset;
      if (card === p.pos || role === p.pos) {
        r = Math.max(r, p.ovr - (role !== card ? 1 : 0));
      } else if (p.alts.includes(card) || p.alts.includes(role)) {
        r -= 1;
      } else if ((RELATED[role] || []).some((x) => x === p.pos || p.alts.includes(x))) {
        r -= 4;
      } else {
        r -= 9;
      }
      // Outfielders in goal (or keepers outfield) are a disaster.
      if ((role === 'GK') !== (p.pos === 'GK')) r = Math.min(r, p.pos === 'GK' ? 30 : 25 + p.a.gkDiving * 0.2);
      out[role] = Math.round(clamp(r, 1, 99));
    }
    return out;
  }

  // Placeholder for squads too small to name a full matchday squad.
  function makeYouthPlayer(teamKey, idx, level, pos) {
    const v = Math.max(35, level);
    const a = {};
    for (const k of Object.values(ATTR_MAP)) a[k] = v;
    if (pos === 'GK') {
      for (const k of ['gkDiving', 'gkHandling', 'gkKicking', 'gkPositioning', 'gkReflexes']) a[k] = v;
      for (const k of Object.values(ATTR_MAP)) if (!k.startsWith('gk') && k !== 'reactions') a[k] = Math.round(v * 0.5);
    } else {
      for (const k of ['gkDiving', 'gkHandling', 'gkKicking', 'gkPositioning', 'gkReflexes']) a[k] = 10;
    }
    a.pace = v;
    const p = {
      id: `youth-${teamKey}-${idx}`,
      name: `Academy ${pos} ${idx + 1}`,
      fullName: `Academy ${pos} ${idx + 1}`,
      pos, alts: [], club: '', league: '', nation: '', gender: '', foot: 'Right',
      skillMoves: 2, weakFoot: 2, age: 18, ovr: v,
      face: { pac: v, sho: v, pas: v, dri: v, def: v, phy: v },
      playstyles: [], ps: {}, a, youth: true,
    };
    p.posRatings = computePositionRatings(p);
    return p;
  }

  function buildDatabase(rows) {
    const players = rows.filter((r) => r.player_id && r.club).map(buildPlayer);
    const teamsByKey = new Map();
    for (const p of players) {
      const key = `${p.club}|${p.league}`;
      let t = teamsByKey.get(key);
      if (!t) {
        t = { key, name: p.club, league: p.league, gender: p.gender, players: [] };
        teamsByKey.set(key, t);
      }
      t.players.push(p);
    }
    const teams = [...teamsByKey.values()];
    for (const t of teams) {
      t.players.sort((x, y) => y.ovr - x.ovr);
      disambiguateNames(t.players);
      padSquad(t);
      const top = t.players.slice(0, 16).map((p) => p.ovr);
      t.rating = Math.round(top.reduce((s, x) => s + x, 0) / top.length);
    }
    teams.sort((x, y) => y.rating - x.rating || x.name.localeCompare(y.name));
    const leagues = [...new Set(teams.map((t) => t.league))].sort((x, y) => x.localeCompare(y));
    return { players, teams, leagues, teamsByKey };
  }

  // Two players called "Silva" in one squad get initials: "J. Silva".
  function disambiguateNames(list) {
    const counts = {};
    for (const p of list) counts[p.name] = (counts[p.name] || 0) + 1;
    for (const p of list) {
      if (counts[p.name] > 1 && p.firstName && p.name !== p.firstName) p.name = `${p.firstName[0]}. ${p.name}`;
    }
  }

  // Guarantee at least 2 keepers and 18 players by adding academy call-ups.
  function padSquad(t) {
    const level = Math.round(t.players[t.players.length - 1].ovr - 4);
    let idx = 0;
    while (t.players.filter((p) => p.pos === 'GK').length < 2) t.players.push(makeYouthPlayer(t.key, idx++, level, 'GK'));
    const fill = ['CB', 'CM', 'ST', 'LB', 'RB', 'CDM', 'RM', 'LM'];
    let f = 0;
    while (t.players.length < 18) t.players.push(makeYouthPlayer(t.key, idx++, level, fill[f++ % fill.length]));
  }

  OF.players = { buildDatabase, buildPlayer, computePositionRatings, ROLE_PROFILE, POS_WEIGHTS };
})(typeof globalThis !== 'undefined' ? globalThis : this);

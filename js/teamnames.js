// Match team names from results/fixtures files (football-data.co.uk style)
// to teams in players.csv.
(function (root) {
  const OF = (root.OF = root.OF || {});

  // Known spellings that differ from the FC 27 club names.
  const ALIASES = {
    'man city': 'Manchester City',
    'man united': 'Man Utd',
    'man utd': 'Man Utd',
    'manchester united': 'Man Utd',
    tottenham: 'Spurs',
    'tottenham hotspur': 'Spurs',
    newcastle: 'Newcastle Utd',
    'newcastle united': 'Newcastle Utd',
    bournemouth: 'AFC Bournemouth',
    leeds: 'Leeds United',
    coventry: 'Coventry City',
    hull: 'Hull City',
    wolves: 'Wolves',
    wolverhampton: 'Wolves',
    'nottingham forest': "Nott'm Forest",
    'nottm forest': "Nott'm Forest",
    leicester: 'Leicester City',
    'west ham united': 'West Ham',
    'brighton and hove albion': 'Brighton',
    'sheffield united': 'Sheffield Utd',
    'sheffield weds': 'Sheffield Wed',
  };

  const norm = (s) => s.toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/&/g, 'and').replace(/[^a-z0-9' ]/g, ' ').replace(/\s+/g, ' ').trim();
  const core = (s) => norm(s).replace(/\b(fc|afc|cf|the)\b/g, '').replace(/\s+/g, ' ').trim();

  // Returns the best team for a name, preferring the given league and
  // men's/women's football to match. null if nothing plausible is found.
  function resolveTeam(db, name, preferLeague, gender = "Men's Football") {
    const n = norm(name);
    const target = ALIASES[n] ? norm(ALIASES[n]) : n;
    const pool = db.teams.filter((t) => !gender || t.gender === gender);
    const rank = (list) => list.sort((a, b) => (b.league === preferLeague) - (a.league === preferLeague) || b.rating - a.rating)[0] || null;
    return rank(pool.filter((t) => norm(t.name) === target))
      || rank(pool.filter((t) => core(t.name) === core(target)))
      || rank(pool.filter((t) => core(t.name).startsWith(core(target)) || core(target).startsWith(core(t.name))));
  }

  OF.resolveTeam = resolveTeam;
})(typeof globalThis !== 'undefined' ? globalThis : this);

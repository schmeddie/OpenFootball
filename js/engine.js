// Minute-by-minute match simulation. Every duel, pass, shot and save is
// resolved from the players' FC attributes (plus PlayStyles, position fit and
// fatigue), and each action feeds player stats that drive match ratings.
(function (root) {
  const OF = (root.OF = root.OF || {});
  const { makeRng, clamp, logistic, blend } = OF.util;
  // Fast mode swaps commentary for no-ops: bulk simulations only need results.
  let QUIET = null;
  const quietCommentary = () => QUIET || (QUIET = Object.fromEntries(Object.keys(OF.commentary).map((k) => [k, () => ''])));

  const MAX_SUBS = 5;
  // Calibration knobs, fitted against real results (see scripts/backtest.js).
  const TUNING = {
    duel: 40, // attribute points per unit of log-odds in a duel (higher = skill matters less)
    possessionScale: 20, // same idea for who controls each minute
    finishScale: 70, // shooter-vs-keeper skill gap per unit of log goal probability
    attackRate: 0.55, // base chance a minute of possession becomes an attack
    involveExp: 2, // how strongly the most skilled players dominate the ball
    homeAdvantage: 5, // control points added to the home side
    xgMult: 1, // scales the quality of every chance
    formSd: 0, // per-match form: spread of a random multiplier on each team's ability
    gameState: 0.08, // how much a lead makes teams sit back (and a late level score makes them cautious)
  };
  const T = TUNING;
  const SUB_WINDOWS = 3;

  // ---- Skill composites -----------------------------------------------------
  // Each composite blends raw attributes, then adds PlayStyle bonuses
  // (+2 for a PlayStyle, +4 for a PlayStyle+).
  const SKILLS = {
    pass: [{ shortPass: 35, vision: 25, ballControl: 15, composure: 15, reactions: 10 }, ['Tiki Taka', 'Incisive Pass', 'Pinged Pass']],
    press: [{ interceptions: 35, awareness: 25, standTackle: 20, aggression: 10, reactions: 10 }, ['Intercept', 'Anticipate']],
    retain: [{ ballControl: 35, composure: 25, strength: 15, balance: 15, agility: 10 }, ['Press Proven', 'First Touch']],
    dribble: [{ dribbling: 35, ballControl: 20, agility: 15, accel: 15, balance: 10, reactions: 5 }, ['Technical', 'Trickster', 'Rapid', 'Quick Step', 'First Touch']],
    tackle: [{ standTackle: 30, awareness: 25, slideTackle: 10, sprint: 15, strength: 10, reactions: 10 }, ['Jockey', 'Slide Tackle', 'Anticipate', 'Bruiser']],
    create: [{ vision: 40, shortPass: 25, longPass: 15, curve: 10, composure: 10 }, ['Incisive Pass', 'Pinged Pass', 'Long Ball Pass']],
    run: [{ positioning: 35, accel: 25, sprint: 20, reactions: 20 }, ['Rapid', 'Quick Step']],
    line: [{ awareness: 35, interceptions: 25, sprint: 20, reactions: 20 }, ['Intercept', 'Anticipate', 'Block']],
    cross: [{ crossing: 60, curve: 20, vision: 10, longPass: 10 }, ['Whipped Pass']],
    aerialAtt: [{ heading: 45, jumping: 30, strength: 15, positioning: 10 }, ['Precision Header', 'Aerial Fortress']],
    aerialDef: [{ heading: 35, jumping: 30, strength: 20, awareness: 15 }, ['Aerial Fortress']],
    finish: [{ finishing: 45, composure: 20, reactions: 15, positioning: 10, shotPower: 10 }, ['Finesse Shot', 'Low Driven Shot', 'Power Shot', 'Chip Shot', 'Gamechanger']],
    headerShot: [{ heading: 60, positioning: 20, jumping: 10, strength: 10 }, ['Precision Header']],
    longShot: [{ longShots: 50, shotPower: 30, curve: 10, composure: 10 }, ['Power Shot', 'Finesse Shot', 'Low Driven Shot']],
    freeKick: [{ fk: 60, curve: 30, shotPower: 10 }, ['Dead Ball']],
    penalty: [{ penalties: 70, composure: 30 }, ['Dead Ball']],
    block: [{ awareness: 40, standTackle: 20, reactions: 20, strength: 20 }, ['Block']],
    gkShot: [{ gkReflexes: 35, gkDiving: 30, gkPositioning: 20, gkHandling: 15 }, ['Far Reach', 'Deflector']],
    gkOneOnOne: [{ gkReflexes: 35, gkPositioning: 30, gkDiving: 20, reactions: 15 }, ['Rush Out', 'Far Reach']],
    gkCross: [{ gkHandling: 40, gkPositioning: 35, jumping: 10, reactions: 15 }, ['Cross Claimer']],
    gkPenalty: [{ gkDiving: 50, gkReflexes: 30, gkPositioning: 20 }, ['Far Reach']],
    foulRisk: [{ aggression: 60, slideTackle: 20, strength: 20 }, []],
  };

  // Which slot roles take part in which kind of action, and how much.
  const INVOLVE = {
    buildUp: { GK: 0.15, CB: 0.7, LB: 0.8, RB: 0.8, LWB: 0.9, RWB: 0.9, CDM: 1.3, CM: 1.5, CAM: 1.1, LM: 0.9, RM: 0.9, LW: 0.5, RW: 0.5, CF: 0.6, ST: 0.3 },
    press: { CB: 0.3, LB: 0.4, RB: 0.4, LWB: 0.6, RWB: 0.6, CDM: 1.5, CM: 1.3, CAM: 0.7, LM: 0.8, RM: 0.8, LW: 0.5, RW: 0.5, CF: 0.5, ST: 0.4 },
    create: { CB: 0.1, LB: 0.3, RB: 0.3, LWB: 0.4, RWB: 0.4, CDM: 0.5, CM: 1.1, CAM: 1.6, LM: 0.9, RM: 0.9, LW: 1.0, RW: 1.0, CF: 1.2, ST: 0.5 },
    run: { LB: 0.1, RB: 0.1, LWB: 0.2, RWB: 0.2, CM: 0.3, CAM: 0.8, LM: 0.8, RM: 0.8, LW: 1.25, RW: 1.25, CF: 1.3, ST: 1.3 },
    dribble: { LB: 0.3, RB: 0.3, LWB: 0.5, RWB: 0.5, CDM: 0.1, CM: 0.4, CAM: 1.0, LM: 1.1, RM: 1.1, LW: 1.5, RW: 1.5, CF: 1.2, ST: 1.0 },
    cross: { LB: 0.9, RB: 0.9, LWB: 1.2, RWB: 1.2, CM: 0.2, CAM: 0.2, LM: 1.4, RM: 1.4, LW: 1.2, RW: 1.2 },
    aerial: { CB: 0.35, CDM: 0.2, CM: 0.3, CAM: 0.4, LM: 0.3, RM: 0.3, LW: 0.45, RW: 0.45, CF: 0.9, ST: 1.3 },
    longShot: { CB: 0.1, LB: 0.15, RB: 0.15, CDM: 0.5, CM: 1.0, CAM: 1.2, LM: 0.6, RM: 0.6, LW: 0.8, RW: 0.8, CF: 1.0, ST: 0.7 },
    defend: { CB: 1.6, LB: 1.0, RB: 1.0, LWB: 0.9, RWB: 0.9, CDM: 1.0, CM: 0.4, CAM: 0.1, LM: 0.3, RM: 0.3 },
    defendAerial: { CB: 1.8, LB: 0.5, RB: 0.5, LWB: 0.4, RWB: 0.4, CDM: 0.8, CM: 0.3, ST: 0.2 },
  };

  class Match {
    // fast: skip commentary and the event log (results and stats are unaffected
    // in distribution, though a seed won't replay the same match in both modes).
    // knockout: a draw goes to extra time and then penalties.
    // strengths: optional [home, away] multipliers on each team's ability,
    // e.g. from how they've performed against their ratings this season.
    constructor({ home, away, seed, homeAdvantage = true, fast = false, knockout = false, strengths = null }) {
      this.seed = seed >>> 0;
      this.fast = fast;
      this.knockout = knockout;
      this.C = fast ? quietCommentary() : OF.commentary;
      this.tick = 0; // bumps every simulated minute; invalidates per-minute caches
      this.ver = 0; // bumps whenever who's on the pitch (or where) changes
      this.rng = makeRng(this.seed);
      this.homeAdvantage = homeAdvantage;
      this.sides = [this.buildSide(home, 0), this.buildSide(away, 1)];
      this.minute = 0;
      this.half = 1;
      this.stoppage = [this.rng.int(1, 4), this.rng.int(2, 6), this.rng.int(0, 2), this.rng.int(1, 3)];
      // Each team's form on the day: everything the ratings can't know
      // (tactics, confidence, niggles, luck), as a multiplier on ability.
      for (const side of this.sides) {
        const g = Math.sqrt(-2 * Math.log(1 - this.rng())) * Math.cos(2 * Math.PI * this.rng());
        side.form = clamp(1 + g * T.formSd, 0.85, 1.15) * (strengths ? strengths[side.idx] || 1 : 1);
      }
      this.shootout = null;
      this.finished = false;
      this.events = [];
      this.goals = [];
    }

    buildSide(cfg, idx) {
      const mk = (p, slot) => ({
        p, side: idx,
        role: slot ? slot.role : null,
        group: slot ? slot.group : null,
        x: slot ? slot.x : null,
        y: slot ? slot.y : null,
        energy: 100,
        onPitch: !!slot,
        minuteOn: slot ? 0 : null,
        minuteOff: null,
        yellow: 0,
        sentOff: false,
        injured: false,
        subbedOn: false,
        subbedOff: false,
        mult: 1,
        multKey: -1,
        st: {
          goals: 0, assists: 0, shots: 0, sot: 0, xg: 0, keyPasses: 0, passes: 0, passOk: 0,
          dribbles: 0, dribblesOk: 0, tackles: 0, interceptions: 0, clearances: 0, blocks: 0,
          aerialsWon: 0, saves: 0, fouls: 0, fouled: 0, conceded: 0, beaten: 0, offsides: 0,
          dispossessed: 0, missedBig: 0, penSaved: 0, red: 0,
        },
      });
      const players = cfg.xi.map((s) => mk(s.player, s));
      const bench = cfg.bench.map((p) => mk(p, null));
      const side = {
        idx,
        team: cfg.team,
        name: cfg.team.name,
        formation: cfg.formation,
        players, bench,
        all: players.concat(bench),
        score: 0,
        subsUsed: 0,
        windowsUsed: 0,
        stats: {
          possession: 0, shots: 0, sot: 0, xg: 0, corners: 0, fouls: 0, yellows: 0, reds: 0,
          offsides: 0, passes: 0, passOk: 0, tackles: 0, saves: 0, bigChances: 0,
        },
      };
      return side;
    }

    // ---- Helpers --------------------------------------------------------------
    // Call whenever players come on/off or change role.
    lineupChanged() {
      this.ver++;
    }

    onPitch(side) {
      if (side.cacheVer !== this.ver) this.refreshLists(side);
      return side.cacheOn;
    }

    outfield(side) {
      if (side.cacheVer !== this.ver) this.refreshLists(side);
      return side.cacheOut;
    }

    refreshLists(side) {
      side.cacheOn = side.players.filter((r) => r.onPitch);
      side.cacheOut = side.cacheOn.filter((r) => r.role !== 'GK');
      side.cacheInv = {};
      side.cacheVer = this.ver;
    }

    keeper(side) {
      return this.onPitch(side).find((r) => r.role === 'GK') || this.onPitch(side)[0];
    }

    // Fatigue and position familiarity scale a player's effective ability.
    formMult(r) {
      const fatigue = 0.86 + 0.14 * (r.energy / 100);
      const nat = r.p.posRatings[r.p.pos] || r.p.ovr;
      const fit = r.role ? r.p.posRatings[r.role] / Math.max(1, nat) : 1;
      const fitMult = clamp(0.55 + 0.45 * fit, 0.7, 1.02);
      return fatigue * fitMult * this.sides[r.side].form;
    }

    // Skill composite before fatigue/position scaling. Depends only on the
    // player, so it's cached on the player and shared across matches.
    baseSkill(r, name) {
      const cache = r.p.skillCache || (r.p.skillCache = {});
      let v = cache[name];
      if (v === undefined) {
        const [weights, styles] = SKILLS[name];
        v = blend(r.p.a, weights);
        for (const s of styles) if (r.p.ps[s]) v += r.p.ps[s] * 2;
        if (name === 'dribble') v += (r.p.skillMoves - 3) * 1.5;
        cache[name] = v;
      }
      return v;
    }

    skill(r, name) {
      let v = this.baseSkill(r, name);
      if ((name === 'finish' || name === 'longShot') && r.p.ps.Gamechanger && this.minute >= 75) v += 2;
      // Energy only changes once per minute and roles only on lineup changes.
      const key = this.tick * 1000 + this.ver;
      if (r.multKey !== key) {
        r.mult = this.formMult(r);
        r.multKey = key;
      }
      return v * r.mult;
    }

    // Weighted pick of who gets involved: role involvement x skill^3.
    choose(side, involveKey, skillName, exclude) {
      const table = INVOLVE[involveKey];
      let list = this.involved(side, involveKey);
      if (!list.length || (list.length === 1 && list[0] === exclude)) {
        list = this.outfield(side);
        if (!list.length || (list.length === 1 && list[0] === exclude)) list = this.onPitch(side);
      }
      return this.rng.weighted(list, (r) => {
        if (r === exclude) return 0;
        const x = this.skill(r, skillName) / 60;
        return (table[r.role] || 0.05) * (T.involveExp === 3 ? x * x * x : x ** T.involveExp);
      });
    }

    involved(side, involveKey) {
      if (side.cacheVer !== this.ver) this.refreshLists(side);
      let list = side.cacheInv[involveKey];
      if (!list) {
        const table = INVOLVE[involveKey];
        list = side.cacheInv[involveKey] = side.cacheOut.filter((r) => (table[r.role] || 0) > 0);
      }
      return list;
    }

    // Team strength in possession: involvement-weighted passing/retention of
    // the current outfielders, scaled down when a side is short of men.
    control(side) {
      const key = this.tick * 1000 + this.ver;
      if (side.ctrlKey === key) return side.ctrl;
      side.ctrlKey = key;
      return (side.ctrl = this.computeControl(side));
    }

    computeControl(side) {
      const list = this.outfield(side);
      let s = 0;
      let w = 0;
      for (const r of list) {
        const wi = INVOLVE.buildUp[r.role] || 0.5;
        s += wi * (this.skill(r, 'pass') * 0.6 + this.skill(r, 'retain') * 0.4);
        w += wi;
      }
      return w ? (s / w) * Math.min(1, list.length / 10) : 0;
    }

    teamPress(side) {
      const key = this.tick * 1000 + this.ver;
      if (side.pressKey === key) return side.press;
      side.pressKey = key;
      return (side.press = this.computePress(side));
    }

    computePress(side) {
      const list = this.outfield(side);
      if (!list.length) return 40;
      const w = list.reduce((s, r) => s + (INVOLVE.press[r.role] || 0.2), 0);
      const v = list.reduce((s, r) => s + (INVOLVE.press[r.role] || 0.2) * this.skill(r, 'press'), 0) / w;
      return v * (list.length / 10);
    }

    minuteLabel() {
      if (this.half === 1 && this.minute > 45) return `45+${this.minute - 45}`;
      if (this.half === 2 && this.minute > 90) return `90+${this.minute - 90}`;
      if (this.half === 3 && this.minute > 105) return `105+${this.minute - 105}`;
      if (this.half === 4 && this.minute > 120) return `120+${this.minute - 120}`;
      return String(this.minute);
    }

    emit(type, side, text, extra = {}) {
      if (this.fast) return null;
      const ev = { minute: this.minuteLabel(), type, side, text, score: [this.sides[0].score, this.sides[1].score], ...extra };
      this.events.push(ev);
      this.out.push(ev);
      return ev;
    }

    // ---- Main loop --------------------------------------------------------------
    step() {
      this.out = [];
      if (this.finished) return this.out;
      if (this.minute === 0) {
        this.minute = 1;
        this.emit('kickoff', null, this.C.kickoff(this));
      }
      const [h, a] = this.sides;
      this.tick++;
      this.tickFatigue();

      // Who dominates the ball this minute.
      const adv = this.homeAdvantage ? T.homeAdvantage : 0;
      const ch = this.control(h) + adv;
      const ca = this.control(a);
      const pHome = logistic(((ch - ca) + (this.teamPress(h) - this.teamPress(a)) * 0.35) / T.possessionScale);
      const att = this.rng.chance(pHome) ? h : a;
      const def = att === h ? a : h;
      att.stats.possession++;
      this.passingTick(att, def);
      let attackRate = T.attackRate + (this.control(att) - this.control(def)) / 300;
      // Game state: leaders protect what they have, trailing sides push on,
      // and level games get cagey late on.
      const lead = att.score - def.score;
      if (lead > 0) attackRate -= T.gameState * Math.min(lead, 2);
      else if (lead < 0) attackRate += T.gameState * 0.5;
      else if (this.minute >= 70) attackRate -= T.gameState * 0.5;
      if (this.rng.chance(clamp(attackRate, 0.4, 0.68))) this.attack(att, def);
      else this.quietMinute(att, def);

      this.maybeInjury();
      this.maybeSubs();
      this.advanceClock();
      return this.out;
    }

    runToEnd() {
      const all = [];
      while (!this.finished) all.push(...this.step());
      return all;
    }

    advanceClock() {
      const end1 = 45 + this.stoppage[0];
      const end2 = 90 + this.stoppage[1];
      if (this.half === 1 && this.minute >= end1) {
        this.emit('halftime', null, this.C.halftime(this));
        this.half = 2;
        this.minute = 46;
        for (const s of this.sides) for (const r of this.onPitch(s)) r.energy = Math.min(100, r.energy + 6);
        this.halftimeSubs();
        this.emit('kickoff', null, this.C.secondHalf(this));
        return;
      }
      if (this.half === 2 && this.minute >= end2) {
        if (this.knockout && this.sides[0].score === this.sides[1].score) {
          this.emit('halftime', null, this.C.extraTime(this));
          this.half = 3;
          this.minute = 91;
          return;
        }
        this.finish();
        return;
      }
      if (this.half === 3 && this.minute >= 105 + this.stoppage[2]) {
        this.half = 4;
        this.minute = 106;
        this.emit('kickoff', null, this.C.extraTimeSecondHalf(this));
        return;
      }
      if (this.half === 4 && this.minute >= 120 + this.stoppage[3]) {
        if (this.sides[0].score === this.sides[1].score) this.penaltyShootout();
        this.finish();
        return;
      }
      this.minute++;
    }

    tickFatigue() {
      for (const s of this.sides) {
        for (const r of this.onPitch(s)) {
          let d = 0.2 + (100 - r.p.a.stamina) / 260;
          if (r.role === 'GK') d *= 0.3;
          if (r.p.ps.Relentless) d *= 1 - 0.12 * r.p.ps.Relentless;
          if (['LWB', 'RWB', 'CM', 'LM', 'RM'].includes(r.role)) d *= 1.12;
          r.energy = Math.max(20, r.energy - d);
        }
      }
    }

    // Background passing so pass counts / accuracy reflect the minute's control.
    passingTick(att, def) {
      const n = this.rng.int(4, 9);
      const press = this.teamPress(def);
      for (let i = 0; i < n; i++) {
        const r = this.choose(att, 'buildUp', 'pass');
        const ok = this.rng.chance(logistic(1.45 + (this.skill(r, 'pass') - press) / 18));
        r.st.passes++;
        att.stats.passes++;
        if (ok) {
          r.st.passOk++;
          att.stats.passOk++;
        }
      }
      // A few passes for the other side too (they have the ball some of the minute).
      const m = this.rng.int(1, 3);
      for (let i = 0; i < m; i++) {
        const r = this.choose(def, 'buildUp', 'pass');
        const ok = this.rng.chance(logistic(1.3 + (this.skill(r, 'pass') - this.teamPress(att)) / 18));
        r.st.passes++;
        def.stats.passes++;
        if (ok) {
          r.st.passOk++;
          def.stats.passOk++;
        }
      }
    }

    quietMinute(att, def) {
      // Midfield fouls and the odd tactical card.
      if (this.rng.chance(0.34)) {
        const fouler = this.choose(def, 'press', 'foulRisk');
        const victim = this.choose(att, 'buildUp', 'retain');
        this.commitFoul(fouler, victim, def, att, 'midfield');
        return;
      }
      if (this.rng.chance(0.2)) {
        const r = this.choose(att, 'buildUp', 'pass');
        this.emit('flavour', att.idx, this.C.possession(this, att, r));
      }
    }

    // ---- Attacking move -------------------------------------------------------
    attack(att, def) {
      // 1. Build-up through midfield.
      const passer = this.choose(att, 'buildUp', 'pass');
      const presser = this.choose(def, 'press', 'press');
      const pBuild = logistic(0.95 + (this.skill(passer, 'pass') * 0.7 + this.skill(passer, 'retain') * 0.3 - this.skill(presser, 'press')) / T.duel);
      if (!this.rng.chance(pBuild)) {
        if (this.rng.chance(0.3)) {
          this.commitFoul(presser, passer, def, att, 'midfield');
          return;
        }
        if (this.rng.chance(0.5)) {
          presser.st.interceptions++;
          passer.st.dispossessed++;
          if (this.rng.chance(0.35)) this.emit('turnover', def.idx, this.C.interception(this, presser, passer));
        } else {
          presser.st.tackles++;
          def.stats.tackles++;
          passer.st.dispossessed++;
          if (this.rng.chance(0.35)) this.emit('turnover', def.idx, this.C.tackleMid(this, presser, passer));
        }
        return;
      }

      // 2. Choose how to attack the final third, based on the squad's strengths.
      const best = (inv, sk) => {
        const list = this.outfield(att).filter((r) => (INVOLVE[inv][r.role] || 0) > 0.5);
        return list.length ? Math.max(...list.map((r) => this.skill(r, sk))) : 40;
      };
      const w = {
        through: 0.30 * Math.pow(best('create', 'create') / 70, 3) * Math.pow(best('run', 'run') / 70, 2),
        dribble: 0.28 * Math.pow(best('dribble', 'dribble') / 70, 4),
        cross: 0.24 * Math.pow(best('cross', 'cross') / 70, 3) * Math.pow(best('aerial', 'aerialAtt') / 70, 2),
        longShot: 0.14 * Math.pow(best('longShot', 'longShot') / 70, 3),
      };
      const kind = this.rng.weighted(Object.keys(w), (k) => w[k]);
      this[`move_${kind}`](att, def, passer);
    }

    move_through(att, def, buildUpPasser) {
      const creator = this.choose(att, 'create', 'create');
      const runner = this.choose(att, 'run', 'run', creator);
      if (!runner) return;
      const defender = this.choose(def, 'defend', 'line');
      const a = this.skill(creator, 'create') * 0.5 + this.skill(runner, 'run') * 0.5;
      const p = logistic(-0.55 + (a - this.skill(defender, 'line')) / T.duel);
      if (this.rng.chance(p)) {
        creator.st.keyPasses++;
        defender.st.beaten++;
        const xg = 0.12 + this.rng() * 0.24;
        this.emit('chance', att.idx, this.C.throughBall(this, creator, runner));
        this.shoot(att, def, runner, creator, xg, 'oneOnOne');
      } else if (this.rng.chance(0.45)) {
        runner.st.offsides++;
        att.stats.offsides++;
        this.emit('offside', att.idx, this.C.offside(this, runner, creator));
      } else {
        defender.st.interceptions++;
        if (this.rng.chance(0.5)) this.emit('defence', def.idx, this.C.cutOut(this, defender, creator, runner));
      }
    }

    move_dribble(att, def, buildUpPasser) {
      const dribbler = this.choose(att, 'dribble', 'dribble');
      const defender = this.choose(def, 'defend', 'tackle');
      dribbler.st.dribbles++;
      const p = logistic(-0.35 + (this.skill(dribbler, 'dribble') - this.skill(defender, 'tackle')) / T.duel);
      if (this.rng.chance(p)) {
        dribbler.st.dribblesOk++;
        defender.st.beaten++;
        this.emit('chance', att.idx, this.C.dribblePast(this, dribbler, defender));
        // Sometimes the dribbler squares it, otherwise shoots.
        if (this.rng.chance(0.3)) {
          const mate = this.choose(att, 'run', 'finish', dribbler);
          if (mate) {
            dribbler.st.keyPasses++;
            this.emit('chance', att.idx, this.C.layOff(this, dribbler, mate));
            this.shoot(att, def, mate, dribbler, 0.08 + this.rng() * 0.2, 'normal');
            return;
          }
        }
        if (buildUpPasser !== dribbler && this.rng.chance(0.25)) buildUpPasser.st.keyPasses++;
        this.shoot(att, def, dribbler, this.rng.chance(0.25) ? buildUpPasser : null, 0.05 + this.rng() * 0.15, 'normal');
      } else {
        // Foul or clean tackle?
        const foulP = 0.1 + (this.skill(defender, 'foulRisk') - this.skill(defender, 'tackle')) / 120 + (defender.yellow ? -0.04 : 0);
        if (this.rng.chance(clamp(foulP, 0.04, 0.3))) {
          const inBox = this.rng.chance(0.13);
          this.commitFoul(defender, dribbler, def, att, inBox ? 'box' : 'danger');
        } else {
          defender.st.tackles++;
          def.stats.tackles++;
          dribbler.st.dispossessed++;
          this.emit('defence', def.idx, this.C.tackle(this, defender, dribbler));
          if (this.rng.chance(0.2)) this.corner(att, def);
        }
      }
    }

    move_cross(att, def, buildUpPasser) {
      const crosser = this.choose(att, 'cross', 'cross');
      const quality = logistic(0.4 + (this.skill(crosser, 'cross') - 58) / 14);
      if (!this.rng.chance(quality)) {
        const d = this.choose(def, 'defendAerial', 'aerialDef');
        d.st.clearances++;
        if (this.rng.chance(0.4)) return this.corner(att, def);
        if (this.rng.chance(0.4)) this.emit('defence', def.idx, this.C.badCross(this, crosser, d));
        return;
      }
      const target = this.choose(att, 'aerial', 'aerialAtt', crosser);
      if (!target) return;
      const gk = this.keeper(def);
      // Keeper comes for it?
      if (this.rng.chance(0.04 + (this.skill(gk, 'gkCross') - 60) / 450)) {
        gk.st.clearances++;
        this.emit('defence', def.idx, this.C.claim(this, gk, crosser));
        return;
      }
      const defender = this.choose(def, 'defendAerial', 'aerialDef');
      const p = logistic(-0.3 + (this.skill(target, 'aerialAtt') - this.skill(defender, 'aerialDef')) / T.duel);
      if (this.rng.chance(p)) {
        target.st.aerialsWon++;
        crosser.st.keyPasses++;
        this.emit('chance', att.idx, this.C.cross(this, crosser, target));
        this.shoot(att, def, target, crosser, 0.06 + this.rng() * 0.14, 'header');
      } else {
        defender.st.aerialsWon++;
        defender.st.clearances++;
        if (this.rng.chance(0.5)) return this.corner(att, def);
        if (this.rng.chance(0.5)) this.emit('defence', def.idx, this.C.headedClear(this, defender, crosser));
      }
    }

    move_longShot(att, def) {
      const shooter = this.choose(att, 'longShot', 'longShot');
      this.shoot(att, def, shooter, null, 0.02 + this.rng() * 0.05, 'long');
    }

    corner(att, def) {
      att.stats.corners++;
      const taker = this.bestAt(att, (r) => this.skill(r, 'cross') + (r.p.ps['Dead Ball'] || 0) * 3);
      this.emit('corner', att.idx, this.C.corner(this, att, taker));
      const target = this.choose(att, 'aerial', 'aerialAtt', taker);
      const defender = this.choose(def, 'defendAerial', 'aerialDef');
      const gk = this.keeper(def);
      if (this.rng.chance(0.06 + (this.skill(gk, 'gkCross') - 60) / 400)) {
        this.emit('defence', def.idx, this.C.claim(this, gk, taker));
        return;
      }
      const delivery = logistic(0.6 + (this.skill(taker, 'cross') - 58) / 14);
      const p = delivery * logistic(-0.2 + (this.skill(target, 'aerialAtt') - this.skill(defender, 'aerialDef')) / T.duel);
      if (this.rng.chance(p)) {
        target.st.aerialsWon++;
        this.shoot(att, def, target, taker, 0.05 + this.rng() * 0.1, 'header');
      } else {
        defender.st.clearances++;
        defender.st.aerialsWon++;
        if (this.rng.chance(0.4)) this.emit('defence', def.idx, this.C.cornerCleared(this, defender));
      }
    }

    bestAt(side, fn) {
      const list = this.outfield(side);
      return list.reduce((b, r) => (fn(r) > fn(b) ? r : b), list[0]);
    }

    // ---- Fouls, cards, set pieces ----------------------------------------------
    commitFoul(fouler, victim, def, att, where) {
      fouler.st.fouls++;
      victim.st.fouled++;
      def.stats.fouls++;
      const aggr = fouler.p.a.aggression;
      let pYellow = (where === 'midfield' ? 0.14 : 0.26) + (aggr - 55) / 250;
      if (where === 'box') pYellow += 0.1;
      if (fouler.yellow) pYellow *= 0.45; // booked players ease off
      const pRed = where === 'midfield' ? 0.001 : 0.004 + (where === 'box' ? 0.01 : 0);
      this.emit('foul', def.idx, this.C.foul(this, fouler, victim, where));
      if (this.rng.chance(pRed)) this.sendOff(fouler, def, false);
      else if (this.rng.chance(clamp(pYellow, 0.03, 0.5))) this.book(fouler, def);

      if (where === 'box') {
        this.penalty(att, def);
      } else if (where === 'danger') {
        this.freeKick(att, def);
      }
    }

    book(r, side) {
      r.yellow++;
      side.stats.yellows++;
      if (r.yellow >= 2) {
        this.emit('yellow', side.idx, this.C.secondYellow(this, r), { player: r.p.name });
        this.sendOff(r, side, true);
      } else {
        this.emit('yellow', side.idx, this.C.yellow(this, r), { player: r.p.name });
      }
    }

    sendOff(r, side, second) {
      r.sentOff = true;
      r.onPitch = false;
      this.lineupChanged();
      r.minuteOff = this.minute;
      side.stats.reds++;
      r.st.red = 1;
      if (!second) this.emit('red', side.idx, this.C.red(this, r), { player: r.p.name });
      else this.emit('red', side.idx, this.C.redAfterSecond(this, r), { player: r.p.name });
      if (r.role === 'GK') this.replaceKeeper(side);
    }

    replaceKeeper(side) {
      const benchGk = side.bench.find((b) => !b.onPitch && b.minuteOn === null && b.p.pos === 'GK');
      if (benchGk && side.subsUsed < MAX_SUBS) {
        // Sacrifice an outfielder to bring on the reserve keeper.
        const off = this.outfield(side).sort((x, y) => this.subScore(x) - this.subScore(y))[0];
        if (off) {
          this.doSub(side, off, benchGk, 'GK');
          return;
        }
      }
      const stand = this.outfield(side).sort((x, y) => y.p.posRatings.GK - x.p.posRatings.GK)[0];
      if (stand) {
        stand.role = 'GK';
        stand.group = 'GK';
        this.lineupChanged();
        this.emit('info', side.idx, this.C.emergencyKeeper(this, stand));
      }
    }

    freeKick(att, def) {
      const taker = this.bestAt(att, (r) => this.skill(r, 'freeKick'));
      const direct = this.rng.chance(0.55);
      if (direct) {
        const dist = this.rng.int(18, 32);
        this.emit('freekick', att.idx, this.C.freeKick(this, att, taker, dist));
        const xg = clamp(0.1 - (dist - 18) * 0.005, 0.03, 0.1);
        this.shoot(att, def, taker, null, xg, 'freeKick');
      } else {
        this.emit('freekick', att.idx, this.C.freeKickCross(this, att, taker));
        const target = this.choose(att, 'aerial', 'aerialAtt', taker);
        const defender = this.choose(def, 'defendAerial', 'aerialDef');
        const p = logistic(-0.4 + (this.skill(taker, 'cross') + this.skill(target, 'aerialAtt') - 60 - this.skill(defender, 'aerialDef')) / 10);
        if (this.rng.chance(p)) this.shoot(att, def, target, taker, 0.05 + this.rng() * 0.12, 'header');
        else {
          defender.st.clearances++;
          this.emit('defence', def.idx, this.C.headedClear(this, defender, taker));
        }
      }
    }

    penalty(att, def) {
      const taker = this.bestAt(att, (r) => this.skill(r, 'penalty'));
      const gk = this.keeper(def);
      this.emit('penalty', att.idx, this.C.penaltyAwarded(this, att, taker));
      att.stats.shots++;
      att.stats.xg += 0.76;
      att.stats.bigChances++;
      taker.st.shots++;
      taker.st.xg += 0.76;
      const pGoal = clamp(0.77 + (this.skill(taker, 'penalty') - this.skill(gk, 'gkPenalty')) / 150, 0.55, 0.92);
      const r = this.rng();
      if (r < pGoal) {
        taker.st.sot++;
        att.stats.sot++;
        this.goal(att, def, taker, null, 'penalty');
      } else if (r < pGoal + (1 - pGoal) * 0.6) {
        taker.st.sot++;
        att.stats.sot++;
        gk.st.saves++;
        gk.st.penSaved++;
        def.stats.saves++;
        this.emit('save', def.idx, this.C.penaltySaved(this, taker, gk), { big: true });
      } else {
        taker.st.missedBig++;
        this.emit('miss', att.idx, this.C.penaltyMissed(this, taker), { big: true });
      }
    }

    // ---- Shots ------------------------------------------------------------------
    shoot(att, def, shooter, assister, xg, kind) {
      const gk = this.keeper(def);
      const skillName = { normal: 'finish', oneOnOne: 'finish', header: 'headerShot', long: 'longShot', freeKick: 'freeKick' }[kind];
      const gkSkillName = { normal: 'gkShot', oneOnOne: 'gkOneOnOne', header: 'gkShot', long: 'gkShot', freeKick: 'gkShot' }[kind];
      xg *= T.xgMult;
      const S = this.skill(shooter, skillName);
      const G = this.skill(gk, gkSkillName);
      att.stats.shots++;
      att.stats.xg += xg;
      shooter.st.shots++;
      shooter.st.xg += xg;
      if (xg >= 0.3) att.stats.bigChances++;

      // Chance of the shot being blocked before it reaches goal.
      if (kind !== 'oneOnOne' && kind !== 'freeKick') {
        const blocker = this.choose(def, 'defend', 'block');
        const pBlock = clamp(0.2 + (this.skill(blocker, 'block') - S) / 150 + (kind === 'long' ? 0.1 : 0), 0.08, 0.4);
        if (this.rng.chance(pBlock)) {
          blocker.st.blocks++;
          this.emit('block', def.idx, this.C.blocked(this, shooter, blocker, kind));
          if (this.rng.chance(0.5)) this.corner(att, def);
          return;
        }
      }

      const pGoal = clamp(xg * Math.exp((S - G + 4) / T.finishScale), 0.005, 0.85);
      const pOnTarget = clamp(0.3 + (S - 55) / 110 + xg * 0.6, 0.2, 0.9);
      const r = this.rng();
      if (r < pGoal) {
        shooter.st.sot++;
        att.stats.sot++;
        this.goal(att, def, shooter, assister, kind);
      } else if (r < Math.max(pOnTarget, pGoal + 0.08)) {
        shooter.st.sot++;
        att.stats.sot++;
        gk.st.saves++;
        def.stats.saves++;
        const big = xg >= 0.25;
        this.emit('save', def.idx, this.C.save(this, shooter, gk, kind, big), { big });
        if (this.rng.chance(0.45)) this.corner(att, def);
      } else {
        if (xg >= 0.3) shooter.st.missedBig++;
        this.emit('miss', att.idx, this.C.miss(this, shooter, kind, xg >= 0.25), { big: xg >= 0.25 });
      }
    }

    goal(att, def, scorer, assister, kind) {
      att.score++;
      scorer.st.goals++;
      if (assister && assister !== scorer) assister.st.assists++;
      for (const r of this.onPitch(def)) {
        if (r.role === 'GK' || r.group === 'DEF') r.st.conceded++;
      }
      const g = { minute: this.minuteLabel(), side: att.idx, scorer: scorer.p.name, assister: assister && assister !== scorer ? assister.p.name : null, kind };
      this.goals.push(g);
      this.emit('goal', att.idx, this.C.goal(this, att, scorer, assister !== scorer ? assister : null, kind), { goal: g });
    }

    // ---- Injuries & substitutions ---------------------------------------------
    maybeInjury() {
      for (const s of this.sides) {
        if (!this.rng.chance(0.0016)) continue;
        const list = this.onPitch(s);
        const r = this.rng.weighted(list, (x) => (x.role === 'GK' ? 0.2 : 1) * (1.4 - x.energy / 100));
        if (!r) continue;
        r.injured = true;
        this.emit('injury', s.idx, this.C.injury(this, r));
        const repl = this.bestReplacement(s, r.role);
        if (repl && s.subsUsed < MAX_SUBS) this.doSub(s, r, repl, r.role, true);
        else {
          r.onPitch = false;
          r.minuteOff = this.minute;
          this.lineupChanged();
          if (r.role === 'GK') this.replaceKeeper(s);
        }
      }
    }

    subScore(r) {
      // Lower = more likely to be hooked.
      return r.energy * 0.6 + this.liveRating(r) * 8 + (r.role === 'GK' ? 1000 : 0) + (r.subbedOn ? 60 : 0);
    }

    bestReplacement(side, role) {
      const avail = side.bench.filter((b) => b.minuteOn === null && !b.onPitch);
      if (!avail.length) return null;
      return avail.reduce((b, x) => (x.p.posRatings[role] > b.p.posRatings[role] ? x : b), avail[0]);
    }

    halftimeSubs() {
      // Occasionally a manager acts at the break (poor performers or a yellow on a defender).
      for (const s of this.sides) {
        const cands = this.outfield(s).filter((r) => this.liveRating(r) < 5.8 || (r.yellow && r.group === 'DEF'));
        if (cands.length && this.rng.chance(0.3)) this.makeWindow(s, 1, cands);
      }
    }

    maybeSubs() {
      if (this.half < 2 || this.minute < 55) return;
      for (const s of this.sides) {
        if (s.subsUsed >= MAX_SUBS || s.windowsUsed >= SUB_WINDOWS) continue;
        const tired = this.outfield(s).filter((r) => r.energy < 62).length;
        const late = this.minute >= 70;
        const p = 0.04 + tired * 0.025 + (late ? 0.05 : 0);
        if (this.rng.chance(p)) this.makeWindow(s, this.rng.int(1, Math.min(2, MAX_SUBS - s.subsUsed)));
      }
    }

    makeWindow(side, count, candidates) {
      if (side.windowsUsed >= SUB_WINDOWS || side.subsUsed >= MAX_SUBS) return;
      const other = this.sides[1 - side.idx];
      const chasing = side.score < other.score;
      let pool = (candidates || this.outfield(side)).slice().sort((x, y) => this.subScore(x) - this.subScore(y));
      let made = 0;
      for (const off of pool) {
        if (made >= count || side.subsUsed >= MAX_SUBS) break;
        // When chasing the game, swap a defender/midfielder for an attacker.
        let role = off.role;
        const avail = side.bench.filter((b) => b.minuteOn === null && !b.onPitch && b.p.pos !== 'GK');
        if (!avail.length) break;
        let on;
        if (chasing && this.minute >= 65 && off.group !== 'ATT' && this.rng.chance(0.5)) {
          on = avail.reduce((b, x) => (x.p.posRatings.ST > b.p.posRatings.ST ? x : b), avail[0]);
          if (on.p.posRatings.ST < on.p.posRatings[role] - 3) on = null;
        }
        if (!on) on = avail.reduce((b, x) => (x.p.posRatings[role] > b.p.posRatings[role] ? x : b), avail[0]);
        // Only make the change if it's a sensible like-for-like (fresh legs count).
        const offValue = off.p.posRatings[role] * this.formMult(off);
        const onValue = on.p.posRatings[role] * (0.86 + 0.14 * 1.0) * clamp(0.55 + 0.45 * on.p.posRatings[role] / Math.max(1, on.p.posRatings[on.p.pos]), 0.7, 1.02);
        if (onValue < offValue - 3 && !candidates) continue;
        this.doSub(side, off, on, role);
        made++;
      }
      if (made) side.windowsUsed++;
    }

    doSub(side, off, on, role, injury) {
      off.onPitch = false;
      off.subbedOff = true;
      off.minuteOff = this.minute;
      on.onPitch = true;
      on.subbedOn = true;
      on.minuteOn = this.minute;
      on.role = role;
      on.group = OF.formations.groupOf(role);
      on.x = off.x;
      on.y = off.y;
      side.players.push(on);
      side.subsUsed++;
      this.lineupChanged();
      this.emit('sub', side.idx, this.C.sub(this, side, off, on), { on: on.p.name, off: off.p.name });
    }

    // ---- Ratings ------------------------------------------------------------------
    liveRating(r) {
      const st = r.st;
      const side = this.sides[r.side];
      const opp = this.sides[1 - r.side];
      const mins = this.minutesPlayed(r);
      let x = 6.0;
      x += st.goals * 1.0 + st.assists * 0.65 + st.keyPasses * 0.15;
      x += st.sot * 0.12 - (st.shots - st.sot) * 0.06 - st.missedBig * 0.25;
      x += st.dribblesOk * 0.12 - (st.dribbles - st.dribblesOk) * 0.04 - st.dispossessed * 0.05;
      x += st.tackles * 0.15 + st.interceptions * 0.12 + st.clearances * 0.05 + st.blocks * 0.15 + st.aerialsWon * 0.04;
      x += st.passOk * 0.006 - (st.passes - st.passOk) * 0.04;
      x += st.saves * 0.3 + st.penSaved * 0.8;
      x -= st.fouls * 0.08 + st.offsides * 0.05 + st.beaten * 0.08;
      x -= r.yellow ? 0.3 : 0;
      x -= st.red ? 1.5 : 0;
      if (r.role === 'GK' || (r.group === 'DEF')) {
        x -= st.conceded * (r.role === 'GK' ? 0.35 : 0.2);
        if (this.finished && st.conceded === 0 && mins >= 60) x += r.role === 'GK' ? 0.6 : 0.4;
      }
      if (this.finished) {
        if (side.score > opp.score) x += 0.25;
        else if (side.score < opp.score) x -= 0.2;
      }
      // Short cameos regress toward 6.0.
      const weight = clamp(mins / 30, 0.35, 1);
      x = 6.0 + (x - 6.0) * (0.6 + 0.4 * weight);
      return clamp(Math.round(x * 10) / 10, 3.0, 10.0);
    }

    minutesPlayed(r) {
      if (r.minuteOn === null) return 0;
      const cap = this.half > 2 ? 120 : 90;
      const endMin = r.minuteOff !== null ? r.minuteOff : Math.min(this.minute, cap);
      return Math.max(0, Math.min(cap, endMin) - r.minuteOn);
    }

    // Five kicks each (stopping once decided), then sudden death. Best penalty
    // takers go first; the keeper faces every kick.
    penaltyShootout() {
      this.emit('halftime', null, this.C.shootoutStart(this));
      const order = this.sides.map((s) =>
        this.onPitch(s).slice().sort((x, y) => this.skill(y, 'penalty') - this.skill(x, 'penalty')));
      const score = [0, 0];
      const taken = [0, 0];
      const kicks = [];
      for (let round = 0; round < 30; round++) {
        for (const side of [0, 1]) {
          const takers = order[side];
          const taker = takers[taken[side] % takers.length];
          const gk = this.keeper(this.sides[1 - side]);
          const pressure = round >= 4 ? 0.03 : 0;
          const p = clamp(0.76 - pressure + (this.skill(taker, 'penalty') - this.skill(gk, 'gkPenalty')) / 150, 0.5, 0.92);
          const scored = this.rng.chance(p);
          taken[side]++;
          if (scored) score[side]++;
          kicks.push({ side, taker: taker.p.name, scored });
          this.emit('shootout', side, this.C.shootoutKick(this, taker, gk, scored, score), { big: true });
          if (round < 5) {
            // Stop early once one side can't catch up.
            const left = [5 - taken[0], 5 - taken[1]];
            if (score[0] > score[1] + left[1] || score[1] > score[0] + left[0]) break;
          }
        }
        if (round < 5) {
          const left = [5 - taken[0], 5 - taken[1]];
          if (score[0] > score[1] + left[1] || score[1] > score[0] + left[0]) break;
        } else if (score[0] !== score[1]) {
          break;
        }
      }
      this.shootout = { score, kicks, winner: score[0] > score[1] ? 0 : 1 };
    }

    // Index of the winning side, or null for a draw.
    winner() {
      const [h, a] = this.sides;
      if (h.score !== a.score) return h.score > a.score ? 0 : 1;
      return this.shootout ? this.shootout.winner : null;
    }

    finish() {
      this.finished = true;
      const [h, a] = this.sides;
      const total = h.stats.possession + a.stats.possession || 1;
      h.stats.possessionPct = Math.round((h.stats.possession / total) * 100);
      a.stats.possessionPct = 100 - h.stats.possessionPct;
      this.emit('fulltime', null, this.C.fulltime(this));
    }

    possessionPct() {
      const [h, a] = this.sides;
      const total = h.stats.possession + a.stats.possession;
      if (!total) return [50, 50];
      const hp = Math.round((h.stats.possession / total) * 100);
      return [hp, 100 - hp];
    }

    // Everyone who appeared, with ratings, grouped by side.
    playerReport() {
      return this.sides.map((s) =>
        s.all
          .filter((r) => r.minuteOn !== null)
          .map((r) => ({
            name: r.p.name,
            pos: r.role,
            ovr: r.p.ovr,
            rating: this.liveRating(r),
            minutes: this.minutesPlayed(r),
            subOn: r.subbedOn ? r.minuteOn : null,
            subOff: r.subbedOff ? r.minuteOff : null,
            sentOff: r.sentOff,
            injured: r.injured,
            yellow: r.yellow,
            energy: Math.round(r.energy),
            st: r.st,
            side: s.idx,
            player: r.p,
          })));
    }

    manOfTheMatch() {
      const all = this.playerReport().flat();
      return all.reduce((b, x) => (x.rating > b.rating || (x.rating === b.rating && x.st.goals > b.st.goals) ? x : b), all[0]);
    }
  }

  Match.TUNING = TUNING;
  OF.Match = Match;
})(typeof globalThis !== 'undefined' ? globalThis : this);

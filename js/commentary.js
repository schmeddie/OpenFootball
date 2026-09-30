// Text commentary. Each function returns one line for a match event; the
// match RNG picks the template so a seeded match always reads the same.
(function (root) {
  const OF = (root.OF = root.OF || {});

  const n = (r) => r.p.name;
  const team = (m, r) => m.sides[r.side].name;
  const pick = (m, arr) => arr[Math.floor(m.rng() * arr.length)];
  const scoreLine = (m) => `${m.sides[0].name} ${m.sides[0].score}-${m.sides[1].score} ${m.sides[1].name}`;

  const commentary = {
    kickoff: (m) => pick(m, [
      `We're under way! ${m.sides[0].name} (${m.sides[0].formation}) against ${m.sides[1].name} (${m.sides[1].formation}).`,
      `The referee blows and ${m.sides[0].name} get us started against ${m.sides[1].name}.`,
    ]),
    halftime: (m) => `Half-time: ${scoreLine(m)}.`,
    secondHalf: (m) => pick(m, ['The second half is under way.', 'We go again - second half.', 'Back out for the second 45.']),
    extraTime: (m) => `End of normal time: ${scoreLine(m)}. We're going to extra time!`,
    extraTimeSecondHalf: (m) => `Into the second period of extra time. ${scoreLine(m)}.`,
    shootoutStart: (m) => `Still level after 120 minutes - this will be settled by a penalty shootout!`,
    shootoutKick: (m, t, gk, scored, score) => `${scored ? 'Scored' : pick(m, ['Saved', 'Missed', 'Saved'])}: ${n(t)}${scored ? '' : ` (${n(gk)})`}. Shootout ${score[0]}-${score[1]}.`,
    fulltime: (m) => {
      const [h, a] = m.sides;
      if (m.shootout) {
        const w = m.sides[m.shootout.winner];
        return `Full-time: ${scoreLine(m)} after extra time. ${w.name} win ${Math.max(...m.shootout.score)}-${Math.min(...m.shootout.score)} on penalties!`;
      }
      if (h.score === a.score) return `Full-time: ${scoreLine(m)}. The points are shared.`;
      const w = h.score > a.score ? h : a;
      return `Full-time: ${scoreLine(m)}. ${w.name} take the win!`;
    },

    possession: (m, side, r) => pick(m, [
      `${side.name} keep the ball patiently, ${n(r)} dictating the tempo.`,
      `${n(r)} recycles possession for ${side.name}.`,
      `${side.name} probe for an opening, but it's crowded in there.`,
      `Neat triangles from ${side.name}, ${n(r)} at the heart of it.`,
    ]),
    interception: (m, d, p) => pick(m, [
      `${n(d)} reads ${n(p)}'s pass and steps in to intercept.`,
      `Good anticipation from ${n(d)} to cut out the ball from ${n(p)}.`,
    ]),
    tackleMid: (m, d, p) => pick(m, [
      `${n(d)} wins it back in midfield, dispossessing ${n(p)}.`,
      `Strong challenge by ${n(d)} on ${n(p)} - ${team(m, d)} regain possession.`,
    ]),
    throughBall: (m, c, r) => pick(m, [
      `Brilliant ball from ${n(c)}! ${n(r)} is in behind...`,
      `${n(c)} threads it through for ${n(r)}, who's clean through!`,
      `Lovely vision from ${n(c)} - ${n(r)} races onto it.`,
    ]),
    offside: (m, r, c) => pick(m, [
      `${n(c)} tries to find ${n(r)}, but the flag is up for offside.`,
      `${n(r)} timed that run a fraction too early. Offside.`,
    ]),
    cutOut: (m, d, c, r) => pick(m, [
      `${n(c)} looks for ${n(r)} but ${n(d)} cuts it out.`,
      `${n(d)} reads the through ball and snuffs out the danger.`,
    ]),
    dribblePast: (m, a, d) => pick(m, [
      `${n(a)} jinks past ${n(d)} and into the box!`,
      `Superb footwork from ${n(a)}, leaving ${n(d)} for dead.`,
      `${n(a)} drives at ${n(d)}, wins the race and is into space.`,
      `${n(a)} glides past ${n(d)} with ease.`,
    ]),
    layOff: (m, a, b) => pick(m, [
      `${n(a)} looks up and squares it for ${n(b)}...`,
      `${n(a)} cuts it back to ${n(b)}...`,
    ]),
    tackle: (m, d, a) => pick(m, [
      `${n(a)} tries to take on ${n(d)}, but ${n(d)} stands firm and wins it.`,
      `Great tackle from ${n(d)} to stop ${n(a)}.`,
      `${n(d)} times the challenge perfectly on ${n(a)}.`,
    ]),
    badCross: (m, c, d) => pick(m, [
      `${n(c)}'s cross is overhit and ${n(d)} clears.`,
      `Poor delivery from ${n(c)}, easily dealt with by ${n(d)}.`,
    ]),
    claim: (m, gk, c) => pick(m, [
      `${n(gk)} comes out and plucks ${n(c)}'s delivery out of the air.`,
      `Commanding from ${n(gk)}, claiming the ball under pressure.`,
    ]),
    cross: (m, c, t) => pick(m, [
      `${n(c)} whips in a cross and ${n(t)} rises highest...`,
      `Inviting delivery from ${n(c)} - ${n(t)} gets a head on it...`,
    ]),
    headedClear: (m, d, c) => pick(m, [
      `${n(d)} heads ${n(c)}'s ball away.`,
      `${n(d)} wins the aerial duel and clears the danger.`,
    ]),
    corner: (m, side, taker) => pick(m, [
      `Corner to ${side.name}. ${n(taker)} to take.`,
      `${n(taker)} jogs over to take a corner for ${side.name}.`,
    ]),
    cornerCleared: (m, d) => `${n(d)} gets to the corner first and heads clear.`,

    foul: (m, f, v, where) => {
      if (where === 'box') return pick(m, [
        `${n(f)} brings down ${n(v)} in the box!`,
        `${n(v)} goes down under the challenge of ${n(f)} - and the referee points to the spot!`,
      ]);
      if (where === 'danger') return pick(m, [
        `${n(f)} clips ${n(v)} just outside the area. Free kick in a dangerous position.`,
        `Cynical from ${n(f)}, hauling down ${n(v)} on the edge of the box.`,
      ]);
      return pick(m, [
        `Foul by ${n(f)} on ${n(v)}.`,
        `${n(f)} goes through the back of ${n(v)}. Free kick.`,
        `${n(v)} is tripped by ${n(f)} in midfield.`,
      ]);
    },
    yellow: (m, r) => `Yellow card: ${n(r)} (${team(m, r)}) goes into the book.`,
    secondYellow: (m, r) => `Second yellow for ${n(r)}!`,
    red: (m, r) => `RED CARD! ${n(r)} is sent off - ${team(m, r)} are down to ${m.onPitch(m.sides[r.side]).length}.`,
    redAfterSecond: (m, r) => `${n(r)} is off and ${team(m, r)} are down to ${m.onPitch(m.sides[r.side]).length}.`,
    emergencyKeeper: (m, r) => `No keeper left - ${n(r)} pulls on the gloves for ${team(m, r)}!`,

    freeKick: (m, side, t, dist) => `${n(t)} stands over a free kick from ${dist} yards...`,
    freeKickCross: (m, side, t) => `${n(t)} swings the free kick into the box...`,
    penaltyAwarded: (m, side, t) => `PENALTY to ${side.name}! ${n(t)} places the ball on the spot...`,
    penaltySaved: (m, t, gk) => pick(m, [
      `SAVED! ${n(gk)} guesses right and keeps out ${n(t)}'s penalty!`,
      `${n(gk)} dives full stretch to deny ${n(t)} from the spot!`,
    ]),
    penaltyMissed: (m, t) => pick(m, [
      `${n(t)} blazes the penalty over the bar!`,
      `${n(t)} drags the penalty wide! What a let-off.`,
    ]),

    blocked: (m, s, b, kind) => pick(m, [
      `${n(s)} shoots but ${n(b)} throws a body in the way. Blocked!`,
      `${n(s)}'s ${kind === 'long' ? 'long-range effort' : 'shot'} is charged down by ${n(b)}.`,
    ]),
    save: (m, s, gk, kind, big) => {
      if (big) return pick(m, [
        `What a save! ${n(gk)} somehow keeps out ${n(s)}!`,
        `${n(s)} should score... but ${n(gk)} makes a stunning stop!`,
        `${n(gk)} stands tall and blocks ${n(s)}'s effort one-on-one!`,
      ]);
      if (kind === 'header') return `${n(s)}'s header is straight at ${n(gk)}.`;
      if (kind === 'long') return pick(m, [`${n(s)} tries from distance - comfortable for ${n(gk)}.`, `${n(s)} lets fly from range! ${n(gk)} tips it over.`]);
      if (kind === 'freeKick') return `${n(s)} curls it towards the corner, but ${n(gk)} is equal to it.`;
      return pick(m, [`${n(s)} forces a save from ${n(gk)}.`, `Good stop by ${n(gk)} to deny ${n(s)}.`, `${n(s)}'s shot is held by ${n(gk)}.`]);
    },
    miss: (m, s, kind, big) => {
      if (big) return pick(m, [
        `How has ${n(s)} missed that?! Wide from close range!`,
        `${n(s)} blazes over with the goal gaping!`,
      ]);
      if (kind === 'header') return pick(m, [`${n(s)}'s header drifts just wide.`, `${n(s)} can't direct the header on target.`]);
      if (kind === 'long') return pick(m, [`${n(s)} tries a shot from distance - well over.`, `Ambitious from ${n(s)}, it flies into the stands.`]);
      if (kind === 'freeKick') return `${n(s)}'s free kick clears the bar.`;
      return pick(m, [`${n(s)} fires wide.`, `${n(s)} snatches at it and misses the target.`, `${n(s)}'s shot flashes past the post!`]);
    },
    goal: (m, side, s, a, kind) => {
      const tail = ` ${scoreLine(m)}.`;
      if (kind === 'penalty') return `GOAL! ${n(s)} sends the keeper the wrong way from the spot!${tail}`;
      if (kind === 'freeKick') return `GOAL! ${n(s)} bends a sublime free kick into the top corner!${tail}`;
      if (kind === 'header') return `GOAL! ${n(s)} powers a header home${a ? ` from ${n(a)}'s delivery` : ''}!${tail}`;
      if (kind === 'long') return `GOAL! ${n(s)} unleashes a rocket from distance!${tail}`;
      if (kind === 'oneOnOne') return `GOAL! ${n(s)} keeps calm and slots it past the keeper${a ? `. Assist: ${n(a)}` : ''}!${tail}`;
      return pick(m, [
        `GOAL! ${n(s)} finds the bottom corner${a ? ` after great work by ${n(a)}` : ''}!${tail}`,
        `GOAL! ${n(s)} lashes it into the net${a ? `, set up by ${n(a)}` : ''}!${tail}`,
      ]);
    },
    injury: (m, r) => `${n(r)} (${team(m, r)}) is down injured and can't continue.`,
    sub: (m, side, off, on) => `Substitution ${side.name}: ${n(on)} replaces ${n(off)}.`,
  };

  OF.commentary = commentary;
})(typeof globalThis !== 'undefined' ? globalThis : this);

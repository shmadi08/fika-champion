window.FikaEngine = (() => {
  const LOCK_MS = 15 * 60 * 1000;
  const KNOCKOUT = new Set(["playoff", "r16", "qf", "sf", "final"]);
  const SF_FINAL = new Set(["sf", "final"]);

  function now() { return Date.now(); }

  function kickMs(match) { return new Date(match.kickoff).getTime(); }

  function isLocked(match, t = now()) {
    return t >= kickMs(match) - LOCK_MS;
  }

  function hasResult(match) {
    return Number.isInteger(match.hg) && Number.isInteger(match.ag);
  }

  function basePoints(ph, pa, ah, aa) {
    if (ph === ah && pa === aa) return 5;
    if ((ph - pa) === (ah - aa)) return 3;
    const pw = Math.sign(ph - pa);
    const aw = Math.sign(ah - aa);
    if (pw === aw && aw !== 0) return 2;
    return 0;
  }

  function bonusPoints(base, ph, pa, ah, aa, stage) {
    let b = 0;
    if (KNOCKOUT.has(stage) && base > 0) b += 2;
    if (SF_FINAL.has(stage) && base === 5) b += 3;
    if (ah === aa && ph === pa) b += 1;
    return b;
  }

  function scoreOne(pred, match) {
    if (!pred || !hasResult(match)) return null;
    const base = basePoints(pred.home, pred.away, match.hg, match.ag);
    const bonus = bonusPoints(base, pred.home, pred.away, match.hg, match.ag, match.stage);
    return { base, bonus, total: base + bonus };
  }

  function streakBonusForIndex(correctStreakCountAfterThis) {
    return correctStreakCountAfterThis > 0 && correctStreakCountAfterThis % 3 === 0 ? 5 : 0;
  }

  /**
   * predictions: {matchId: {home, away, at}}
   * joinedAt: membership timestamp
   * matches: catalog
   */
  function scoreUser(predictions, matches, joinedAt) {
    const list = matches
      .slice()
      .sort((a, b) => kickMs(a) - kickMs(b) || a.id.localeCompare(b.id));

    let streak = 0;
    let total = 0, exact = 0, gd = 0, winner = 0, missed = 0, played = 0;
    const byMatch = {};

    for (const m of list) {
      if (!hasResult(m)) continue;
      if (joinedAt && kickMs(m) - LOCK_MS < joinedAt) {
        continue;
      }
      const pred = predictions[m.id];
      played += 1;
      if (!pred) {
        missed += 1;
        streak = 0;
        byMatch[m.id] = { base: 0, bonus: 0, streak: 0, total: 0, missed: true };
        continue;
      }
      const s = scoreOne(pred, m);
      if (s.base > 0) streak += 1;
      else streak = 0;
      const st = streakBonusForIndex(streak);
      const row = { ...s, streak: st, total: s.total + st, missed: false };
      byMatch[m.id] = row;
      total += row.total;
      if (s.base === 5) exact += 1;
      else if (s.base === 3) gd += 1;
      else if (s.base === 2) winner += 1;
    }
    return { total, exact, gd, winner, missed, played, byMatch };
  }

  function rankMembers(rows) {
    return rows.slice().sort((a, b) => {
      if (b.total !== a.total) return b.total - a.total;
      if (b.exact !== a.exact) return b.exact - a.exact;
      if (b.gd !== a.gd) return b.gd - a.gd;
      return a.displayName.localeCompare(b.displayName, "fa");
    });
  }

  function tehran(isoOrMs) {
    const d = new Date(isoOrMs);
    return new Intl.DateTimeFormat("fa-IR", {
      timeZone: "Asia/Tehran",
      year: "numeric", month: "short", day: "numeric",
      hour: "2-digit", minute: "2-digit"
    }).format(d);
  }
  function stockholm(isoOrMs) {
    const d = new Date(isoOrMs);
    return new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Stockholm", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(d);
  }
  function validGoals(n) {
    return Number.isInteger(n) && n >= 0 && n <= 20;
  }

  return {
    LOCK_MS, now, isLocked, hasResult, basePoints, bonusPoints,
    scoreOne, scoreUser, rankMembers, tehran, Stockholm, validGoals, kickMs
  };
})();

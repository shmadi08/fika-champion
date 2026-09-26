window.FikaStore = (() => {
  const E = window.FikaEngine;
  const KEY = "fika-champion-v11";
  const LIMITS = {
    login: [10, 60_000], register: [8, 60_000], predict: [30, 60_000],
    chat: [12, 60_000], invite: [8, 60_000], feedback: [6, 60_000], result: [20, 60_000]
  };

  let remote = null;

  async function detect() {
    if (remote !== null) return remote;
    if (location.protocol === "file:") { remote = false; return false; }
    try {
      const r = await fetch("/api/me", { credentials: "same-origin" });
      remote = r.ok;
    } catch { remote = false; }
    return remote;
  }

  async function api(method, path, body) {
    const r = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || "خطای شبکه");
    return data;
  }

  function load() {
    try { return JSON.parse(localStorage.getItem(KEY)) || seed(); }
    catch { return seed(); }
  }
  function save(db) { localStorage.setItem(KEY, JSON.stringify(db)); }
  function seed() {
    return {
      users: [], memberships: [], invites: [], predictions: [], messages: [],
      feedback: [], matches: structuredClone(window.FIKA_MATCHES), audit: [], rates: {}, sessions: {}
    };
  }
  function rand(n = 24) {
    const a = new Uint8Array(n);
    crypto.getRandomValues(a);
    return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
  }
  async function hash(password, salt) {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(salt + "\n" + password));
    return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
  }
  function rate(db, key, kind) {
    const [max, win] = LIMITS[kind];
    const now = Date.now();
    const recent = (db.rates[key] || []).filter((t) => now - t < win);
    if (recent.length >= max) return false;
    recent.push(now); db.rates[key] = recent; return true;
  }
  function sessionUser(db) {
    const sid = localStorage.getItem("fika-sid");
    if (!sid || !db.sessions[sid]) return null;
    const user = db.users.find((u) => u.id === db.sessions[sid].userId);
    const mem = user ? db.memberships.find((m) => m.userId === user.id) : null;
    return user ? { user, mem, sid } : null;
  }
  function requireUser(db) {
    const s = sessionUser(db);
    if (!s) throw new Error("باید وارد شوید.");
    return s;
  }
  function requireActive(db) {
    const s = requireUser(db);
    if (!s.mem || s.mem.removed) throw new Error("عضویت شما فعال نیست.");
    return s;
  }
  function requireAdmin(db) {
    const s = requireActive(db);
    if (s.mem.role !== "admin") throw new Error("فقط مدیر.");
    return s;
  }

  const local = {
    async register({ email, password, displayName, inviteCode }) {
      const db = load();
      if (!rate(db, "ip:reg", "register")) throw new Error("زیادی درخواست دادید. کمی صبر کنید.");
      email = String(email || "").trim().toLowerCase();
      displayName = String(displayName || "").trim();
      password = String(password || "");
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("ایمیل درست نیست.");
      if (displayName.length < 2 || displayName.length > 24) throw new Error("نام نمایشی ۲ تا ۲۴ حرف.");
      if (password.length < 8) throw new Error("رمز حداقل ۸ کاراکتر.");
      if (db.users.some((u) => u.email === email)) throw new Error("این ایمیل قبلاً ثبت شده.");
      const isFirst = db.users.length === 0;
      let invite = null;
      if (!isFirst) {
        invite = db.invites.find((i) => i.code === String(inviteCode || "").trim());
        if (!invite || invite.revoked) throw new Error("ورود به گروه فقط با کد دعوت معتبر است.");
        if (invite.expiresAt && Date.now() > invite.expiresAt) throw new Error("این دعوت منقضی شده.");
        if (invite.used >= invite.maxUses) throw new Error("ظرفیت این دعوت تمام شده.");
      }
      const salt = rand(16);
      const user = { id: rand(8), email, displayName, salt, passwordHash: await hash(password, salt), createdAt: Date.now() };
      db.users.push(user);
      db.memberships.push({ userId: user.id, role: isFirst ? "admin" : "user", joinedAt: Date.now(), removed: false });
      if (invite) invite.used += 1;
      const sid = rand(24);
      db.sessions[sid] = { userId: user.id, at: Date.now() };
      save(db);
      localStorage.setItem("fika-sid", sid);
      return { ok: true, isFirst };
    },
    async login({ email, password }) {
      const db = load();
      if (!rate(db, "ip:login", "login")) throw new Error("زیادی تلاش کردید.");
      email = String(email || "").trim().toLowerCase();
      const user = db.users.find((u) => u.email === email);
      if (!user || (await hash(String(password || ""), user.salt)) !== user.passwordHash) throw new Error("ایمیل یا رمز نادرست است.");
      const sid = rand(24);
      db.sessions[sid] = { userId: user.id, at: Date.now() };
      save(db);
      localStorage.setItem("fika-sid", sid);
      return { ok: true };
    },
    async logout() {
      const db = load();
      const sid = localStorage.getItem("fika-sid");
      if (sid) delete db.sessions[sid];
      save(db);
      localStorage.removeItem("fika-sid");
    },
    async me() {
      const db = load();
      const s = sessionUser(db);
      if (!s) return null;
      return {
        id: s.user.id, email: s.user.email, displayName: s.user.displayName,
        role: s.mem ? s.mem.role : null, removed: !!(s.mem && s.mem.removed),
        joinedAt: s.mem ? s.mem.joinedAt : null,
        isAdmin: !!(s.mem && s.mem.role === "admin" && !s.mem.removed)
      };
    },
    async listMatches() { return load().matches.slice().sort((a, b) => E.kickMs(a) - E.kickMs(b)); },
    async savePrediction(matchId, home, away) {
      const db = load();
      const s = requireActive(db);
      if (!rate(db, s.user.id + ":pred", "predict")) throw new Error("سقف ثبت پیش‌بینی پر شد.");
      const match = db.matches.find((m) => m.id === matchId);
      if (!match) throw new Error("بازی پیدا نشد.");
      if (E.isLocked(match)) throw new Error("قفل شده. سرور ذخیره را رد کرد.");
      home = Number(home); away = Number(away);
      if (!E.validGoals(home) || !E.validGoals(away)) throw new Error("گل فقط عدد درست ۰ تا ۲۰.");
      const existing = db.predictions.find((p) => p.userId === s.user.id && p.matchId === matchId);
      if (existing) { existing.home = home; existing.away = away; existing.at = Date.now(); }
      else db.predictions.push({ id: rand(6), userId: s.user.id, matchId, home, away, at: Date.now() });
      save(db);
    },
    async myPredictions() {
      const db = load();
      const s = requireUser(db);
      const map = {};
      db.predictions.filter((p) => p.userId === s.user.id).forEach((p) => { map[p.matchId] = p; });
      return map;
    },
    async standings() {
      const db = load();
      return E.rankMembers(db.memberships.map((mem) => {
        const user = db.users.find((u) => u.id === mem.userId);
        const preds = {};
        db.predictions.filter((p) => p.userId === mem.userId).forEach((p) => { preds[p.matchId] = p; });
        return { userId: mem.userId, displayName: user ? user.displayName : "—", removed: !!mem.removed, role: mem.role, ...E.scoreUser(preds, db.matches, mem.joinedAt) };
      }));
    },
    async sendMessage(text) {
      const db = load();
      const s = requireActive(db);
      if (!rate(db, s.user.id + ":chat", "chat")) throw new Error("سقف پیام پر شد.");
      text = String(text || "").replace(/<[^>]*>/g, "").trim();
      if (!text) throw new Error("پیام خالی رد می‌شود.");
      if (text.length > 400) throw new Error("پیام خیلی بلند است.");
      db.messages.push({ id: rand(6), userId: s.user.id, text, at: Date.now(), hidden: false });
      db.messages = db.messages.slice(-300);
      save(db);
    },
    async listMessages() {
      const db = load();
      const s = requireActive(db);
      return db.messages.map((m) => {
        const u = db.users.find((x) => x.id === m.userId);
        return { ...m, displayName: u ? u.displayName : "حذف‌شده", mine: m.userId === s.user.id };
      });
    },
    async hideMessage(id) {
      const db = load();
      requireAdmin(db);
      const msg = db.messages.find((m) => m.id === id);
      if (!msg) throw new Error("پیام نیست.");
      msg.hidden = true; save(db);
    },
    async sendFeedback(text) {
      const db = load();
      const s = requireActive(db);
      if (!rate(db, s.user.id + ":fb", "feedback")) throw new Error("سقف بازخورد پر شد.");
      text = String(text || "").replace(/<[^>]*>/g, "").trim();
      if (!text) throw new Error("متن خالی رد می‌شود.");
      if (text.length > 800) throw new Error("متن خیلی بلند است.");
      db.feedback.push({ id: rand(6), userId: s.user.id, text, at: Date.now() });
      save(db);
    },
    async listFeedback() {
      const db = load();
      const s = requireActive(db);
      return db.feedback.filter((f) => f.userId === s.user.id || s.mem.role === "admin").map((f) => {
        const u = db.users.find((x) => x.id === f.userId);
        return { ...f, displayName: u ? u.displayName : "—" };
      }).reverse();
    },
    async createInvite({ maxUses, days }) {
      const db = load();
      requireAdmin(db);
      if (!rate(db, "inv", "invite")) throw new Error("سقف ساخت دعوت پر شد.");
      maxUses = Math.max(1, Math.min(20, Number(maxUses) || 1));
      days = Math.max(1, Math.min(30, Number(days) || 7));
      const inv = { id: rand(6), code: rand(18), maxUses, used: 0, createdAt: Date.now(), expiresAt: Date.now() + days * 86400000, revoked: false };
      db.invites.unshift(inv); save(db); return inv;
    },
    async revokeInvite(id) {
      const db = load();
      requireAdmin(db);
      const inv = db.invites.find((i) => i.id === id);
      if (!inv) throw new Error("دعوت نیست.");
      inv.revoked = true; save(db);
    },
    async listInvites() { requireAdmin(load()); return load().invites; },
    async listMembers() {
      const db = load();
      requireAdmin(db);
      return db.memberships.map((m) => {
        const u = db.users.find((x) => x.id === m.userId);
        return { ...m, email: u ? u.email : "", displayName: u ? u.displayName : "" };
      });
    },
    async removeMember(userId) {
      const db = load();
      const s = requireAdmin(db);
      if (userId === s.user.id) throw new Error("نمی‌توانید خودتان را حذف کنید.");
      const mem = db.memberships.find((m) => m.userId === userId);
      if (!mem) throw new Error("عضو نیست.");
      mem.removed = true; mem.removedAt = Date.now();
      Object.keys(db.sessions).forEach((sid) => { if (db.sessions[sid].userId === userId) delete db.sessions[sid]; });
      save(db);
    },
    async setResult(matchId, hg, ag) {
      const db = load();
      const s = requireAdmin(db);
      const match = db.matches.find((m) => m.id === matchId);
      if (!match) throw new Error("بازی نیست.");
      if (match.source === "official" && E.hasResult(match)) throw new Error("نتیجه رسمی قفل است. فقط اگر منبع قطع باشد دستی وارد می‌شود.");
      hg = Number(hg); ag = Number(ag);
      if (!E.validGoals(hg) || !E.validGoals(ag)) throw new Error("گل ۰ تا ۲۰.");
      match.hg = hg; match.ag = ag; match.source = "manual"; match.manualBy = s.user.id; match.manualAt = Date.now();
      save(db);
    },
    async addKnockout({ stage, home, away, kickoff }) {
      const db = load();
      requireAdmin(db);
      if (!["playoff", "r16", "qf", "sf", "final"].includes(stage)) throw new Error("مرحله نامعتبر.");
      const t = Date.parse(kickoff);
      if (!t) throw new Error("ساعت سوت نامعتبر.");
      const match = { id: "k-" + rand(4), md: 0, stage, kickoff: new Date(t).toISOString(), home, away, source: null };
      db.matches.push(match); save(db); return match;
    },
    async updateProfile(displayName) {
      const db = load();
      const s = requireActive(db);
      displayName = String(displayName || "").trim();
      if (displayName.length < 2 || displayName.length > 24) throw new Error("نام نمایشی ۲ تا ۲۴ حرف.");
      s.user.displayName = displayName; save(db);
    }
  };

  const net = {
    register: (p) => api("POST", "/api/register", p),
    login: (p) => api("POST", "/api/login", p),
    logout: () => api("POST", "/api/logout"),
    me: async () => (await api("GET", "/api/me")).user,
    listMatches: async () => (await api("GET", "/api/matches")).matches.sort((a, b) => E.kickMs(a) - E.kickMs(b)),
    savePrediction: (matchId, home, away) => api("POST", "/api/predict", { matchId, home, away }),
    myPredictions: async () => (await api("GET", "/api/predictions")).predictions,
    standings: async () => (await api("GET", "/api/standings")).rows,
    sendMessage: (text) => api("POST", "/api/chat", { text }),
    listMessages: async () => (await api("GET", "/api/chat")).messages,
    hideMessage: (id) => api("POST", "/api/chat/hide", { id }),
    sendFeedback: (text) => api("POST", "/api/feedback", { text }),
    listFeedback: async () => (await api("GET", "/api/feedback")).items,
    createInvite: async (p) => (await api("POST", "/api/invites", p)).invite,
    revokeInvite: (id) => api("POST", "/api/invites/revoke", { id }),
    listInvites: async () => (await api("GET", "/api/invites")).invites,
    listMembers: async () => (await api("GET", "/api/members")).members,
    removeMember: (userId) => api("POST", "/api/members/remove", { userId }),
    setResult: (matchId, hg, ag) => api("POST", "/api/result", { matchId, hg, ag }),
    addKnockout: (p) => api("POST", "/api/knockout", p),
    updateProfile: (displayName) => api("POST", "/api/profile", { displayName })
  };

  const wrap = {};
  for (const k of Object.keys(local)) {
    wrap[k] = async (...args) => {
      const use = await detect();
      return (use ? net : local)[k](...args);
    };
  }
  wrap.ready = detect;
  return wrap;
})();

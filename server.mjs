import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const DB_PATH = path.join(__dirname, "data", "db.json");
const MATCHES_PATH = path.join(__dirname, "data", "matches.json");
const GH_TOKEN = process.env.GITHUB_TOKEN || "";
const GH_REPO = process.env.GITHUB_DATA_REPO || "";
const GH_PATH = process.env.GITHUB_DATA_PATH || "db.json";
console.log("persist", Boolean(process.env.GITHUB_TOKEN), process.env.GITHUB_DATA_REPO);
const LOCK_MS = 15 * 60 * 1000;
const KNOCKOUT = new Set(["playoff", "r16", "qf", "sf", "final"]);
const SF_FINAL = new Set(["sf", "final"]);
const LIMITS = {
  login: [10, 60_000], register: [8, 60_000], predict: [30, 60_000],
  chat: [12, 60_000], invite: [8, 60_000], feedback: [6, 60_000], result: [20, 60_000]
};

function readJSON(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fallback; }
}
function seed() {
  const matches = readJSON(MATCHES_PATH, []);
  return { users: [], memberships: [], invites: [], predictions: [], messages: [], feedback: [], matches, audit: [], rates: {}, sessions: {} };
}
let mem = null;
let ghSha = null;
function persistOn() { return !!(GH_TOKEN && GH_REPO); }
async function ghGet() {
  const r = await fetch("https://api.github.com/repos/" + GH_REPO + "/contents/" + GH_PATH, {
    headers: { Authorization: "Bearer " + GH_TOKEN, Accept: "application/vnd.github+json", "User-Agent": "fika-champion" }
  });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error("github-get " + r.status);
  const j = await r.json();
  ghSha = j.sha;
  return JSON.parse(Buffer.from(j.content, "base64").toString("utf8"));
}
async function ghPut(db) {
  const payload = { message: "update fika data", content: Buffer.from(JSON.stringify(db)).toString("base64") };
  if (ghSha) payload.sha = ghSha;
  const r = await fetch("https://api.github.com/repos/" + GH_REPO + "/contents/" + GH_PATH, {
    method: "PUT",
    headers: { Authorization: "Bearer " + GH_TOKEN, Accept: "application/vnd.github+json", "User-Agent": "fika-champion", "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (r.status === 409 || r.status === 422) {
    await ghGet();
    if (ghSha) payload.sha = ghSha;
    const r2 = await fetch("https://api.github.com/repos/" + GH_REPO + "/contents/" + GH_PATH, {
      method: "PUT",
      headers: { Authorization: "Bearer " + GH_TOKEN, Accept: "application/vnd.github+json", "User-Agent": "fika-champion", "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!r2.ok) throw new Error("github-put " + r2.status);
    const j2 = await r2.json();
    ghSha = j2.content && j2.content.sha;
    return;
  }
  if (!r.ok) throw new Error("github-put " + r.status);
  const j = await r.json();
  ghSha = j.content && j.content.sha;
}
async function load() {
  if (mem && Array.isArray(mem.users)) {
    if (!mem.matches || !mem.matches.length) mem.matches = readJSON(MATCHES_PATH, []);
    return mem;
  }
  if (persistOn()) {
    try { mem = await ghGet(); } catch (err) { console.error("persist load", err.message); }
  }
  const s = seed();
  mem = Object.assign(s, mem && typeof mem === "object" ? mem : {});
  if (!Array.isArray(mem.users)) mem.users = [];
  if (!mem.matches || !mem.matches.length) mem.matches = readJSON(MATCHES_PATH, []);
  return mem;
}
async function save(db) {
  mem = db;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  try { fs.writeFileSync(DB_PATH, JSON.stringify(db)); } catch (e) {}
  if (persistOn()) { try { await ghPut(db); } catch (err) { console.error("persist save", err.message); } }
}
function rand(n = 24) { return crypto.randomBytes(n).toString("hex"); }
function hash(password, salt) {
  return crypto.createHash("sha256").update(salt + "\n" + password).digest("hex");
}
function kickMs(m) { return Date.parse(m.kickoff); }
function isLocked(m, t = Date.now()) { return t >= kickMs(m) - LOCK_MS; }
function hasResult(m) { return Number.isInteger(m.hg) && Number.isInteger(m.ag); }
function validGoals(n) { n = Number(n); return Number.isInteger(n) && n >= 0 && n <= 20; }
function basePoints(ph, pa, ah, aa) {
  if (ph === ah && pa === aa) return 5;
  if ((ph - pa) === (ah - aa)) return 3;
  const pw = Math.sign(ph - pa), aw = Math.sign(ah - aa);
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
function scoreUser(predictions, matches, joinedAt) {
  const list = matches.slice().sort((a, b) => kickMs(a) - kickMs(b) || a.id.localeCompare(b.id));
  let streak = 0, total = 0, exact = 0, gd = 0, winner = 0, missed = 0, played = 0;
  const byMatch = {};
  for (const m of list) {
    if (!hasResult(m)) continue;
    if (joinedAt && kickMs(m) - LOCK_MS < joinedAt) continue;
    const pred = predictions[m.id];
    played += 1;
    if (!pred) {
      missed += 1; streak = 0;
      byMatch[m.id] = { base: 0, bonus: 0, streak: 0, total: 0, missed: true };
      continue;
    }
    const base = basePoints(pred.home, pred.away, m.hg, m.ag);
    const bonus = bonusPoints(base, pred.home, pred.away, m.hg, m.ag, m.stage);
    if (base > 0) streak += 1; else streak = 0;
    const st = streak > 0 && streak % 3 === 0 ? 5 : 0;
    const row = { base, bonus, streak: st, total: base + bonus + st, missed: false };
    byMatch[m.id] = row;
    total += row.total;
    if (base === 5) exact += 1; else if (base === 3) gd += 1; else if (base === 2) winner += 1;
  }
  return { total, exact, gd, winner, missed, played, byMatch };
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || "";
  raw.split(";").forEach((p) => {
    const i = p.indexOf("=");
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function send(res, code, obj, extra = {}) {
  const headers = { "Content-Type": "application/json; charset=utf-8", ...extra };
  res.writeHead(code, headers);
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = "";
    req.on("data", (c) => {
      d += c;
      if (d.length > 200_000) { req.destroy(); reject(new Error("big")); }
    });
    req.on("end", () => {
      if (!d) return resolve({});
      try { resolve(JSON.parse(d)); } catch { reject(new Error("json")); }
    });
  });
}
function mime(p) {
  const ext = path.extname(p);
  return ({
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".webmanifest": "application/manifest+json"
  })[ext] || "application/octet-stream";
}
function rate(db, key, kind) {
  const [max, win] = LIMITS[kind];
  const now = Date.now();
  const recent = (db.rates[key] || []).filter((t) => now - t < win);
  if (recent.length >= max) return false;
  recent.push(now);
  db.rates[key] = recent;
  return true;
}
function audit(db, userId, action, detail) {
  db.audit.unshift({ id: rand(4), at: Date.now(), userId, action, detail });
  db.audit = db.audit.slice(0, 400);
}
function auth(db, req) {
  const sid = parseCookies(req).sid;
  if (!sid || !db.sessions[sid]) return null;
  const sess = db.sessions[sid];
  const user = db.users.find((u) => u.id === sess.userId);
  const mem = db.memberships.find((m) => m.userId === sess.userId);
  if (!user) return null;
  return { user, mem, sid };
}
function setSid(res, sid, req) {
  const secure = (req.headers["x-forwarded-proto"] === "https") ? "; Secure" : "";
  return {
    "Set-Cookie": `sid=${sid}; HttpOnly; Path=/; SameSite=Lax; Max-Age=2592000${secure}`
  };
}

const TYPES = {
  ".html": true, ".js": true, ".css": true, ".json": true, ".png": true, ".svg": true, ".webmanifest": true, ".ico": true
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://" + (req.headers.host || "localhost"));
  try {
    if (url.pathname.startsWith("/api/")) return await api(req, res, url);
    let p = url.pathname === "/" ? "/index.html" : url.pathname;
    p = path.normalize(p).replace(/^(\.\.[/\\])+/, "");
    const file = path.join(__dirname, p);
    if (!file.startsWith(__dirname)) return send(res, 403, { error: "forbidden" });
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      return send(res, 404, { error: "not found" });
    }
    const ext = path.extname(file);
    if (!TYPES[ext]) return send(res, 404, { error: "not found" });
    res.writeHead(200, { "Content-Type": mime(file), "Cache-Control": "no-cache" });
    fs.createReadStream(file).pipe(res);
  } catch (err) {
    send(res, 500, { error: "server" });
  }
});

async function api(req, res, url) {
  const db = await load();
  const route = req.method + " " + url.pathname;
  const body = req.method === "GET" ? {} : await readBody(req).catch(() => null);
  if (body === null) return send(res, 400, { error: "درخواست نامعتبر." });

  const fail = (msg, code = 400) => send(res, code, { error: msg });
  const session = () => auth(db, req);
  const needUser = () => {
    const s = session();
    if (!s) throw Object.assign(new Error("باید وارد شوید."), { code: 401 });
    return s;
  };
  const needActive = () => {
    const s = needUser();
    if (!s.mem || s.mem.removed) throw Object.assign(new Error("عضویت شما فعال نیست."), { code: 403 });
    return s;
  };
  const needAdmin = () => {
    const s = needActive();
    if (s.mem.role !== "admin") throw Object.assign(new Error("فقط مدیر."), { code: 403 });
    return s;
  };

  try {
    if (route === "POST /api/register") {
      if (!rate(db, "ip:reg", "register")) return fail("زیادی درخواست دادید. کمی صبر کنید.", 429);
      const email = String(body.email || "").trim().toLowerCase();
      const displayName = String(body.displayName || "").trim();
      const password = String(body.password || "");
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail("ایمیل درست نیست.");
      if (displayName.length < 2 || displayName.length > 24) return fail("نام نمایشی ۲ تا ۲۴ حرف.");
      if (password.length < 8) return fail("رمز حداقل ۸ کاراکتر.");
      if (db.users.some((u) => u.email === email)) return fail("این ایمیل قبلاً ثبت شده.");
      const isFirst = db.users.length === 0;
      let invite = null;
      if (!isFirst) {
        invite = db.invites.find((i) => i.code === String(body.inviteCode || "").trim());
        if (!invite || invite.revoked) return fail("ورود به گروه فقط با کد دعوت معتبر است.");
        if (invite.expiresAt && Date.now() > invite.expiresAt) return fail("این دعوت منقضی شده.");
        if (invite.used >= invite.maxUses) return fail("ظرفیت این دعوت تمام شده.");
      }
      const salt = rand(16);
      const user = { id: rand(8), email, displayName, salt, passwordHash: hash(password, salt), createdAt: Date.now() };
      db.users.push(user);
      db.memberships.push({ userId: user.id, role: isFirst ? "admin" : "user", joinedAt: Date.now(), removed: false });
      if (invite) invite.used += 1;
      const sid = rand(24);
      db.sessions[sid] = { userId: user.id, at: Date.now() };
      audit(db, user.id, isFirst ? "first-admin" : "join", "");
      await save(db);
      return send(res, 200, { ok: true, isFirst }, setSid(res, sid, req));
    }

    if (route === "POST /api/login") {
      if (!rate(db, "ip:login", "login")) return fail("زیادی تلاش کردید.", 429);
      const email = String(body.email || "").trim().toLowerCase();
      const user = db.users.find((u) => u.email === email);
      if (!user || hash(String(body.password || ""), user.salt) !== user.passwordHash) return fail("ایمیل یا رمز نادرست است.", 401);
      const sid = rand(24);
      db.sessions[sid] = { userId: user.id, at: Date.now() };
      await save(db);
      return send(res, 200, { ok: true }, setSid(res, sid, req));
    }

    if (route === "POST /api/logout") {
      const s = session();
      if (s) delete db.sessions[s.sid];
      await save(db);
      return send(res, 200, { ok: true }, { "Set-Cookie": "sid=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax" });
    }

    if (route === "GET /api/me") {
      const s = session();
      if (!s) return send(res, 200, { user: null });
      return send(res, 200, {
        user: {
          id: s.user.id, email: s.user.email, displayName: s.user.displayName,
          role: s.mem ? s.mem.role : null, removed: !!(s.mem && s.mem.removed),
          joinedAt: s.mem ? s.mem.joinedAt : null,
          isAdmin: !!(s.mem && s.mem.role === "admin" && !s.mem.removed)
        }
      });
    }

    if (route === "GET /api/matches") {
      needUser();
      return send(res, 200, { matches: db.matches });
    }

    if (route === "GET /api/predictions") {
      const s = needUser();
      const map = {};
      db.predictions.filter((p) => p.userId === s.user.id).forEach((p) => { map[p.matchId] = p; });
      return send(res, 200, { predictions: map });
    }

    if (route === "POST /api/predict") {
      const s = needActive();
      if (!rate(db, s.user.id + ":pred", "predict")) return fail("سقف ثبت پیش‌بینی پر شد.", 429);
      const match = db.matches.find((m) => m.id === body.matchId);
      if (!match) return fail("بازی پیدا نشد.");
      if (isLocked(match)) return fail("قفل شده. سرور ذخیره را رد کرد.");
      const home = Number(body.home), away = Number(body.away);
      if (!validGoals(home) || !validGoals(away)) return fail("گل فقط عدد درست ۰ تا ۲۰.");
      const existing = db.predictions.find((p) => p.userId === s.user.id && p.matchId === match.id);
      if (existing) { existing.home = home; existing.away = away; existing.at = Date.now(); }
      else db.predictions.push({ id: rand(6), userId: s.user.id, matchId: match.id, home, away, at: Date.now() });
      await save(db);
      return send(res, 200, { ok: true });
    }

    if (route === "GET /api/standings") {
      needUser();
      const rows = db.memberships.map((mem) => {
        const user = db.users.find((u) => u.id === mem.userId);
        const preds = {};
        db.predictions.filter((p) => p.userId === mem.userId).forEach((p) => { preds[p.matchId] = p; });
        const sc = scoreUser(preds, db.matches, mem.joinedAt);
        return { userId: mem.userId, displayName: user ? user.displayName : "—", removed: !!mem.removed, role: mem.role, ...sc };
      }).sort((a, b) => b.total - a.total || b.exact - a.exact || b.gd - a.gd || a.displayName.localeCompare(b.displayName, "fa"));
      return send(res, 200, { rows });
    }

    if (route === "GET /api/chat") {
      const s = needActive();
      const messages = db.messages.map((m) => {
        const u = db.users.find((x) => x.id === m.userId);
        return { ...m, displayName: u ? u.displayName : "حذف‌شده", mine: m.userId === s.user.id };
      });
      return send(res, 200, { messages });
    }

    if (route === "POST /api/chat") {
      const s = needActive();
      if (!rate(db, s.user.id + ":chat", "chat")) return fail("سقف پیام پر شد.", 429);
      const text = String(body.text || "").replace(/<[^>]*>/g, "").trim();
      if (!text) return fail("پیام خالی رد می‌شود.");
      if (text.length > 400) return fail("پیام خیلی بلند است.");
      db.messages.push({ id: rand(6), userId: s.user.id, text, at: Date.now(), hidden: false });
      db.messages = db.messages.slice(-300);
      await save(db);
      return send(res, 200, { ok: true });
    }

    if (route === "POST /api/chat/hide") {
      const s = needAdmin();
      const msg = db.messages.find((m) => m.id === body.id);
      if (!msg) return fail("پیام نیست.");
      msg.hidden = true; msg.hiddenBy = s.user.id; msg.hiddenAt = Date.now();
      audit(db, s.user.id, "hide-message", body.id);
      await save(db);
      return send(res, 200, { ok: true });
    }

    if (route === "POST /api/feedback") {
      const s = needActive();
      if (!rate(db, s.user.id + ":fb", "feedback")) return fail("سقف بازخورد پر شد.", 429);
      const text = String(body.text || "").replace(/<[^>]*>/g, "").trim();
      if (!text) return fail("متن خالی رد می‌شود.");
      if (text.length > 800) return fail("متن خیلی بلند است.");
      db.feedback.push({ id: rand(6), userId: s.user.id, text, at: Date.now() });
      await save(db);
      return send(res, 200, { ok: true });
    }

    if (route === "GET /api/feedback") {
      const s = needActive();
      const items = db.feedback.filter((f) => f.userId === s.user.id || s.mem.role === "admin").map((f) => {
        const u = db.users.find((x) => x.id === f.userId);
        return { ...f, displayName: u ? u.displayName : "—" };
      }).reverse();
      return send(res, 200, { items });
    }

    if (route === "POST /api/invites") {
      const s = needAdmin();
      if (!rate(db, s.user.id + ":inv", "invite")) return fail("سقف ساخت دعوت پر شد.", 429);
      const maxUses = Math.max(1, Math.min(20, Number(body.maxUses) || 1));
      const days = Math.max(1, Math.min(30, Number(body.days) || 7));
      const inv = { id: rand(6), code: rand(18), maxUses, used: 0, createdAt: Date.now(), expiresAt: Date.now() + days * 86400000, revoked: false, by: s.user.id };
      db.invites.unshift(inv);
      audit(db, s.user.id, "invite-create", "");
      await save(db);
      return send(res, 200, { invite: inv });
    }

    if (route === "POST /api/invites/revoke") {
      needAdmin();
      const inv = db.invites.find((i) => i.id === body.id);
      if (!inv) return fail("دعوت نیست.");
      inv.revoked = true;
      await save(db);
      return send(res, 200, { ok: true });
    }

    if (route === "GET /api/invites") {
      needAdmin();
      return send(res, 200, { invites: db.invites });
    }

    if (route === "GET /api/members") {
      needAdmin();
      const members = db.memberships.map((m) => {
        const u = db.users.find((x) => x.id === m.userId);
        return { ...m, email: u ? u.email : "", displayName: u ? u.displayName : "" };
      });
      return send(res, 200, { members });
    }

    if (route === "POST /api/members/remove") {
      const s = needAdmin();
      if (body.userId === s.user.id) return fail("نمی‌توانید خودتان را حذف کنید.");
      const mem = db.memberships.find((m) => m.userId === body.userId);
      if (!mem) return fail("عضو نیست.");
      mem.removed = true; mem.removedAt = Date.now();
      Object.keys(db.sessions).forEach((sid) => { if (db.sessions[sid].userId === body.userId) delete db.sessions[sid]; });
      audit(db, s.user.id, "remove-member", body.userId);
      await save(db);
      return send(res, 200, { ok: true });
    }

    if (route === "POST /api/result") {
      const s = needAdmin();
      if (!rate(db, s.user.id + ":res", "result")) return fail("سقف ثبت نتیجه پر شد.", 429);
      const match = db.matches.find((m) => m.id === body.matchId);
      if (!match) return fail("بازی نیست.");
      if (match.source === "official" && hasResult(match)) return fail("نتیجه رسمی قفل است. فقط اگر منبع قطع باشد دستی وارد می‌شود.");
      const hg = Number(body.hg), ag = Number(body.ag);
      if (!validGoals(hg) || !validGoals(ag)) return fail("گل ۰ تا ۲۰.");
      match.hg = hg; match.ag = ag; match.source = "manual"; match.manualBy = s.user.id; match.manualAt = Date.now();
      audit(db, s.user.id, "manual-result", match.id);
      await save(db);
      return send(res, 200, { ok: true });
    }

    if (route === "POST /api/knockout") {
      const s = needAdmin();
      if (!KNOCKOUT.has(body.stage)) return fail("مرحله نامعتبر.");
      const t = Date.parse(body.kickoff);
      if (!t) return fail("ساعت سوت نامعتبر.");
      const match = { id: "k-" + rand(4), md: 0, stage: body.stage, kickoff: new Date(t).toISOString(), home: body.home, away: body.away, source: null };
      db.matches.push(match);
      audit(db, s.user.id, "add-knockout", match.id);
      await save(db);
      return send(res, 200, { match });
    }

    if (route === "POST /api/profile") {
      const s = needActive();
      let displayName = String(body.displayName || "").trim();
      const password = String(body.password || "");
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail("ایمیل درست نیست.");
      if (displayName.length < 2) displayName = email.split("@")[0].slice(0, 24);
      if (displayName.length < 2) displayName = "بازیکن";
      if (displayName.length > 24) displayName = displayName.slice(0, 24);
      s.user.displayName = displayName;
      await save(db);
      return send(res, 200, { ok: true });
    }

    return fail("نه", 404);
  } catch (err) {
    return send(res, err.code || 400, { error: err.message || "خطا" });
  }
}

server.listen(PORT, "0.0.0.0", () => {
  console.log("Fika Champion http://127.0.0.1:" + PORT);
});

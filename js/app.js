(() => {
  const S = window.FikaStore;
  const E = window.FikaEngine;
  const T = window.FIKA_TEAMS;

  const $ = (id) => document.getElementById(id);
  const toast = (msg) => {
    const el = $("toast");
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove("show"), 2600);
  };

  let page = "matches";
  let mdFilter = 2;

  function team(code) { return T[code] || code; }

  function showAuth(show) {
    $("auth").classList.toggle("hidden", !show);
    $("app").classList.toggle("hidden", show);
  }

  function renderAuth(mode) {
    $("auth-title").textContent = mode === "login" ? "ورود" : "ساخت حساب";
    const first = !localStorage.getItem("fika-champion-v11") || !(JSON.parse(localStorage.getItem("fika-champion-v11") || "{}").users || []).length;
    $("invite-wrap").classList.toggle("hidden", mode === "login" || first);
    $("name-wrap").classList.toggle("hidden", mode === "login");
    $("auth-switch").innerHTML = mode === "login"
      ? `حساب ندارید؟ <a href="#" data-go="reg">ساخت حساب</a>`
      : `حساب دارید؟ <a href="#" data-go="login">ورود</a>`;
    $("auth-form").dataset.mode = mode;
    $("first-hint").classList.toggle("hidden", mode === "login" || !first);
  }

  async function onAuth(ev) {
    ev.preventDefault();
    const mode = $("auth-form").dataset.mode;
    const payload = {
      email: $("email").value,
      password: $("password").value,
      displayName: $("displayName").value,
      inviteCode: $("inviteCode").value
    };
    try {
      if (mode === "login") await S.login(payload);
      else await S.register(payload);
      boot();
    } catch (err) { alert(err.message); }
  }

  function navTo(name) {
    page = name;
    document.querySelectorAll(".nav button").forEach((b) => b.classList.toggle("active", b.dataset.page === name));
    render();
  }

  async function render() {
    const me = await S.me();
    if (!me) { showAuth(true); renderAuth("login"); return; }
    if (me.removed) {
      showAuth(false);
      $("userchip").textContent = me.displayName + " · حذف‌شده";
      $("view").innerHTML = `<div class="card"><h3>حساب حذف شده</h3><p class="muted">امتیاز بازی‌های تمام‌شده سر جایش می‌ماند. پیش‌بینی و گفتگو بسته است.</p><button class="btn ghost" id="out">خروج</button></div>`;
      $("out").onclick = async () => { await S.logout(); boot(); };
      return;
    }
    showAuth(false);
    $("userchip").textContent = me.displayName + (me.isAdmin ? " · مدیر" : "");
    const views = { matches: viewMatches, table: viewTable, chat: viewChat, more: viewMore, admin: viewAdmin };
    await (views[page] || viewMatches)(me);
  }

  function matchStatus(m) {
    if (E.hasResult(m)) return { key: "done", label: m.source === "manual" ? "نتیجه دستی" : "تمام" };
    if (E.isLocked(m)) return { key: "lock", label: "قفل" };
    const left = E.kickMs(m) - Date.now() - E.LOCK_MS;
    if (left < 36e5 * 6) return { key: "soon", label: "نزدیک قفل" };
    return { key: "open", label: "باز" };
  }

  async function viewMatches(me) {
    const matches = await S.listMatches();
    const preds = await S.myPredictions();
    const scored = E.scoreUser(preds, matches, me.joinedAt);
    const weeks = [...new Set(matches.filter((m) => m.md).map((m) => m.md))];
    const knock = matches.filter((m) => !m.md);
    if (!weeks.includes(mdFilter) && mdFilter !== "k") mdFilter = 2;
    const list = mdFilter === "k" ? knock : matches.filter((m) => m.md === mdFilter);

    $("view").innerHTML = `
      <div class="hero">
        <h2>پیش‌بینی هفته</h2>
        <p>قفل ۱۵ دقیقه قبل از سوت، با ساعت سرور. گل ۰ تا ۲۰. هر بازی یک پیش‌بینی.</p>
        <div class="pills">
          <span class="pill">لیگ ۲۶/۲۷</span>
          <span class="pill">بدون شرط‌بندی پول</span>
        </div>
      </div>
      <div class="tabs" id="mdtabs"></div>
      <div class="card" id="mlist"></div>
    `;
    const tabs = $("mdtabs");
    weeks.forEach((w) => {
      const b = document.createElement("button");
      b.textContent = "هفته " + w;
      b.className = mdFilter === w ? "on" : "";
      b.onclick = () => { mdFilter = w; render(); };
      tabs.appendChild(b);
    });
    const kb = document.createElement("button");
    kb.textContent = "حذفی";
    kb.className = mdFilter === "k" ? "on" : "";
    kb.onclick = () => { mdFilter = "k"; render(); };
    tabs.appendChild(kb);

    const box = $("mlist");
    if (!list.length) {
      box.innerHTML = `<p class="muted">هنوز بازی حذفی ثبت نشده. تاریخ‌ها در بخش بیشتر آمده است.</p>`;
      return;
    }
    list.forEach((m) => {
      const st = matchStatus(m);
      const pred = preds[m.id];
      const sc = scored.byMatch[m.id];
      const locked = E.isLocked(m);
      const wrap = document.createElement("div");
      wrap.className = "match-block";
      wrap.innerHTML = `
        <div class="meta">
          <span>${E.tehran(m.kickoff)} · تهران</span>
          <span class="badge ${st.key === "lock" || st.key === "done" ? "lock" : ""} ${m.source === "manual" ? "manual" : ""}">${st.label}${m.md ? " · هفته " + m.md : " · " + (window.FIKA_STAGES[m.stage] || "")}</span>
        </div>
        <div class="match">
          <div class="team">${team(m.home)}</div>
          <div class="score-box" data-id="${m.id}"></div>
          <div class="team away">${team(m.away)}</div>
        </div>
        <div class="pts-slot"></div>
      `;
      const sb = wrap.querySelector(".score-box");
      if (E.hasResult(m) && locked) {
        sb.innerHTML = `<div class="result">${m.hg} – ${m.ag}</div>`;
        if (pred) {
          const line = sc
            ? `پیش‌بینی شما ${pred.home}–${pred.away} · پایه ${sc.base}${sc.bonus ? " · بونوس " + sc.bonus : ""}${sc.streak ? " · استریک +" + sc.streak : ""} · جمع ${sc.total}`
            : `پیش‌بینی شما ${pred.home}–${pred.away}`;
          wrap.querySelector(".pts-slot").innerHTML = `<div class="pts">${line}</div>`;
        } else {
          wrap.querySelector(".pts-slot").innerHTML = `<div class="pts">نزده · زنجیره می‌شکند</div>`;
        }
      } else if (locked) {
        sb.innerHTML = pred
          ? `<div class="result">${pred.home} – ${pred.away}</div>`
          : `<div class="result muted">—</div>`;
        wrap.querySelector(".pts-slot").innerHTML = `<div class="pts">${pred ? "قفل شد. منتظر نتیجه." : "قفل شد و پیش‌بینی نزدید."}</div>`;
      } else {
        sb.innerHTML = `
          <input inputmode="numeric" maxlength="2" value="${pred ? pred.home : ""}" data-side="h">
          <span class="colon">:</span>
          <input inputmode="numeric" maxlength="2" value="${pred ? pred.away : ""}" data-side="a">
        `;
        const btn = document.createElement("button");
        btn.className = "btn";
        btn.style.marginTop = "8px";
        btn.textContent = pred ? "ویرایش پیش‌بینی" : "ثبت پیش‌بینی";
        btn.onclick = () => {
          const h = Number(sb.querySelector('[data-side="h"]').value);
          const a = Number(sb.querySelector('[data-side="a"]').value);
          try { await S.savePrediction(m.id, h, a); toast("ذخیره شد"); render(); }
          catch (err) { toast(err.message); }
        };
        wrap.querySelector(".pts-slot").appendChild(btn);
      }
      box.appendChild(wrap);
      const hr = document.createElement("div");
      hr.style.borderTop = "1px solid rgba(255,255,255,.05)";
      hr.style.margin = "12px 0";
      box.appendChild(hr);
    });
  }

  async function viewTable() {
    const rows = await S.standings();
    $("view").innerHTML = `
      <div class="hero">
        <h2>جدول گروه</h2>
        <p>اول امتیاز کل، بعد نتیجه دقیق، بعد تفاضل درست، بعد نام نمایشی.</p>
      </div>
      <div class="card">
        <table class="table">
          <thead><tr><th></th><th>نام</th><th>امتیاز</th><th>دقیق</th><th>تفاضل</th><th>نزده</th></tr></thead>
          <tbody>${rows.map((r, i) => `
            <tr class="${r.removed ? "removed" : ""}">
              <td class="rank">${i + 1}</td>
              <td>${r.displayName}${r.removed ? " <span class='badge lock'>حذف‌شده</span>" : ""}${r.role === "admin" ? " <span class='badge'>مدیر</span>" : ""}</td>
              <td>${r.total}</td>
              <td>${r.exact}</td>
              <td>${r.gd}</td>
              <td>${r.missed}</td>
            </tr>`).join("")}</tbody>
        </table>
      </div>
    `;
  }

  async function viewChat(me) {
    const msgs = await S.listMessages();
    $("view").innerHTML = `
      <div class="card">
        <h3>گفتگوی گروه</h3>
        <p class="tiny">متن ساده. کد صفحه اجرا نمی‌شود. مدیر می‌تواند پیام را از چشم گروه بردارد.</p>
        <div class="chat-log" id="clog"></div>
        <div style="display:grid;grid-template-columns:1fr auto;gap:8px;margin-top:10px">
          <input id="chattext" maxlength="400" placeholder="پیام…">
          <button class="btn" id="chatsend" style="width:auto;padding:12px 16px">ارسال</button>
        </div>
      </div>
    `;
    const log = $("clog");
    msgs.forEach((m) => {
      if (m.hidden && !me.isAdmin) return;
      const d = document.createElement("div");
      d.className = "bubble" + (m.mine ? " me" : "") + (m.hidden ? " hidden" : "");
      d.innerHTML = `<div class="who">${m.displayName}${m.hidden ? " · حذف‌شده از دید گروه" : ""}</div>
        <div></div><div class="when">${E.tehran(m.at)}</div>`;
      d.children[1].textContent = m.text;
      if (me.isAdmin && !m.hidden) {
        const b = document.createElement("button");
        b.className = "btn ghost";
        b.style.marginTop = "6px";
        b.textContent = "پنهان کردن";
        b.onclick = async () => { try { await S.hideMessage(m.id); render(); } catch (e) { toast(e.message); } };
        d.appendChild(b);
      }
      log.appendChild(d);
    });
    log.scrollTop = log.scrollHeight;
    $("chatsend").onclick = () => {
      try { await S.sendMessage($("chattext").value); render(); }
      catch (e) { toast(e.message); }
    };
  }

  async function viewMore(me) {
    $("view").innerHTML = `
      <div class="card">
        <h3>پروفایل</h3>
        <div class="kv"><span>ایمیل</span><span class="mono">${me.email}</span></div>
        <label>نام نمایشی</label>
        <input id="newname" value="${me.displayName}">
        <div class="row-btns">
          <button class="btn" id="savename">ذخیره نام</button>
          <button class="btn ghost" id="out">خروج</button>
        </div>
      </div>
      <div class="card">
        <h3>بازخورد خصوصی</h3>
        <p class="tiny">فقط شما و مدیر می‌بینید.</p>
        <textarea id="fb" placeholder="پیشنهاد یا ایراد…"></textarea>
        <button class="btn" id="fbsend" style="margin-top:8px">ارسال بازخورد</button>
        <div id="fblist" style="margin-top:12px"></div>
      </div>
      <div class="card">
        <h3>امتیاز بعد از اصلاح</h3>
        <ul class="rules">
          <li>نتیجه دقیق ۵ · تفاضل درست ۳ · فقط برنده ۲ · وگرنه صفر. فقط یکی از این‌ها پایه است.</li>
          <li>حذفی و پایه بیشتر از صفر: ۲+</li>
          <li>نیمه‌نهایی یا فینال و فقط نتیجه دقیق: ۳+</li>
          <li>بازی مساوی و شما هم مساوی: ۱+</li>
          <li>سومین، ششمین، … درست پیاپی به ترتیب سوت: ۵+</li>
          <li>گل وقت اضافه حساب است. پنالتی گل نیست. اگر ۱۲۰ دقیقه ۱–۱ بماند، نتیجه ۱–۱ است.</li>
        </ul>
      </div>
      <div class="card">
        <h3>تقویم حذفی</h3>
        ${window.FIKA_CALENDAR_NOTE.map((x) => `<div class="kv"><span>${x.k}</span><span>${x.v}</span></div>`).join("")}
        <p class="tiny">ساعت سوت همان بازی در منبع رسمی ملاک است، نه جدول چاپی.</p>
      </div>
      <div class="card">
        <h3>نصب روی گوشی</h3>
        <p class="install-hint">
          این اپ فروشگاه نیست؛ صفحه را به صفحه اصلی اضافه کنید.
          آیفون: دکمه اشتراک → Add to Home Screen.
          اندروید کروم: منو → نصب برنامه یا Add to Home screen.
        </p>
      </div>
    `;
    $("savename").onclick = () => {
      try { await S.updateProfile($("newname").value); toast("ذخیره شد"); render(); }
      catch (e) { toast(e.message); }
    };
    $("out").onclick = async () => { await S.logout(); boot(); };
    $("fbsend").onclick = () => {
      try { await S.sendFeedback($("fb").value); toast("بازخورد ثبت شد"); render(); }
      catch (e) { toast(e.message); }
    };
    const fblist = $("fblist");
    (await S.listFeedback()).forEach((f) => {
      const d = document.createElement("div");
      d.className = "tiny";
      d.style.padding = "8px 0";
      d.textContent = `${f.displayName} · ${E.tehran(f.at)} — ${f.text}`;
      fblist.appendChild(d);
    });
  }

  async function viewAdmin(me) {
    if (!me.isAdmin) { page = "more"; render(); return; }
    const invites = await S.listInvites();
    const members = await S.listMembers();
    const openMatches = (await S.listMatches()).filter((m) => !E.hasResult(m) || m.source !== "official");
    $("view").innerHTML = `
      <div class="hero"><h2>مدیریت گروه</h2><p>دعوت، اعضا، نتیجه پشتیبان، بازی حذفی.</p></div>
      <div class="card">
        <h3>دعوت‌نامه</h3>
        <div class="row-btns">
          <div><label>سقف استفاده</label><input id="imax" type="number" value="3" min="1" max="20"></div>
          <div><label>اعتبار (روز)</label><input id="idays" type="number" value="7" min="1" max="30"></div>
        </div>
        <button class="btn" id="mkinv" style="margin-top:10px">ساخت کد بلند تصادفی</button>
        <div id="invout" style="margin-top:10px"></div>
      </div>
      <div class="card">
        <h3>اعضا</h3>
        <div id="mems"></div>
      </div>
      <div class="card">
        <h3>نتیجه پشتیبان</h3>
        <p class="tiny">فقط وقتی منبع رسمی قطع است. سیستم ثبت می‌کند که دستی است.</p>
        <label>بازی</label>
        <select id="resmatch">${openMatches.map((m) => `<option value="${m.id}">${team(m.home)} – ${team(m.away)}</option>`).join("")}</select>
        <div class="row-btns">
          <div><label>گل میزبان</label><input id="resh" type="number" min="0" max="20"></div>
          <div><label>گل مهمان</label><input id="resa" type="number" min="0" max="20"></div>
        </div>
        <button class="btn" id="setres" style="margin-top:10px">ثبت نتیجه دستی</button>
      </div>
      <div class="card">
        <h3>افزودن بازی حذفی</h3>
        <label>مرحله</label>
        <select id="kstage">
          <option value="playoff">پلی‌آف</option>
          <option value="r16">یک‌هشتم</option>
          <option value="qf">یک‌چهارم</option>
          <option value="sf">نیمه‌نهایی</option>
          <option value="final">فینال</option>
        </select>
        <div class="row-btns">
          <div><label>میزبان</label><select id="khome">${Object.entries(T).map(([k,v]) => `<option value="${k}">${v}</option>`).join("")}</select></div>
          <div><label>مهمان</label><select id="kaway">${Object.entries(T).map(([k,v]) => `<option value="${k}">${v}</option>`).join("")}</select></div>
        </div>
        <label>سوت (محلی دستگاه، بعد به جهانی ذخیره می‌شود)</label>
        <input id="kkick" type="datetime-local">
        <button class="btn" id="addk" style="margin-top:10px">افزودن</button>
      </div>
    `;
    const invout = $("invout");
    invites.forEach((inv) => {
      const d = document.createElement("div");
      d.className = "kv";
      d.innerHTML = `<span class="mono">${inv.revoked ? "باطل" : inv.code}</span><span>${inv.used}/${inv.maxUses} · تا ${E.tehran(inv.expiresAt)}</span>`;
      if (!inv.revoked) {
        const b = document.createElement("button");
        b.className = "btn ghost";
        b.style.width = "auto";
        b.style.marginRight = "8px";
        b.textContent = "ابطال";
        b.onclick = async () => { await S.revokeInvite(inv.id); render(); };
        d.prepend(b);
      }
      invout.appendChild(d);
    });
    $("mkinv").onclick = () => {
      try {
        const inv = await S.createInvite({ maxUses: $("imax").value, days: $("idays").value });
        toast("کد ساخته شد");
        render();
        setTimeout(() => alert("کد دعوت:\n" + inv.code), 50);
      } catch (e) { toast(e.message); }
    };
    const mems = $("mems");
    members.forEach((m) => {
      const d = document.createElement("div");
      d.className = "kv";
      d.innerHTML = `<span>${m.displayName} · ${m.email}${m.removed ? " · حذف‌شده" : ""} · ${m.role === "admin" ? "مدیر" : "کاربر"}</span>`;
      if (!m.removed && m.userId !== me.id) {
        const b = document.createElement("button");
        b.className = "btn danger";
        b.style.width = "auto";
        b.textContent = "حذف";
        b.onclick = async () => { if (confirm("حذف شود؟ امتیاز بازی‌های تمام‌شده می‌ماند.")) { await S.removeMember(m.userId); render(); } };
        d.appendChild(b);
      }
      mems.appendChild(d);
    });
    $("setres").onclick = () => {
      try { await S.setResult($("resmatch").value, $("resh").value, $("resa").value); toast("نتیجه دستی ثبت شد"); render(); }
      catch (e) { toast(e.message); }
    };
    $("addk").onclick = () => {
      try {
        const local = $("kkick").value;
        if (!local) throw new Error("ساعت سوت را بگذارید.");
        await S.addKnockout({ stage: $("kstage").value, home: $("khome").value, away: $("kaway").value, kickoff: new Date(local).toISOString() });
        toast("بازی حذفی اضافه شد"); render();
      } catch (e) { toast(e.message); }
    };
  }

  async function boot() {
    const me = await S.me();
    if (!me) {
      showAuth(true);
      renderAuth(JSON.parse(localStorage.getItem("fika-champion-v11") || "{}").users?.length ? "login" : "reg");
      $("admin-nav").classList.add("hidden");
      return;
    }
    showAuth(false);
    $("admin-nav").classList.toggle("hidden", !me.isAdmin);
    if (page === "admin" && !me.isAdmin) page = "matches";
    render();
  }

  $("auth-form").addEventListener("submit", onAuth);
  $("auth-switch").addEventListener("click", (e) => {
    const a = e.target.closest("[data-go]");
    if (!a) return;
    e.preventDefault();
    renderAuth(a.dataset.go === "reg" ? "reg" : "login");
  });
  document.querySelectorAll(".nav button").forEach((b) => b.addEventListener("click", () => navTo(b.dataset.page)));

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }

  boot();
})();

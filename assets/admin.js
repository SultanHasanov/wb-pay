/* Админка: календарь, менеджеры, выплаты, настройки опроса, журнал. */

(() => {
  const el = (id) => document.getElementById(id);
  const all = (sel) => Array.from(document.querySelectorAll(sel));
  const PALETTE = ["#6c5ce7", "#00b894", "#e17055", "#0984e3", "#d63031", "#b8860b"];

  const now = new Date();
  const S = {
    year: now.getFullYear(),
    month: now.getMonth() + 1,
    workdays: [], managers: [], polls: [], votelog: [], settings: null,
    tab: "calendar",
    modalDate: null,
  };

  const mgrById = (id) => S.managers.find((m) => m.id === id);
  const tz = () => (S.settings && S.settings.tz) || "Europe/Moscow";
  const activeManagers = () =>
    S.managers.filter((m) => m.active !== false).sort((a, b) => (a.sort || 0) - (b.sort || 0));

  const POLL_STATUS = {
    creating: ["wait", "отправляется"],
    sent: ["wait", "ждём выбора"],
    awaiting_confirm: ["wait", "ждём подтверждения"],
    awaiting_hold: ["wait", "идёт отсчёт"],
    committed: ["ok", "зафиксирован"],
    conflict: ["no", "расхождение"],
    cancelled: ["mut", "отменён"],
  };

  const pill = (status) => {
    const [cls, label] = POLL_STATUS[status] || ["mut", status || "—"];
    return `<span class="pill pill--${cls}">${U.esc(label)}</span>`;
  };

  /* ================= загрузка ================= */
  async function loadAll() {
    const [workdays, managers, polls, votelog, settings] = await Promise.all([
      DB.list("workdays"), DB.list("managers"), DB.list("polls"),
      DB.list("votelog"), DB.settings(),
    ]);
    S.workdays = workdays;
    S.managers = managers.sort((a, b) => (a.sort || 0) - (b.sort || 0));
    S.polls = polls;
    S.votelog = votelog;
    S.settings = settings ? { ...DEFAULT_SETTINGS, ...settings } : null;
  }

  async function refresh() {
    await loadAll();
    drawAll();
  }

  function drawAll() {
    drawHeader();
    drawCalendar();
    drawManagers();
    drawPay();
    drawPoll();
    drawLog();
  }

  function drawHeader() {
    const today = U.todayISO(tz());
    const poll = S.polls.find(
      (p) => p.date === today && p.kind === "shift" && p.status !== "cancelled"
    );
    const rows = S.workdays.filter((w) => w.date === today);
    let s = `Сегодня ${U.fmtLong(today)}. `;
    if (rows.length) {
      s += "На смене: " + rows.map((w) => (mgrById(w.managerId) || {}).name || "?").join(", ");
    } else if (poll) {
      s += "Опрос: " + (POLL_STATUS[poll.status] || ["", poll.status])[1];
    } else {
      s += "Опрос ещё не отправлен.";
    }
    el("adminToday").textContent = s;
  }

  /* ================= календарь ================= */
  function drawCalendar() {
    const label = `${U.MONTHS[S.month - 1]} ${S.year}`;
    el("monthLabel").textContent = label;
    el("payMonthLabel").textContent = label;
    Cal.renderWeekdays(el("weekdays"));
    Cal.render(el("calendar"), {
      year: S.year, month: S.month,
      workdays: S.workdays, managers: S.managers,
      clickable: true,
      onDayClick: openDay,
    });
    Cal.renderTotals(el("totals"), Cal.totals(S.workdays, S.managers, S.year, S.month));
  }

  function openDay(date) {
    S.modalDate = date;
    const rows = S.workdays.filter((w) => w.date === date);
    el("dayTitle").textContent = U.fmtLong(date);

    const poll = S.polls.find((p) => p.date === date && p.kind === "shift" && p.status !== "cancelled");
    el("daySub").innerHTML = poll
      ? `Опрос: ${pill(poll.status)}`
      : `<span class="muted">Опроса за этот день не было</span>`;

    const list = S.managers.filter((m) => m.active !== false || rows.some((w) => w.managerId === m.id));
    el("dayRows").innerHTML = list.map((m) => {
      const w = rows.find((x) => x.managerId === m.id);
      return `
        <div style="display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid var(--line)">
          <span class="chip" style="background:${U.esc(m.color || "#888")}">${U.esc(m.letter || "?")}</span>
          <span style="flex:1;font-weight:550">${U.esc(m.name)}</span>
          <label class="nowrap" style="font-size:13px">
            <input type="checkbox" data-worked="${m.id}" ${w ? "checked" : ""} /> работал
          </label>
          <label class="nowrap" style="font-size:13px">
            <input type="checkbox" data-paid="${m.id}" ${w && w.paid ? "checked" : ""} ${w ? "" : "disabled"} /> оплачен
          </label>
        </div>`;
    }).join("") || `<div class="muted">Сначала заведите менеджеров.</div>`;

    // «оплачен» имеет смысл только если день отмечен
    all("#dayRows input[data-worked]").forEach((cb) => {
      cb.addEventListener("change", () => {
        const paid = el("dayRows").querySelector(`input[data-paid="${cb.dataset.worked}"]`);
        paid.disabled = !cb.checked;
        if (!cb.checked) paid.checked = false;
      });
    });

    el("dayNote").value = (rows.find((w) => w.note) || {}).note || "";
    el("dayModal").classList.add("on");
  }

  const closeDay = () => el("dayModal").classList.remove("on");

  async function saveDay() {
    const date = S.modalDate;
    if (!date) return;
    const note = el("dayNote").value.trim();
    const rows = S.workdays.filter((w) => w.date === date);

    for (const m of S.managers) {
      const workedBox = el("dayRows").querySelector(`input[data-worked="${m.id}"]`);
      if (!workedBox) continue;
      const worked = workedBox.checked;
      const paid = el("dayRows").querySelector(`input[data-paid="${m.id}"]`).checked;
      const existing = rows.find((w) => w.managerId === m.id);

      if (worked && !existing) {
        await DB.create("workdays", {
          date, managerId: m.id, rate: Number(m.rate) || 0,
          paid, source: "manual", confirmedBy: "", confirmedAt: new Date().toISOString(), note,
        });
      } else if (worked && existing) {
        await DB.update("workdays", existing.id, { paid, note });
      } else if (!worked && existing) {
        await DB.remove("workdays", existing.id);
      }
    }
    closeDay();
    await refresh();
  }

  /* ================= менеджеры ================= */
  function drawManagers() {
    el("mgrSeed").hidden = S.managers.length > 0;
    el("mgrList").innerHTML = S.managers.map((m) => `
      <div class="card" style="box-shadow:none;border:1px solid var(--line);margin-bottom:10px" data-mgr="${m.id}">
        <div class="grid2">
          <div class="field"><label>Имя (вариант в опросе)</label>
            <input type="text" data-f="name" value="${U.esc(m.name || "")}" /></div>
          <div class="field"><label>Телефон для белого списка</label>
            <input type="text" data-f="phone" value="${U.esc(m.phone || "")}" placeholder="79001234567" /></div>
        </div>
        <div class="grid2">
          <div class="field"><label>Ставка за день, ₽</label>
            <input type="number" data-f="rate" value="${Number(m.rate) || 0}" min="0" /></div>
          <div class="field"><label>Буква и цвет в календаре</label>
            <div style="display:flex;gap:8px">
              <input type="text" data-f="letter" value="${U.esc(m.letter || "")}" maxlength="2" style="width:60px" />
              <input type="color" data-f="color" value="${U.esc(m.color || "#6c5ce7")}" />
            </div>
          </div>
        </div>
        <div class="check">
          <input type="checkbox" data-f="active" id="act-${m.id}" ${m.active !== false ? "checked" : ""} />
          <label for="act-${m.id}">Активен — участвует в опросе</label>
        </div>
        <div class="btn-row">
          <button class="btn btn--sm" data-act="save">Сохранить</button>
          <button class="btn btn--danger btn--sm" data-act="del">Удалить</button>
          <span class="muted" data-msg></span>
        </div>
      </div>`).join("") || `<div class="muted">Пока никого нет.</div>`;

    all("#mgrList [data-mgr]").forEach((box) => {
      const id = Number(box.dataset.mgr);
      const get = (f) => box.querySelector(`[data-f="${f}"]`);
      box.querySelector('[data-act="save"]').addEventListener("click", async () => {
        const name = get("name").value.trim();
        if (!name) return (box.querySelector("[data-msg]").textContent = "Имя обязательно");
        await DB.update("managers", id, {
          name,
          phone: get("phone").value.trim(),
          rate: Number(get("rate").value) || 0,
          letter: (get("letter").value.trim() || name[0]).toUpperCase(),
          color: get("color").value,
          active: get("active").checked,
        });
        box.querySelector("[data-msg]").textContent = "Сохранено";
        await refresh();
      });
      box.querySelector('[data-act="del"]').addEventListener("click", async () => {
        const used = S.workdays.filter((w) => w.managerId === id).length;
        const warn = used
          ? `У этого менеджера ${used} отмеченных дней. Записи останутся в базе, но без имени. Удалить?`
          : "Удалить менеджера?";
        if (!confirm(warn)) return;
        await DB.remove("managers", id);
        await refresh();
      });
    });
  }

  async function addManager(name = "") {
    const used = S.managers.map((m) => m.color);
    await DB.create("managers", {
      name: name || "Новый менеджер",
      letter: (name[0] || "?").toUpperCase(),
      color: PALETTE.find((c) => !used.includes(c)) || PALETTE[0],
      phone: "",
      rate: 800,
      active: true,
      sort: S.managers.length + 1,
    });
    await refresh();
  }

  /* ================= выплаты ================= */
  function drawPay() {
    const list = Cal.totals(S.workdays, S.managers, S.year, S.month);
    el("payList").innerHTML = list.map((t) => `
      <div style="display:flex;align-items:center;gap:10px;padding:11px 0;border-bottom:1px solid var(--line);flex-wrap:wrap">
        <span class="chip" style="background:${U.esc(t.manager.color || "#888")}">${U.esc(t.manager.letter || "?")}</span>
        <span style="font-weight:600">${U.esc(t.manager.name)}</span>
        <span class="muted">${t.days} дн. · начислено ${U.money(t.accrued)}</span>
        <span style="margin-left:auto;text-align:right">
          <div style="color:var(--ok);font-size:13px">выплачено ${U.money(t.paid)}</div>
          <div style="font-weight:650">осталось ${U.money(t.left)}</div>
        </span>
        <button class="btn btn--ok btn--sm" data-paymonth="${t.manager.id}" ${t.days === t.paidDays ? "disabled" : ""}>
          Отметить месяц
        </button>
      </div>`).join("") || `<div class="muted">Нет данных.</div>`;

    all("#payList [data-paymonth]").forEach((b) => {
      b.addEventListener("click", async () => {
        const id = Number(b.dataset.paymonth);
        const prefix = `${S.year}-${String(S.month).padStart(2, "0")}`;
        const rows = S.workdays.filter(
          (w) => w.managerId === id && String(w.date).startsWith(prefix) && !w.paid
        );
        if (!rows.length) return;
        if (!confirm(`Отметить оплаченными ${rows.length} дн. за ${U.MONTHS[S.month - 1]}?`)) return;
        for (const w of rows) await DB.update("workdays", w.id, { paid: true });
        await refresh();
      });
    });

    const sel = el("payWho");
    const keep = sel.value;
    sel.innerHTML = `<option value="">Все менеджеры</option>` +
      S.managers.map((m) => `<option value="${m.id}">${U.esc(m.name)}</option>`).join("");
    sel.value = keep;
  }

  async function markRange(paid) {
    const from = el("payFrom").value;
    const to = el("payTo").value;
    const who = el("payWho").value;
    if (!from || !to) return (el("payMsg").textContent = "Укажите обе даты");
    if (from > to) return (el("payMsg").textContent = "Начало периода позже конца");

    const rows = S.workdays.filter(
      (w) => w.date >= from && w.date <= to &&
             (!who || w.managerId === Number(who)) && !!w.paid !== paid
    );
    if (!rows.length) return (el("payMsg").textContent = "Нечего менять в этом периоде");
    if (!confirm(`${paid ? "Отметить оплаченными" : "Снять отметку"}: ${rows.length} дн.?`)) return;

    for (const w of rows) await DB.update("workdays", w.id, { paid });
    el("payMsg").textContent = `Готово: ${rows.length} дн.`;
    await refresh();
  }

  /* ================= опрос ================= */
  function drawPoll() {
    el("noSettingsCard").hidden = !!S.settings;
    if (!S.settings) {
      el("pollToday").textContent = "Сначала создайте настройки.";
      return;
    }
    const s = S.settings;
    el("sEnabled").checked = !!s.enabled;
    el("sTime").value = s.pollTime || "09:00";
    el("sTz").value = s.tz || "Europe/Moscow";
    el("sSkipWeekends").checked = !!s.skipWeekends;
    el("sQuestion").value = s.question || "";
    el("sMode").value = s.confirmMode || "confirm";
    el("sHold").value = Number(s.holdMinutes) || 10;
    el("sCleanup").value = s.cleanup || "off";
    el("sCleanupDelay").value = Number.isFinite(Number(s.cleanupDelaySec))
      ? Number(s.cleanupDelaySec) : 10;
    el("sGroup").value = s.groupId || "";
    el("sPhones").value = (s.allowExtraPhones || []).join(", ");
    el("sPin").value = s.adminPin || "";

    const today = U.todayISO(tz());
    const poll = S.polls.find((p) => p.date === today && p.kind === "shift" && p.status !== "cancelled");
    if (!poll) {
      el("pollToday").innerHTML = `<span class="muted">Опрос за ${U.fmtShort(today)} ещё не отправлен.</span>`;
    } else {
      const m = poll.pendingManagerId ? mgrById(poll.pendingManagerId) : null;
      el("pollToday").innerHTML =
        `${pill(poll.status)} <span class="muted">· отправлен ${U.fmtTime(poll.sentAt)}` +
        (m ? ` · выбор: ${U.esc(m.name)}` : "") + `</span>`;
    }
  }

  const phonesFromInput = () =>
    el("sPhones").value.split(",").map((x) => x.trim()).filter(Boolean);

  async function saveSettings(patch, msgId) {
    if (!S.settings) return;
    await DB.saveSettings(S.settings.id, patch);
    el(msgId).textContent = "Сохранено";
    setTimeout(() => (el(msgId).textContent = ""), 2500);
    await refresh();
  }

  async function sendPollNow(force) {
    const msg = el("sendMsg");
    msg.textContent = "Отправляю…";
    try {
      const ctx = await Bot.loadCtx();
      const res = await Bot.sendShiftPoll(U.todayISO(ctx.settings.tz), ctx, { force });
      if (res.sent) msg.textContent = "Опрос отправлен в группу";
      else if (res.skipped === "already_sent") msg.textContent = "Опрос за сегодня уже есть — используйте «Переотправить заново»";
      else msg.textContent = "Отправку перехватила другая вкладка";
      await refresh();
    } catch (e) {
      msg.textContent = "Ошибка: " + e.message;
    }
  }

  async function loadGroups() {
    const box = el("groupList");
    box.innerHTML = `<span class="muted">Загружаю…</span>`;
    try {
      const contacts = await Green.getContacts();
      const groups = (contacts || []).filter((c) => String(c.id).endsWith("@g.us"));
      if (!groups.length) return (box.innerHTML = `<span class="muted">Групп не найдено.</span>`);
      box.innerHTML = `<div class="tbl-wrap"><table>${groups.map((g) => `
        <tr><td>${U.esc(g.name || g.contactName || "без названия")}</td>
        <td class="muted nowrap">${U.esc(g.id)}</td>
        <td class="right"><button class="btn btn--soft btn--sm" data-gid="${U.esc(g.id)}">Выбрать</button></td></tr>`
      ).join("")}</table></div>`;
      all("#groupList [data-gid]").forEach((b) =>
        b.addEventListener("click", () => {
          el("sGroup").value = b.dataset.gid;
          box.innerHTML = `<span class="muted">Выбрано. Не забудьте «Сохранить».</span>`;
        }));
    } catch (e) {
      box.innerHTML = `<span class="err">Ошибка: ${U.esc(e.message)}</span>`;
    }
  }

  async function checkGreen() {
    const box = el("greenReport");
    box.innerHTML = `<span class="muted">Проверяю…</span>`;
    el("fixGreen").hidden = true;
    try {
      const [state, got] = await Promise.all([Green.getStateInstance(), Green.getSettings()]);
      const bad = [];
      const rows = Object.entries(REQUIRED_GREEN_SETTINGS).map(([k, need]) => {
        const cur = got ? got[k] : undefined;
        const ok = String(cur ?? "") === String(need);
        if (!ok) bad.push(k);
        return `<tr><td class="nowrap">${k}</td>
          <td class="muted">${U.esc(String(cur ?? "—")) || "пусто"}</td>
          <td class="nowrap">${U.esc(String(need)) || "пусто"}</td>
          <td>${ok ? '<span class="pill pill--ok">ок</span>' : '<span class="pill pill--no">не так</span>'}</td></tr>`;
      }).join("");

      const authorized = state && state.stateInstance === "authorized";
      box.innerHTML = `
        <div style="margin-bottom:10px">Состояние инстанса:
          ${authorized ? '<span class="pill pill--ok">authorized</span>'
                       : `<span class="pill pill--no">${U.esc((state && state.stateInstance) || "нет ответа")}</span>`}
        </div>
        <div class="tbl-wrap"><table>
          <tr><th>Параметр</th><th>Сейчас</th><th>Нужно</th><th></th></tr>${rows}
        </table></div>
        <div class="muted" style="margin-top:10px">
          ${bad.length
            ? "Пока эти параметры не исправлены, выборы из группы приходить не будут."
            : "Всё настроено верно."}
        </div>`;
      el("fixGreen").hidden = bad.length === 0;
    } catch (e) {
      box.innerHTML = `<span class="err">Ошибка: ${U.esc(e.message)}</span>`;
    }
  }

  async function fixGreen() {
    if (!confirm("Применить нужные настройки к инстансу? Green API может перезапустить его на минуту.")) return;
    const box = el("greenReport");
    try {
      await Green.setSettings({ ...REQUIRED_GREEN_SETTINGS });
      box.innerHTML = `<span class="muted">Настройки отправлены. Инстанс может перезапускаться до минуты — проверьте ещё раз.</span>`;
    } catch (e) {
      box.innerHTML = `<span class="err">Ошибка: ${U.esc(e.message)}</span>`;
    }
  }

  /* ================= журнал ================= */
  function drawLog() {
    const REASON = {
      not_in_whitelist: "номера нет в белом списке",
      unknown_poll: "опрос не найден в базе",
      day_locked: "день уже зафиксирован",
      unknown_option: "неизвестный вариант",
    };
    const rows = [...S.votelog].sort((a, b) => (b.id || 0) - (a.id || 0)).slice(0, 200);
    el("logTable").innerHTML =
      `<tr><th>Когда</th><th>День</th><th>Кто</th><th>Выбор</th><th>Итог</th></tr>` +
      (rows.map((r) => `
        <tr>
          <td class="nowrap muted">${U.fmtTime(r.at)}</td>
          <td class="nowrap">${r.date ? U.fmtShort(r.date) : "—"}</td>
          <td>${U.esc(r.senderName || r.sender || "—")}<div class="muted">${U.esc(r.sender || "")}</div></td>
          <td>${U.esc(r.option || "—")}</td>
          <td>${r.accepted
                ? '<span class="pill pill--ok">принят</span>'
                : `<span class="pill pill--no">отклонён</span><div class="muted">${U.esc(REASON[r.reason] || r.reason || "")}</div>`}</td>
        </tr>`).join("") ||
        `<tr><td colspan="5" class="muted">Пока пусто.</td></tr>`);

    const polls = [...S.polls].sort((a, b) => (b.id || 0) - (a.id || 0)).slice(0, 60);
    el("pollTable").innerHTML =
      `<tr><th>День</th><th>Тип</th><th>Отправлен</th><th>Статус</th><th>Выбор</th></tr>` +
      (polls.map((p) => {
        const m = p.pendingManagerId ? mgrById(p.pendingManagerId) : null;
        return `<tr>
          <td class="nowrap">${p.date ? U.fmtShort(p.date) : "—"}</td>
          <td class="muted">${p.kind === "confirm" ? "подтверждение" : "смена"}</td>
          <td class="nowrap muted">${U.fmtTime(p.sentAt)}</td>
          <td>${pill(p.status)}</td>
          <td>${m ? U.esc(m.name) : "—"}</td>
        </tr>`;
      }).join("") || `<tr><td colspan="5" class="muted">Пока пусто.</td></tr>`);
  }

  /* ================= вкладки и события ================= */
  function switchTab(name) {
    S.tab = name;
    all("[data-tab]").forEach((b) => b.classList.toggle("tab--on", b.dataset.tab === name));
    all("[data-pane]").forEach((p) => (p.hidden = p.dataset.pane !== name));
  }

  function moveMonth(delta) {
    S.month += delta;
    if (S.month < 1) { S.month = 12; S.year--; }
    if (S.month > 12) { S.month = 1; S.year++; }
    drawCalendar();
    drawPay();
  }

  function bind() {
    all("[data-tab]").forEach((b) => b.addEventListener("click", () => switchTab(b.dataset.tab)));
    all("[data-move]").forEach((b) => b.addEventListener("click", () => moveMonth(Number(b.dataset.move))));

    el("daySave").addEventListener("click", saveDay);
    el("dayClose").addEventListener("click", closeDay);
    el("dayModal").addEventListener("click", (e) => { if (e.target === el("dayModal")) closeDay(); });

    el("mgrAdd").addEventListener("click", () => addManager());
    el("mgrSeed").addEventListener("click", async () => {
      await addManager("Хеда");
      await addManager("Камила");
    });

    el("payRange").addEventListener("click", () => markRange(true));
    el("unpayRange").addEventListener("click", () => markRange(false));

    el("seedSettings").addEventListener("click", async () => {
      await DB.create("settings", { ...DEFAULT_SETTINGS });
      await refresh();
    });

    el("saveSchedule").addEventListener("click", () => saveSettings({
      enabled: el("sEnabled").checked,
      pollTime: el("sTime").value || "09:00",
      tz: el("sTz").value.trim() || "Europe/Moscow",
      skipWeekends: el("sSkipWeekends").checked,
      question: el("sQuestion").value.trim() || DEFAULT_SETTINGS.question,
      confirmMode: el("sMode").value,
      holdMinutes: Number(el("sHold").value) || 10,
      cleanup: el("sCleanup").value,
      cleanupDelaySec: Math.max(0, Number(el("sCleanupDelay").value) || 0),
    }, "scheduleMsg"));

    el("saveGroup").addEventListener("click", () => saveSettings({
      groupId: el("sGroup").value.trim(),
      allowExtraPhones: phonesFromInput(),
      adminPin: el("sPin").value.trim() || DEFAULT_SETTINGS.adminPin,
    }, "groupMsg"));

    el("sendNow").addEventListener("click", () => sendPollNow(false));
    el("resendNow").addEventListener("click", () => {
      if (confirm("Отправить новый опрос за сегодня? Прежний перестанет учитываться.")) sendPollNow(true);
    });
    el("loadGroups").addEventListener("click", loadGroups);
    el("checkGreen").addEventListener("click", checkGreen);
    el("fixGreen").addEventListener("click", fixGreen);
  }

  /* ================= вход ================= */
  async function start() {
    el("app").hidden = false;
    el("gate").hidden = true;
    if (!CFG.mokkyReady() || !CFG.greenReady()) el("setupBanner").hidden = false;
    bind();
    await refresh();
    setInterval(refresh, 60000);
    Bot.start({ onChange: refresh });
  }

  async function init() {
    if (!CFG.mokkyReady()) {
      el("app").hidden = false;
      el("setupBanner").hidden = false;
      el("adminToday").textContent = "Заполните assets/config.js";
      return;
    }
    try {
      await loadAll();
    } catch (e) {
      el("gate").hidden = false;
      el("pinErr").textContent = e.message;
      return;
    }

    // Настроек ещё нет — впускаем без PIN, иначе первичную настройку не сделать
    const pin = S.settings && S.settings.adminPin;
    if (!pin) return start();

    if (sessionStorage.getItem("shift-admin") === "1") return start();

    el("gate").hidden = false;
    const tryPin = () => {
      if (el("pin").value === String(pin)) {
        sessionStorage.setItem("shift-admin", "1");
        start();
      } else {
        el("pinErr").textContent = "Неверный PIN";
      }
    };
    el("pinBtn").addEventListener("click", tryPin);
    el("pin").addEventListener("keydown", (e) => { if (e.key === "Enter") tryPin(); });
    el("pin").focus();
  }

  document.addEventListener("DOMContentLoaded", init);
})();

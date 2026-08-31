/* Публичная страница: календарь только на просмотр + статус сегодняшнего опроса. */

(() => {
  const el = (id) => document.getElementById(id);
  const now = new Date();
  let year = now.getFullYear();
  let month = now.getMonth() + 1;
  let data = { workdays: [], managers: [], polls: [], settings: null };

  const STATUS_TEXT = {
    creating: ["warn", "опрос отправляется…"],
    sent: ["warn", "опрос отправлен, ждём выбора"],
    awaiting_confirm: ["warn", "ждём подтверждения"],
    awaiting_hold: ["warn", "принято, идёт отсчёт до фиксации"],
    committed: ["ok", "зафиксировано"],
    conflict: ["err", "расхождение, нужна правка вручную"],
    cancelled: ["mut", "отменён"],
  };

  async function load() {
    const [workdays, managers, polls, settings] = await Promise.all([
      DB.list("workdays"), DB.list("managers"), DB.list("polls"), DB.settings(),
    ]);
    data = { workdays, managers, polls, settings };
  }

  function draw() {
    el("monthLabel").textContent = `${U.MONTHS[month - 1]} ${year}`;
    Cal.renderWeekdays(el("weekdays"));
    Cal.render(el("calendar"), {
      year, month,
      workdays: data.workdays,
      managers: data.managers,
      clickable: false,
    });
    Cal.renderTotals(
      el("totals"),
      Cal.totals(data.workdays, data.managers, year, month),
      U.MONTHS[month - 1]
    );
    drawToday();
  }

  function drawToday() {
    const tz = (data.settings && data.settings.tz) || "Europe/Moscow";
    const today = U.todayISO(tz);
    const poll = data.polls.find((p) => p.date === today && p.kind === "shift" && p.status !== "cancelled");
    const rows = data.workdays.filter((w) => w.date === today);

    let text = `Сегодня ${U.fmtLong(today)}. `;
    if (rows.length) {
      const names = rows
        .map((w) => (data.managers.find((m) => m.id === w.managerId) || {}).name || "?")
        .join(", ");
      text += `На смене: ${names}.`;
    } else if (poll) {
      const [, label] = STATUS_TEXT[poll.status] || ["mut", poll.status];
      text += `Опрос: ${label}.`;
    } else {
      text += "Опрос ещё не отправлен.";
    }
    el("todayLine").textContent = text;
  }

  function setStatus(kind, text) {
    const box = el("botStatus");
    box.className = `status status--${kind}`;
    el("botStatusText").textContent = text;
  }

  function watchBot() {
    setInterval(() => {
      const s = Bot.status;
      if (!s.configured) return setStatus("warn", "Бот выключен — не заполнен config.js");
      if (s.lastError) return setStatus("err", `Ошибка бота: ${s.lastError}`);
      if (!s.leader) return setStatus("ok", "Бот работает в другой вкладке");
      if (s.lastTick) return setStatus("ok", `Бот на связи · ${U.fmtTime(s.lastTick)}`);
      setStatus("warn", "Бот запускается…");
    }, 2000);
  }

  async function refresh() {
    try {
      await load();
      draw();
    } catch (e) {
      el("todayLine").textContent = `Ошибка загрузки: ${e.message}`;
    }
  }

  function init() {
    if (!CFG.mokkyReady() || !CFG.greenReady()) el("setupBanner").hidden = false;

    el("prevM").addEventListener("click", () => {
      if (--month < 1) { month = 12; year--; }
      draw();
    });
    el("nextM").addEventListener("click", () => {
      if (++month > 12) { month = 1; year++; }
      draw();
    });

    if (!CFG.mokkyReady()) {
      setStatus("warn", "Не настроено подключение");
      el("todayLine").textContent = "Заполните assets/config.js";
      return;
    }

    refresh();
    setInterval(refresh, 60000);          // подхватываем правки из других вкладок
    Bot.start({ onChange: refresh });
    watchBot();
  }

  document.addEventListener("DOMContentLoaded", init);
})();

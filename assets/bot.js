/* Бот: отправка опроса по расписанию + разбор выборов из WhatsApp.
   Работает в браузере, пока открыта хотя бы одна вкладка сайта.
   Выборы при закрытой вкладке не теряются — очередь Green API
   хранит уведомления 24 часа и разбирается при следующем открытии. */

window.Bot = (() => {
  const NOBODY = "Никто не на смене";
  const YES = "✅ Подтверждаю";
  const NO = "❌ Отменить";

  const LOCK_KEY = "shift-bot-leader";
  const LOCK_TTL = 45000;
  const TAB_ID = Math.random().toString(36).slice(2);

  const status = {
    running: false,
    leader: false,
    lastTick: null,
    lastError: null,
    configured: false,
  };
  let running = false;
  let onChange = () => {};

  const log = (...a) => console.log("[bot]", ...a);

  /* --- Ведущая вкладка ------------------------------------------------
     Несколько открытых вкладок в одном браузере не должны параллельно
     слать опрос и разбирать очередь. Простой замок в localStorage с TTL:
     кто обновил метку последним и свежее TTL — тот и работает. */
  function claimLeadership() {
    try {
      const raw = localStorage.getItem(LOCK_KEY);
      const now = Date.now();
      if (raw) {
        const l = JSON.parse(raw);
        if (l.id !== TAB_ID && now - l.ts < LOCK_TTL) return false;
      }
      localStorage.setItem(LOCK_KEY, JSON.stringify({ id: TAB_ID, ts: now }));
      return true;
    } catch {
      return true; // localStorage недоступен — работаем без замка
    }
  }

  function releaseLeadership() {
    try {
      const raw = localStorage.getItem(LOCK_KEY);
      if (raw && JSON.parse(raw).id === TAB_ID) localStorage.removeItem(LOCK_KEY);
    } catch { /* не важно */ }
  }

  /* --- Контекст: настройки и менеджеры -------------------------------- */
  async function loadCtx() {
    const [settings, managers] = await Promise.all([
      DB.settings(),
      DB.list("managers"),
    ]);
    if (!settings) throw new Error("В mokky нет записи в коллекции settings");
    return { settings: { ...DEFAULT_SETTINGS, ...settings }, managers };
  }

  const activeManagers = (ctx) =>
    ctx.managers
      .filter((m) => m.active !== false)
      .sort((a, b) => (a.sort || 0) - (b.sort || 0));

  /* Сообщение в группу не должно ронять фиксацию, если WhatsApp сбойнул.
     trackPoll — записать id сообщения в запись дня, чтобы потом убрать его
     из группы вместе с опросами. Итоговое «Зафиксировано» шлём без трекинга:
     оно должно пережить уборку. */
  async function say(ctx, text, trackPoll) {
    try {
      if (!ctx.settings.groupId) return;
      const res = await Green.sendMessage(ctx.settings.groupId, text);
      if (trackPoll && res && res.idMessage) {
        const ids = [...(trackPoll.noteIds || []), res.idMessage];
        trackPoll.noteIds = ids;
        await DB.update("polls", trackPoll.id, { noteIds: ids }).catch(() => {});
      }
    } catch (e) {
      log("не удалось отправить сообщение:", e.message);
    }
  }

  /* Уборка в группе после фиксации дня: опросы и служебные сообщения
     удаляются, чтобы чат не зарастал. История остаётся в mokky.

     Удаляем не сразу, а с задержкой — чтобы все успели увидеть результат.
     Срок хранится в базе (cleanupAt), а не только в таймере вкладки:
     если вкладку закроют до срабатывания, уборку подхватит цикл. */
  async function scheduleCleanup(poll, ctx) {
    const mode = ctx.settings.cleanup || "off";
    if (mode === "off" || !ctx.settings.groupId) return;

    const sec = Number(ctx.settings.cleanupDelaySec);
    const delay = Number.isFinite(sec) && sec >= 0 ? sec : 10;
    await DB.update("polls", poll.id, {
      cleanupAt: new Date(Date.now() + delay * 1000).toISOString(),
    }).catch(() => {});

    setTimeout(() => runCleanup(poll.id).catch(() => {}), delay * 1000 + 200);
  }

  async function runCleanup(pollId) {
    const ctx = await loadCtx();
    if ((ctx.settings.cleanup || "off") === "off" || !ctx.settings.groupId) return;

    const poll = (await DB.list("polls")).find((p) => p.id === pollId);
    if (!poll || !poll.cleanupAt) return;
    if (Date.now() < new Date(poll.cleanupAt).getTime()) return;

    const ids = [...(poll.msgIds || []), ...(poll.noteIds || [])];
    for (const id of ids) {
      try {
        await Green.deleteMessage(ctx.settings.groupId, id);
      } catch (e) {
        log("не удалось удалить сообщение", id, e.message);
      }
    }
    await DB.update("polls", pollId, {
      msgIds: [], noteIds: [], cleanupAt: null,
    }).catch(() => {});
  }

  /* --- Белый список ---------------------------------------------------
     WhatsApp не умеет ограничивать, кто голосует в групповом опросе.
     Поэтому фильтруем на своей стороне: в вебхуке приходит optionVoters
     со списком номеров, и мы засчитываем только своих. */
  function whitelist(ctx) {
    const wl = [];
    for (const m of ctx.managers) {
      if (m.phone) wl.push({ phone: m.phone, name: m.name });
    }
    for (const p of ctx.settings.allowExtraPhones || []) {
      if (p) wl.push({ phone: p, name: "Админ" });
    }
    return wl;
  }

  function resolveVotes(votes, ctx) {
    const wl = whitelist(ctx);
    const rows = [];
    for (const v of votes || []) {
      for (const voter of v.optionVoters || []) {
        const hit = wl.find((w) => U.samePhone(w.phone, voter));
        rows.push({
          phone: U.digits(voter),
          name: hit ? hit.name : "",
          option: v.optionName,
          accepted: !!hit,
          reason: hit ? "" : "not_in_whitelist",
        });
      }
    }
    const accepted = rows.filter((r) => r.accepted);
    const options = [...new Set(accepted.map((r) => r.option))];
    return { rows, accepted, options };
  }

  async function logVotes(poll, pd, rows, result) {
    for (const r of rows) {
      try {
        await DB.create("votelog", {
          at: new Date().toISOString(),
          date: poll ? poll.date : "",
          kind: poll ? poll.kind : "",
          stanzaId: (pd && pd.stanzaId) || "",
          sender: r.phone,
          senderName: r.name,
          option: r.option,
          accepted: r.accepted,
          reason: r.reason,
          result: result || "",
        });
      } catch (e) {
        log("не удалось записать в журнал:", e.message);
      }
    }
  }

  /* --- Отправка опроса ------------------------------------------------- */
  async function sendShiftPoll(dateISO, ctx, { force = false } = {}) {
    const s = ctx.settings;
    if (!s.groupId) throw new Error("Не указан ID группы в настройках");

    const active = activeManagers(ctx);
    if (!active.length) throw new Error("Нет активных менеджеров");

    let polls = await DB.list("polls");

    // Зависший замок: запись «creating» старше двух минут означает, что
    // прошлая попытка оборвалась. Без уборки этот день заблокирован навсегда.
    const stale = polls.filter(
      (p) => p.status === "creating" &&
             (!p.sentAt || Date.now() - new Date(p.sentAt).getTime() > 120000)
    );
    for (const p of stale) await DB.remove("polls", p.id).catch(() => {});
    if (stale.length) polls = polls.filter((p) => !stale.includes(p));

    // Отменённые опросы день не занимают: иначе один тестовый прогон
    // блокировал бы плановую отправку до конца суток.
    const existing = polls.filter(
      (p) => p.date === dateISO && p.kind === "shift" && p.status !== "cancelled"
    );

    if (existing.length && !force) return { skipped: "already_sent" };

    // Повторная отправка: старые опросы за этот день закрываем
    if (force) {
      for (const p of existing) {
        await DB.update("polls", p.id, { status: "cancelled" }).catch(() => {});
        for (const c of polls.filter((x) => x.parentId === p.id && x.status !== "cancelled")) {
          await DB.update("polls", c.id, { status: "cancelled" }).catch(() => {});
        }
      }
    }

    // Замок от двойной отправки: создаём запись и проверяем, что она самая ранняя
    const mine = await DB.create("polls", {
      date: dateISO,
      kind: "shift",
      parentId: null,
      stanzaId: null,
      question: "",
      status: "creating",
      pendingManagerId: null,
      pendingSince: null,
      confirmedBy: "",
      lastVoteSig: null,
      sentAt: new Date().toISOString(),
    });

    const fresh = (await DB.list("polls")).filter(
      (p) => p.date === dateISO && p.kind === "shift" && p.status === "creating"
    );
    const winner = fresh.reduce((a, b) => (a && a.id <= b.id ? a : b), fresh[0]);
    if (!winner || winner.id !== mine.id) {
      await DB.remove("polls", mine.id).catch(() => {});
      return { skipped: "lost_lock" };
    }

    const question = `${s.question} ${U.fmtShort(dateISO)}`;
    const options = [...active.map((m) => m.name), NOBODY];

    try {
      const res = await Green.sendPoll(s.groupId, question, options);
      await DB.update("polls", mine.id, {
        stanzaId: (res && res.idMessage) || null,
        question,
        status: "sent",
        sentAt: new Date().toISOString(),
        msgIds: res && res.idMessage ? [res.idMessage] : [],
        noteIds: [],
      });
      onChange();
      return { sent: true, id: mine.id };
    } catch (e) {
      // Иначе неудачная отправка навсегда заблокировала бы этот день
      await DB.remove("polls", mine.id).catch(() => {});
      throw e;
    }
  }

  async function sendConfirmPoll(shiftPoll, manager, ctx) {
    const question = `Подтвердите смену: ${manager.name} — ${U.fmtShort(shiftPoll.date)}`;
    const rec = await DB.create("polls", {
      date: shiftPoll.date,
      kind: "confirm",
      parentId: shiftPoll.id,
      stanzaId: null,
      question,
      status: "creating",
      pendingManagerId: manager.id,
      pendingSince: null,
      confirmedBy: "",
      lastVoteSig: null,
      sentAt: new Date().toISOString(),
    });
    try {
      const res = await Green.sendPoll(ctx.settings.groupId, question, [YES, NO]);
      await DB.update("polls", rec.id, {
        stanzaId: (res && res.idMessage) || null,
        status: "sent",
      });
      // Опрос-подтверждение убирается вместе с днём, поэтому его id
      // копится в записи основного опроса.
      if (res && res.idMessage) {
        const parent = (await DB.list("polls")).find((p) => p.id === shiftPoll.id);
        const ids = [...((parent && parent.msgIds) || []), res.idMessage];
        await DB.update("polls", shiftPoll.id, { msgIds: ids }).catch(() => {});
      }
    } catch (e) {
      await DB.remove("polls", rec.id).catch(() => {});
      throw e;
    }
  }

  async function cancelChildren(shiftPoll) {
    const polls = await DB.list("polls");
    for (const c of polls) {
      if (c.parentId === shiftPoll.id && c.kind === "confirm" && c.status !== "cancelled") {
        await DB.update("polls", c.id, { status: "cancelled" }).catch(() => {});
      }
    }
  }

  /* --- Фиксация смены -------------------------------------------------- */
  async function commitShift(poll, manager, by, ctx) {
    const workdays = await DB.list("workdays");
    const dup = workdays.find((w) => w.date === poll.date && w.managerId === manager.id);
    if (!dup) {
      await DB.create("workdays", {
        date: poll.date,
        managerId: manager.id,
        rate: Number(manager.rate) || 0,
        paid: false,
        source: "poll",
        confirmedBy: by || "",
        confirmedAt: new Date().toISOString(),
        note: "",
      });
    }
    await DB.update("polls", poll.id, {
      status: "committed",
      pendingManagerId: manager.id,
      pendingSince: null,
    });
    await cancelChildren(poll);
    if ((ctx.settings.cleanup || "off") !== "all") {
      await say(ctx, `✅ Зафиксировано: ${manager.name} — ${U.fmtShort(poll.date)}`);
    }
    await scheduleCleanup(poll, ctx);
    onChange();
  }

  /* --- Разбор выбора в основном опросе --------------------------------- */
  async function handleShiftVote(poll, pd, ctx) {
    const { rows, options } = resolveVotes(pd.votes, ctx);

    if (poll.status === "committed") {
      await logVotes(poll, pd, rows.map((r) => ({
        ...r, accepted: false, reason: r.accepted ? "day_locked" : r.reason,
      })), "day_locked");
      return;
    }

    if (options.length > 1) {
      await logVotes(poll, pd, rows, "conflict");
      if (poll.status !== "conflict") {
        await DB.update("polls", poll.id, { status: "conflict", pendingManagerId: null });
        await cancelChildren(poll);
        await say(ctx,
          `⚠️ Расхождение в опросе за ${U.fmtShort(poll.date)}: выбрано несколько вариантов ` +
          `(${options.join(", ")}). День не зафиксирован — отметьте вручную в админке.`, poll);
        onChange();
      }
      return;
    }

    // Выбор сняли — возвращаем опрос в исходное состояние
    if (options.length === 0) {
      await logVotes(poll, pd, rows, "no_choice");
      if (poll.status !== "sent") {
        await DB.update("polls", poll.id, {
          status: "sent", pendingManagerId: null, pendingSince: null,
        });
        await cancelChildren(poll);
        onChange();
      }
      return;
    }

    const choice = options[0];
    const voter = rows.find((r) => r.accepted && r.option === choice);

    if (choice === NOBODY) {
      await logVotes(poll, pd, rows, "nobody");
      if (poll.status !== "committed") {
        await DB.update("polls", poll.id, {
          status: "committed", pendingManagerId: null, pendingSince: null,
        });
        await cancelChildren(poll);
        if ((ctx.settings.cleanup || "off") !== "all") {
          await say(ctx, `✅ Записано: ${U.fmtShort(poll.date)} — никто не на смене.`);
        }
        await scheduleCleanup(poll, ctx);
        onChange();
      }
      return;
    }

    const manager = activeManagers(ctx).find((m) => m.name === choice);
    if (!manager) {
      await logVotes(poll, pd, rows.map((r) => ({ ...r, accepted: false, reason: "unknown_option" })), "unknown_option");
      return;
    }

    // Тот же выбор пришёл повторно — ничего нового не делаем
    if (poll.pendingManagerId === manager.id &&
        (poll.status === "awaiting_confirm" || poll.status === "awaiting_hold")) {
      await logVotes(poll, pd, rows, "unchanged");
      return;
    }

    await logVotes(poll, pd, rows, `choice:${manager.name}`);
    const mode = ctx.settings.confirmMode;

    if (mode === "instant") {
      await commitShift(poll, manager, voter ? voter.phone : "", ctx);
      return;
    }

    if (mode === "hold") {
      await DB.update("polls", poll.id, {
        status: "awaiting_hold",
        pendingManagerId: manager.id,
        pendingSince: new Date().toISOString(),
        confirmedBy: voter ? voter.phone : "",
      });
      await cancelChildren(poll);
      await say(ctx,
        `⏳ Принято: ${manager.name} — ${U.fmtShort(poll.date)}. ` +
        `Зафиксирую через ${ctx.settings.holdMinutes} мин. Ошиблись — переголосуйте в опросе.`, poll);
      onChange();
      return;
    }

    // confirm: выбор попадёт в базу только после явного подтверждения
    await DB.update("polls", poll.id, {
      status: "awaiting_confirm",
      pendingManagerId: manager.id,
      pendingSince: new Date().toISOString(),
      confirmedBy: voter ? voter.phone : "",
    });
    await cancelChildren(poll);
    await sendConfirmPoll(poll, manager, ctx);
    onChange();
  }

  /* --- Разбор опроса-подтверждения ------------------------------------- */
  async function handleConfirmVote(poll, pd, ctx) {
    const { rows, options } = resolveVotes(pd.votes, ctx);
    await logVotes(poll, pd, rows, options[0] || "no_choice");

    if (poll.status === "cancelled" || options.length !== 1) return;

    const polls = await DB.list("polls");
    const shift = polls.find((p) => p.id === poll.parentId);
    if (!shift || shift.status === "committed") return;

    const manager = ctx.managers.find((m) => m.id === poll.pendingManagerId);
    if (!manager) return;

    if (options[0] === YES) {
      const voter = rows.find((r) => r.accepted && r.option === YES);
      await DB.update("polls", poll.id, { status: "committed" });
      await commitShift(shift, manager, voter ? voter.phone : "", ctx);
    } else if (options[0] === NO) {
      await DB.update("polls", poll.id, { status: "cancelled" });
      await DB.update("polls", shift.id, {
        status: "sent", pendingManagerId: null, pendingSince: null,
      });
      await say(ctx,
        `❌ Отменено. Выберите заново в опросе за ${U.fmtShort(shift.date)}.`, shift);
      onChange();
    }
  }

  /* --- Обработка одного уведомления ------------------------------------ */
  async function processNotification(body, ctx) {
    if (!body || body.typeWebhook !== "incomingMessageReceived") return;
    const md = body.messageData;
    if (!md || md.typeMessage !== "pollUpdateMessage") return;
    const pd = md.pollMessageData;
    if (!pd) return;

    const chatId = body.senderData && body.senderData.chatId;
    if (ctx.settings.groupId && chatId !== ctx.settings.groupId) return;

    const polls = await DB.list("polls");
    // Сначала по идентификатору сообщения, затем — запасной путь по тексту
    // вопроса (в него подставлена дата, поэтому он уникален для дня).
    let poll =
      (pd.stanzaId && polls.find((p) => p.stanzaId && p.stanzaId === pd.stanzaId)) ||
      (pd.name && polls.find((p) => p.question && p.question === pd.name)) ||
      null;

    if (!poll) {
      const { rows } = resolveVotes(pd.votes, ctx);
      await logVotes(null, pd, rows.map((r) => ({
        ...r, accepted: false, reason: "unknown_poll",
      })), "unknown_poll");
      return;
    }

    // pollUpdateMessage приносит полное состояние голосования, а не дельту,
    // поэтому одинаковые уведомления можно спокойно отбрасывать.
    const sig = JSON.stringify(pd.votes || []);
    if (poll.lastVoteSig === sig) return;
    await DB.update("polls", poll.id, { lastVoteSig: sig }).catch(() => {});
    poll = { ...poll, lastVoteSig: sig };

    if (poll.kind === "confirm") await handleConfirmVote(poll, pd, ctx);
    else await handleShiftVote(poll, pd, ctx);
  }

  /* --- Шаги цикла ------------------------------------------------------ */
  async function scheduleStep(ctx) {
    const s = ctx.settings;
    if (!s.enabled || !s.groupId) return;
    const now = U.tzNow(s.tz);
    if (s.skipWeekends && now.isWeekend) return;

    const [h, m] = String(s.pollTime || "09:00").split(":").map(Number);
    if (now.minutes < (h || 0) * 60 + (m || 0)) return;

    await sendShiftPoll(now.date, ctx);
  }

  async function holdStep(ctx) {
    if (ctx.settings.confirmMode !== "hold") return;
    const polls = await DB.list("polls");
    const waitMs = (Number(ctx.settings.holdMinutes) || 10) * 60000;
    for (const p of polls) {
      if (p.kind !== "shift" || p.status !== "awaiting_hold") continue;
      if (!p.pendingSince || !p.pendingManagerId) continue;
      if (Date.now() - new Date(p.pendingSince).getTime() < waitMs) continue;
      const manager = ctx.managers.find((x) => x.id === p.pendingManagerId);
      if (manager) await commitShift(p, manager, p.confirmedBy, ctx);
    }
  }

  /* Страховка: если вкладку закрыли до срабатывания таймера, просроченную
     уборку подхватывает цикл — в этой же или в любой другой вкладке. */
  async function cleanupStep(ctx) {
    if ((ctx.settings.cleanup || "off") === "off") return;
    const now = Date.now();
    for (const p of await DB.list("polls")) {
      if (!p.cleanupAt || now < new Date(p.cleanupAt).getTime()) continue;
      await runCleanup(p.id);
    }
  }

  /* Когда в Green API прописан webhookUrl, receiveNotification отключается —
     режимы взаимоисключающие. Ловим это один раз и дальше очередь не трогаем:
     выборы приходят на вебхук, а вкладке остаётся расписание и уборка. */
  let webhookMode = false;

  async function drainStep(ctx) {
    if (webhookMode) return false;

    let n;
    try {
      n = await Green.receiveNotification(20);
    } catch (e) {
      if (/webhook/i.test(e.message)) {
        webhookMode = true;
        status.webhookMode = true;
        log("включён режим вебхука — очередь не опрашиваем");
        return false;
      }
      throw e;
    }

    if (!n || !n.receiptId) return false;
    try {
      await processNotification(n.body, ctx);
    } catch (e) {
      log("ошибка обработки уведомления:", e.message);
    } finally {
      // Удаляем всегда: пока уведомление в очереди, следующее не придёт.
      await Green.deleteNotification(n.receiptId).catch((e) =>
        log("не удалось удалить уведомление:", e.message));
    }
    return true;
  }

  /* Один полный проход. Используется и вкладкой браузера, и скриптом
     GitHub Actions (bot/tick.cjs) — логика одна на оба запуска.
     Возвращает true, если в очереди что-то было. */
  async function tick(ctx) {
    await maintain(ctx);
    return drainStep(ctx);
  }

  /* Обслуживание без чтения очереди: расписание, отложенные фиксации, уборка.
     Именно это зовёт Vercel cron — очередь там читать нельзя и не нужно. */
  async function maintain(ctx) {
    await scheduleStep(ctx);
    await holdStep(ctx);
    await cleanupStep(ctx);
  }

  /* --- Главный цикл ---------------------------------------------------- */
  async function loop() {
    while (running) {
      try {
        if (!claimLeadership()) {
          status.leader = false;
          await U.sleep(10000);
          continue;
        }
        status.leader = true;

        const ctx = await loadCtx();
        const had = await tick(ctx);

        status.lastTick = new Date().toISOString();
        status.lastError = null;
        // В режиме вебхука очередь не читается и цикл ничем не блокируется —
        // не крутим его вхолостую, обслуживания раз в полминуты достаточно.
        if (!had) await U.sleep(status.webhookMode ? 30000 : 1000);
      } catch (e) {
        status.lastError = e.message;
        log("сбой цикла:", e.message);
        await U.sleep(10000);
      }
    }
    status.leader = false;
  }

  function start(opts = {}) {
    if (running) return;
    onChange = opts.onChange || (() => {});
    status.configured = CFG.mokkyReady() && CFG.greenReady() && CFG.BOT_ENABLED;
    if (!status.configured) {
      log("бот не запущен: не заполнен assets/config.js");
      return;
    }
    running = true;
    status.running = true;
    loop();
    window.addEventListener("beforeunload", releaseLeadership);
  }

  function stop() {
    running = false;
    status.running = false;
    releaseLeadership();
  }

  return {
    start, stop, status,
    tick, maintain, sendShiftPoll, loadCtx, processNotification,
    NOBODY, YES, NO,
  };
})();

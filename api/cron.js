/* Утренняя отправка опроса + отложенные фиксации + уборка.
   Очередь здесь не читаем: при включённом вебхуке это и не нужно, и нельзя.

   Вызывается по расписанию из vercel.json, а также руками:
     /api/cron          — как обычно, опрос уйдёт если пора и его ещё не было
     /api/cron?force=1  — отправить прямо сейчас, заменив сегодняшний опрос */

const { Bot, U } = require("./_bot.js");

module.exports = async (req, res) => {
  // Vercel подписывает вызовы по расписанию, если задан CRON_SECRET.
  // Без него функция открыта — это удобно для ручной проверки с телефона.
  const secret = process.env.CRON_SECRET;
  const fromCron = req.headers.authorization === `Bearer ${secret}`;
  if (secret && !fromCron && req.query.force === undefined) {
    return res.status(401).json({ ok: false, error: "нужен CRON_SECRET" });
  }

  try {
    const ctx = await Bot.loadCtx();
    const now = U.tzNow(ctx.settings.tz);
    const force = req.query.force !== undefined;

    let sent = null;
    if (force) {
      sent = await Bot.sendShiftPoll(now.date, ctx, { force: true });
    }
    // Расписание, отложенные фиксации и уборка
    await Bot.maintain(ctx);

    res.status(200).json({
      ok: true,
      сейчас: `${now.date} ${now.hm} (${ctx.settings.tz})`,
      отправкаПо: ctx.settings.pollTime,
      включён: !!ctx.settings.enabled,
      группа: ctx.settings.groupId || "не указана",
      принудительнаяОтправка: force ? sent : null,
    });
  } catch (e) {
    console.error("cron:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
};

/* Приём выборов из WhatsApp. Green API стучится сюда в момент голосования —
   никакой очереди и никакого ожидания тика.

   Адрес этой функции нужно прописать в Green API как webhookUrl:
   https://<ваш-проект>.vercel.app/api/webhook */

const { Bot, DB, U } = require("./_bot.js");

/* Дождаться отложенной уборки, если её срок вот-вот наступит.
   В serverless нет фонового таймера: функция завершится раньше, чем
   сработает setTimeout, поэтому короткое ожидание делаем прямо здесь. */
async function finishCleanup(ctx, limitMs = 15000) {
  if ((ctx.settings.cleanup || "off") === "off") return;

  const due = (await DB.list("polls"))
    .filter((p) => p.cleanupAt)
    .map((p) => new Date(p.cleanupAt).getTime() - Date.now());
  if (!due.length) return;

  const wait = Math.min(Math.max(...due.map((d) => Math.max(d, 0))), limitMs);
  if (wait > 0) await U.sleep(wait + 200);
  await Bot.maintain(ctx);
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(200).json({ ok: true, hint: "вебхук на месте, ждёт POST от Green API" });
  }

  // Необязательная защита: если задан WEBHOOK_TOKEN, он же прописывается
  // в Green API как webhookUrlToken и приходит в заголовке Authorization.
  const want = process.env.WEBHOOK_TOKEN;
  if (want && req.headers.authorization !== `Bearer ${want}`) {
    return res.status(401).json({ ok: false, error: "неверный токен" });
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const ctx = await Bot.loadCtx();

    await Bot.processNotification(body, ctx);
    await finishCleanup(ctx);

    res.status(200).json({ ok: true });
  } catch (e) {
    // Возвращаем 500: Green API повторит доставку, а обработка идемпотентна
    // (pollUpdateMessage несёт полное состояние голосования), так что
    // повтор ничего не сломает и выбор не потеряется.
    console.error("webhook:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
};

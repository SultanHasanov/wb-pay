/* Приём выборов из WhatsApp. Green API стучится сюда в момент голосования —
   никакой очереди и никакого ожидания тика.

   Адрес этой функции нужно прописать в Green API как webhookUrl:
   https://<ваш-проект>.vercel.app/api/webhook */

const { Bot, DB, U, Green } = require("./_bot.js");
const AI = require("./_ai.js");

/* --- ИИ-собеседник ----------------------------------------------------
   Отвечает в группе, только когда к боту обращаются: сообщение начинается
   с «бот»/«bot», в нём упомянут номер бота или это reply на его сообщение.
   Свои сообщения бота приходят другим typeWebhook, так что петли нет. */
const CALL_RE = /^\s*(бот|bot)(?=[\s,:!?.]|$)[\s,:!?.]*/i;

function chatText(md) {
  if (md.typeMessage === "textMessage") return (md.textMessageData || {}).textMessage || "";
  return (md.extendedTextMessageData || {}).text || "";
}

async function maybeChat(body, ctx) {
  if (!process.env.GEMINI_API_KEY) return;
  if (!body || body.typeWebhook !== "incomingMessageReceived") return;
  const md = body.messageData || {};
  if (!["textMessage", "extendedTextMessage", "quotedMessage"].includes(md.typeMessage)) return;

  const chatId = body.senderData && body.senderData.chatId;
  if (!ctx.settings.groupId || chatId !== ctx.settings.groupId) return;

  const wid = (body.instanceData && body.instanceData.wid) || "";
  const botNum = wid.replace(/\D/g, "");
  let text = chatText(md);

  const called = CALL_RE.test(text);
  const mentioned = !!botNum && text.includes(`@${botNum}`);
  const replied = !!wid && (md.quotedMessage || {}).participant === wid;
  if (!called && !mentioned && !replied) return;

  text = text.replace(CALL_RE, "").replace(`@${botNum}`, "").trim() || "привет";

  const managers = ctx.managers.filter((m) => m.active !== false).map((m) => m.name);
  const now = U.tzNow(ctx.settings.tz);
  const today = (await DB.list("workdays").catch(() => []))
    .filter((w) => w.date === now.date)
    .map((w) => (ctx.managers.find((m) => m.id === w.managerId) || {}).name)
    .filter(Boolean);
  const facts = `сегодня ${U.fmtShort(now.date)}, ${now.hm}; на смене сегодня: ` +
    (today.length ? today.join(", ") : "пока никто не отмечен") + ".";

  const answer = await AI.reply(text, {
    author: (body.senderData && body.senderData.senderName) || "",
    managers,
    facts,
  });
  if (answer) await Green.sendMessage(chatId, answer, md.idMessage);
}

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

    // Сбой ИИ не должен давать 500: Green API повторил бы доставку зря
    await maybeChat(body, ctx).catch((e) => console.error("ai chat:", e.message));

    res.status(200).json({ ok: true });
  } catch (e) {
    // Возвращаем 500: Green API повторит доставку, а обработка идемпотентна
    // (pollUpdateMessage несёт полное состояние голосования), так что
    // повтор ничего не сломает и выбор не потеряется.
    console.error("webhook:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
};

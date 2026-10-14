/* Приём выборов из WhatsApp. Green API стучится сюда в момент голосования —
   никакой очереди и никакого ожидания тика.

   Адрес этой функции нужно прописать в Green API как webhookUrl:
   https://<ваш-проект>.vercel.app/api/webhook */

const { Bot, DB, U, Green } = require("./_bot.js");
const AI = require("./_ai.js");

/* --- ИИ-собеседник ----------------------------------------------------
   Отвечает в любой группе, где состоит номер бота, но только когда к нему
   обращаются: сообщение начинается с «бот»/«bot», в нём упомянут номер
   бота или это reply на его сообщение. На одни смайлики не отвечает.
   Если бота отметили в ответе на чужое сообщение — отвечает на то сообщение.
   Свои сообщения бота приходят другим typeWebhook, так что петли нет. */
const CALL_RE = /^\s*(бот|bot)(?=[\s,:!?.]|$)[\s,:!?.]*/i;

// Как сообщение выглядит для модели: у медиа содержимого нет, только метка
const MEDIA = {
  audioMessage: "[голосовое]", stickerMessage: "[стикер]", imageMessage: "[фото]",
  videoMessage: "[видео]", documentMessage: "[файл]",
};

function msgText(m) {
  let what = m.textMessage || (m.extendedTextMessage || {}).text || "";
  if (!what && MEDIA[m.typeMessage]) what = MEDIA[m.typeMessage];
  if (what && m.caption) what += ` ${m.caption}`;
  return String(what).slice(0, 300);
}

function msgAuthor(m) {
  if (m.type === "outgoing") return m.sendByApi ? "Ты" : "Владелец номера";
  return m.senderName || m.senderContactName || "Кто-то";
}

function historyLine(m) {
  const what = msgText(m);
  return what ? `${msgAuthor(m)}: ${what}` : null;
}

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
  if (!chatId || !chatId.endsWith("@g.us")) return;
  const isMain = chatId === ctx.settings.groupId;

  const wid = (body.instanceData && body.instanceData.wid) || "";
  const botNum = wid.replace(/\D/g, "");
  let text = chatText(md);

  const q = md.quotedMessage || {};
  const called = CALL_RE.test(text);
  const mentioned = !!botNum && text.includes(`@${botNum}`);
  const replied = !!wid && q.participant === wid;
  if (!called && !mentioned && !replied) return;

  // Бота отметили в ответе на чужое сообщение — отвечаем на то сообщение
  const forOther = (called || mentioned) && !!q.stanzaId && !replied;

  text = text.replace(CALL_RE, "").replace(`@${botNum}`, "").trim();
  if (!text && called && !forOther) text = "привет";
  // Ответ смайликами на сообщение бота — это реакция, а не вопрос
  if (!forOther && !/[\p{L}\p{N}]/u.test(text)) return;

  // Смены и имена менеджеров — только для рабочей группы, в чужие не выносим
  let managers = [];
  let facts = "";
  if (isMain) {
    const today = U.tzNow(ctx.settings.tz).date;
    managers = ctx.managers.filter((m) => m.active !== false).map((m) => m.name);
    const onShift = (await DB.list("workdays").catch(() => []))
      .filter((w) => w.date === today)
      .map((w) => (ctx.managers.find((m) => m.id === w.managerId) || {}).name)
      .filter(Boolean);
    facts = `на смене сегодня: ${onShift.length ? onShift.join(", ") : "пока никто не отмечен"}.`;
  }

  // Последние сообщения чата, новые первыми. Без них модель отвечает
  // вслепую и выдаёт афоризмы мимо разговора.
  const raw = await Green.getChatHistory(chatId, 13).catch((e) => {
    console.error("history:", e.message);
    return [];
  }) || [];
  const history = raw
    .filter((m) => m.idMessage !== md.idMessage)
    .slice(0, 12)
    .reverse()
    .map(historyLine)
    .filter(Boolean);

  // Процитированное сообщение: автора берём из истории, если оно там есть
  const src = raw.find((m) => m.idMessage === q.stanzaId);
  const quotedText = (src && msgText(src)) || msgText(q);
  const quoted = quotedText ? {
    text: quotedText,
    mine: replied,
    author: src ? msgAuthor(src) : "",
  } : null;

  const answer = await AI.reply(text, {
    author: (body.senderData && body.senderData.senderName) || "",
    managers,
    facts,
    quoted,
    forOther,
    history,
  });
  if (!answer) return;

  // Отвечаем цитатой на то сообщение, на которое просили ответить, и
  // отмечаем его автора: «@79991234567» в тексте WhatsApp показывает
  // как упоминание. Скрытые @lid-номера отметить нельзя — тогда без неё.
  const to = forOther ? q.participant : (body.senderData && body.senderData.sender);
  const tag = to && to.endsWith("@c.us") && to !== wid ? `@${to.replace(/\D/g, "")} ` : "";
  await Green.sendMessage(chatId, tag + answer, forOther ? q.stanzaId : md.idMessage);
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

/* Приём выборов из WhatsApp. Green API стучится сюда в момент голосования —
   никакой очереди и никакого ожидания тика.

   Адрес этой функции нужно прописать в Green API как webhookUrl:
   https://<ваш-проект>.vercel.app/api/webhook */

const { Bot, DB, U, Green } = require("./_bot.js");
const AI = require("./_ai.js");
const TTS = require("./_tts.js");

// Ответ голосом укладываем в 60 с функции (vercel.json):
// текст до 15 с, озвучка с перекодированием до 20 с, остальное — отправка
const VOICE_TEXT_MS = 15000;
const VOICE_TTS_MS = 20000;

/* --- ИИ-собеседник ----------------------------------------------------
   Отвечает в любой группе, где состоит номер бота, но только когда к нему
   обращаются: сообщение начинается с «бот»/«bot», в нём упомянут номер
   бота или это reply на его сообщение. На одни смайлики не отвечает.
   Если бота отметили в ответе на чужое сообщение — отвечает на то сообщение.
   Голосовые слушает: если голосовое пришло ответом на его сообщение или
   его позвали в ответ на чужое голосовое («бот, что он сказал?»).
   Свои сообщения бота приходят другим typeWebhook, так что петли нет. */
const CALL_RE = /^\s*(бот|bot)(?=[\s,:!?.]|$)[\s,:!?.]*/i;

/* «скажи голосом», «ответь голосовым» — ответить голосовым сообщением.
   Слово «голосовое» сюда не входит: «расшифруй голосовое» — просьба
   послушать, а не ответить голосом. */
const VOICE_RE = /(?:(?:скажи|ответь|расскажи|отправь|запиши|скинь)\s+)?голос(?:ом|овым)(?=[\s,:!?.]|$)[\s,:!?.]*/iu;

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

// Голосовые WhatsApp — ogg/opus по 10–30 КБ на минуту; больше 5 МБ не тянем
const AUDIO_MAX = 5 * 1024 * 1024;
const AUDIO_MS = 6000;

/* Скачать голосовое и отдать в виде, который понимает Gemini.
   Ссылку берём из самого сообщения, а у цитаты её нет — тогда
   спрашиваем Green API. Не вышло — null, бот ответит без звука. */
async function loadAudio(chatId, idMessage, url, mime) {
  try {
    if (!url) url = ((await Green.downloadFile(chatId, idMessage)) || {}).downloadUrl;
    if (!url) return null;
    const res = await fetch(url, { signal: AbortSignal.timeout(AUDIO_MS) });
    if (!res.ok) throw new Error(`скачивание → ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > AUDIO_MAX) return null;
    const type = (mime || res.headers.get("content-type") || "audio/ogg").split(";")[0];
    return { mime: type, data: buf.toString("base64") };
  } catch (e) {
    console.error("audio:", e.message);
    return null;
  }
}

async function maybeChat(body, ctx) {
  if (!process.env.GEMINI_API_KEY) return;
  if (!body || body.typeWebhook !== "incomingMessageReceived") return;
  const md = body.messageData || {};
  const isVoice = md.typeMessage === "audioMessage";
  if (!isVoice && !["textMessage", "extendedTextMessage", "quotedMessage"].includes(md.typeMessage)) return;

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
  const wantVoice = VOICE_RE.test(text);
  if (wantVoice) text = text.replace(VOICE_RE, " ").replace(/\s+/g, " ").trim();
  if (!text && wantVoice && !forOther) text = "скажи что-нибудь";
  if (!text && called && !forOther) text = "привет";
  // Ответ смайликами на сообщение бота — это реакция, а не вопрос.
  // У голосового текста нет вовсе — его смысл в звуке.
  if (!forOther && !isVoice && !/[\p{L}\p{N}]/u.test(text)) return;

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

  // Голосовое ответом боту — слушаем его; «бот» в ответ на чужое
  // голосовое — слушаем то, что процитировали
  let audio = null;
  if (isVoice) {
    const f = md.fileMessageData || {};
    audio = await loadAudio(chatId, md.idMessage, f.downloadUrl, f.mimeType);
  } else if (forOther && q.typeMessage === "audioMessage") {
    audio = await loadAudio(chatId, q.stanzaId, src && src.downloadUrl, src && src.mimeType);
  }
  // Звук не скачался — молчим: без него ответить на голосовое нечем
  if (isVoice && !audio) return;

  const answer = await AI.reply(text, {
    audio,
    voice: wantVoice,
    // Голосом: модели меньше времени, остальное — на озвучку и отправку
    budgetMs: wantVoice ? VOICE_TEXT_MS : undefined,
    author: (body.senderData && body.senderData.senderName) || "",
    managers,
    facts,
    quoted,
    forOther,
    history,
  });
  if (!answer) return;
  // Отвечаем цитатой на то сообщение, на которое просили ответить.
  // Без @-упоминания автора: цитаты достаточно, номер в тексте — лишний.
  const quoteId = forOther ? q.stanzaId : md.idMessage;

  // Голосом не вышло (квота, таймаут, ffmpeg) — тот же ответ текстом
  if (wantVoice) {
    const ogg = await TTS.speak(answer, VOICE_TTS_MS).catch((e) => {
      console.error("tts:", e.message);
      return null;
    });
    if (ogg) {
      try {
        return await Green.sendFileByUpload(chatId, ogg, "voice.ogg", quoteId);
      } catch (e) {
        console.error("voice send:", e.message);
      }
    }
  }
  await Green.sendMessage(chatId, answer, quoteId);
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

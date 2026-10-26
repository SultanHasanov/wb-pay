/* Приём выборов из WhatsApp. Green API стучится сюда в момент голосования —
   никакой очереди и никакого ожидания тика.

   Адрес этой функции нужно прописать в Green API как webhookUrl:
   https://<ваш-проект>.vercel.app/api/webhook */

const { Bot, DB, U, Green, CFG } = require("./_bot.js");
const AI = require("./_ai.js");
const TTS = require("./_tts.js");
const Assistant = require("./_assistant.js");

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
const VOICE_RE = /(?:(?:скажи|ответь|расскажи|отправь|запиши|скинь)\s+)?(?:(женск|мужск)\S*\s+)?голос(?:ом|овым)(?=[\s,:!?.]|$)[\s,:!?.]*/iu;

// Метка, которой модель просит озвучить ответ: [голос], [голос:ж], [голос:м]
const VOICE_TAG = /\[\s*голос\s*(?::\s*([жм]))?\s*\]/iu;

// «женским голосом» → "f", «мужским» → "m", иначе null — случайный голос
const genderOf = (s) => (/^ж/i.test(s || "") ? "f" : /^м/i.test(s || "") ? "m" : null);

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
  const voiceAsk = text.match(VOICE_RE);
  const wantVoice = !!voiceAsk;
  let gender = voiceAsk ? genderOf(voiceAsk[1]) : null;
  if (wantVoice) text = text.replace(VOICE_RE, " ").replace(/\s+/g, " ").trim();
  // «скажи голосом» ответом на сообщение бота — озвучить это сообщение
  const readAloud = wantVoice && replied && !text;
  if (!text && wantVoice && !forOther && !readAloud) text = "скажи что-нибудь";
  if (!text && called && !forOther) text = "привет";
  // Ответ смайликами на сообщение бота — это реакция, а не вопрос.
  // У голосового текста нет вовсе — его смысл в звуке.
  if (!forOther && !isVoice && !readAloud && !/[\p{L}\p{N}]/u.test(text)) return;

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

  // Озвучиваем текст, а не метку вроде «[голосовое]»
  if (readAloud && quoted && !Object.values(MEDIA).includes(quoted.text)) {
    return sendVoice(chatId, quoted.text, md.idMessage, gender);
  }

  let answer = await AI.reply(text, {
    audio,
    voice: wantVoice,
    // Просьба ответить голосом может быть и внутри голосового — тогда
    // её распознаёт модель. Время на озвучку оставляем в обоих случаях.
    budgetMs: wantVoice || audio ? VOICE_TEXT_MS : undefined,
    author: (body.senderData && body.senderData.senderName) || "",
    managers,
    facts,
    quoted,
    forOther,
    history,
  });
  if (!answer) return;
  // Метку [голос] модель ставит, когда её просят ответить голосом
  const tag = answer.match(VOICE_TAG);
  const voiceReply = wantVoice || !!tag;
  if (tag && !gender) gender = genderOf(tag[1]);
  // Модель пишет «[голос]: текст» — двоеточие уходит вместе с меткой
  answer = answer.replace(new RegExp(VOICE_TAG.source, "giu"), "").replace(/^[\s:–—-]+/, "").trim();
  if (!answer) return;
  // Отвечаем цитатой на то сообщение, на которое просили ответить.
  // Без @-упоминания автора: цитаты достаточно, номер в тексте — лишний.
  const quoteId = forOther ? q.stanzaId : md.idMessage;

  if (voiceReply) return sendVoice(chatId, answer, quoteId, gender);
  await Green.sendMessage(chatId, answer, quoteId);
}

// Голосом не вышло (квота, таймаут, ffmpeg) — тот же текст обычным сообщением
async function sendVoice(chatId, text, quoteId, gender) {
  const ogg = await TTS.speak(text, VOICE_TTS_MS, [], gender).catch((e) => {
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
  return Green.sendMessage(chatId, text, quoteId);
}

/* --- Помощник в личке по заказам Wildberries --------------------------
   Клиент пишет боту напрямую (@c.us): просит взять/отложить заказ,
   отменить целиком или частично, оформить доставку или позвать оператора.
   Состояние диалога не храним отдельно — восстанавливаем по истории чата.
   Для операций с товаром нужен QR-код (фото): если его нет — просим,
   когда приходит — пересылаем сводку и картинку в рабочую группу.
   Голосом отвечаем только если клиент сам прислал голосовое или попросил. */

// Фиксированное подтверждение клиенту при пересылке заявки. По этой метке
// в истории узнаём, что QR уже переслан, и не дублируем пересылку.
const FWD_MARK = "✅ Заявку принял";

// Фото из истории считаем QR текущей заявки, только если оно свежее.
// Старые картинки (прошлые заявки/тесты) за QR не принимаем.
const QR_MAX_AGE = 30 * 60;

const OP_RU = {
  take: "Взять / отложить (не отдавать в автоотмену)",
  cancel: "Отмена заказа",
  partial: "Частичная отмена (часть отменить, часть забрать)",
};

// Отправить клиенту ответ: голосом, если он сам голосом/попросил, иначе текстом
function answerUser(chatId, text, voice) {
  if (!text) return;
  if (voice) return sendVoice(chatId, text, undefined, null);
  return Green.sendMessage(chatId, text);
}

// Переслать заявку и QR в рабочую группу
async function forwardOrder(group, { op, summary, author, chatId, qrUrl }) {
  const phone = chatId.replace("@c.us", "");
  const head = [
    "🧾 Заявка по заказу",
    `Операция: ${OP_RU[op] || op}`,
    summary ? `Просьба: ${summary}` : null,
    `Клиент: ${author || "без имени"} (+${phone})`,
    `Чат: https://wa.me/${phone}`,
  ].filter(Boolean).join("\n");
  await Green.sendMessage(group, head).catch((e) => console.error("fwd text:", e.message));
  if (qrUrl) {
    await Green.sendFileByUrl(group, qrUrl, "qr.jpg", "QR-код заказа")
      .catch((e) => console.error("fwd qr:", e.message));
  }
}

// Позвать оператора в группу (бот не справился или клиент просит человека)
async function notifyHuman(group, { summary, author, chatId }) {
  const phone = chatId.replace("@c.us", "");
  const msg = [
    "🙋 Нужен оператор — бот не справился или клиент просит человека.",
    summary ? `Вопрос: ${summary}` : null,
    `Клиент: ${author || "без имени"} (+${phone})`,
    `Чат: https://wa.me/${phone}`,
  ].filter(Boolean).join("\n");
  await Green.sendMessage(group, msg).catch((e) => console.error("human:", e.message));
}

async function maybePrivate(body, ctx) {
  if (!process.env.GEMINI_API_KEY) return;
  if (!body || body.typeWebhook !== "incomingMessageReceived") return;
  const md = body.messageData || {};
  const t = md.typeMessage;
  const isVoice = t === "audioMessage";
  const isImage = t === "imageMessage";
  const isText = ["textMessage", "extendedTextMessage", "quotedMessage"].includes(t);
  if (!isVoice && !isImage && !isText) return;

  // Только личные чаты. Группы обрабатывает maybeChat / processNotification.
  const chatId = body.senderData && body.senderData.chatId;
  if (!chatId || !chatId.endsWith("@c.us")) return;

  const group = ctx.settings.ordersGroupId || process.env.ORDERS_GROUP_ID || ctx.settings.groupId;
  const nowTs = Number(body.timestamp) || Math.floor(Date.now() / 1000);

  // Что написал клиент сейчас + QR, если это фото (в т.ч. с подписью)
  let text = chatText(md);
  let qrUrl = null;
  if (isImage) {
    const f = md.fileMessageData || {};
    qrUrl = f.downloadUrl || null;
    if (!qrUrl) qrUrl = ((await Green.downloadFile(chatId, md.idMessage).catch(() => null)) || {}).downloadUrl || null;
    if (f.caption) text = text ? `${text} ${f.caption}` : f.caption;
  }

  // Голосовое слушаем; не скачалось — просим написать или прислать ещё раз
  let audio = null;
  if (isVoice) {
    const f = md.fileMessageData || {};
    audio = await loadAudio(chatId, md.idMessage, f.downloadUrl, f.mimeType);
    if (!audio) {
      return Green.sendMessage(chatId,
        "Не получилось прослушать голосовое. Напишите, пожалуйста, что нужно по заказу, или пришлите ещё раз.");
    }
  }

  // История чата: контекст для модели и поиск ранее присланного QR
  const raw = await Green.getChatHistory(chatId, 15).catch((e) => {
    console.error("history:", e.message);
    return [];
  }) || [];
  const history = raw
    .filter((m) => m.idMessage !== md.idMessage)
    .slice(0, 12)
    .reverse()
    .map(historyLine)
    .filter(Boolean);

  // Когда в последний раз мы уже переслали заявку (по метке в истории).
  // Всё, что отправлено до этого момента, считаем уже обработанным.
  const lastFwdTs = raw
    .filter((m) => m.type === "outgoing" && String(msgText(m)).includes(FWD_MARK)
      && (Number(m.timestamp) || 0) >= nowTs - QR_MAX_AGE)
    .reduce((mx, m) => Math.max(mx, Number(m.timestamp) || 0), 0);

  // QR текущей заявки: фото сейчас или свежее фото из истории. Старое не берём.
  let qrTs = isImage ? nowTs : 0;
  if (!qrUrl) {
    const qrMsg = raw.find((m) => m.typeMessage === "imageMessage"
      && (Number(m.timestamp) || 0) >= nowTs - QR_MAX_AGE);
    if (qrMsg) {
      qrTs = Number(qrMsg.timestamp) || 0;
      qrUrl = qrMsg.downloadUrl
        || ((await Green.downloadFile(chatId, qrMsg.idMessage).catch(() => null)) || {}).downloadUrl
        || null;
    }
  }
  // Новый, ещё не пересланный QR — только такой пересылаем в группу
  const freshQr = !!qrUrl && qrTs > lastFwdTs;

  const author = (body.senderData && body.senderData.senderName) || "";
  const decision = await Assistant.handle({ text, audio, history, qrAttached: freshQr, author });
  if (!decision) return;

  const wantVoice = isVoice || decision.voice;
  const op = decision.op || "none";
  const reply = (decision.reply || "").trim();
  const summary = (decision.summary || text || "").trim();
  const orderOp = op === "take" || op === "cancel" || op === "partial";

  if (orderOp) {
    // Пришёл новый, ещё не пересланный QR — пересылаем заявку и подтверждаем
    if (freshQr) {
      if (group) await forwardOrder(group, { op, summary, author, chatId, qrUrl });
      return answerUser(chatId, `${FWD_MARK} Передал сотрудникам пункта. Ожидайте, с вами свяжутся.`, wantVoice);
    }
    // QR ещё нет — просим прислать фото кода (статус уже принятой заявки
    // модель распознаёт по истории и отвечает через op=none)
    return answerUser(chatId,
      reply || "Пришлите, пожалуйста, фото QR-кода заказа — и я передам заявку сотрудникам.", wantVoice);
  }

  if (op === "human") {
    if (group) await notifyHuman(group, { summary, author, chatId });
    return answerUser(chatId, reply || "Секунду, подключаю сотрудника — он скоро ответит.", wantVoice);
  }

  // delivery → про wbdav.ru; none → короткий отклик. Текст сформулировала модель.
  return answerUser(chatId, reply, wantVoice);
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
  // Проверка озвучки без отправки в чат: /api/webhook?diag=voice
  if (req.method === "GET" && req.query && req.query.diag === "voice") {
    const log = [];
    const t = Date.now();
    const ogg = await TTS.speak("Проверка связи, раз, два, три.", VOICE_TTS_MS, log, req.query.g || null);
    return res.status(200).json({ ok: !!ogg, bytes: ogg ? ogg.length : 0, ms: Date.now() - t, log });
  }

  // Проверка загрузки файла в Green API без отправки в чат: ?diag=upload
  if (req.method === "GET" && req.query && req.query.diag === "upload") {
    try {
      const ogg = await TTS.speak("Проверка.", VOICE_TTS_MS);
      if (!ogg) return res.status(200).json({ ok: false, error: "озвучка не удалась" });
      const out = await Green.uploadFile(ogg, "audio/ogg");
      return res.status(200).json({ ok: true, host: Green.mediaHosts()[0], hosts: Green.mediaHosts(), out });
    } catch (e) {
      return res.status(200).json({ ok: false, error: e.message.replace(CFG.GREEN_TOKEN, "***") });
    }
  }

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
    await maybePrivate(body, ctx).catch((e) => console.error("ai private:", e.message));

    res.status(200).json({ ok: true });
  } catch (e) {
    // Возвращаем 500: Green API повторит доставку, а обработка идемпотентна
    // (pollUpdateMessage несёт полное состояние голосования), так что
    // повтор ничего не сломает и выбор не потеряется.
    console.error("webhook:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
};

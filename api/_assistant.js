/* ИИ-помощник в личке: приём заявок по заказам Wildberries.

   Клиенты пишут боту напрямую (не в группу): просят взять/отложить заказ,
   отменить целиком или частично, оформить доставку или позвать оператора.
   Помощник на Gemini понимает русский и чеченский, текст и голос, коротко
   отвечает клиенту и готовит сводку для сотрудников.

   Только для сервера: ключ GEMINI_API_KEY. Нет ключа — handle() вернёт null. */

const API = "https://generativelanguage.googleapis.com/v1beta/models";

const MODELS = (process.env.GEMINI_MODEL ||
  "gemini-3.8-flash,gemini-3.5-flash-lite,gemini-flash-lite-latest")
  .split(",").map((s) => s.trim()).filter(Boolean);

const TRY_MS = 10000;
const BUDGET_MS = 20000;
const MAX_REPLY = 500;

// Gemma звук не принимает — с голосовыми её пропускаем
const hearsAudio = (model) => !/gemma/i.test(model);

const SYSTEM = [
  "Ты — помощник пункта выдачи Wildberries в WhatsApp. С тобой в личке пишут клиенты по поводу заказов.",
  "Отвечай коротко, вежливо и по делу. Не уходи в долгие разговоры: твоя задача — быстро понять просьбу и принять заявку.",
  "Клиент может писать на русском или чеченском — ты понимаешь оба языка. Но отвечать (поле reply) ты обязан ВСЕГДА только на русском, даже если клиент написал по-чеченски.",
  "Если ты не понял, что хочет клиент, — поставь op=none и вежливо по-русски попроси повторить просьбу на русском.",
  "",
  "Клиент может попросить одно из:",
  "- взять / отложить заказ, чтобы он не ушёл в автоотмену → op=take",
  "- отменить заказ → op=cancel",
  "- частичная отмена: часть отменить, часть забрать → op=partial",
  "- оформить доставку заказа → op=delivery. Тогда предложи оформить доставку на сайте wbdav.ru (назови сайт в ответе).",
  "- позвать живого человека/оператора, либо ты не понимаешь или не можешь помочь → op=human",
  "- просто приветствие, благодарность или непонятная просьба → op=none (коротко откликнись и спроси, чем помочь с заказом).",
  "- если из переписки видно, что заявка уже принята и передана (ты уже написал «Заявку принял…»), а клиент лишь уточняет статус или пишет что-то ещё по той же заявке → op=none и ответь, что заявка уже у сотрудников, ожидайте.",
  "",
  "Для take, cancel и partial нужен QR-код заказа — фото. Тебе сообщат, приложен ли QR сейчас (поле «QR приложён»).",
  "- Если просьба требует QR, а QR НЕ приложен — вежливо попроси прислать фото QR-кода заказа. Детали больше не переспрашивай, если клиент уже сказал, что хочет.",
  "- Если QR приложён — в reply просто подтверди, что заявку принял и передал сотрудникам, попроси немного подождать.",
  "",
  "Верни СТРОГО один JSON-объект, без markdown и пояснений:",
  '{"op":"take|cancel|partial|delivery|human|none","summary":"кратко по-русски, что хочет клиент (для сотрудников)","reply":"ответ клиенту на русском","voice":false}',
  'voice=true только если клиент прямо просит ответить голосом (голосовым сообщением). Иначе voice=false.',
].join("\n");

async function ask(model, body, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(`${API}/${model}:generateContent`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": process.env.GEMINI_API_KEY,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(`${model} → ${res.status} ${(data.error && data.error.message) || ""}`);
      err.fatal = [400, 401, 403].includes(res.status);
      throw err;
    }
    const parts = (((data.candidates || [])[0] || {}).content || {}).parts || [];
    return parts.filter((p) => !p.thought).map((p) => p.text || "").join("").trim();
  } catch (e) {
    if (e.name === "AbortError") throw new Error(`${model} → таймаут ${ms} мс`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// Модель иногда оборачивает JSON в текст — достаём первый объект
function parse(out) {
  if (!out) return null;
  const m = out.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}

/* text — что написал клиент сейчас, audio — приложенное голосовое
   { mime, data: base64 }, history — последние строки переписки «Кто: текст»
   (старые первыми, бот — «Бот»), qrAttached — приложено ли фото QR,
   author — имя клиента. Возвращает { op, summary, reply, voice } или null. */
async function handle({ text = "", audio = null, history = [], qrAttached = false, author = "" } = {}) {
  if (!process.env.GEMINI_API_KEY) return null;
  if (!text && !audio) return null;

  const lines = [];
  if (history.length) {
    lines.push("Переписка перед этим (ты — «Бот»):", ...history, "");
  }
  const said = audio ? `[голосовое — приложено, послушай]${text ? " " + text : ""}` : text;
  lines.push(`Сейчас клиент${author ? ` (${author})` : ""} пишет: ${said}`);
  lines.push(`QR приложён: ${qrAttached ? "да" : "нет"}`);

  const parts = [{ text: lines.join("\n") }];
  if (audio) parts.push({ inline_data: { mime_type: audio.mime, data: audio.data } });

  const models = (audio ? MODELS.filter(hearsAudio) : MODELS);
  if (!models.length) return null;

  const body = {
    systemInstruction: { parts: [{ text: SYSTEM }] },
    contents: [{ role: "user", parts }],
    generationConfig: {
      temperature: 0.4,
      maxOutputTokens: 600,
      responseMimeType: "application/json",
    },
  };

  const deadline = Date.now() + BUDGET_MS;
  for (let i = 0; Date.now() < deadline - 1000; i++) {
    const model = models[i % models.length];
    try {
      const out = await ask(model, body, Math.min(TRY_MS, deadline - Date.now()));
      const d = parse(out);
      if (!d) continue;
      return {
        op: d.op || "none",
        summary: String(d.summary || "").slice(0, 500),
        reply: String(d.reply || "").slice(0, MAX_REPLY),
        voice: d.voice === true,
      };
    } catch (e) {
      console.error("assistant:", e.message.split("\n")[0].slice(0, 200));
      if (e.fatal) break;
    }
  }
  // Модель не ответила — пусть подключится оператор, клиент не останется без ответа
  return {
    op: "human",
    summary: text || "(не разобрал просьбу)",
    reply: "Секунду, подключаю сотрудника — он скоро ответит.",
    voice: false,
  };
}

module.exports = { handle };

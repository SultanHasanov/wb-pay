/* ИИ-собеседник на Gemini: короткие умные ответы с юмором в группе.

   Только для сервера. Ключ берётся из переменной окружения GEMINI_API_KEY
   и в assets/ не попадает — эта папка раздаётся публично.
   Нет ключа — reply() молча возвращает null. */

const API = "https://generativelanguage.googleapis.com/v1beta/models";

// Модели перебираются по кругу. Первой — самая умная из доступных на
// бесплатном тарифе; она часто отвечает 503 «high demand», тогда берём
// лёгкие. Pro-модели на бесплатном тарифе не работают вовсе (квота 0).
const MODELS = (process.env.GEMINI_MODEL ||
  "gemini-3.8-flash,gemini-3.5-flash-lite,gemini-flash-lite-latest,gemma-4-31b-it")
  .split(",").map((s) => s.trim()).filter(Boolean);

// Функция на Vercel живёт 30 с (vercel.json), оставляем запас на отправку
const BUDGET_MS = 22000;
const TRY_MS = 10000;

const MAX_LEN = 400;
// Расшифровка голосового длиннее обычной реплики
const MAX_LEN_AUDIO = 1200;

// Gemma звук не принимает — с голосовыми её пропускаем
const hearsAudio = (model) => !/gemma/i.test(model);

// Если Google так и не ответил — лучше короткая отговорка, чем молчание
const FALLBACKS = [
  "Задумался и завис. Спроси ещё раз через минуту.",
  "Сейчас не соображаю — сервера перегружены. Чуть позже отвечу.",
  "Мысль была, но потерялась где-то у Google. Повтори попозже.",
];

/* Установка «обязан шутить» давала натужные афоризмы вроде «смех без
   причины — способ сэкономить на аргументах». Поэтому роль — умный
   собеседник, у которого юмор по ситуации, а не по обязанности.
   Время и дату не передаём вовсе — модель вставляла их в каждый ответ. */
const STYLE = [
  "Ты — участник чата: умный, начитанный, спокойный человек с хорошим чувством юмора. " +
    "Пишешь как живой взрослый человек в мессенджере, а не как бот-шутник.",
  "Как отвечать:",
  "- Сначала смысл: ответь на то, что сказали или спросили, с учётом переписки выше.",
  "- Юмор — лёгкий и из ситуации: ирония, точное наблюдение, спокойная подколка. " +
    "Если шутка не просится — просто ответь нормально. Лучше без шутки, чем натянутая.",
  "- Никаких афоризмов, «мудрых» сентенций вида «X — залог Y» и каламбуров ради каламбуров. " +
    "Не клоун и не зануда-умник.",
  "- Разговорный русский, на «ты», как пишут знакомые в чате. Коротко: обычно одно предложение, максимум два.",
  "- Не упоминай время и дату. Не начинай с имени. Эмодзи — редко.",
  "- На подколки и грубость отвечай спокойно, с достоинством и лёгкой иронией, без обиды.",
  "- Голосовое ты слышишь, только если оно приложено к сообщению. Содержимое остальных " +
    "голосовых, стикеров и фото тебе неизвестно — не делай вид, что знаешь.",
  "- На приложенное голосовое отвечай по его смыслу, как на обычное сообщение. " +
    "Просят расшифровать или пересказать — дай текст или краткий пересказ. " +
    "Неразборчиво — так и скажи.",
  "- Если пишут на чеченском — можно ответить по-чеченски коротко или по-русски.",
  "- Ничего не выдумывай. Без пошлости, политики и шуток про национальность и религию.",
  "Примеры — только чтобы понять тон, дословно их не повторяй:",
  "«что ты умеешь?» → «Отвечать на вопросы, подсказывать, кто на смене, и поддерживать беседу. С последним пока переменный успех.»",
  "«кто прав, я или она?» → «Судя по переписке — она. Но держался ты достойно.»",
  "«брат ты здесь?» → «Здесь. Что случилось?»",
  "«посоветуй фильм» → «Если думать не хочется — любая комедия с Джимом Керри. Если хочется — тоже он, но „Шоу Трумана“.»",
];

// Без менеджеров — это посторонняя группа, про смены там молчим
const prompt = (managers) => [
  managers.length
    ? `Чат — рабочая группа, где отмечают смены менеджеров (${managers.join(", ")}). ` +
      "О сменах говори, только если спросили."
    : "Чат — обычная WhatsApp-группа.",
  ...STYLE,
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
      // Ключ неверный или запрещён — другие модели не помогут
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

/* text — что написали боту, author — имя отправителя, managers — имена,
   facts — кто сегодня на смене, quoted — на какое сообщение ответили
   ({ text, author, mine: это было сообщение бота }), forOther — бота
   отметили, чтобы он ответил на процитированное чужое сообщение,
   history — последние сообщения чата «Имя: текст», старые первыми,
   audio — голосовое { mime, data: base64 }: само сообщение или,
   при forOther, процитированное. */
async function reply(text, {
  author = "", managers = [], facts = "", quoted = null, forOther = false, history = [],
  audio = null,
} = {}) {
  if (!process.env.GEMINI_API_KEY) return null;
  if (!text && !audio && !(forOther && quoted)) return null;

  const lines = [];
  // Справку кладём в само сообщение: из системной подсказки лёгкие
  // модели её теряли и сочиняли, кто на смене
  if (facts) lines.push(`Справка (используй, только если спросят): ${facts}`, "");
  if (history.length) {
    lines.push("Переписка перед этим (ты — «Ты»):", ...history, "");
  }
  if (forOther && quoted) {
    lines.push(
      "Тебя отметили, чтобы ты ответил на это сообщение:",
      `${quoted.author || "Кто-то"}: ${audio ? "[голосовое — приложено, послушай]" : quoted.text}`,
      text ? `${author || "Позвавший"} добавил: ${text}` : `(${author || "кто-то"} просто отметил тебя)`,
      "Ответь автору того сообщения по его сути.",
    );
  } else {
    lines.push("Тебе пишут:");
    if (quoted && quoted.text) {
      lines.push(quoted.mine
        ? `(в ответ на твоё сообщение «${quoted.text}»)`
        : `(в ответ на сообщение «${quoted.text}»)`);
    }
    const said = audio ? `[голосовое — приложено, послушай]${text ? " " + text : ""}` : text;
    lines.push(author ? `${author}: ${said}` : said);
  }

  const parts = [{ text: lines.join("\n") }];
  if (audio) parts.push({ inline_data: { mime_type: audio.mime, data: audio.data } });
  const models = audio ? MODELS.filter(hearsAudio) : MODELS;
  if (!models.length) return null;
  const maxLen = audio ? MAX_LEN_AUDIO : MAX_LEN;

  const body = {
    systemInstruction: { parts: [{ text: prompt(managers) }] },
    contents: [{ role: "user", parts }],
    generationConfig: { temperature: 0.9, maxOutputTokens: 2048 },
  };

  const deadline = Date.now() + BUDGET_MS;
  for (let i = 0; Date.now() < deadline - 1000; i++) {
    const model = models[i % models.length];
    try {
      const out = await ask(model, body, Math.min(TRY_MS, deadline - Date.now()));
      if (out) return out.length > maxLen ? out.slice(0, maxLen - 1) + "…" : out;
    } catch (e) {
      console.error("gemini:", e.message.split("\n")[0].slice(0, 200));
      if (e.fatal) break;
    }
  }
  return FALLBACKS[Math.floor(Math.random() * FALLBACKS.length)];
}

module.exports = { reply };

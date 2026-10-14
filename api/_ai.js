/* ИИ-собеседник на Gemini: шутливые короткие ответы в группе.

   Только для сервера. Ключ берётся из переменной окружения GEMINI_API_KEY
   и в assets/ не попадает — эта папка раздаётся публично.
   Нет ключа — reply() молча возвращает null. */

const API = "https://generativelanguage.googleapis.com/v1beta/models";

// Модели перебираются по кругу: Google временами отвечает 503
// «high demand» или подвисает на 5–10 с под нагрузкой — тогда берём
// следующую. Полные flash-модели в часы пик почти всегда 503, поэтому
// по умолчанию только лёгкие и gemma.
const MODELS = (process.env.GEMINI_MODEL ||
  "gemini-3.5-flash-lite,gemini-flash-lite-latest,gemini-3.1-flash-lite,gemma-4-31b-it")
  .split(",").map((s) => s.trim()).filter(Boolean);

// Функция на Vercel живёт 30 с (vercel.json), оставляем запас на отправку
const BUDGET_MS = 22000;
const TRY_MS = 15000;

const MAX_LEN = 300;

// Если Google так и не ответил — лучше пошутить заготовкой, чем молчать
const FALLBACKS = [
  "Остроумие временно недоступно. Абонент думает над ответом лучше вашего вопроса.",
  "Нейросеть ушла искать смысл жизни. Обещала вернуться, но все так говорят.",
  "Сервер завис от восхищения вашим вопросом. Повторите, когда он придёт в себя.",
  "Ответ был гениальный, но его съела очередь в Google.",
];

/* Стиль задаём жёстко: без этого модель скатывается в «кофе, понедельник
   и на часах 20:31». Время и дату не передаём вовсе — иначе вставляет
   их в каждый ответ. */
const STYLE = [
  "Твой стиль — сухое остроумие и ирония, как у хорошего стендапера или автора колких твитов: " +
    "неожиданный поворот, игра слов, точная подколка по сути сказанного. " +
    "Самоирония про то, что ты бот, уместна, но не в каждом ответе.",
  "Правила:",
  "- Одно, максимум два коротких предложения. Чем короче и точнее — тем смешнее.",
  "- Цепляйся за конкретные слова собеседника, а не отвечай шаблонно.",
  "- Никаких банальностей: кофе, чай, понедельник, пятница, вайфай, мемасики, " +
    "«кожаный мешок», «разгонять тоску», «не заскучаешь».",
  "- Не упоминай время и дату.",
  "- Не начинай с обращения по имени. Без восторженных восклицаний, максимум одно эмодзи, лучше без.",
  "- На грубость отвечай не обидой, а изящной колкостью.",
  "- Если пишут на чеченском или другом языке — можно коротко ответить на нём же или иронично по-русски.",
  "- Никакой пошлости, политики и шуток про национальность или религию.",
  "- Факты не выдумывай: чего не знаешь — обыграй, но не сочиняй.",
];

// Без менеджеров — это посторонняя группа, про смены там молчим
const prompt = (managers, facts) => [
  managers.length
    ? `Ты — бот в WhatsApp-группе, где отмечают рабочие смены менеджеров (${managers.join(", ")}). ` +
      "О сменах говори, только если спросили."
    : "Ты — бот в WhatsApp-чате.",
  ...STYLE,
  ...(facts ? [`Факты: ${facts}`] : []),
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
   ({ text, mine: это было сообщение бота }), чтобы шутить в контексте. */
async function reply(text, { author = "", managers = [], facts = "", quoted = null } = {}) {
  if (!process.env.GEMINI_API_KEY || !text) return null;

  const lines = [];
  if (quoted && quoted.text) {
    lines.push(quoted.mine
      ? `(Твоё прошлое сообщение: «${quoted.text}»)`
      : `(Ответ на сообщение: «${quoted.text}»)`);
  }
  lines.push(author ? `${author}: ${text}` : text);

  const body = {
    systemInstruction: { parts: [{ text: prompt(managers, facts) }] },
    contents: [{ role: "user", parts: [{ text: lines.join("\n") }] }],
    generationConfig: { temperature: 1.1, maxOutputTokens: 1024 },
  };

  const deadline = Date.now() + BUDGET_MS;
  for (let i = 0; Date.now() < deadline - 1000; i++) {
    const model = MODELS[i % MODELS.length];
    try {
      const out = await ask(model, body, Math.min(TRY_MS, deadline - Date.now()));
      if (out) return out.length > MAX_LEN ? out.slice(0, MAX_LEN - 1) + "…" : out;
    } catch (e) {
      console.error("gemini:", e.message);
      if (e.fatal) break;
    }
  }
  return FALLBACKS[Math.floor(Math.random() * FALLBACKS.length)];
}

module.exports = { reply };

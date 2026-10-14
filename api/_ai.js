/* ИИ-собеседник на Gemini: шутливые короткие ответы в группе.

   Только для сервера. Ключ берётся из переменной окружения GEMINI_API_KEY
   и в assets/ не попадает — эта папка раздаётся публично.
   Нет ключа — reply() молча возвращает null. */

const API = "https://generativelanguage.googleapis.com/v1beta/models";

// Модели перебираются по очереди: Google временами отвечает 503
// «high demand» или снимает старую модель — тогда берём следующую.
const MODELS = (process.env.GEMINI_MODEL || "gemini-3.5-flash-lite,gemini-flash-latest,gemini-flash-lite-latest")
  .split(",").map((s) => s.trim()).filter(Boolean);

const MAX_LEN = 300;

const prompt = (managers, facts) =>
  "Ты — бот в WhatsApp-группе, где отмечают рабочие смены" +
  (managers.length ? ` менеджеров (${managers.join(", ")})` : "") + ". " +
  "Отвечай по-русски, остроумно и с юмором, по-доброму, без грубости и пошлости. " +
  "Строго 1–2 коротких предложения. Без списков, хэштегов и markdown. " +
  "Если спрашивают по делу — ответь по делу, но с шуткой, факты не выдумывай." +
  (facts ? ` Факты на сейчас: ${facts}` : "");

async function ask(model, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 9000);
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
    if (!res.ok) throw new Error(`${model} → ${res.status} ${(data.error && data.error.message) || ""}`);
    const parts = (((data.candidates || [])[0] || {}).content || {}).parts || [];
    return parts.filter((p) => !p.thought).map((p) => p.text || "").join("").trim();
  } finally {
    clearTimeout(timer);
  }
}

/* text — что написали боту, author — имя отправителя, managers — имена,
   facts — строка с актуальными данными (дата, кто на смене). */
async function reply(text, { author = "", managers = [], facts = "" } = {}) {
  if (!process.env.GEMINI_API_KEY || !text) return null;

  const body = {
    systemInstruction: { parts: [{ text: prompt(managers, facts) }] },
    contents: [{
      role: "user",
      parts: [{ text: author ? `${author}: ${text}` : text }],
    }],
    generationConfig: { temperature: 1, maxOutputTokens: 1024 },
  };

  let lastErr;
  for (const model of MODELS) {
    try {
      const out = await ask(model, body);
      if (out) return out.length > MAX_LEN ? out.slice(0, MAX_LEN - 1) + "…" : out;
    } catch (e) {
      lastErr = e;
      console.error("gemini:", e.message);
    }
  }
  if (lastErr) throw lastErr;
  return null;
}

module.exports = { reply };

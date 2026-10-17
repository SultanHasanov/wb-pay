/* Озвучка ответов: текст → речь Gemini → голосовое WhatsApp.

   Gemini отдаёт WAV (24 кГц, моно, 16 бит), а голосовым с волной
   WhatsApp показывает только ogg/opus — перекодируем через ffmpeg.
   Только для сервера, ключ — тот же GEMINI_API_KEY. */

const { spawn } = require("child_process");
// Без ffmpeg голосом не ответить, но вебхук с опросами падать не должен
let ffmpeg = null;
try {
  ffmpeg = require("ffmpeg-static");
} catch (e) {
  console.error("ffmpeg-static не найден:", e.message);
}

const API = "https://generativelanguage.googleapis.com/v1beta/interactions";

const MODELS = (process.env.GEMINI_TTS_MODEL ||
  "gemini-3.8-flash-tts,gemini-3.8-flash-lite-tts,gemini-3.1-flash-tts-preview")
  .split(",").map((s) => s.trim()).filter(Boolean);

// Голос из готовых у Gemini; спокойный мужской
const VOICE = process.env.GEMINI_TTS_VOICE || "Charon";
const STYLE = "спокойно, дружелюбно, разговорно, как в голосовом сообщении другу";

async function ask(model, text, ms) {
  const res = await fetch(API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": process.env.GEMINI_API_KEY,
    },
    body: JSON.stringify({
      model,
      input: [{
        type: "user_input",
        content: [{
          type: "text",
          text,
          annotations: [{ type: "speech_metadata", style: STYLE }],
        }],
      }],
      response_format: { type: "audio" },
      generation_config: { speech_config: [{ voice: VOICE }] },
    }),
    signal: AbortSignal.timeout(ms),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`${model} → ${res.status} ${(data.error && data.error.message) || ""}`);
    err.fatal = [401, 403].includes(res.status);
    throw err;
  }
  const audio = (data.steps || [])
    .filter((s) => s.type === "model_output")
    .flatMap((s) => s.content || [])
    .filter((c) => c.type === "audio" && c.data)
    .pop();
  if (!audio) throw new Error(`${model} → пустой ответ без звука`);
  return Buffer.from(audio.data, "base64");
}

// WAV или «сырой» PCM → ogg/opus. Без заголовка RIFF считаем, что это PCM.
function toOgg(sound) {
  const input = sound.subarray(0, 4).toString() === "RIFF"
    ? ["-f", "wav"]
    : ["-f", "s16le", "-ar", "24000", "-ac", "1"];
  const args = [
    "-hide_banner", "-loglevel", "error", ...input, "-i", "pipe:0",
    "-c:a", "libopus", "-b:a", "32k", "-ar", "48000", "-ac", "1",
    "-application", "voip", "-f", "ogg", "pipe:1",
  ];
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpeg, args);
    const out = [];
    let err = "";
    p.stdout.on("data", (d) => out.push(d));
    p.stderr.on("data", (d) => { err += d; });
    p.on("error", reject);
    p.on("close", (code) => {
      if (code === 0 && out.length) resolve(Buffer.concat(out));
      else reject(new Error(`ffmpeg → ${code} ${err.trim().slice(0, 200)}`));
    });
    p.stdin.on("error", () => {});
    p.stdin.end(sound);
  });
}

/* Озвучить text за budgetMs. Возвращает ogg/opus или null —
   тогда вызывающий отправит ответ текстом. */
async function speak(text, budgetMs = 20000) {
  if (!process.env.GEMINI_API_KEY || !text || !ffmpeg) return null;
  const deadline = Date.now() + budgetMs;
  for (const model of MODELS) {
    const left = deadline - Date.now() - 2000;
    if (left < 3000) break;
    try {
      return await toOgg(await ask(model, text, left));
    } catch (e) {
      console.error("tts:", e.message.split("\n")[0].slice(0, 200));
      if (e.fatal) break;
    }
  }
  return null;
}

module.exports = { speak };

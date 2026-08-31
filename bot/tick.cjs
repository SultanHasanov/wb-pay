/* Запуск бота в GitHub Actions — то же самое, что делает открытая вкладка,
   только без браузера. Логика не дублируется: подгружаем те же файлы из
   assets/ и вызываем Bot.tick().

   Локально:  node bot/tick.cjs
   Настройки: RUN_SECONDS — сколько секунд крутиться (по умолчанию 240) */

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
global.window = global;

const load = (f) => eval(fs.readFileSync(path.join(ROOT, "assets", f), "utf8"));
load("config.js");
load("util.js");
load("db.js");
load("green.js");
load("bot.js");

/* Ключи можно держать прямо в assets/config.js (как сейчас) либо передать
   через переменные окружения — тогда в файле останутся заглушки, а значения
   придут из GitHub Secrets. Работают оба варианта. */
for (const k of ["MOKKY_URL", "GREEN_ID", "GREEN_TOKEN", "GREEN_API_URL"]) {
  if (process.env[k]) CFG[k] = process.env[k];
}

(async () => {
  if (!CFG.mokkyReady() || !CFG.greenReady()) {
    console.error("Не заполнены ключи: ни в assets/config.js, ни в переменных окружения.");
    process.exit(1);
  }

  const seconds = Number(process.env.RUN_SECONDS) || 240;
  const deadline = Date.now() + seconds * 1000;
  let ticks = 0, handled = 0, errors = 0;

  const now = U.tzNow("Europe/Moscow");
  console.log(`Старт: ${now.date} ${now.hm} МСК, работаем ${seconds} с.`);

  while (Date.now() < deadline) {
    try {
      const ctx = await Bot.loadCtx();
      const had = await Bot.tick(ctx);
      ticks++;
      if (had) handled++;
      else await U.sleep(1000);
    } catch (e) {
      errors++;
      console.error("сбой тика:", e.message);
      await U.sleep(5000);
    }
  }

  console.log(`Готово. Тиков: ${ticks}, обработано уведомлений: ${handled}, ошибок: ${errors}`);
  // Обрываем незавершённые таймеры отложенной уборки — их подхватит
  // cleanupStep на следующем запуске, срок хранится в базе.
  process.exit(0);
})();

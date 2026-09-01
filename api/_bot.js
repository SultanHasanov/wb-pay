/* Общая загрузка бота для функций Vercel.

   Логика не дублируется: подключаем те же файлы из assets/, что и браузер.
   Они написаны как обычные скрипты и присваивают всё в window, поэтому
   сначала подменяем window на global, а потом просто require-им — так
   сборщик Vercel видит зависимости статически и кладёт файлы в бандл. */

global.window = global;

require("../assets/config.js");
require("../assets/util.js");
require("../assets/db.js");
require("../assets/green.js");
require("../assets/bot.js");

/* Ключи можно держать в assets/config.js (как сейчас) либо задать
   переменными окружения в настройках проекта Vercel — приоритет у них. */
for (const k of ["MOKKY_URL", "GREEN_ID", "GREEN_TOKEN", "GREEN_API_URL"]) {
  if (process.env[k]) global.CFG[k] = process.env[k];
}

module.exports = {
  CFG: global.CFG,
  U: global.U,
  DB: global.DB,
  Green: global.Green,
  Bot: global.Bot,
};

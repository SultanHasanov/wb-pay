/* ============================================================
   НАСТРОЙКИ ПОДКЛЮЧЕНИЯ — единственное место, где лежат ключи.
   Заполните 3 значения ниже и всё заработает.
   ============================================================ */

window.CFG = {
  // 1. Адрес вашего инстанса mokky.dev (без слэша в конце)
  MOKKY_URL: "https://84dde73bba978b5e.mokky.dev",

  // 2. Green API — idInstance и apiTokenInstance из личного кабинета
  GREEN_ID: "7107650151",
  GREEN_TOKEN: "b28ccd70c99346a4a488375aaaa2af2aa2727033980143eebc",

  // 3. Обычно менять не нужно
  GREEN_API_URL: "https://7107.api.greenapi.com",

  // Выключатель бота на уровне кода (в админке есть свой, в настройках)
  BOT_ENABLED: true,
};

CFG.mokkyReady = () =>
  !!CFG.MOKKY_URL && !CFG.MOKKY_URL.includes("REPLACE_ME");

CFG.greenReady = () =>
  !!CFG.GREEN_ID &&
  !!CFG.GREEN_TOKEN &&
  !CFG.GREEN_ID.includes("REPLACE_ME") &&
  !CFG.GREEN_TOKEN.includes("REPLACE_ME");

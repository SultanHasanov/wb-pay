/* Обёртка над mokky.dev.
   Коллекции читаем целиком и фильтруем в JS — так мы не зависим
   от синтаксиса запросов mokky и от того, что он может поменяться. */

window.DB = (() => {
  const base = () => String(CFG.MOKKY_URL || "").replace(/\/+$/, "");

  async function req(path, opts = {}) {
    if (!CFG.mokkyReady()) {
      throw new Error("MOKKY_URL не заполнен в assets/config.js");
    }
    const res = await fetch(base() + path, {
      ...opts,
      headers: opts.body
        ? { "Content-Type": "application/json", ...(opts.headers || {}) }
        : opts.headers,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`mokky ${opts.method || "GET"} ${path} → ${res.status} ${text}`.trim());
    }
    if (res.status === 204) return null;
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  const list = async (col) => {
    const data = await req(`/${col}`);
    return Array.isArray(data) ? data : [];
  };

  const create = (col, obj) =>
    req(`/${col}`, { method: "POST", body: JSON.stringify(obj) });

  const update = (col, id, patch) =>
    req(`/${col}/${id}`, { method: "PATCH", body: JSON.stringify(patch) });

  const remove = (col, id) => req(`/${col}/${id}`, { method: "DELETE" });

  /* Настройки живут одной записью в коллекции settings. */
  async function settings() {
    const rows = await list("settings");
    return rows[0] || null;
  }

  const saveSettings = (id, patch) => update("settings", id, patch);

  return { list, create, update, remove, settings, saveSettings };
})();

/* Значения по умолчанию — используются при первичной настройке
   и как подстраховка, если в записи settings чего-то не хватает. */
window.DEFAULT_SETTINGS = {
  enabled: true,
  pollTime: "09:00",
  tz: "Europe/Moscow",
  groupId: "",
  skipWeekends: false,
  question: "Кто сегодня на смене?",
  confirmMode: "confirm",   // confirm | hold | instant
  holdMinutes: 10,
  cleanup: "keep_result",   // off | keep_result | all — уборка в группе после фиксации
  cleanupDelaySec: 10,      // через сколько секунд после фиксации удалять
  allowExtraPhones: [],
  adminPin: "1234",
  eveningEnabled: true,     // вечернее напоминание «Завтра смена …»
  eveningTime: "21:00",
  evening: null,            // служебное: { date, firstId, secondId, stage }, перезаписывается
};

/* Общие помощники: даты, телефоны, форматирование. */

window.U = (() => {
  const MONTHS = [
    "Январь", "Февраль", "Март", "Апрель", "Май", "Июнь",
    "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь",
  ];
  const MONTHS_GEN = [
    "января", "февраля", "марта", "апреля", "мая", "июня",
    "июля", "августа", "сентября", "октября", "ноября", "декабря",
  ];

  /* Текущее время в заданной таймзоне. Через Intl, а не через смещение —
     иначе переход на летнее время и чужие зоны считаются неверно. */
  function tzNow(tz = "Europe/Moscow", d = new Date()) {
    let parts;
    try {
      parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: tz,
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit",
        hourCycle: "h23",
        weekday: "short",
      }).formatToParts(d);
    } catch {
      // Неизвестная таймзона — падаем на локальную, но не роняем приложение
      return tzNow("UTC", d);
    }
    const p = {};
    for (const x of parts) p[x.type] = x.value;
    return {
      date: `${p.year}-${p.month}-${p.day}`,
      hm: `${p.hour}:${p.minute}`,
      minutes: Number(p.hour) * 60 + Number(p.minute),
      weekday: p.weekday,                       // "Mon" … "Sun"
      isWeekend: p.weekday === "Sat" || p.weekday === "Sun",
    };
  }

  const todayISO = (tz) => tzNow(tz).date;

  /* "2026-09-01" -> {y,m,d}. Без new Date(): строка с дефисами парсится
     как UTC-полночь, и в зонах западнее UTC день уезжает на предыдущий. */
  function parseISO(s) {
    const [y, m, d] = String(s).split("-").map(Number);
    return { y, m, d };
  }

  const iso = (y, m, d) =>
    `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

  /* "2026-09-01" -> "01.09" */
  function fmtShort(s) {
    const { m, d } = parseISO(s);
    return `${String(d).padStart(2, "0")}.${String(m).padStart(2, "0")}`;
  }

  /* "2026-09-01" -> "1 сентября 2026" */
  function fmtLong(s) {
    const { y, m, d } = parseISO(s);
    return `${d} ${MONTHS_GEN[m - 1]} ${y}`;
  }

  function fmtTime(isoStamp) {
    if (!isoStamp) return "";
    const d = new Date(isoStamp);
    if (isNaN(d)) return "";
    return d.toLocaleString("ru-RU", {
      day: "2-digit", month: "2-digit",
      hour: "2-digit", minute: "2-digit",
    });
  }

  const money = (n) => `${Math.round(Number(n) || 0).toLocaleString("ru-RU")} ₽`;

  /* Телефоны: сравниваем только цифры по последним 10 знакам,
     чтобы 7999…, 8999… и +7 999 … считались одним номером. */
  const digits = (s) => String(s ?? "").replace(/\D/g, "");
  function samePhone(a, b) {
    const A = digits(a), B = digits(b);
    if (A.length < 10 || B.length < 10) return false;
    return A.slice(-10) === B.slice(-10);
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  return {
    MONTHS, MONTHS_GEN,
    tzNow, todayISO, parseISO, iso,
    fmtShort, fmtLong, fmtTime, money,
    digits, samePhone, sleep, esc,
  };
})();

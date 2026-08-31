/* Отрисовка месяца и подсчёт итогов. Общее для публичной страницы и админки. */

window.Cal = (() => {
  const WEEKDAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];

  const byId = (managers) => {
    const m = new Map();
    for (const x of managers) m.set(x.id, x);
    return m;
  };

  /* Ставка берётся из записи дня, а не из менеджера: смена ставки
     не должна задним числом переписывать уже отработанные дни. */
  const rateOf = (w, mgr) => Number(w.rate ?? (mgr && mgr.rate) ?? 0);

  function daysOf(year, month) {
    // month: 1..12
    const first = new Date(year, month - 1, 1);
    const shift = (first.getDay() + 6) % 7;           // 0 = понедельник
    const count = new Date(year, month, 0).getDate();
    return { shift, count };
  }

  function render(el, { year, month, workdays, managers, clickable, onDayClick }) {
    const mgrs = byId(managers);
    const { shift, count } = daysOf(year, month);
    const today = U.todayISO();

    el.innerHTML = "";

    for (let i = 0; i < shift; i++) {
      const pad = document.createElement("div");
      pad.className = "cell cell--empty";
      el.appendChild(pad);
    }

    for (let d = 1; d <= count; d++) {
      const date = U.iso(year, month, d);
      const rows = workdays.filter((w) => w.date === date);

      const cell = document.createElement("button");
      cell.type = "button";
      cell.className = "cell";
      if (date === today) cell.classList.add("cell--today");
      if (rows.length && rows.every((w) => w.paid)) cell.classList.add("cell--paid");
      if (!clickable) cell.disabled = true;

      const num = document.createElement("span");
      num.className = "cell__num";
      num.textContent = d;
      cell.appendChild(num);

      if (rows.length) {
        const marks = document.createElement("span");
        marks.className = "cell__marks";
        for (const w of rows) {
          const m = mgrs.get(w.managerId);
          const chip = document.createElement("span");
          chip.className = "chip" + (w.paid ? " chip--paid" : "");
          chip.style.background = (m && m.color) || "#8a8a8a";
          chip.textContent = (m && m.letter) || "?";
          chip.title = `${(m && m.name) || "неизвестен"}${w.paid ? " · выплачено" : ""}`;
          marks.appendChild(chip);
        }
        cell.appendChild(marks);
      }

      if (clickable && onDayClick) {
        cell.addEventListener("click", () => onDayClick(date, rows));
      }
      el.appendChild(cell);
    }
  }

  /* Итоги по каждому менеджеру.

     Главное в карточке — долг за ВЕСЬ неоплаченный период, а не за
     выбранный месяц: неоплаченные дни с прошлых месяцев тоже входят в сумму,
     и цифра не меняется при перелистывании календаря. Отметили выплату —
     дни и деньги уходят из долга.

     Отдельно считаем месяц, который сейчас открыт, — для справки. */
  function totals(workdays, managers, year, month) {
    const prefix = `${year}-${String(month).padStart(2, "0")}`;
    return managers.map((m) => {
      const mine = workdays.filter((w) => w.managerId === m.id);
      const unpaid = mine.filter((w) => !w.paid);
      const dates = unpaid.map((w) => w.date).sort();
      const inMonth = mine.filter((w) => String(w.date).startsWith(prefix));

      return {
        manager: m,
        // весь неоплаченный период
        unpaidDays: unpaid.length,
        unpaidSum: unpaid.reduce((s, w) => s + rateOf(w, m), 0),
        from: dates[0] || null,
        to: dates[dates.length - 1] || null,
        // открытый месяц
        monthDays: inMonth.length,
        monthSum: inMonth.reduce((s, w) => s + rateOf(w, m), 0),
        monthUnpaid: inMonth.filter((w) => !w.paid),
        // за всё время
        allDays: mine.length,
        allSum: mine.reduce((s, w) => s + rateOf(w, m), 0),
      };
    });
  }

  /* Период, за который накопился долг. */
  function unpaidPeriod(t) {
    if (!t.unpaidDays) return "всё выплачено";
    if (t.from === t.to) return `за ${U.fmtShort(t.from)}`;
    return `с ${U.fmtShort(t.from)} по ${U.fmtShort(t.to)}`;
  }

  function renderTotals(el, list, monthName) {
    el.innerHTML = "";
    for (const t of list) {
      const card = document.createElement("div");
      card.className = "tot" + (t.unpaidDays ? "" : " tot--clear");
      card.innerHTML = `
        <div class="tot__head">
          <span class="chip chip--lg" style="background:${U.esc(t.manager.color || "#888")}">
            ${U.esc(t.manager.letter || "?")}
          </span>
          <span class="tot__name">${U.esc(t.manager.name)}</span>
          <span class="tot__days">${t.unpaidDays} дн.</span>
        </div>
        <div class="tot__sum">${U.money(t.unpaidSum)}</div>
        <div class="tot__line tot__line--left">К выплате · ${U.esc(unpaidPeriod(t))}</div>
        <div class="tot__line tot__line--month">
          ${monthName ? `За ${U.esc(monthName.toLowerCase())}: ` : "За месяц: "}${t.monthDays} дн. · ${U.money(t.monthSum)}
        </div>`;
      el.appendChild(card);
    }
    if (!list.length) {
      el.innerHTML = `<div class="muted">Менеджеры не заведены.</div>`;
    }
  }

  function renderWeekdays(el) {
    el.innerHTML = WEEKDAYS.map((w) => `<span>${w}</span>`).join("");
  }

  return { render, totals, renderTotals, renderWeekdays, unpaidPeriod, rateOf, WEEKDAYS };
})();

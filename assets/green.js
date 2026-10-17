/* Обёртка над Green API.
   Браузер ходит сюда напрямую — проверено, что отдаётся
   Access-Control-Allow-Origin: * и разрешены GET/POST/DELETE. */

window.Green = (() => {
  const url = (method, tail = "") =>
    `${CFG.GREEN_API_URL}/waInstance${CFG.GREEN_ID}/${method}/${CFG.GREEN_TOKEN}${tail}`;

  async function req(method, { verb = "GET", body, tail = "", query = "", nullOn = [] } = {}) {
    if (!CFG.greenReady()) {
      throw new Error("GREEN_ID / GREEN_TOKEN не заполнены в assets/config.js");
    }
    const res = await fetch(url(method, tail) + query, {
      method: verb,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (nullOn.includes(res.status)) return null;
    if (!res.ok) {
      throw new Error(`Green API ${method} → ${res.status} ${text}`.trim());
    }
    return text ? JSON.parse(text) : null;
  }

  return {
    /* options: массив строк. WhatsApp требует 2–12 уникальных вариантов,
       вопрос до 255 символов, каждый вариант до 100. */
    sendPoll(chatId, message, options, multipleAnswers = false) {
      return req("sendPoll", {
        verb: "POST",
        body: {
          chatId,
          message: String(message).slice(0, 255),
          options: options.map((o) => ({ optionName: String(o).slice(0, 100) })),
          multipleAnswers,
        },
      });
    },

    /* quotedMessageId — ответить цитатой на это сообщение. */
    sendMessage(chatId, message, quotedMessageId) {
      const body = { chatId, message };
      if (quotedMessageId) body.quotedMessageId = quotedMessageId;
      return req("sendMessage", { verb: "POST", body });
    },

    /* Удаление у всех участников работает 72 часа после отправки,
       дальше сообщение исчезает только у самого отправителя. */
    deleteMessage(chatId, idMessage, onlySenderDelete = false) {
      return req("deleteMessage", {
        verb: "POST",
        body: { chatId, idMessage, onlySenderDelete },
      });
    },

    /* Ждёт до receiveTimeout секунд, если очередь пуста.
       Возвращает { receiptId, body } либо null.
       Пустую очередь Green API отдаёт то как 200 с пустым телом,
       то как 408 — оба случая означают «ничего нет», а не ошибку. */
    receiveNotification(receiveTimeout = 20) {
      return req("receiveNotification", {
        query: `?receiveTimeout=${receiveTimeout}`,
        nullOn: [408],
      });
    },

    /* Пока уведомление не удалено, следующее из очереди не придёт. */
    deleteNotification(receiptId) {
      return req("deleteNotification", { verb: "DELETE", tail: `/${receiptId}` });
    },

    /* Последние count сообщений чата, новые первыми. */
    getChatHistory(chatId, count = 12) {
      return req("getChatHistory", { verb: "POST", body: { chatId, count } });
    },

    /* Отправка файла. Green API просит грузить файлы на media-хост
       инстанса (7107.api… → 7107.media…). Тип сообщения он выбирает по
       расширению: .ogg с opus уходит голосовым. Только для сервера —
       в браузере файлы не шлём. */
    async sendFileByUpload(chatId, data, fileName, quotedMessageId) {
      if (!CFG.greenReady()) {
        throw new Error("GREEN_ID / GREEN_TOKEN не заполнены в assets/config.js");
      }
      const media = CFG.GREEN_MEDIA_URL || CFG.GREEN_API_URL.replace(".api.", ".media.");
      const form = new FormData();
      form.append("chatId", chatId);
      form.append("file", new Blob([data]), fileName);
      form.append("fileName", fileName);
      if (quotedMessageId) form.append("quotedMessageId", quotedMessageId);
      const res = await fetch(
        `${media}/waInstance${CFG.GREEN_ID}/sendFileByUpload/${CFG.GREEN_TOKEN}`,
        { method: "POST", body: form },
      );
      const text = await res.text();
      if (!res.ok) throw new Error(`Green API sendFileByUpload → ${res.status} ${text}`.trim());
      return text ? JSON.parse(text) : null;
    },

    /* Ссылка на файл медиа-сообщения: { downloadUrl }. Нужна для цитат —
       у процитированного голосового своей ссылки в вебхуке нет. */
    downloadFile(chatId, idMessage) {
      return req("downloadFile", { verb: "POST", body: { chatId, idMessage } });
    },

    getStateInstance: () => req("getStateInstance"),
    getSettings: () => req("getSettings"),
    setSettings: (obj) => req("setSettings", { verb: "POST", body: obj }),
    getContacts: () => req("getContacts"),
  };
})();

/* Настройки инстанса, без которых схема молча не работает.
   pollMessageWebhook по умолчанию "no" — выборы просто не придут.
   enableLidMode должен быть "no", иначе вместо номеров приходят @lid
   и сверка по телефону ломается.
   webhookUrl должен быть пуст, иначе receiveNotification отдаёт ошибку. */
window.REQUIRED_GREEN_SETTINGS = {
  webhookUrl: "",
  incomingWebhook: "yes",
  pollMessageWebhook: "yes",
  enableLidMode: "no",
};

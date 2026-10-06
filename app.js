(() => {
  "use strict";

  const STORAGE_KEY = "portfolio-studio-data-v1";
  const DATABASE_NAME = "portfolio-studio";
  const DATABASE_STORE = "portfolio";
  const MAX_FILE_SIZE = 3 * 1024 * 1024;
  const editorRoot = document.getElementById("editor-app");
  const viewerRoot = document.getElementById("viewer-app");
  const cloudConfig = window.PORTFOLIO_CONFIG || {};
  const supabaseUrl = String(cloudConfig.supabaseUrl || "").replace(/\/+$/, "");
  const supabaseAnonKey = String(cloudConfig.supabaseAnonKey || "");
  const storageBucket = String(cloudConfig.storageBucket || "portfolio-files");
  const cloudRequested = Boolean(supabaseUrl || supabaseAnonKey);
  const cloudEnabled = Boolean(supabaseUrl && supabaseAnonKey);
  const authStorageKey = "portfolio-editor-auth-v1";

  const seedData = {
    profile: {
      name: "Реева Турсынай Жусипбаевна",
      role: "Әдіскер",
      workplace: "№6 Өркен бөбекжай ЖБҚ МКҚК",
      address: "Маңғыстау облысы, Мұнайлы ауданы",
      quote: "«Педагогке бақыт — балаға сапалы тәрбие»",
      photo: ""
    },
    categories: [
      {
        id: "about",
        title: "Педагог туралы жалпы мәлімет",
        icon: "♙",
        items: [
          { id: "about-text", type: "text", title: "Жалпы мәлімет", text: "Тегі, аты-жөні: Реева Турсынай Жусипбаевна\nМамандығы: Мектепке дейінгі тәрбие, педагог-психолог және әдіскер." }
        ]
      },
      {
        id: "results",
        title: "Педагогтер қызметінің нәтижесі",
        icon: "✧",
        items: [
          { id: "achievements", type: "group", title: "Педагогикалық жетістіктер", children: [] },
          { id: "seminars", type: "group", title: "Семинар", children: [] },
          { id: "experience", type: "group", title: "Озат педагогикалық тәжірибе", children: [] }
        ]
      },
      {
        id: "science",
        title: "Ғылыми-педагогикалық қызмет",
        icon: "⌂",
        items: [
          { id: "science-work", type: "text", title: "Ғылыми-педагогикалық қызмет", text: "Ғылыми және педагогикалық жұмыстар туралы ақпарат." },
          { id: "publications", type: "text", title: "Жарияланымдар", text: "Мақалалар мен жарияланымдар туралы ақпарат." }
        ]
      }
    ]
  };

  let data = structuredClone(seedData);
  let selectedId = data.categories[0]?.id || null;
  let activeView = "category";
  let saveTimer;
  let hasLocalImportData = false;
  let authSession = readAuthSession();
  let cloudUpdatedAt = null;
  const databasePromise = openDatabase().catch((error) => {
    console.warn("IndexedDB недоступна, используется хранилище браузера:", error);
    return null;
  });

  function openDatabase() {
    if (!window.indexedDB) return Promise.reject(new Error("Браузер не поддерживает IndexedDB."));
    return new Promise((resolve, reject) => {
      const request = window.indexedDB.open(DATABASE_NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(DATABASE_STORE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("Не удалось открыть базу данных."));
      request.onblocked = () => reject(new Error("База данных заблокирована другой вкладкой."));
    });
  }

  function requestResult(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("Ошибка чтения базы данных."));
    });
  }

  function isPortfolioData(parsed) {
    return parsed && typeof parsed === "object" && parsed.profile && Array.isArray(parsed.categories);
  }

  function migrateDefaultResultItems(portfolio) {
    const results = portfolio.categories.find((category) => category.id === "results");
    const defaults = {
      achievements: ["Педагогикалық жетістіктер", "Кәсіби жетістіктер мен марапаттар туралы ақпарат."],
      seminars: ["Семинар", "Өткізілген семинарлар мен кәсіби кездесулер."],
      experience: ["Озат педагогикалық тәжірибе", "Педагогикалық тәжірибе мен әдістемелік материалдар."]
    };
    for (const item of results?.items || []) {
      const original = defaults[item.id];
      if (original && item.type === "text" && item.title === original[0] && item.text === original[1]) {
        item.type = "group";
        item.children = [];
        delete item.text;
      }
    }
    for (const category of portfolio.categories) normalizeTableItems(category.items);
    return portfolio;
  }

  function normalizeTableItems(items) {
    for (const item of items || []) {
      if (item.type === "table") {
        item.headers = Array.isArray(item.headers) ? item.headers : ["№", "Название", "Описание"];
        item.rows = Array.isArray(item.rows) ? item.rows.map((row) => (
          item.headers.map((_, index) => {
            const cell = row[index];
            return cell && typeof cell === "object"
              ? { text: String(cell.text || ""), url: String(cell.url || ""), data: String(cell.data || ""), fileName: String(cell.fileName || "") }
              : { text: String(cell || ""), url: "", data: "", fileName: "" };
          })
        )) : [];
      }
      if (Array.isArray(item.children)) normalizeTableItems(item.children);
    }
  }

  function ensureTableCell(item, rowIndex, columnIndex) {
    if (item?.type !== "table" || !item.rows[rowIndex]) return null;
    const value = item.rows[rowIndex][columnIndex];
    if (!value || typeof value !== "object") {
      item.rows[rowIndex][columnIndex] = { text: String(value || ""), url: "", data: "", fileName: "" };
    }
    return item.rows[rowIndex][columnIndex];
  }

  function readAuthSession() {
    try {
      const stored = localStorage.getItem(authStorageKey);
      return stored ? JSON.parse(stored) : null;
    } catch (error) {
      console.warn("Не удалось восстановить вход редактора:", error);
      return null;
    }
  }

  function writeAuthSession(session) {
    authSession = session;
    if (session) localStorage.setItem(authStorageKey, JSON.stringify(session));
    else localStorage.removeItem(authStorageKey);
  }

  async function getAccessToken() {
    if (!authSession?.access_token) throw new Error("Войдите в редактор, чтобы сохранить изменения.");
    if (Number(authSession.expires_at) > Date.now() / 1000 + 60) return authSession.access_token;
    if (!authSession.refresh_token) {
      writeAuthSession(null);
      throw new Error("Сеанс редактора истёк. Войдите снова.");
    }
    const response = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=refresh_token`, {
      method: "POST",
      headers: { apikey: supabaseAnonKey, "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: authSession.refresh_token })
    });
    const result = await response.json();
    if (!response.ok) {
      writeAuthSession(null);
      throw new Error(result.msg || result.message || "Сеанс истёк. Войдите снова.");
    }
    writeAuthSession({ ...result, expires_at: Math.floor(Date.now() / 1000) + result.expires_in });
    return result.access_token;
  }

  async function cloudRequest(path, options = {}, requireAuth = false) {
    const token = requireAuth ? await getAccessToken() : supabaseAnonKey;
    const response = await fetch(`${supabaseUrl}${path}`, {
      ...options,
      headers: {
        apikey: supabaseAnonKey,
        ...(requireAuth ? { Authorization: `Bearer ${token}` } : {}),
        ...(options.body instanceof Blob ? {} : { "Content-Type": "application/json" }),
        ...options.headers
      }
    });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Supabase (${response.status}): ${detail || response.statusText}`);
    }
    if (response.status === 204) return null;
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }

  async function signIn(email, password) {
    const response = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { apikey: supabaseAnonKey, "Content-Type": "application/json" },
      body: JSON.stringify({ email, password })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.msg || result.message || result.error_description || "Не удалось войти. Проверьте email и пароль.");
    writeAuthSession({ ...result, expires_at: Math.floor(Date.now() / 1000) + result.expires_in });
  }

  async function loadCloudData() {
    const rows = await cloudRequest("/rest/v1/portfolio?id=eq.1&select=data,updated_at");
    if (rows?.length && isPortfolioData(rows[0].data)) {
      hasLocalImportData = false;
      cloudUpdatedAt = rows[0].updated_at || null;
      return migrateDefaultResultItems(rows[0].data);
    }
    cloudUpdatedAt = null;
    if (editorRoot) {
      const localData = await loadLocalData();
      if (localData) {
        hasLocalImportData = true;
        return localData;
      }
    }
    return structuredClone(seedData);
  }

  async function loadLocalData() {
    try {
      const database = await databasePromise;
      if (database) {
        const stored = await requestResult(database.transaction(DATABASE_STORE, "readonly").objectStore(DATABASE_STORE).get(STORAGE_KEY));
        if (isPortfolioData(stored)) return migrateDefaultResultItems(stored);
      }
      const stored = localStorage.getItem(STORAGE_KEY);
      if (!stored) return null;
      const parsed = JSON.parse(stored);
      if (!isPortfolioData(parsed)) {
        throw new Error("Сохранённые данные портфолио имеют неверный формат.");
      }
      return migrateDefaultResultItems(parsed);
    } catch (error) {
      console.error("Не удалось загрузить портфолио:", error);
      return null;
    }
  }

  async function loadData() {
    if (cloudRequested && !cloudEnabled) {
      throw new Error("В config.js укажите и Supabase URL, и publishable/anon key.");
    }
    return cloudEnabled ? loadCloudData() : (await loadLocalData()) || structuredClone(seedData);
  }

  function persistData() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveData().then(() => {
        updateSaveState("Сохранено");
      }).catch((error) => {
        console.error("Не удалось сохранить портфолио:", error);
        updateSaveState("Не удалось сохранить");
        window.alert(cloudEnabled
          ? `Не удалось сохранить в облако: ${error.message}`
          : "Не удалось сохранить данные в браузере. Возможно, размер файлов слишком большой. Удалите часть файлов и попробуйте снова.");
      });
    }, 180);
  }

  async function uploadEmbeddedFiles(value) {
    if (typeof value === "string" && value.startsWith("data:")) {
      const fileResponse = await fetch(value);
      const blob = await fileResponse.blob();
      const extension = ({ "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" })[blob.type] || "bin";
      const objectPath = `uploads/${newId()}.${extension}`;
      await cloudRequest(`/storage/v1/object/${encodeURIComponent(storageBucket)}/${objectPath.split("/").map(encodeURIComponent).join("/")}`, {
        method: "POST",
        body: blob,
        headers: { "Content-Type": blob.type || "application/octet-stream", "x-upsert": "false" }
      }, true);
      return `${supabaseUrl}/storage/v1/object/public/${encodeURIComponent(storageBucket)}/${objectPath.split("/").map(encodeURIComponent).join("/")}`;
    }
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) value[index] = await uploadEmbeddedFiles(value[index]);
    } else if (value && typeof value === "object") {
      for (const key of Object.keys(value)) value[key] = await uploadEmbeddedFiles(value[key]);
    }
    return value;
  }

  async function saveData() {
    if (cloudEnabled) {
      await uploadEmbeddedFiles(data);
      const updatedAt = new Date().toISOString();
      await cloudRequest("/rest/v1/portfolio?on_conflict=id", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({ id: 1, data, updated_at: updatedAt })
      }, true);
      cloudUpdatedAt = updatedAt;
      return;
    }
    const database = await databasePromise;
    if (!database) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
      return;
    }
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(DATABASE_STORE, "readwrite");
      transaction.objectStore(DATABASE_STORE).put(data, STORAGE_KEY);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error("Не удалось записать данные."));
      transaction.onabort = () => reject(transaction.error || new Error("Сохранение было отменено."));
    });
  }

  function updateSaveState(text) {
    const state = document.querySelector("[data-save-state]");
    if (state) state.lastChild.textContent = ` ${text}`;
  }

  function escapeHtml(value = "") {
    return String(value).replace(/[&<>"']/g, (char) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[char]);
  }

  function safeUrl(value) {
    let trimmed = String(value || "").trim();
    if (!trimmed) return "";
    if (!/^(https?:|mailto:|tel:)/i.test(trimmed)) trimmed = `https://${trimmed}`;
    try {
      const url = new URL(trimmed, window.location.href);
      if (!["http:", "https:", "mailto:", "tel:"].includes(url.protocol)) return "";
      return url.href;
    } catch {
      return "";
    }
  }

  function newId() {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function getCategory(id = selectedId) {
    return data.categories.find((category) => category.id === id);
  }

  function findItem(itemId, items = data.categories.flatMap((category) => category.items), parentItems = null) {
    for (const item of items) {
      if (item.id === itemId) return { item, parentItems };
      if (Array.isArray(item.children)) {
        const found = findItem(itemId, item.children, item.children);
        if (found) return found;
      }
    }
    return null;
  }

  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error || new Error("Не удалось прочитать файл."));
      reader.readAsDataURL(file);
    });
  }

  function iconFor(type) {
    return ({ text: "T", link: "↗", image: "▧", pdf: "▤", button: "→", table: "▦", group: "▤" })[type] || "•";
  }

  function renderEditor() {
    if (!editorRoot) return;
    if (cloudEnabled && !authSession) {
      renderEditorLogin();
      return;
    }
    const selectedCategory = getCategory();
    editorRoot.innerHTML = `
      <header class="editor-topbar">
        <div class="brand"><span class="brand-mark">П</span><span>Портфолио<small>Редактор сайта</small></span></div>
        <div class="top-actions">
          <span class="save-state" data-save-state><i class="save-dot"></i> Сохранено</span>
          <a class="button button-primary" href="./viewer.html" target="_blank" rel="noopener">Открыть просмотр <span aria-hidden="true">↗</span></a>
          ${cloudEnabled ? '<button class="button button-quiet button-small" type="button" data-action="logout">Выйти</button>' : ""}
        </div>
      </header>
      <div class="editor-shell">
        <aside class="editor-sidebar" aria-label="Разделы редактора">
          <p class="sidebar-label">Портфолио</p>
          <button class="nav-item ${activeView === "profile" ? "active" : ""}" type="button" data-action="profile"><span>◉</span> Профиль</button>
          <div class="sidebar-divider"></div>
          <p class="sidebar-label">Разделы сайта</p>
          ${data.categories.map((category, index) => `
            <button class="nav-item ${activeView === "category" && category.id === selectedId ? "active" : ""}" type="button" data-action="select-category" data-id="${escapeHtml(category.id)}">
              <span>${escapeHtml(category.icon || "▧")}</span><span>${escapeHtml(category.title)}</span><span class="nav-number">${String(index + 1).padStart(2, "0")}</span>
            </button>`).join("")}
          <button class="nav-item add-category-link" type="button" data-action="add-category"><span>＋</span> Добавить раздел</button>
        </aside>
        <main class="editor-main">
          ${!cloudEnabled ? `<div class="sync-notice sync-warning"><strong>Облачная синхронизация не настроена</strong><span>Сейчас изменения видны только в этом браузере. Настройте Supabase и заполните config.js по инструкции.</span></div>` : ""}
          ${hasLocalImportData ? `<div class="sync-notice"><strong>Найдены изменения, сохранённые в этом браузере</strong><span>Перенесите их в облако, чтобы посетители и другие устройства увидели портфолио.</span><button class="button button-primary button-small" type="button" data-action="import-local">Импортировать данные этого браузера в облако</button></div>` : ""}
          ${activeView === "profile" ? renderProfileEditor() : selectedCategory ? renderCategoryEditor(selectedCategory) : `
            <section class="panel"><div class="empty-blocks"><span class="empty-icon">＋</span><strong>Пока нет разделов</strong><span>Добавьте первый раздел портфолио.</span><button class="button button-primary button-small" type="button" data-action="add-category">Добавить раздел</button></div></section>`}
        </main>
      </div>`;
    bindEditorEvents();
  }

  function renderEditorLogin(errorMessage = "") {
    if (!editorRoot) return;
    editorRoot.innerHTML = `<main class="login-page">
      <form class="login-card" data-login-form>
        <span class="brand-mark">П</span>
        <p class="eyebrow">Приватный доступ</p>
        <h1>Вход в редактор</h1>
        <p class="login-description">Войдите в аккаунт редактора, чтобы изменять и публиковать портфолио.</p>
        ${errorMessage ? `<p class="login-error" role="alert">${escapeHtml(errorMessage)}</p>` : ""}
        <div class="field"><label for="login-email">Email</label><input id="login-email" name="email" type="email" autocomplete="username" required /></div>
        <div class="field"><label for="login-password">Пароль</label><input id="login-password" name="password" type="password" autocomplete="current-password" required /></div>
        <button class="button button-primary" type="submit">Войти</button>
        <a class="viewer-link" href="./index.html">Вернуться на сайт</a>
      </form>
    </main>`;
    editorRoot.onsubmit = async (event) => {
      if (!event.target.matches("[data-login-form]")) return;
      event.preventDefault();
      const form = event.target;
      const submitButton = form.querySelector('[type="submit"]');
      submitButton.disabled = true;
      submitButton.textContent = "Входим…";
      try {
        await signIn(form.elements.email.value.trim(), form.elements.password.value);
        data = await loadCloudData();
        selectedId = data.categories[0]?.id || null;
        renderEditor();
      } catch (error) {
        console.error("Не удалось войти в редактор:", error);
        renderEditorLogin(error.message);
      }
    };
  }

  function renderProfileEditor() {
    const profile = data.profile;
    return `
      <div class="page-heading"><p class="eyebrow">Настройки сайта</p><h1>Профиль портфолио</h1><p>Эта информация появится на главной странице для посетителей.</p></div>
      <section class="panel">
        <div class="panel-heading"><div><h2>Основная информация</h2><p>Заполните профиль автора портфолио.</p></div></div>
        <div class="form-grid">
          <div class="field field-full"><label for="profile-name">Имя и фамилия</label><input id="profile-name" data-profile="name" value="${escapeHtml(profile.name)}" placeholder="Например, Турсынай Жусипбаевна" /></div>
          <div class="field"><label for="profile-role">Должность</label><input id="profile-role" data-profile="role" value="${escapeHtml(profile.role)}" placeholder="Педагог" /></div>
          <div class="field"><label for="profile-workplace">Место работы</label><input id="profile-workplace" data-profile="workplace" value="${escapeHtml(profile.workplace)}" placeholder="Название организации" /></div>
          <div class="field field-full"><label for="profile-address">Адрес</label><input id="profile-address" data-profile="address" value="${escapeHtml(profile.address)}" placeholder="Город, район" /></div>
          <div class="field field-full"><label for="profile-quote">Цитата на главной странице</label><input id="profile-quote" data-profile="quote" value="${escapeHtml(profile.quote)}" placeholder="Ваша любимая цитата" /></div>
          <div class="field field-full"><label>Фотография</label>
            <div class="photo-row"><img class="profile-thumb" src="${escapeHtml(profile.photo || "")}" alt="" onerror="this.style.display='none'" />
              <label class="upload-label">Загрузить фото<input type="file" accept="image/*" data-profile-photo /></label>
              ${profile.photo ? '<button type="button" class="button button-quiet button-small" data-action="remove-profile-photo">Удалить фото</button>' : ""}
            </div><span class="field-hint">JPG, PNG или WebP, до 3 МБ.</span>
          </div>
        </div>
      </section>
      <section class="panel">
        <div class="panel-heading"><div><h2>Структура портфолио</h2><p>Добавляйте и редактируйте разделы, которые увидят посетители.</p></div><button class="button button-outline button-small" type="button" data-action="add-category">＋ Добавить раздел</button></div>
        ${data.categories.length ? `<div class="block-list">${data.categories.map((category, index) => `
          <div class="content-block"><div class="block-head"><span class="block-type"><span class="block-type-icon">${escapeHtml(category.icon || "▧")}</span>${escapeHtml(category.title)}</span><button class="button button-quiet button-small" type="button" data-action="select-category" data-id="${escapeHtml(category.id)}">Редактировать · ${index + 1}</button></div></div>`).join("")}</div>` : `<div class="empty-blocks"><strong>Добавьте первый раздел</strong><span>Например: «Достижения» или «Публикации».</span></div>`}
      </section>`;
  }

  function renderCategoryEditor(category) {
    return `
      <div class="page-heading"><p class="eyebrow">Редактирование раздела</p><h1>Содержание сайта</h1><p>Добавляйте текст, ссылки, фотографии и документы — они сразу появятся в просмотрщике.</p></div>
      <section class="panel">
        <div class="panel-heading"><div><h2>Название раздела</h2><p>Раздел будет показан отдельной карточкой на странице портфолио.</p></div></div>
        <div class="category-title-row">
          <div class="field"><label for="category-title">Заголовок</label><input id="category-title" data-category="title" value="${escapeHtml(category.title)}" /></div>
          <button class="button button-danger button-small" type="button" data-action="delete-category" data-id="${escapeHtml(category.id)}">Удалить раздел</button>
        </div>
        <div class="block-list">
          ${category.items.length ? category.items.map((item, index) => renderBlock(category, item, index)).join("") : `
            <div class="empty-blocks"><span class="empty-icon">＋</span><strong>Раздел пока пустой</strong><span>Добавьте нужные материалы с помощью кнопок ниже.</span></div>`}
        </div>
        <div class="content-toolbar" aria-label="Добавить материал">
          <button class="button button-outline" type="button" data-action="add-block" data-type="text">＋ Текст</button>
          <button class="button button-outline" type="button" data-action="add-block" data-type="link">＋ Ссылка</button>
          <button class="button button-outline" type="button" data-action="add-block" data-type="image">＋ Фото</button>
          <button class="button button-outline" type="button" data-action="add-block" data-type="pdf">＋ PDF-документ</button>
          <button class="button button-outline" type="button" data-action="add-block" data-type="button">＋ Кнопка</button>
          <button class="button button-outline" type="button" data-action="add-block" data-type="table">＋ Таблица</button>
          <button class="button button-outline" type="button" data-action="add-block" data-type="group">＋ Вложенный раздел</button>
        </div>
      </section>`;
  }

  function renderBlock(category, item, index, parentId = "") {
    const labels = { text: "Текст", link: "Ссылка", image: "Фотография", pdf: "PDF-документ", button: "Кнопка", table: "Таблица", group: "Вложенный раздел" };
    const titleField = `<div class="field"><label>Название</label><input data-item-field="title" data-item-id="${escapeHtml(item.id)}" value="${escapeHtml(item.title || "")}" placeholder="${labels[item.type] || "Название"}" /></div>`;
    let fields = item.type === "group" ? "" : titleField;
    if (item.type === "group") {
      fields += `<div class="nested-editor">
        <div class="field"><label>Название раздела</label><input data-item-field="title" data-item-id="${escapeHtml(item.id)}" value="${escapeHtml(item.title || "")}" placeholder="Название раздела" /></div>
        <p class="field-hint">Вложенный раздел откроется как отдельная страница. Добавляйте в него любые материалы или новые подразделы.</p>
        <div class="block-list nested-block-list">${item.children?.length ? item.children.map((child, childIndex) => renderBlock(category, child, childIndex, item.id)).join("") : `<div class="empty-blocks"><strong>В разделе пока нет материалов</strong><span>Добавьте текст, документы или ещё один раздел.</span></div>`}</div>
        <div class="content-toolbar">
          <button class="button button-outline" type="button" data-action="add-block" data-type="text" data-parent-id="${escapeHtml(item.id)}">＋ Текст</button>
          <button class="button button-outline" type="button" data-action="add-block" data-type="link" data-parent-id="${escapeHtml(item.id)}">＋ Ссылка</button>
          <button class="button button-outline" type="button" data-action="add-block" data-type="image" data-parent-id="${escapeHtml(item.id)}">＋ Фото</button>
          <button class="button button-outline" type="button" data-action="add-block" data-type="pdf" data-parent-id="${escapeHtml(item.id)}">＋ PDF-документ</button>
          <button class="button button-outline" type="button" data-action="add-block" data-type="button" data-parent-id="${escapeHtml(item.id)}">＋ Кнопка</button>
          <button class="button button-outline" type="button" data-action="add-block" data-type="table" data-parent-id="${escapeHtml(item.id)}">＋ Таблица</button>
          <button class="button button-outline" type="button" data-action="add-block" data-type="group" data-parent-id="${escapeHtml(item.id)}">＋ Вложенный раздел</button>
        </div>
      </div>`;
    }
    if (item.type === "text") {
      fields = `${titleField}<div class="field"><label>Текст</label><textarea data-item-field="text" data-item-id="${escapeHtml(item.id)}" placeholder="Введите текст...">${escapeHtml(item.text || "")}</textarea></div>`;
    } else if (item.type === "table") {
      fields = `${titleField}${renderTableEditor(item)}`;
    } else if (item.type === "link" || item.type === "button") {
      fields = `${titleField}<div class="field"><label>${item.type === "button" ? "Ссылка кнопки" : "Адрес ссылки"}</label><input data-item-field="url" data-item-id="${escapeHtml(item.id)}" type="url" value="${escapeHtml(item.url || "")}" placeholder="https://example.com" /><span class="field-hint">Ссылка откроется в новой вкладке.</span></div>`;
      if (item.type === "button") {
        fields += `<div class="field"><label>Подпись кнопки</label><input data-item-field="text" data-item-id="${escapeHtml(item.id)}" value="${escapeHtml(item.text || "")}" placeholder="Открыть материал" /></div>`;
      }
    } else if (item.type === "image" || item.type === "pdf") {
      fields = `${titleField}<div class="field"><label>Загрузить ${item.type === "pdf" ? "PDF" : "изображение"}</label>
        <label class="upload-label">${item.fileName ? `Заменить: ${escapeHtml(item.fileName)}` : "Выбрать файл"}
          <input type="file" data-item-file data-item-id="${escapeHtml(item.id)}" accept="${item.type === "pdf" ? "application/pdf,.pdf" : "image/*"}" />
        </label><span class="field-hint">Максимальный размер файла — 3 МБ.${item.data ? " Файл загружен." : ""}</span>
      </div>`;
      if (item.type === "pdf") {
        fields += `<div class="field"><label>Как показывать документ</label><select data-item-field="displayMode" data-item-id="${escapeHtml(item.id)}">
          <option value="click" ${item.displayMode !== "inline" ? "selected" : ""}>Открывать по нажатию</option>
          <option value="inline" ${item.displayMode === "inline" ? "selected" : ""}>Показывать сразу в разделе</option>
        </select><span class="field-hint">Выбор применяется только к этому документу.</span></div>`;
      }
      if (item.data) fields += `<button class="button button-quiet button-small" type="button" data-action="remove-file" data-id="${escapeHtml(item.id)}">Удалить файл</button>`;
    }
    return `<article class="content-block ${item.type === "group" ? "group-block" : ""}">
      <div class="block-head"><span class="block-type"><span class="block-type-icon">${iconFor(item.type)}</span>${labels[item.type] || "Материал"} <span class="nav-number">${String(index + 1).padStart(2, "0")}</span></span>
        <div class="block-actions">
          ${index > 0 ? `<button class="button button-icon" type="button" title="Переместить вверх" aria-label="Переместить вверх" data-action="move-block" data-direction="-1" data-parent-id="${escapeHtml(parentId)}" data-id="${escapeHtml(item.id)}">↑</button>` : ""}
          ${index < (parentId ? findItem(parentId)?.item.children.length : category.items.length) - 1 ? `<button class="button button-icon" type="button" title="Переместить вниз" aria-label="Переместить вниз" data-action="move-block" data-direction="1" data-parent-id="${escapeHtml(parentId)}" data-id="${escapeHtml(item.id)}">↓</button>` : ""}
          <button class="button button-icon" type="button" title="Удалить материал" aria-label="Удалить материал" data-action="delete-block" data-parent-id="${escapeHtml(parentId)}" data-id="${escapeHtml(item.id)}">×</button>
        </div>
      </div>
      <div class="block-body">${fields}</div>
    </article>`;
  }

  function renderTableEditor(item) {
    const headers = Array.isArray(item.headers) ? item.headers : [];
    const rows = Array.isArray(item.rows) ? item.rows : [];
    return `<div class="table-editor-wrap"><table class="table-editor"><thead><tr>${headers.map((header, columnIndex) => `
      <th><div class="table-header-editor">
        <input aria-label="Заголовок столбца ${columnIndex + 1}" data-table-header="${columnIndex}" data-item-id="${escapeHtml(item.id)}" value="${escapeHtml(header)}" placeholder="Столбец ${columnIndex + 1}" />
        <button class="button button-danger button-small" type="button" aria-label="Удалить столбец ${columnIndex + 1}" title="Удалить столбец" data-action="delete-table-column" data-column="${columnIndex}" data-id="${escapeHtml(item.id)}">×</button>
      </div></th>`).join("")}<th class="table-action-cell">Действия</th></tr></thead>
      <tbody>${rows.map((row, rowIndex) => `<tr>${headers.map((_, columnIndex) => `
        <td><div class="table-cell-editor">
          <input aria-label="Текст ячейки ${rowIndex + 1}, ${columnIndex + 1}" data-table-cell="${rowIndex},${columnIndex}" data-item-id="${escapeHtml(item.id)}" value="${escapeHtml(row[columnIndex]?.text || "")}" placeholder="Текст ячейки" />
          <input aria-label="Ссылка из ячейки ${rowIndex + 1}, ${columnIndex + 1}" type="url" data-table-link="${rowIndex},${columnIndex}" data-item-id="${escapeHtml(item.id)}" value="${escapeHtml(row[columnIndex]?.url || "")}" placeholder="Ссылка (необязательно)" />
          <label class="upload-label table-upload">${row[columnIndex]?.fileName ? `Заменить: ${escapeHtml(row[columnIndex].fileName)}` : "Прикрепить PDF / фото"}
            <input type="file" accept="application/pdf,image/*,.pdf" data-table-file="${rowIndex},${columnIndex}" data-item-id="${escapeHtml(item.id)}" />
          </label>
          ${row[columnIndex]?.data || row[columnIndex]?.url ? `<button class="button button-quiet button-small" type="button" data-action="remove-table-attachment" data-cell="${rowIndex},${columnIndex}" data-id="${escapeHtml(item.id)}">Убрать вложение</button>` : ""}
        </div></td>`).join("")}
        <td class="table-action-cell"><button class="button button-danger button-small" type="button" data-action="delete-table-row" data-row="${rowIndex}" data-id="${escapeHtml(item.id)}">Удалить строку</button></td></tr>`).join("")}</tbody>
    </table></div><div class="table-actions">
      <button class="button button-outline button-small" type="button" data-action="add-table-row" data-id="${escapeHtml(item.id)}">＋ Добавить строку</button>
      <button class="button button-outline button-small" type="button" data-action="add-table-column" data-id="${escapeHtml(item.id)}">＋ Добавить столбец</button>
    </div>`;
  }

  function bindEditorEvents() {
    editorRoot.oninput = onEditorInput;
    editorRoot.onchange = onEditorChange;
    editorRoot.onclick = (event) => {
      onEditorClick(event).catch((error) => {
        console.error("Не удалось выполнить действие редактора:", error);
        window.alert(error.message || "Не удалось выполнить действие.");
      });
    };
  }

  function onEditorInput(event) {
    const target = event.target;
    if (target.matches("[data-profile]")) {
      data.profile[target.dataset.profile] = target.value;
      persistData();
    } else if (target.matches("[data-category]")) {
      const category = getCategory();
      if (category) category[target.dataset.category] = target.value;
      persistData();
    } else if (target.matches("[data-item-field]")) {
      const item = findItem(target.dataset.itemId)?.item;
      if (item) item[target.dataset.itemField] = target.value;
      persistData();
    } else if (target.matches("[data-table-header]")) {
      const item = findItem(target.dataset.itemId)?.item;
      if (item?.type === "table") item.headers[Number(target.dataset.tableHeader)] = target.value;
      persistData();
    } else if (target.matches("[data-table-cell]")) {
      const item = findItem(target.dataset.itemId)?.item;
      const [rowIndex, columnIndex] = target.dataset.tableCell.split(",").map(Number);
      const cell = ensureTableCell(item, rowIndex, columnIndex);
      if (cell) cell.text = target.value;
      persistData();
    } else if (target.matches("[data-table-link]")) {
      const item = findItem(target.dataset.itemId)?.item;
      const [rowIndex, columnIndex] = target.dataset.tableLink.split(",").map(Number);
      const cell = ensureTableCell(item, rowIndex, columnIndex);
      if (cell) {
        cell.url = target.value;
        if (target.value) {
          cell.data = "";
          cell.fileName = "";
        }
      }
      persistData();
    }
    updateSaveState("Есть изменения…");
  }

  async function onEditorChange(event) {
    const target = event.target;
    if (target.matches("select[data-item-field]")) {
      const item = findItem(target.dataset.itemId)?.item;
      if (item) item[target.dataset.itemField] = target.value;
      persistData();
      updateSaveState("Есть изменения…");
    } else if (target.matches("[data-profile-photo]")) {
      await handleUpload(target.files?.[0], (dataUrl) => { data.profile.photo = dataUrl; });
      renderEditor();
    } else if (target.matches("[data-item-file]")) {
      const item = findItem(target.dataset.itemId)?.item;
      if (!item) return;
      await handleUpload(target.files?.[0], (dataUrl, file) => {
        item.data = dataUrl;
        item.fileName = file.name;
      }, item.type);
      renderEditor();
    } else if (target.matches("[data-table-file]")) {
      const item = findItem(target.dataset.itemId)?.item;
      const [rowIndex, columnIndex] = target.dataset.tableFile.split(",").map(Number);
      const cell = ensureTableCell(item, rowIndex, columnIndex);
      if (!cell) return;
      const file = target.files?.[0];
      if (!file) return;
      if (file.size > MAX_FILE_SIZE) {
        window.alert("Файл слишком большой. Максимальный размер — 3 МБ.");
        target.value = "";
        return;
      }
      if (file.type !== "application/pdf" && !file.type.startsWith("image/") && !file.name.toLowerCase().endsWith(".pdf")) {
        window.alert("Прикрепите PDF-файл или изображение.");
        target.value = "";
        return;
      }
      try {
        cell.data = await fileToDataUrl(file);
        cell.fileName = file.name;
        cell.url = "";
        persistData();
        renderEditor();
      } catch (error) {
        console.error("Не удалось загрузить вложение таблицы:", error);
        window.alert("Не удалось прочитать выбранный файл.");
      }
    }
  }

  async function handleUpload(file, onLoaded, expectedType) {
    if (!file) return;
    if (file.size > MAX_FILE_SIZE) {
      window.alert("Файл слишком большой. Максимальный размер — 3 МБ.");
      return;
    }
    if (expectedType === "pdf" && file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
      window.alert("Для этого блока выберите файл PDF.");
      return;
    }
    if (expectedType === "image" && !file.type.startsWith("image/")) {
      window.alert("Для этого блока выберите изображение.");
      return;
    }
    try {
      onLoaded(await fileToDataUrl(file), file);
      persistData();
    } catch (error) {
      console.error("Не удалось загрузить файл:", error);
      window.alert("Не удалось прочитать выбранный файл.");
    }
  }

  async function onEditorClick(event) {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    const { action, id } = button.dataset;
    if (action === "profile") {
      activeView = "profile";
    } else if (action === "logout") {
      writeAuthSession(null);
      renderEditor();
      return;
    } else if (action === "import-local") {
      if (!window.confirm("Заменить облачное портфолио данными, сохранёнными в этом браузере?")) return;
      const localData = await loadLocalData();
      if (!localData) {
        hasLocalImportData = false;
        renderEditor();
        return;
      }
      data = localData;
      await saveData();
      hasLocalImportData = false;
      selectedId = data.categories[0]?.id || null;
      updateSaveState("Опубликовано");
      renderEditor();
      return;
    } else if (action === "select-category") {
      selectedId = id;
      activeView = "category";
    } else if (action === "add-category") {
      const category = { id: newId(), title: "Новый раздел", icon: "▧", items: [] };
      data.categories.push(category);
      selectedId = category.id;
      activeView = "category";
      persistData();
    } else if (action === "delete-category") {
      if (!window.confirm("Удалить раздел и все материалы в нём?")) return;
      data.categories = data.categories.filter((category) => category.id !== id);
      selectedId = data.categories[0]?.id || null;
      activeView = "category";
      persistData();
    } else if (action === "add-block") {
      const category = getCategory();
      if (!category) return;
      const type = button.dataset.type;
      const title = ({ text: "Новый текст", link: "Новая ссылка", image: "Фотография", pdf: "Документ", button: "Новая кнопка", table: "Новая таблица", group: "Новый раздел" })[type];
      const parent = button.dataset.parentId ? findItem(button.dataset.parentId)?.item : null;
      const targetItems = parent ? parent.children : category.items;
      if (!targetItems) return;
      targetItems.push({
        id: newId(), type, title, text: "", url: "", data: "", fileName: "", displayMode: "click",
        ...(type === "group" ? { children: [] } : {}),
        ...(type === "table" ? { headers: ["№", "Название", "Описание"], rows: [[{ text: "", url: "", data: "", fileName: "" }, { text: "", url: "", data: "", fileName: "" }, { text: "", url: "", data: "", fileName: "" }]] } : {})
      });
      persistData();
    } else if (action === "add-table-row" || action === "delete-table-row" || action === "add-table-column" || action === "delete-table-column") {
      const item = findItem(id)?.item;
      if (item?.type !== "table") return;
      if (action === "add-table-row") {
        item.rows.push(item.headers.map(() => ({ text: "", url: "", data: "", fileName: "" })));
      } else if (action === "delete-table-row") {
        item.rows.splice(Number(button.dataset.row), 1);
      } else if (action === "add-table-column") {
        item.headers.push(`Столбец ${item.headers.length + 1}`);
        for (const row of item.rows) {
          row.push({ text: "", url: "", data: "", fileName: "" });
        }
      } else {
        if (item.headers.length <= 1) {
          window.alert("В таблице должен остаться хотя бы один столбец.");
          return;
        }
        const column = Number(button.dataset.column);
        item.headers.splice(column, 1);
        for (const row of item.rows) {
          row.splice(column, 1);
        }
      }
      persistData();
    } else if (action === "remove-table-attachment") {
      const item = findItem(id)?.item;
      const [rowIndex, columnIndex] = button.dataset.cell.split(",").map(Number);
      const cell = ensureTableCell(item, rowIndex, columnIndex);
      if (cell) {
        cell.data = "";
        cell.fileName = "";
        cell.url = "";
        persistData();
      }
    } else if (action === "delete-block") {
      const parentId = button.dataset.parentId;
      const target = parentId ? findItem(parentId)?.item.children : getCategory()?.items;
      if (target) {
        const index = target.findIndex((item) => item.id === id);
        if (index >= 0) target.splice(index, 1);
      }
      persistData();
    } else if (action === "move-block") {
      const parentId = button.dataset.parentId;
      const target = parentId ? findItem(parentId)?.item.children : getCategory()?.items;
      if (!target) return;
      const from = target.findIndex((item) => item.id === id);
      const to = from + Number(button.dataset.direction);
      if (from >= 0 && to >= 0 && to < target.length) {
        [target[from], target[to]] = [target[to], target[from]];
        persistData();
      }
    } else if (action === "remove-profile-photo") {
      data.profile.photo = "";
      persistData();
    } else if (action === "remove-file") {
      const item = findItem(id)?.item;
      if (item) {
        item.data = "";
        item.fileName = "";
        persistData();
      }
    }
    renderEditor();
  }

  function renderViewer() {
    if (!viewerRoot) return;
    document.title = `${data.profile.name || "Портфолио"} — портфолио`;
    const params = new URLSearchParams(window.location.search);
    const sectionId = params.get("section");
    const itemPath = params.get("path")
      ? params.get("path").split(",").filter(Boolean)
      : params.get("item") ? [params.get("item")] : [];
    if (params.get("view") === "portfolio") {
      viewerRoot.innerHTML = renderViewerPortfolio();
      return;
    }
    const category = getCategory(sectionId);
    if (sectionId && !category) {
      viewerRoot.innerHTML = `<main class="viewer-error"><div><h1>Раздел не найден</h1><p>Возможно, он был удалён из портфолио.</p><a href="./viewer.html">Вернуться на главную</a></div></main>`;
      return;
    }
    if (itemPath.length) {
      let items = category?.items;
      let item = null;
      for (const id of itemPath) {
        item = items?.find((entry) => entry.id === id) || null;
        if (!item) break;
        items = item.children;
      }
      if (!item) {
        viewerRoot.innerHTML = `<main class="viewer-error"><div><h1>Материал не найден</h1><p>Возможно, он был удалён из портфолио.</p><a href="./viewer.html${sectionId ? `?section=${encodeURIComponent(sectionId)}` : ""}">Вернуться назад</a></div></main>`;
        return;
      }
      viewerRoot.innerHTML = item.type === "group"
        ? renderViewerGroup(category, item, itemPath)
        : renderViewerItem(category, item, itemPath);
      return;
    }
    viewerRoot.innerHTML = category ? renderViewerCategory(category) : renderViewerHome();
  }

  async function refreshCloudViewer() {
    try {
      const rows = await cloudRequest("/rest/v1/portfolio?id=eq.1&select=data,updated_at");
      if (!rows?.length || rows[0].updated_at === cloudUpdatedAt || !isPortfolioData(rows[0].data)) return;
      cloudUpdatedAt = rows[0].updated_at || null;
      data = migrateDefaultResultItems(rows[0].data);
      renderViewer();
    } catch (error) {
      console.error("Не удалось обновить просмотр портфолио из облака:", error);
    }
  }

  function viewerHeader(title, backHref = "./index.html", backText = "← Портфолиоға оралу") {
    return `<header class="viewer-topbar"><a class="viewer-back" href="${backHref}">${escapeHtml(backText)}</a><h1>${escapeHtml(title)}</h1><a href="./index.html">Басты бетке</a></header>`;
  }

  function renderViewerHome() {
    const profile = data.profile;
    return `
      ${viewerHeader("Портфолио")}
      <main class="viewer-main">
        <section class="viewer-hero">
          <div class="viewer-avatar">${profile.photo ? `<img src="${escapeHtml(profile.photo)}" alt="${escapeHtml(profile.name)}" />` : escapeHtml((profile.name || "П").trim().charAt(0) || "П")}</div>
          <p class="viewer-kicker">ПОРТФОЛИО</p>
          <h2>${escapeHtml(profile.name)}</h2>
          <p class="viewer-role">${escapeHtml(profile.role)}</p>
          <div class="profile-meta">
            ${profile.workplace ? `<div class="profile-meta-row"><strong>Жұмыс орны:</strong><span>${escapeHtml(profile.workplace)}</span></div>` : ""}
            ${profile.address ? `<div class="profile-meta-row"><strong>Мекенжайы:</strong><span>${escapeHtml(profile.address)}</span></div>` : ""}
          </div>
          ${profile.quote ? `<p class="viewer-quote">${escapeHtml(profile.quote)}</p>` : ""}
          <a class="button button-primary viewer-primary" href="./viewer.html?view=portfolio">Портфолионы қарау <span aria-hidden="true">→</span></a>
        </section>
      </main>
      ${viewerFooter(profile.quote)}`;
  }

  function renderViewerPortfolio() {
    return `
      ${viewerHeader("Портфолио", "./index.html", "← Басты бетке")}
      <main class="viewer-main">
        <section class="viewer-section">
          <div class="viewer-section-head"><span class="viewer-section-icon">✧</span><h2>Портфолио бөлімдері</h2></div>
          ${data.categories.length ? `<div class="category-grid">${data.categories.map((category, index) => `
            <a class="category-card" href="./viewer.html?section=${encodeURIComponent(category.id)}">
              <span class="category-number">${String(index + 1).padStart(2, "0")}</span>
              <span class="viewer-section-icon">${escapeHtml(category.icon || "▧")}</span>
              <span class="category-card-title">${escapeHtml(category.title)}</span>
            </a>`).join("")}</div>` : `<div class="viewer-empty"><strong>Портфолио дайындалуда</strong><p>Жақында жаңа бөлімдер қосылады.</p></div>`}
        </section>
      </main>
      ${viewerFooter(data.profile.quote)}`;
  }

  function renderViewerCategory(category) {
    return renderViewerCollection(category, category.items, [], category.title, "./index.html");
  }

  function renderViewerGroup(category, group, path) {
    const parentHref = path.length > 1
      ? `./viewer.html?section=${encodeURIComponent(category.id)}&path=${encodeURIComponent(path.slice(0, -1).join(","))}`
      : `./viewer.html?section=${encodeURIComponent(category.id)}`;
    return renderViewerCollection(category, group.children || [], path, group.title, parentHref);
  }

  function renderViewerCollection(category, items, path, title, backHref) {
    const availableItems = items.filter((item) => (
      item.type === "text" || item.type === "table" || item.data || safeUrl(item.url) || item.type === "group"
    ));
    const itemCards = availableItems.map((item, index) => {
      const itemPath = [...path, item.id].join(",");
      if (item.type === "pdf" && item.displayMode === "inline") {
        return `<article class="viewer-content-card inline-pdf-card">
          <div class="block-head"><span class="block-type"><span class="block-type-icon">▤</span>${escapeHtml(item.title || item.fileName || "PDF-документ")}</span>
            <a class="viewer-link" href="./viewer.html?section=${encodeURIComponent(category.id)}&path=${encodeURIComponent(itemPath)}">Жаңа бетте ашу ↗</a>
          </div>
          <iframe class="viewer-pdf" src="${escapeHtml(item.data)}" title="${escapeHtml(item.title || "PDF құжат")}"></iframe>
        </article>`;
      }
      return `<a class="category-card material-card" href="./viewer.html?section=${encodeURIComponent(category.id)}&path=${encodeURIComponent(itemPath)}">
        <span class="category-number">${String(index + 1).padStart(2, "0")}</span>
        <span class="viewer-section-icon">${iconFor(item.type)}</span>
        <span class="category-card-title">${escapeHtml(item.title || item.fileName || "Материал")}</span>
        <span class="material-type">${item.type === "group" ? "Бөлім · ашу →" : `${escapeHtml(({ text: "Текст", link: "Ссылка", image: "Фотография", pdf: "PDF-документ", button: "Кнопка", table: "Таблица" })[item.type] || "Материал")} · ашу →`}</span>
      </a>`;
    }).join("");
    return `
      ${viewerHeader(title, backHref)}
      <main class="viewer-main">
        <section class="viewer-section">
          <div class="viewer-section-head"><span class="viewer-section-icon">${escapeHtml(category.icon || "▧")}</span><h2>${escapeHtml(title)}</h2></div>
          ${availableItems.length ? `<div class="category-grid">${itemCards}</div>` : `<div class="viewer-empty"><strong>Бұл бөлім әзірлену үстінде</strong><p>Мазмұн жақын арада қосылады.</p></div>`}
        </section>
      </main>
      ${viewerFooter(data.profile.quote)}`;
  }

  function renderViewerItem(category, item, path) {
    const parentPath = path.slice(0, -1);
    const backHref = parentPath.length
      ? `./viewer.html?section=${encodeURIComponent(category.id)}&path=${encodeURIComponent(parentPath.join(","))}`
      : `./viewer.html?section=${encodeURIComponent(category.id)}`;
    const url = safeUrl(item.url);
    let content = "";
    if (item.type === "text") {
      content = `<article class="viewer-content-card"><div class="viewer-content-body">${escapeHtml(item.text || "")}</div></article>`;
    } else if (item.type === "table") {
      content = renderViewerTable(item);
    } else if (item.type === "image" && item.data) {
      content = `<article class="viewer-content-card viewer-detail-media"><img class="viewer-image" src="${escapeHtml(item.data)}" alt="${escapeHtml(item.title || item.fileName || "Портфолио суреті")}" /></article>`;
    } else if (item.type === "pdf" && item.data) {
      content = `<article class="viewer-content-card"><iframe class="viewer-pdf" src="${escapeHtml(item.data)}" title="${escapeHtml(item.title || "PDF құжат")}"></iframe><div class="viewer-content-body"><a class="viewer-link" href="${escapeHtml(item.data)}" target="_blank" rel="noopener">Құжатты жаңа бетте ашу ↗</a></div></article>`;
    } else if (item.type === "link" && url) {
      content = `<article class="viewer-content-card"><div class="viewer-content-body"><p>${escapeHtml(item.text || item.title || url)}</p><a class="button button-primary" href="${escapeHtml(url)}" target="_blank" rel="noopener">Сілтемені ашу ↗</a></div></article>`;
    } else if (item.type === "button" && url) {
      content = `<article class="viewer-content-card"><div class="viewer-content-body"><a class="button button-primary" href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(item.text || item.title || "Открыть")} ↗</a></div></article>`;
    }
    if (!content) content = `<div class="viewer-empty"><strong>Материал әзірлену үстінде</strong><p>Мазмұн жақын арада қосылады.</p></div>`;
    return `
      ${viewerHeader(item.title || item.fileName || "Материал", backHref, `← ${category.title}`)}
      <main class="viewer-main">
        <section class="viewer-section">
          <div class="viewer-section-head"><span class="viewer-section-icon">${iconFor(item.type)}</span><h2>${escapeHtml(item.title || item.fileName || "Материал")}</h2></div>
          ${content}
        </section>
      </main>
      ${viewerFooter(data.profile.quote)}`;
  }

  function renderViewerTable(item) {
    const headers = Array.isArray(item.headers) ? item.headers : [];
    const rows = Array.isArray(item.rows) ? item.rows : [];
    if (!headers.length) return `<div class="viewer-empty"><strong>Таблица әзірлену үстінде</strong><p>Кестеге бағандар қосыңыз.</p></div>`;
    return `<div class="viewer-table-scroll"><table class="viewer-table"><thead><tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join("")}</tr></thead>
      <tbody>${rows.map((row) => `<tr>${headers.map((_, index) => {
        const cell = row[index] && typeof row[index] === "object"
          ? row[index]
          : { text: String(row[index] || ""), url: "", data: "" };
        const href = cell.data || safeUrl(cell.url);
        const text = escapeHtml(cell.text || "");
        return `<td>${href && text ? `<a class="viewer-table-link" href="${escapeHtml(href)}" target="_blank" rel="noopener">${text} ↗</a>` : text}</td>`;
      }).join("")}</tr>`).join("")}</tbody></table></div>`;
  }

  function viewerFooter(quote) {
    return `<footer class="viewer-footer">${escapeHtml(quote || "Педагог портфолиосы")}</footer>`;
  }

  function renderStartupError(error) {
    console.error("Не удалось загрузить портфолио:", error);
    const root = editorRoot || viewerRoot;
    if (!root) return;
    root.innerHTML = `<main class="viewer-error"><div><h1>Не удалось загрузить портфолио</h1><p>${escapeHtml(error.message || "Проверьте настройки Supabase и подключение к интернету.")}</p><button class="button button-outline" type="button" onclick="location.reload()">Попробовать снова</button></div></main>`;
  }

  loadData().then((storedData) => {
    data = storedData;
    selectedId = data.categories[0]?.id || null;
    if (editorRoot) renderEditor();
    if (viewerRoot) {
      renderViewer();
      if (cloudEnabled) window.setInterval(refreshCloudViewer, 15000);
    }
  }).catch(renderStartupError);
})();

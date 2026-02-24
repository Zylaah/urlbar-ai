/**
 * URL Bar LLM Integration for Zen Browser
 * 
 * Usage:
 * 1. Type "/provider" (e.g., "/mistral", "/openai", "/gemini", "/ollama")
 * 2. Press Tab to activate LLM mode
 * 3. Type your message
 * 4. Press Enter to send and stream response
 * 
 * Installation:
 * - Requires fx-autoconfig: https://github.com/MrOtherGuy/fx-autoconfig
 * - Place this file in your fx-autoconfig js/ directory
 * - Import in your import.uc.mjs: import "./urlbar-llm.uc.js";
 */

(function() {
  "use strict";

  // Timing and size limits (centralized constants)
  /** System instruction so the LLM responds in the same language as the user's message */
  const LANGUAGE_SYSTEM_INSTRUCTION = "Always respond in the same language the user used for their message. If the user writes in French, respond in French; if in Spanish, in Spanish; and so on.";

  const LIMITS = {
    CACHE_TTL: 30 * 60 * 1000,       // 30 minutes
    MAX_CACHE_SIZE: 50,               // Max cached search results
    BLUR_DELAY: 300,                  // ms before blur deactivates LLM mode
    FOCUS_RESTORE_DELAY: 100,         // ms before restoring focus after link click
    DDG_TIMEOUT: 8000,                // DuckDuckGo request timeout (ms)
    OLLAMA_WEBSEARCH_TIMEOUT: 10000,  // Ollama web search API timeout (ms)
    OLLAMA_WEBFETCH_TIMEOUT: 8000,    // Ollama web fetch API timeout (ms)
    PAGE_FETCH_TIMEOUT: 3500,         // Individual page content fetch timeout (ms)
    ALL_PAGES_FETCH_TIMEOUT: 4000,    // Total timeout for all page fetches (ms)
    MAX_PAGE_CONTENT_LENGTH: 3000,    // Max chars extracted per page
    MAX_SIMPLE_CONTENT_LENGTH: 2500,  // Max chars for simple fallback extraction
    MAX_SEARCH_RESULTS: 5,            // Default search result limit
    MAX_FETCH_RESULTS: 3,             // Pages to fetch content from
    RENDER_DEBOUNCE: 50,              // ms debounce for markdown rendering during stream
    ANIMATION_GLOW_DURATION: 1000,    // ms for pill glow animation
    SCROLL_DELAY: 50,                 // ms delay before scrolling to pills
    SCROLL_DELAY_MESSAGE: 10,         // ms delay before scrolling after user message
    RETRY_MAX_ATTEMPTS: 3,            // Max retries for API calls
    RETRY_BASE_DELAY_MS: 1000,        // Base delay for exponential backoff (ms)
    RETRY_MAX_DELAY_MS: 10000,        // Cap on backoff delay (ms)
  };

  // Ollama Web Search/Fetch API endpoints
  const OLLAMA_WEB_SEARCH_URL = "https://ollama.com/api/web_search";
  const OLLAMA_WEB_FETCH_URL = "https://ollama.com/api/web_fetch";

  // Configuration
  const CONFIG = {
    providers: {
      mistral: {
        name: "Mistral",
        apiKey: "", // Set via about:config or prompt
        baseUrl: "https://api.mistral.ai/v1/chat/completions",
        model: "mistral-medium-latest"
      },
      openai: {
        name: "OpenAI",
        apiKey: "",
        baseUrl: "https://api.openai.com/v1/chat/completions",
        model: "gpt-4"
      },
      ollama: {
        name: "Ollama",
        apiKey: null, // Not needed for local LLM
        baseUrl: "http://localhost:11434/api/chat",
        model: "mistral"
      },
      gemini: {
        name: "Gemini",
        apiKey: "",
        baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
        model: "gemini-2.5-flash"
      }
    },
    ollamaWebSearch: {
      apiKey: "" // Ollama API key for web search (https://ollama.com/settings/keys)
    },
    defaultProvider: "ollama"
  };

  // State
  let isLLMMode = false;
  let currentProvider = null;
  let currentQuery = "";
  let streamingResultRow = null;
  let abortController = null;
  let originalPlaceholder = "";
  let isClickingLink = false; // Track if we're currently clicking a link
  let isSelectingInContainer = false; // Track if user is selecting text in the container
  
  // Suppress/restore the native urlbar blur handler.
  // This follows the same pattern Firefox uses in UrlbarController.focusOnUnifiedSearchButton()
  // to prevent the panel from closing when focus temporarily leaves the input.
  function suppressNativeBlur() {
    if (window.gURLBar && window.gURLBar.inputField) {
      window.gURLBar.inputField.removeEventListener("blur", window.gURLBar);
    }
  }
  function restoreNativeBlur() {
    if (window.gURLBar && window.gURLBar.inputField) {
      window.gURLBar.inputField.addEventListener("blur", window.gURLBar);
    }
  }
  let conversationHistory = []; // Store conversation messages for follow-ups
  let conversationContainer = null; // Container for all messages
  let currentAssistantMessage = ""; // Track current streaming response
  let currentSearchSources = []; // Track sources used for current response

  // Global conversation history (urlbar is shared; one list, persisted in profile)
  const HISTORY_FILE_NAME = "urlbar-llm-history.json";
  const HISTORY_MAX_SESSIONS_PER_PROVIDER = 20;
  const HISTORY_MAX_MESSAGES_PER_SESSION = 50;
  const HISTORY_MAX_TITLE_LENGTH = 120;
  /** Per-message safety cap (no truncation below this); allows full conversation restore */
  const HISTORY_MAX_CONTENT_LENGTH = 500000;

  // Runtime navigation state for history browsing (Alt+ArrowUp)
  let historyIndex = -1; // -1 = live conversation, >= 0 = index in stored sessions
  let lastHistoryProviderKey = null;

  // When loading a conversation from history, we keep its session id so on deactivate we update that session instead of creating a new one
  let currentSessionId = null;

  // Get preferences - Direct access to preference service using Components
  const prefsService = Components.classes["@mozilla.org/preferences-service;1"]
    .getService(Components.interfaces.nsIPrefBranch);
  
  const scriptSecurityManager = Components.classes["@mozilla.org/scriptsecuritymanager;1"]
    .getService(Components.interfaces.nsIScriptSecurityManager);
  
  const scriptLoader = Components.classes["@mozilla.org/moz/jssubscript-loader;1"]
    .getService(Components.interfaces.mozIJSSubScriptLoader);

  // Create a minimal Services-like object
  const Services = {
    prefs: prefsService,
    scriptSecurityManager: scriptSecurityManager,
    scriptloader: scriptLoader
  };

  // Retryable HTTP statuses (transient server/rate-limit errors)
  const RETRYABLE_STATUSES = [429, 500, 502, 503, 504];

  /**
   * Fetch with retry and exponential backoff.
   * Retries on network errors and transient HTTP statuses (429, 5xx).
   * Does not retry on AbortError or client errors (4xx except 429).
   */
  async function fetchWithRetry(url, options = {}, signal = null) {
    const maxAttempts = LIMITS.RETRY_MAX_ATTEMPTS;
    const baseDelay = LIMITS.RETRY_BASE_DELAY_MS;
    const maxDelay = LIMITS.RETRY_MAX_DELAY_MS;
    let lastError = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const response = await fetch(url, { ...options, signal });
        if (response.ok) return response;

        if (RETRYABLE_STATUSES.includes(response.status) && attempt < maxAttempts - 1) {
          await response.text().catch(() => ""); // Drain body to release connection
          const delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
          log(`API error ${response.status}, retrying in ${delay}ms (attempt ${attempt + 1}/${maxAttempts})`);
          await sleepWithAbort(delay, signal);
          continue;
        }

        const errorText = await response.text().catch(() => "");
        lastError = new Error(`API error: ${response.status} ${response.statusText}${errorText ? " — " + errorText.slice(0, 200) : ""}`);
        throw lastError;
      } catch (err) {
        if (err.name === "AbortError") throw err;

        const isRetryable =
          err.name === "TypeError" ||
          (err.message && /network|fetch|failed|timeout|connection|refused/i.test(err.message));

        if (isRetryable && attempt < maxAttempts - 1) {
          const delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
          log(`Request failed (${err.message}), retrying in ${delay}ms (attempt ${attempt + 1}/${maxAttempts})`);
          await sleepWithAbort(delay, signal);
          lastError = err;
          continue;
        }
        throw err;
      }
    }
    throw lastError || new Error("Request failed after retries");
  }

  function sleepWithAbort(ms, signal) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(resolve, ms);
      if (signal) {
        const onAbort = () => {
          clearTimeout(t);
          reject(new DOMException("Aborted", "AbortError"));
        };
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  }

  // ============================================
  // Global conversation history (IndexedDB)
  // ============================================
  const HISTORY_DB_NAME = "urlbar-llm-history";
  const HISTORY_DB_VERSION = 1;
  const HISTORY_STORE_NAME = "sessions";

  function openHistoryDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(HISTORY_DB_NAME, HISTORY_DB_VERSION);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve(req.result);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(HISTORY_STORE_NAME)) {
          const store = db.createObjectStore(HISTORY_STORE_NAME, { keyPath: "id" });
          store.createIndex("providerKey", "providerKey", { unique: false });
          store.createIndex("providerUpdated", ["providerKey", "updatedAt"], { unique: false });
        }
      };
    });
  }

  /** Get all sessions for a provider, newest first */
  function getProviderSessions(providerKey) {
    return new Promise((resolve, reject) => {
      if (!providerKey) {
        resolve([]);
        return;
      }
      openHistoryDB().then((db) => {
        const tx = db.transaction(HISTORY_STORE_NAME, "readonly");
        const store = tx.objectStore(HISTORY_STORE_NAME);
        const index = store.index("providerKey");
        const req = index.getAll(IDBKeyRange.only(providerKey));
        req.onsuccess = () => {
          const sessions = (req.result || []).filter((s) => s && s.providerKey === providerKey);
          sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
          db.close();
          log("Loaded LLM history from IndexedDB");
          resolve(sessions);
        };
        req.onerror = () => {
          db.close();
          reject(req.error);
        };
      }).catch(reject);
    });
  }

  /** Save or update a session; prunes per-provider excess */
  function putSession(session) {
    if (!session || !session.providerKey) return Promise.resolve();
    return openHistoryDB().then((db) => {
      return new Promise((resolve, reject) => {
        const tx = db.transaction(HISTORY_STORE_NAME, "readwrite");
        const store = tx.objectStore(HISTORY_STORE_NAME);
        const getReq = store.get(session.id);
        getReq.onsuccess = () => {
          const existing = getReq.result;
          const toSave = {
            id: session.id,
            providerKey: session.providerKey,
            createdAt: existing?.createdAt || session.createdAt || session.updatedAt || Date.now(),
            updatedAt: session.updatedAt || Date.now(),
            title: session.title,
            messages: session.messages
          };
          store.put(toSave);
          tx.oncomplete = () => {
            db.close();
            pruneSessionsForProvider(session.providerKey).then(resolve).catch(reject);
          };
        };
        getReq.onerror = () => {
          db.close();
          reject(getReq.error);
        };
        tx.onerror = () => {
          db.close();
          reject(tx.error);
        };
      });
    }).then(() => {
      log("Saved LLM session to IndexedDB:", session.id);
    }).catch((e) => {
      logWarn("Error saving LLM history:", e);
    });
  }

  function pruneSessionsForProvider(providerKey) {
    return openHistoryDB().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(HISTORY_STORE_NAME, "readwrite");
      const store = tx.objectStore(HISTORY_STORE_NAME);
      const index = store.index("providerKey");
      const req = index.getAll(IDBKeyRange.only(providerKey));
      req.onsuccess = () => {
        const sessions = (req.result || []).filter((s) => s && s.providerKey === providerKey);
        sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
        if (sessions.length > HISTORY_MAX_SESSIONS_PER_PROVIDER) {
          const toRemove = sessions.slice(HISTORY_MAX_SESSIONS_PER_PROVIDER);
          toRemove.forEach((s) => store.delete(s.id));
        }
      };
      req.onerror = () => { db.close(); reject(req.error); };
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    }));
  }

  /** Delete a session by id */
  function deleteSessionById(id) {
    return openHistoryDB().then((db) => {
      return new Promise((resolve, reject) => {
        const tx = db.transaction(HISTORY_STORE_NAME, "readwrite");
        const store = tx.objectStore(HISTORY_STORE_NAME);
        store.delete(id);
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => { db.close(); reject(tx.error); };
      });
    });
  }

  /** One-time migration from JSON file if it exists */
  function migrateFromFileIfNeeded() {
    try {
      const dirSvc = Components.classes["@mozilla.org/file/directory_service;1"]
        .getService(Components.interfaces.nsIProperties);
      const profD = dirSvc.get("ProfD", Components.interfaces.nsIFile);
      const file = profD.clone();
      file.append(HISTORY_FILE_NAME);
      if (!file.exists()) return Promise.resolve();
      const converter = Components.classes["@mozilla.org/intl/converter-input-stream;1"]
        .createInstance(Components.interfaces.nsIConverterInputStream);
      const fileStream = Components.classes["@mozilla.org/network/file-input-stream;1"]
        .createInstance(Components.interfaces.nsIFileInputStream);
      fileStream.init(file, 0x01, 0, 0);
      converter.init(fileStream, "UTF-8", 8192, Components.interfaces.nsIConverterInputStream.DEFAULT_REPLACEMENT_CHARACTER);
      const parts = [];
      const out = {};
      let n;
      while ((n = converter.readString(8192, out)) > 0) parts.push(String(out.value));
      converter.close();
      fileStream.close();
      const data = JSON.parse(parts.join(""));
      const sessions = Array.isArray(data?.sessions) ? data.sessions : [];
      if (!sessions.length) {
        file.remove(false);
        return Promise.resolve();
      }
      return openHistoryDB().then((db) => {
        return new Promise((resolve, reject) => {
          const tx = db.transaction(HISTORY_STORE_NAME, "readwrite");
          const store = tx.objectStore(HISTORY_STORE_NAME);
          sessions.forEach((s) => { if (s && s.id && s.providerKey) store.put(s); });
          tx.oncomplete = () => {
            db.close();
            try { file.remove(false); } catch (e) {}
            log("Migrated", sessions.length, "sessions from file to IndexedDB");
            resolve();
          };
          tx.onerror = () => { db.close(); reject(tx.error); };
        });
      });
    } catch (e) {
      return Promise.resolve();
    }
  }

  function getCurrentTab() {
    try {
      const topWin = window.top || window;
      const browser = topWin.gBrowser || topWin.getBrowser?.();
      return browser?.selectedTab || null;
    } catch (e) {
      return null;
    }
  }

  /** Safety cap only (500k); normal messages are stored in full for complete conversation restore */
  function truncateContent(content) {
    if (!content || typeof content !== "string") {
      return "";
    }
    if (content.length > HISTORY_MAX_CONTENT_LENGTH) {
      return content.slice(0, HISTORY_MAX_CONTENT_LENGTH) + "...";
    }
    return content;
  }

  function buildSessionFromConversation(urlbar) {
    if (!conversationHistory || conversationHistory.length === 0) {
      log("Skipped building history session: empty conversationHistory");
      return null;
    }

    const providerKey = urlbar.getAttribute("llm-provider") || (currentProvider && Object.entries(CONFIG.providers).find(([key, p]) => p === currentProvider)?.[0]);
    if (!providerKey) {
      log("Skipped building history session: missing providerKey");
      return null;
    }

    // Find first non-empty user message for title
    let title = "";
    for (const msg of conversationHistory) {
      if (msg && msg.role === "user" && msg.content && msg.content.trim()) {
        title = msg.content.trim();
        break;
      }
    }
    if (!title) {
      log("Skipped building history session: no non-empty user message found");
      return null;
    }
    if (title.length > HISTORY_MAX_TITLE_LENGTH) {
      title = title.slice(0, HISTORY_MAX_TITLE_LENGTH) + "...";
    }

    // Trim to last N messages; keep full content and sources for assistant messages (no truncation for normal length)
    const msgs = conversationHistory
      .slice(-HISTORY_MAX_MESSAGES_PER_SESSION)
      .map((m) => {
        const out = { role: m.role, content: truncateContent(m.content) }; // truncateContent only caps at 500k as safety
        if (m.role === "assistant" && m.sources && m.sources.length > 0) {
          out.sources = m.sources.map((s) => ({
            title: s.title,
            url: s.url,
            source: s.source,
            index: s.index
          }));
        }
        return out;
      });

    if (!msgs.length) {
      return null;
    }

    const now = Date.now();
    const id = currentSessionId || `${now}-${Math.random().toString(36).slice(2, 8)}`;
    return {
      id,
      providerKey,
      createdAt: currentSessionId ? undefined : now,
      updatedAt: now,
      title,
      messages: msgs
    };
  }

  function maybeSaveConversationToHistory(urlbar) {
    const session = buildSessionFromConversation(urlbar);
    if (!session) {
      log("History not saved: no session built from conversation");
      return;
    }
    putSession(session);
    // So the next save (e.g. on deactivate) updates this session instead of adding a duplicate
    currentSessionId = session.id;
  }

  function renderUserMessageFromHistory(message) {
    if (!conversationContainer || !conversationContainer.parentNode) {
      conversationContainer = createConversationContainer();
      if (!conversationContainer) {
        return;
      }
    }
    const messageDiv = document.createElement("div");
    messageDiv.className = "llm-message llm-message-user";
    messageDiv.textContent = message;
    conversationContainer.appendChild(messageDiv);
  }

  function renderAssistantMessageFromHistory(message, sources) {
    if (!conversationContainer || !conversationContainer.parentNode) {
      conversationContainer = createConversationContainer();
      if (!conversationContainer) {
        return;
      }
    }

    const messageDiv = document.createElement("div");
    messageDiv.className = "llm-message llm-message-assistant";

    const contentDiv = document.createElement("div");
    contentDiv.className = "llm-message-content";

    renderMarkdownToElement(message, contentDiv);

    messageDiv.appendChild(contentDiv);
    if (sources && sources.length > 0) {
      injectFaviconsIntoCitationMarkers(messageDiv, sources);
    }
    conversationContainer.appendChild(messageDiv);
  }

  function loadSessionIntoCurrentConversation(session, urlbar, urlbarInput) {
    if (!session || !Array.isArray(session.messages)) {
      return;
    }

    // Abort any in-flight request and clear streaming row
    if (abortController) {
      try {
        abortController.abort();
      } catch (e) {}
      abortController = null;
    }
    if (streamingResultRow) {
      streamingResultRow.remove();
      streamingResultRow = null;
    }

    // Reset conversation container
    if (conversationContainer && conversationContainer.parentNode) {
      conversationContainer.remove();
    }
    conversationContainer = createConversationContainer();
    if (!conversationContainer) {
      return;
    }

    // Track this session so on deactivate we update it instead of creating a new one
    currentSessionId = session.id || null;

    // Replace in-memory history (keep sources for assistant messages)
    conversationHistory = session.messages.map((m) => {
      const out = { role: m.role, content: m.content };
      if (m.role === "assistant" && m.sources && m.sources.length > 0) {
        out.sources = m.sources;
      }
      return out;
    });

    // Render messages
    for (const msg of conversationHistory) {
      if (!msg || !msg.content) {
        continue;
      }
      if (msg.role === "user") {
        renderUserMessageFromHistory(msg.content);
      } else if (msg.role === "assistant") {
        renderAssistantMessageFromHistory(msg.content, msg.sources);
      }
    }

    // Ensure LLM mode visuals are active
    urlbar.setAttribute("llm-mode-active", "true");
    urlbar.setAttribute("llm-provider", session.providerKey);
    urlbarInput.setAttribute("placeholder", "Ask a follow-up...");
    urlbarInput.focus();
  }

  function isShowingHistoryList() {
    return !!(conversationContainer && conversationContainer.querySelector(".llm-history-list"));
  }

  function dismissHistoryList(urlbar, urlbarInput) {
    if (!isShowingHistoryList()) {
      return;
    }
    if (conversationContainer && conversationContainer.parentNode) {
      conversationContainer.remove();
    }
    conversationContainer = null;
    conversationHistory = [];
    currentSessionId = null; /* Next question starts a new session */
    urlbarInput.setAttribute("placeholder", "Ask anything...");
    const urlbarViewBodyInner = document.querySelector(".urlbarView-body-inner");
    if (urlbarViewBodyInner) {
      urlbarViewBodyInner.style.display = "none";
    }
    urlbarInput.focus();
    log("Dismissed history list, back to LLM mode");
  }

  async function showHistoryListForProvider(providerKey, urlbar, urlbarInput) {
    const sessions = await getProviderSessions(providerKey);
    if (!sessions.length) {
      log("No stored LLM history sessions to show for provider:", providerKey);
      return;
    }

    // Ensure we have a container
    if (conversationContainer && conversationContainer.parentNode) {
      conversationContainer.remove();
    }
    conversationContainer = createConversationContainer();
    if (!conversationContainer) {
      return;
    }

    // History list root
    const listRoot = document.createElement("div");
    listRoot.className = "llm-history-list";

    sessions.forEach((session, index) => {
      const item = document.createElement("div");
      item.className = "llm-history-list-item";
      item.setAttribute("data-session-index", String(index));

      /* Zen urlbar row structure: row > row-inner > no-wrap > [favicon, content] */
      const rowInner = document.createElement("div");
      rowInner.className = "llm-history-list-row-inner";

      const noWrap = document.createElement("div");
      noWrap.className = "llm-history-list-no-wrap";

      const faviconBox = document.createElement("span");
      faviconBox.className = "llm-history-favicon";
      const faviconImg = document.createElement("img");
      faviconImg.src = "chrome://browser/skin/zen-icons/history.svg";
      faviconImg.alt = "";
      faviconImg.setAttribute("aria-hidden", "true");
      faviconBox.appendChild(faviconImg);
      noWrap.appendChild(faviconBox);

      const metaRow = document.createElement("div");
      metaRow.className = "llm-history-list-meta";

      const title = document.createElement("span");
      title.className = "llm-history-list-title";
      title.textContent = session.title || "(untitled conversation)";
      metaRow.appendChild(title);

      if (session.updatedAt || session.createdAt) {
        const subtitle = document.createElement("span");
        subtitle.className = "llm-history-list-subtitle";
        const ts = session.updatedAt || session.createdAt;
        try {
          subtitle.textContent = new Date(ts).toLocaleString();
        } catch (e) {
          subtitle.textContent = "";
        }
        metaRow.appendChild(subtitle);
      }

      noWrap.appendChild(metaRow);
      rowInner.appendChild(noWrap);

      const actions = document.createElement("div");
      actions.className = "llm-history-list-actions";

      const deleteButton = document.createElement("button");
      deleteButton.className = "llm-history-button llm-history-delete-button";
      deleteButton.textContent = "Delete";

      actions.appendChild(deleteButton);
      rowInner.appendChild(actions);
      item.appendChild(rowInner);

      deleteButton.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const idxAttr = item.getAttribute("data-session-index");
        const idx = idxAttr ? parseInt(idxAttr, 10) : NaN;
        if (!Number.isFinite(idx) || idx < 0 || idx >= sessions.length) {
          return;
        }

        const targetId = sessions[idx].id;
        try {
          await deleteSessionById(targetId);
        } catch (err) {
          logWarn("Failed to delete session:", err);
          return;
        }

        // Remove from current in-memory list UI
        item.remove();
        sessions.splice(idx, 1);

        // Reindex remaining items' data-session-index attributes
        const remainingItems = listRoot.querySelectorAll(".llm-history-list-item");
        remainingItems.forEach((el, newIndex) => {
          el.setAttribute("data-session-index", String(newIndex));
        });

        log("Deleted history session from provider:", providerKey, "session id:", targetId);

        // If no sessions left, return to clean LLM mode (no history list)
        if (!sessions.length) {
          if (conversationContainer && conversationContainer.parentNode) {
            conversationContainer.remove();
          }
          conversationContainer = null;
          conversationHistory = [];
          urlbarInput.setAttribute("placeholder", "Ask anything...");
          // Hide results area like on first activation with no conversation
          const urlbarViewBodyInner = document.querySelector(".urlbarView-body-inner");
          if (urlbarViewBodyInner) {
            urlbarViewBodyInner.style.display = "none";
          }
        }
      });

      /* Click on row (not Delete) opens conversation – matches Zen suggestion behavior */
      item.addEventListener("click", (e) => {
        if (e.target.closest(".llm-history-delete-button")) return;
        const idxAttr = item.getAttribute("data-session-index");
        const idx = idxAttr ? parseInt(idxAttr, 10) : NaN;
        if (Number.isFinite(idx) && idx >= 0 && idx < sessions.length) {
          historyIndex = idx;
          lastHistoryProviderKey = providerKey;
          loadSessionIntoCurrentConversation(sessions[idx], urlbar, urlbarInput);
        }
      });

      listRoot.appendChild(item);
    });

    conversationContainer.appendChild(listRoot);

    // Ensure LLM mode visuals and focus
    urlbar.setAttribute("llm-mode-active", "true");
    urlbar.setAttribute("llm-provider", providerKey);
    urlbarInput.setAttribute("placeholder", "Select a conversation or ask a new question...");
    urlbarInput.focus();
  }

  // ============================================
  // Load Mozilla Readability for content extraction
  // ============================================
  let ReadabilityClass = null;
  
  // Try to load Readability.js from the same directory as this script
  try {
    // Derive the directory from this script's own path
    const currentScriptPath = Components.stack.filename;
    const scriptDir = currentScriptPath.substring(0, currentScriptPath.lastIndexOf('/') + 1);
    const readabilityPath = scriptDir + "Readability.js";
    const scope = {};
    Services.scriptloader.loadSubScript(readabilityPath, scope);
    ReadabilityClass = scope.Readability;
    log("Loaded Mozilla Readability from", readabilityPath);
  } catch (e) {
    logWarn("Could not load Readability.js:", e.message);
    // Readability will be null, fallback extraction will be used
  }
  
  function getPref(name, defaultValue) {
    try {
      if (!Services || !Services.prefs) {
        return defaultValue;
      }
      const type = Services.prefs.getPrefType(name);
      if (type === Services.prefs.PREF_STRING) {
        return Services.prefs.getStringPref(name, defaultValue);
      } else if (type === Services.prefs.PREF_BOOL) {
        return Services.prefs.getBoolPref(name, defaultValue);
      } else if (type === Services.prefs.PREF_INT) {
        return Services.prefs.getIntPref(name, defaultValue);
      }
    } catch (e) {
      // Pref doesn't exist, return default
    }
    return defaultValue;
  }

  function setPref(name, value) {
    try {
      if (!Services || !Services.prefs) {
        return;
      }
      if (typeof value === "string") {
        Services.prefs.setStringPref(name, value);
      } else if (typeof value === "boolean") {
        Services.prefs.setBoolPref(name, value);
      } else if (typeof value === "number") {
        Services.prefs.setIntPref(name, value);
      }
    } catch (e) {
      logError("Failed to set preference:", e);
    }
  }

  // Debug logging (enable via about:config: extension.urlbar-llm.debug = true)
  function log(...args) {
    if (getPref("extension.urlbar-llm.debug", false)) {
      console.log("[URLBar LLM]", ...args);
    }
  }

  function logWarn(...args) {
    console.warn("[URLBar LLM]", ...args);
  }

  function logError(...args) {
    console.error("[URLBar LLM]", ...args);
  }

  // Check if LLM is enabled
  function isEnabled() {
    return getPref("extension.urlbar-llm.enabled", true);
  }

  // Check if web search is enabled
  function isWebSearchEnabled() {
    return getPref("extension.urlbar-llm.web-search-enabled", true);
  }

  /**
   * LLM-based web search classification
   * Asks the model itself whether the question is within its knowledge scope.
   * If not, triggers a web search. This replaces pure heuristic detection.
   */
  async function queryNeedsWebSearchLLM(query, isFollowUp = false, signal = null) {
    // Never search on follow-ups (the model already has context)
    if (isFollowUp) {
      log('No search: follow-up message');
      return false;
    }

    // Ask the LLM to classify the query
    log('Asking model to classify query for web search need:', query);

    const classificationPrompt = [
      {
        role: "system",
        content: `You are a classifier. The user will give you a question or request. You must decide whether you can answer it confidently and accurately from your own training knowledge, or whether it requires up-to-date or real-time information from the web (e.g. current events, live prices, recent news, very specific/niche facts you're unsure about, information after your knowledge cutoff).

Reply with ONLY one word:
- "SEARCH" if you need web search to answer accurately
- "ANSWER" if you can answer confidently from your own knowledge

Do NOT explain. Just reply with one word.`
      },
      {
        role: "user",
        content: query
      }
    ];

    try {
      let responseText = "";

      if (currentProvider.name === "Ollama") {
        // Ollama native API (non-streaming)
        const response = await fetchWithRetry(currentProvider.baseUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: currentProvider.model,
            messages: classificationPrompt,
            stream: false
          })
        }, signal);
        const json = await response.json();
        responseText = (json.message?.content || "").trim().toUpperCase();
      } else {
        // OpenAI-compatible API (non-streaming)
        const base = currentProvider.baseUrl.replace(/\/+$/, "");
        let url = base.endsWith('/chat/completions')
          ? base
          : base + "/chat/completions";
        const isGemini = currentProvider.name === "Gemini";
        if (isGemini && currentProvider.apiKey) {
          url += (url.includes("?") ? "&" : "?") + "key=" + encodeURIComponent(currentProvider.apiKey);
        }
        const headers = { "Content-Type": "application/json", "Authorization": `Bearer ${currentProvider.apiKey}` };
        const response = await fetchWithRetry(url, {
          method: "POST",
          headers,
          body: JSON.stringify({
            model: currentProvider.model,
            messages: classificationPrompt,
            stream: false,
            max_tokens: 5,
            temperature: 0
          })
        }, signal);
        const json = await response.json();
        responseText = (json.choices?.[0]?.message?.content || "").trim().toUpperCase();
      }

      log('Model classification response:', responseText);

      // The model replied SEARCH or ANSWER
      const needsSearch = responseText.includes("SEARCH");
      log('Model decided:', needsSearch ? 'needs web search' : 'can answer from knowledge');
      return needsSearch;

    } catch (err) {
      // If classification fails (timeout, network error, etc.), fall back to no search
      // so the model still answers from its own knowledge
      logWarn('Classification request failed, defaulting to no search:', err.message);
      return false;
    }
  }

  // Load API keys and config from preferences
  function loadConfig() {
    // Check if enabled
    if (!isEnabled()) {
      return;
    }

    for (const [key, provider] of Object.entries(CONFIG.providers)) {
      // Load API keys
      if (key !== "ollama") {
        const prefKey = `extension.urlbar-llm.${key}-api-key`;
        provider.apiKey = getPref(prefKey, "");
      }
      
      // Load models
      const modelPref = `extension.urlbar-llm.${key}-model`;
      provider.model = getPref(modelPref, provider.model);
    }

    // Load Ollama base URL
    CONFIG.providers.ollama.baseUrl = getPref(
      "extension.urlbar-llm.ollama-base-url",
      "http://localhost:11434/api/chat"
    );

    // Load Ollama web search API key
    CONFIG.ollamaWebSearch.apiKey = getPref(
      "extension.urlbar-llm.ollama-web-search-api-key",
      ""
    );
  }

  // Initialize when browser window loads
  function init() {
    // Check if enabled
    if (!isEnabled()) {
      return;
    }

    loadConfig();

    // Migrate from JSON file to IndexedDB on first run
    migrateFromFileIfNeeded().catch(() => {});

    // Wait for browser window
    if (window.location.href !== "chrome://browser/content/browser.xhtml") {
      return;
    }

    const urlbar = document.getElementById("urlbar");
    if (!urlbar) {
      // Wait a bit for urlbar to be ready
      setTimeout(init, 100);
      return;
    }

    const urlbarInput = urlbar.querySelector("#urlbar-input");
    if (!urlbarInput) {
      setTimeout(init, 100);
      return;
    }

    setupEventListeners(urlbar, urlbarInput);
    log("Initialized");
  }

  function setupEventListeners(urlbar, urlbarInput) {
    // Check if already initialized to prevent duplicate listeners
    if (urlbar._llmInitialized) {
      log("Already initialized, skipping duplicate setup");
      return;
    }
    urlbar._llmInitialized = true;
    
    let inputValue = "";
    let lastInputTime = Date.now();

    // Listen for input changes
    // When the user focuses back on the input, restore the native blur listener
    // and clear the selection flag so things go back to normal
    urlbarInput.addEventListener("focus", () => {
      if (isSelectingInContainer) {
        isSelectingInContainer = false;
        // Restore native blur handler (was suppressed during text selection)
        if (window.gURLBar && window.gURLBar.inputField) {
          window.gURLBar.inputField.addEventListener("blur", window.gURLBar);
        }
        log("Selection ended - native blur restored, urlbar input refocused");
      }
    });

    urlbarInput.addEventListener("input", (e) => {
      inputValue = e.target.value;
      lastInputTime = Date.now();
      // User is typing — clear selection state and restore native blur
      if (isSelectingInContainer) {
        isSelectingInContainer = false;
        restoreNativeBlur();
      }
      
      if (isLLMMode) {
        // Update query while in LLM mode
        currentQuery = inputValue;
        // Prevent native urlbar from processing results
        e.stopPropagation();
      } else {
        // Check for "/provider" pattern
        const match = inputValue.match(/^\/(\w+)(\s|$)/);
        if (match) {
          const providerKey = match[1].toLowerCase();
          if (CONFIG.providers[providerKey]) {
            // Show hint that Tab activates
            showActivationHint(urlbar, providerKey);
          } else {
            urlbar.removeAttribute("llm-hint");
          }
        } else {
          urlbar.removeAttribute("llm-hint");
        }
      }
    }, true);

    // Intercept paste events in LLM mode to prevent native urlbar from
    // starting a new search query (which would destroy the conversation)
    urlbarInput.addEventListener("paste", (e) => {
      if (isLLMMode) {
        e.stopPropagation();
        log("Paste event captured in LLM mode");
      }
    }, true);

    // Listen for Tab key to activate
    urlbarInput.addEventListener("keydown", (e) => {
      if (e.key === "Tab" && !isLLMMode) {
        const match = inputValue.match(/^\/(\w+)(\s|$)/);
        if (match) {
          e.preventDefault();
          e.stopPropagation();
          
          const providerKey = match[1].toLowerCase();
          if (CONFIG.providers[providerKey]) {
            activateLLMMode(urlbar, urlbarInput, providerKey);
          }
        }
      } else if (e.key === "Enter" && isLLMMode && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        
        // Send query to LLM (follow-up or new)
        const query = currentQuery;
        if (query.trim()) {
          // If history list is visible, we're starting a new conversation (not opening one); clear list and session id
          const wasShowingHistoryList = isShowingHistoryList();
          if (wasShowingHistoryList) {
            conversationContainer.innerHTML = "";
            currentSessionId = null;
          }

          // Add user message to conversation
          conversationHistory.push({
            role: "user",
            content: query
          });
          
          // Clear the input immediately after sending
          currentQuery = "";
          urlbarInput.value = "";
          
          // Update placeholder for follow-ups
          urlbarInput.setAttribute("placeholder", "Ask a follow-up...");
          
          // Display user message and send to LLM
          displayUserMessage(query);
          // Reset history navigation when sending a new message
          historyIndex = -1;
          lastHistoryProviderKey = urlbar.getAttribute("llm-provider") || null;
          sendToLLM(urlbar, urlbarInput, query);
        }
      } else if (isLLMMode && e.altKey && e.key === "ArrowDown") {
        e.preventDefault();
        e.stopPropagation();
        if (isShowingHistoryList()) {
          dismissHistoryList(urlbar, urlbarInput);
        }
      } else if (isLLMMode && e.altKey && e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();

        const providerKey = urlbar.getAttribute("llm-provider");
        if (!providerKey) {
          log("Alt+ArrowUp pressed but no providerKey on urlbar");
          return;
        }

        // Load stored sessions for this provider
        getProviderSessions(providerKey).then((sessions) => {
          if (!sessions.length) {
            log("Alt+ArrowUp pressed but no stored sessions for provider:", providerKey);
            return;
          }
          log("Alt+ArrowUp showing history list for provider:", providerKey, "with", sessions.length, "sessions");
          showHistoryListForProvider(providerKey, urlbar, urlbarInput);
        });
      } else if (e.key === "Escape" && isLLMMode) {
        e.preventDefault();
        e.stopPropagation();
        // Exit LLM mode but keep urlbar open (like Backspace on empty input)
        deactivateLLMMode(urlbar, urlbarInput, false);
      } else if ((e.key === "Delete" || e.key === "Backspace") && isLLMMode) {
        // Exit LLM mode if input is empty and user presses Delete/Backspace
        const currentValue = urlbarInput.value || "";
        if (currentValue.trim() === "") {
          e.preventDefault();
          e.stopPropagation();
          deactivateLLMMode(urlbar, urlbarInput, false);
        }
      }
    }, true);

    // Clean up on blur (when urlbar loses focus)
    urlbarInput.addEventListener("blur", (e) => {
      // Don't deactivate if clicking a link or selecting text
      if (isClickingLink) {
        log("Blur ignored - clicking link");
        return;
      }
      if (isSelectingInContainer) {
        log("Blur ignored - selecting text in container");
        return;
      }
      
      // Don't deactivate if clicking inside the conversation container
      const llmContainer = document.querySelector(".llm-conversation-container");
      
      setTimeout(() => {
        // Double check we're not clicking a link or selecting text
        if (isClickingLink) {
          log("Blur ignored in timeout - clicking link");
          return;
        }
        if (isSelectingInContainer) {
          log("Blur ignored in timeout - selecting text");
          return;
        }
        
        // Check if focus moved to something inside the LLM conversation
        const activeElement = document.activeElement;
        const relatedTarget = e.relatedTarget;
        
        // Check if the related target is a link (clicking on a link or its children)
        const isLinkClick = relatedTarget && (
          relatedTarget.tagName === 'A' || 
          (relatedTarget.closest && relatedTarget.closest('a'))
        );
        
        const clickedInsideLLM = llmContainer && (
          llmContainer.contains(activeElement) || 
          llmContainer.contains(relatedTarget) ||
          isLinkClick
        );
        
        if (document.activeElement !== urlbarInput && isLLMMode && !clickedInsideLLM) {
          log("Blur deactivating - activeElement:", activeElement?.tagName, "relatedTarget:", relatedTarget?.tagName);
          deactivateLLMMode(urlbar, urlbarInput, true);
        } else if (clickedInsideLLM) {
          log("Blur ignored - clicked inside LLM container or link");
        }
      }, LIMITS.BLUR_DELAY);
    });

    // Listen for urlbar panel closing (when urlbar is not "floating" anymore)
    const urlbarView = document.querySelector(".urlbarView");
    if (urlbarView) {
      // Watch for view panel closing/hiding
      const observer = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
          if (mutation.type === "attributes" && mutation.attributeName === "hidden") {
            // Panel is now hidden
            // Don't deactivate if we're clicking a link, selecting text, or in the conversation
            if (isClickingLink || isSelectingInContainer) {
              log("View hide ignored - clicking link or selecting text");
              return;
            }
            const llmContainer = document.querySelector(".llm-conversation-container");
            if (urlbarView.hidden && isLLMMode && !llmContainer?.matches(':hover')) {
              log("View hidden, deactivating");
              deactivateLLMMode(urlbar, urlbarInput, true);
            }
          }
        });
      });
      
      observer.observe(urlbarView, {
        attributes: true,
        attributeFilter: ["hidden"]
      });
    }

    // Watch for when urlbar "open" attribute is removed (unfocused state)
    const urlbarOpenObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === "attributes" && mutation.attributeName === "open") {
          if (!urlbar.hasAttribute("open") && isLLMMode) {
            if (isClickingLink || isSelectingInContainer) {
              log("Urlbar close ignored - clicking link or selecting text");
              return;
            }
            const llmContainer = document.querySelector(".llm-conversation-container");
            if (!llmContainer?.matches(':hover')) {
              log("Urlbar closed, deactivating");
              deactivateLLMMode(urlbar, urlbarInput, true);
            }
          }
        }
      }
    });
    urlbarOpenObserver.observe(urlbar, {
      attributes: true,
      attributeFilter: ["open"]
    });

    // Robust outside-click: when user clicks outside urlbar/urlbarView while in LLM or history mode,
    // fully reset (exit history + LLM mode). Blur and mutation observers can miss edge cases.
    document.addEventListener("mousedown", function outsideClickHandler(e) {
      if (!isLLMMode && !isShowingHistoryList()) return;
      if (isClickingLink || isSelectingInContainer) return;

      const target = e.target;
      const urlbarView = document.querySelector(".urlbarView");
      const clickedInsideUrlbar = urlbar && urlbar.contains(target);
      const clickedInsideView = urlbarView && urlbarView.contains(target);
      if (clickedInsideUrlbar || clickedInsideView) return;

      log("Outside click detected, deactivating LLM mode and resetting urlbar");
      deactivateLLMMode(urlbar, urlbarInput, true);
    }, true);
  }

  function showActivationHint(urlbar, providerKey) {
    const provider = CONFIG.providers[providerKey];
    // Could show a visual hint here
    urlbar.setAttribute("llm-hint", provider.name);
  }

  // Render markdown as DOM elements (avoids XHTML parsing issues)
  function renderMarkdownToElement(text, element) {
    if (!text) {
      element.textContent = "";
      return;
    }
    
    // Clear existing content
    element.textContent = "";
    
    // Split by code blocks and tables first to handle them separately
    const parts = [];
    let lastIndex = 0;
    
    // Combined regex for code blocks and tables
    const codeBlockRegex = /```(\w+)?\n([\s\S]*?)```/g;
    const tableRegex = /(?:^|\n)((?:\|[^\n]+\|\r?\n)+)/g;
    
    // First pass: extract code blocks
    let codeMatches = [];
    let match;
    while ((match = codeBlockRegex.exec(text)) !== null) {
      codeMatches.push({ index: match.index, end: match.index + match[0].length, type: 'code', lang: match[1], content: match[2] });
    }
    
    // Second pass: extract tables (only if not inside code blocks)
    let tableMatches = [];
    while ((match = tableRegex.exec(text)) !== null) {
      const tableStart = match.index + (match[0].startsWith('\n') ? 1 : 0);
      const tableEnd = match.index + match[0].length;
      
      // Check if this table is inside a code block
      const insideCodeBlock = codeMatches.some(cb => tableStart >= cb.index && tableEnd <= cb.end);
      if (!insideCodeBlock) {
        const tableContent = match[1].trim();
        // Validate it's actually a table (has at least 2 rows and separator row)
        const rows = tableContent.split('\n').filter(r => r.trim());
        if (rows.length >= 2) {
          const hasValidSeparator = rows.some(row => /^\|[\s\-:|]+\|$/.test(row.trim()));
          if (hasValidSeparator) {
            tableMatches.push({ index: tableStart, end: tableEnd, type: 'table', content: tableContent });
          }
        }
      }
    }
    
    // Combine and sort all matches
    const allMatches = [...codeMatches, ...tableMatches].sort((a, b) => a.index - b.index);
    
    // Build parts array
    for (const m of allMatches) {
      if (m.index > lastIndex) {
        parts.push({ type: 'text', content: text.slice(lastIndex, m.index) });
      }
      parts.push(m);
      lastIndex = m.end;
    }
    // Add remaining text
    if (lastIndex < text.length) {
      parts.push({ type: 'text', content: text.slice(lastIndex) });
    }
    
    // Render each part
    for (const part of parts) {
      if (part.type === 'code') {
        const pre = document.createElement('pre');
        const code = document.createElement('code');
        if (part.lang) {
          code.className = `language-${part.lang}`;
        }
        code.textContent = part.content.trim();
        pre.appendChild(code);
        element.appendChild(pre);
      } else if (part.type === 'table') {
        const table = parseMarkdownTable(part.content);
        if (table) {
          element.appendChild(table);
        }
      } else {
        // Parse inline markdown in text
        const span = document.createElement('span');
        span.innerHTML = parseInlineMarkdown(part.content);
        element.appendChild(span);
      }
    }
    
    // Don't attach individual link handlers - we'll use event delegation on the message element instead
  }
  
  // Parse markdown table and return a DOM table element
  function parseMarkdownTable(tableText) {
    try {
      const rows = tableText.split('\n').filter(r => r.trim());
      if (rows.length < 2) return null;
      
      // Find the separator row (contains only |, -, :, and spaces)
      let separatorIndex = -1;
      let alignments = [];
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i].trim();
        if (/^\|[\s\-:|]+\|$/.test(row)) {
          separatorIndex = i;
          // Parse alignments from separator
          const cells = row.split('|').filter(c => c.trim() !== '');
          alignments = cells.map(cell => {
            const trimmed = cell.trim();
            if (trimmed.startsWith(':') && trimmed.endsWith(':')) return 'center';
            if (trimmed.endsWith(':')) return 'right';
            return 'left';
          });
          break;
        }
      }
      
      if (separatorIndex === -1) return null;
      
      const table = document.createElement('table');
      table.className = 'llm-markdown-table';
      
      // Header rows (before separator)
      if (separatorIndex > 0) {
        const thead = document.createElement('thead');
        for (let i = 0; i < separatorIndex; i++) {
          const tr = document.createElement('tr');
          const cells = parseTableRow(rows[i]);
          cells.forEach((cell, idx) => {
            const th = document.createElement('th');
            th.innerHTML = parseInlineMarkdown(cell);
            if (alignments[idx]) {
              th.style.textAlign = alignments[idx];
            }
            tr.appendChild(th);
          });
          thead.appendChild(tr);
        }
        table.appendChild(thead);
      }
      
      // Body rows (after separator)
      if (separatorIndex < rows.length - 1) {
        const tbody = document.createElement('tbody');
        for (let i = separatorIndex + 1; i < rows.length; i++) {
          const tr = document.createElement('tr');
          const cells = parseTableRow(rows[i]);
          cells.forEach((cell, idx) => {
            const td = document.createElement('td');
            td.innerHTML = parseInlineMarkdown(cell);
            if (alignments[idx]) {
              td.style.textAlign = alignments[idx];
            }
            tr.appendChild(td);
          });
          tbody.appendChild(tr);
        }
        table.appendChild(tbody);
      }
      
      return table;
    } catch (e) {
      logWarn('Failed to parse table:', e);
      return null;
    }
  }
  
  // Parse a single table row into cells
  function parseTableRow(row) {
    // Remove leading/trailing pipes and split
    const trimmed = row.trim();
    const withoutPipes = trimmed.startsWith('|') ? trimmed.slice(1) : trimmed;
    const withoutEndPipe = withoutPipes.endsWith('|') ? withoutPipes.slice(0, -1) : withoutPipes;
    return withoutEndPipe.split('|').map(cell => cell.trim());
  }
  
  function parseInlineMarkdown(text) {
    let html = escapeHtml(text);
    
    // Inline code (`code`) - do this first to protect code content
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
    
    // Bold-italic (***text*** or ___text___) - must be before bold and italic
    html = html.replace(/\*\*\*([^*]+?)\*\*\*/g, '<strong><em>$1</em></strong>');
    html = html.replace(/___([^_]+?)___/g, '<strong><em>$1</em></strong>');
    
    // Bold (**text** or __text__) - must be before italic to avoid conflicts
    html = html.replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/__([^_]+?)__/g, '<strong>$1</strong>');
    
    // Italic (*text* or _text_) - only match complete pairs
    // Use word boundaries to avoid matching partial bold syntax
    // Only match if there's a complete opening and closing marker
    html = html.replace(/\b_([^_<>]+?)_\b/g, '<em>$1</em>');
    // For asterisk, make sure it's not part of bold (not preceded/followed by another *)
    html = html.replace(/(?<![*\\])\*([^*<>\s][^*<>]*?)\*(?![*])/g, '<em>$1</em>');
    
    // Headers (# Header) - must be in order from most # to least
    html = html.replace(/^###### (.+)$/gm, '<h6>$1</h6>');
    html = html.replace(/^##### (.+)$/gm, '<h5>$1</h5>');
    html = html.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
    html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
    html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
    
    // Lists (- item or * item)
    html = html.replace(/^[\-\*] (.+)$/gm, '<li>$1</li>');
    html = html.replace(/^(\d+)\. (.+)$/gm, '<li>$2</li>');
    html = html.replace(/(<li>[\s\S]*?<\/li>\n?)+/g, (match) => `<ul>${match}</ul>`);
    
    // Links [text](url) - only allow http/https to prevent javascript: injection
    html = html.replace(/\[([^\]]+)\]\(([^\)]+)\)/g, (match, text, url) => {
      const trimmedUrl = url.trim().toLowerCase();
      if (trimmedUrl.startsWith('http://') || trimmedUrl.startsWith('https://')) {
        return `<a href="${url}" target="_blank" rel="noopener">${text}</a>`;
      }
      return text; // Strip unsafe links, keep text
    });
    
    // Citation markers [1], [2], etc. - convert to styled spans (favicon injected later by injectFaviconsIntoCitationMarkers)
    // Match [1], [2], [3] etc. but not [text](url) links which were already converted
    html = html.replace(/\[(\d+)\](?!\()/g, '<span class="llm-citation-marker" data-source="$1"></span>');
    
    // Horizontal rule (---, ***, ___) - must be before line breaks
    html = html.replace(/^(?:---+|\*\*\*+|___+)\s*$/gm, '<hr class="llm-markdown-hr"/>');
    
    // Line breaks
    html = html.replace(/\n/g, '<br/>');
    
    return html;
  }

  function escapeHtml(text) {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  /**
   * Web search using DuckDuckGo HTML
   * In Firefox chrome context, we have elevated privileges and can fetch directly
   */
  
  // Search results cache (LRU-style with size limit)
  const searchCache = new Map();

  function cacheSet(key, value) {
    // Evict oldest entry if at capacity
    if (searchCache.size >= LIMITS.MAX_CACHE_SIZE) {
      const oldestKey = searchCache.keys().next().value;
      searchCache.delete(oldestKey);
    }
    searchCache.set(key, value);
  }
  
  async function searchWeb(query, limit = LIMITS.MAX_SEARCH_RESULTS, providerKey = null) {
    if (!isWebSearchEnabled()) {
      return null;
    }

    const startTime = Date.now();
    log('Searching for:', query);
    
    // Check cache first
    const cacheKey = `${query}:${limit}`;
    const cached = searchCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < LIMITS.CACHE_TTL) {
      log('Using cached results for:', query);
      return cached.results;
    }

    try {
      const useOllamaSearch = providerKey === 'ollama' && hasOllamaWebSearchKey();
      // Try Ollama Web Search API first (if API key is configured)
      if (useOllamaSearch) {
        const ollamaResults = await searchOllamaWeb(query, limit);
        if (ollamaResults && ollamaResults.length > 0) {
          cacheSet(cacheKey, { results: ollamaResults, timestamp: Date.now() });
          log('Ollama web search completed in', Date.now() - startTime, 'ms, found', ollamaResults.length, 'results');
          return ollamaResults;
        }
        log('Ollama web search failed, falling back to DuckDuckGo...');
      }

      // Try DuckDuckGo HTML search (direct fetch - works in chrome context)
      const results = await searchDuckDuckGoDirect(query, limit);
      
      if (results && results.length > 0) {
        // Cache results
        cacheSet(cacheKey, { results, timestamp: Date.now() });
        log('Search completed in', Date.now() - startTime, 'ms, found', results.length, 'results');
        return results;
      }
      
      logWarn('All search methods failed');
      return null;

    } catch (error) {
      logError('Web search failed:', error);
      return null;
    }
  }
  
  
  /**
   * Direct DuckDuckGo search using XMLHttpRequest
   * XMLHttpRequest in chrome context bypasses CORS restrictions
   */
  async function searchDuckDuckGoDirect(query, limit = LIMITS.MAX_SEARCH_RESULTS) {
    return new Promise((resolve) => {
      const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
      log('Fetching DuckDuckGo:', url);
      
      const xhr = new XMLHttpRequest();
      xhr.timeout = LIMITS.DDG_TIMEOUT;
      
      xhr.onload = function() {
        if (xhr.status === 200) {
          const html = xhr.responseText;
          log('Got DuckDuckGo HTML, length:', html.length);
          
          if (html && html.length > 1000 && html.includes('result')) {
            const results = parseDuckDuckGoHTML(html, limit);
            resolve(results.length > 0 ? results : null);
          } else {
            logWarn('DuckDuckGo returned invalid response');
            resolve(null);
          }
        } else {
          logWarn('DuckDuckGo HTTP error:', xhr.status);
          resolve(null);
        }
      };
      
      xhr.onerror = function() {
        logWarn('DuckDuckGo request error');
        resolve(null);
      };
      
      xhr.ontimeout = function() {
        logWarn('DuckDuckGo request timeout');
        resolve(null);
      };
      
      xhr.open('GET', url, true);
      xhr.setRequestHeader('Accept', 'text/html,application/xhtml+xml');
      xhr.send();
    });
  }
  
  /**
   * Helper to check if Ollama web search API key is configured
   */
  function hasOllamaWebSearchKey() {
    return CONFIG.ollamaWebSearch.apiKey && CONFIG.ollamaWebSearch.apiKey.trim().length > 0;
  }

  /**
   * Search using Ollama's Web Search API
   * Requires an Ollama API key from https://ollama.com/settings/keys
   * Returns results in the same format as other search functions
   */
  async function searchOllamaWeb(query, limit = LIMITS.MAX_SEARCH_RESULTS) {
    if (!hasOllamaWebSearchKey()) {
      log('No Ollama web search API key configured');
      return null;
    }

    try {
      log('Searching with Ollama Web Search API:', query);

      const response = await Promise.race([
        fetch(OLLAMA_WEB_SEARCH_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${CONFIG.ollamaWebSearch.apiKey}`
          },
          body: JSON.stringify({
            query: query,
            max_results: Math.min(limit, 10) // Ollama API max is 10
          })
        }),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Ollama web search timeout')), LIMITS.OLLAMA_WEBSEARCH_TIMEOUT)
        )
      ]);

      if (!response.ok) {
        logWarn('Ollama web search HTTP error:', response.status);
        return null;
      }

      const data = await response.json();

      if (data.results && data.results.length > 0) {
        const results = data.results.slice(0, limit).map((r, i) => {
          let source = '';
          try {
            source = new URL(r.url).hostname.replace('www.', '');
          } catch (e) {
            source = 'unknown';
          }

          return {
            title: r.title || '',
            url: r.url || '',
            snippet: r.content || r.title || '',
            source: source,
            index: i + 1
          };
        }).filter(r => r.url && r.title);

        if (results.length > 0) {
          log('Ollama web search found', results.length, 'results');
          return results;
        }
      }

      logWarn('Ollama web search returned no results');
      return null;

    } catch (error) {
      logWarn('Ollama web search failed:', error.message);
      return null;
    }
  }

  /**
   * Fetch page content using Ollama's Web Fetch API
   * Returns clean page content without needing local HTML parsing
   * Requires an Ollama API key
   */
  async function fetchPageContentOllama(url) {
    if (!hasOllamaWebSearchKey()) {
      return null;
    }

    try {
      const response = await Promise.race([
        fetch(OLLAMA_WEB_FETCH_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${CONFIG.ollamaWebSearch.apiKey}`
          },
          body: JSON.stringify({ url: url })
        }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Ollama web fetch timeout')), LIMITS.OLLAMA_WEBFETCH_TIMEOUT)
        )
      ]);

      if (!response.ok) {
        logWarn('Ollama web fetch HTTP error:', response.status, 'for', url);
        return null;
      }

      const data = await response.json();

      if (data.content && data.content.length > 50) {
        let content = '';
        if (data.title) {
          content += `# ${data.title}\n\n`;
        }
        content += data.content;

        // Clean up and truncate
        content = content
          .replace(/\n{3,}/g, '\n\n')
          .replace(/[ \t]+/g, ' ')
          .trim();

        log('Ollama web fetch extracted', content.length, 'chars from:', url);
        return content.length > LIMITS.MAX_PAGE_CONTENT_LENGTH
          ? content.substring(0, LIMITS.MAX_PAGE_CONTENT_LENGTH) + '...'
          : content;
      }

      return null;

    } catch (error) {
      logWarn('Ollama web fetch failed for', url, ':', error.message);
      return null;
    }
  }

  /**
   * Parse DuckDuckGo HTML to extract search results
   * Uses multiple selector strategies for robustness (inspired by Hana)
   */
  function parseDuckDuckGoHTML(html, limit) {
    try {
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, 'text/html');
      
      let results = [];
      
      // Strategy 1: Try standard result container selectors
      const resultSelectors = [
        'div.results_links_deep',
        'div.result',
        'div[data-result]',
        '.result',
        '.web-result'
      ];
      
      for (const selector of resultSelectors) {
        const elements = doc.querySelectorAll(selector);
        if (elements.length > 0) {
          log('Found', elements.length, 'results with selector:', selector);
          
          for (const el of elements) {
            if (results.length >= limit) break;
            
            const result = parseResultElement(el);
            if (result && !results.some(r => r.url === result.url)) {
              results.push({ ...result, index: results.length + 1 });
            }
          }
          
          if (results.length > 0) break; // Use first successful selector
        }
      }
      
      // Strategy 2: If no results, try finding links with uddg parameter
      if (results.length === 0) {
        log('Trying uddg link extraction...');
        const uddgLinks = doc.querySelectorAll('a[href*="uddg="]');
        
        for (const link of uddgLinks) {
          if (results.length >= limit) break;
          
          let url = cleanDDGUrl(link.getAttribute('href') || '');
          if (!url.startsWith('http') || url.includes('duckduckgo.com')) continue;
          
          const title = link.textContent.trim();
          if (!title || title.length < 5) continue;
          if (results.some(r => r.url === url)) continue;
          
          try {
            results.push({
              title,
              url,
              snippet: title,
              source: new URL(url).hostname.replace('www.', ''),
              index: results.length + 1
            });
          } catch (e) { }
        }
      }
      
      // Sort by relevance (longer snippets = more relevant)
      results.sort((a, b) => (b.snippet?.length || 0) - (a.snippet?.length || 0));
      
      log('Parsed', results.length, 'results from DuckDuckGo');
      return results.slice(0, limit);
      
    } catch (error) {
      logError('Failed to parse DuckDuckGo HTML:', error);
      return [];
    }
  }
  
  /**
   * Parse a single result element using multiple selector strategies
   */
  function parseResultElement(el) {
    try {
      // Try multiple title selectors
      const titleSelectors = [
        'a.result__a',
        '.result__title a',
        'h3 a',
        '.title a',
        'a[data-testid="result-title-a"]'
      ];
      
      let title = '';
      let linkEl = null;
      
      for (const selector of titleSelectors) {
        linkEl = el.querySelector(selector);
        if (linkEl) {
          title = linkEl.textContent.trim();
          if (title) break;
        }
      }
      
      if (!title || !linkEl) return null;
      
      // Get URL
      let url = linkEl.getAttribute('href') || '';
      url = cleanDDGUrl(url);
      
      if (!url.startsWith('http') || url.includes('duckduckgo.com')) {
        return null;
      }
      
      // Try multiple snippet selectors
      const snippetSelectors = [
        'a.result__snippet',
        '.result__snippet',
        '.snippet',
        '.result__body'
      ];
      
      let snippet = '';
      for (const selector of snippetSelectors) {
        const snippetEl = el.querySelector(selector);
        if (snippetEl) {
          snippet = snippetEl.textContent.trim();
          if (snippet) break;
        }
      }
      
      // Use title as fallback snippet
      if (!snippet) snippet = title;
      
      // Quality check
      if (title.length < 3 || url.length < 10) {
        return null;
      }
      
      return {
        title,
        url,
        snippet,
        source: new URL(url).hostname.replace('www.', '')
      };
      
    } catch (e) {
      return null;
    }
  }
  
  /**
   * Clean DuckDuckGo redirect URL to get actual target URL
   */
  function cleanDDGUrl(url) {
    if (!url) return '';
    
    try {
      // Handle //duckduckgo.com/l/?uddg= format
      if (url.includes('duckduckgo.com/l/?uddg=') || url.includes('duckduckgo.com/l?uddg=')) {
        const match = url.match(/uddg=([^&]+)/);
        if (match) {
          url = decodeURIComponent(match[1]);
        }
      } 
      // Handle uddg= parameter anywhere
      else if (url.includes('uddg=')) {
        const match = url.match(/uddg=([^&]+)/);
        if (match) {
          url = decodeURIComponent(match[1]);
        }
      }
      // Handle kh= parameter (another DDG redirect format)
      else if (url.includes('kh=') && url.includes('duckduckgo')) {
        const match = url.match(/kh=([^&]+)/);
        if (match) {
          url = decodeURIComponent(match[1]);
        }
      }
      
      // Ensure URL is properly decoded
      if (url.includes('%')) {
        try {
          url = decodeURIComponent(url);
        } catch (e) {
          // Already decoded or invalid
        }
      }
    } catch (e) {
      logWarn('Error cleaning URL:', e);
    }
    
    return url;
  }

  /**
   * Fetch and extract main content from a webpage using Mozilla Readability
   * @param {string} url - The URL to fetch
   * @param {number} maxLength - Maximum content length to return
   * @param {number} timeout - Timeout in ms (default 3500)
   * @returns {Promise<string|null>} - Extracted text content or null
   */
  async function fetchPageContent(url, maxLength = LIMITS.MAX_PAGE_CONTENT_LENGTH, timeout = LIMITS.PAGE_FETCH_TIMEOUT) {
    try {
      // Use XMLHttpRequest in chrome context to bypass CORS (no third-party proxy needed)
      const html = await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.timeout = timeout;
        xhr.onload = () => {
          if (xhr.status === 200 && xhr.responseText && xhr.responseText.length >= 100) {
            resolve(xhr.responseText);
          } else {
            resolve(null);
          }
        };
        xhr.onerror = () => resolve(null);
        xhr.ontimeout = () => resolve(null);
        xhr.open('GET', url, true);
        xhr.setRequestHeader('Accept', 'text/html,application/xhtml+xml');
        xhr.send();
      });

      if (!html) {
        return null;
      }
      
      // Parse HTML
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, 'text/html');
      
      // Try Mozilla Readability first (if loaded)
      if (ReadabilityClass) {
        try {
          // Clone the document as Readability modifies it
          const docClone = doc.cloneNode(true);
          const reader = new ReadabilityClass(docClone, {
            charThreshold: 100
          });
          const article = reader.parse();
          
          if (article && article.textContent && article.textContent.length > 100) {
            // Build the extracted content
            let content = '';
            if (article.title) {
              content += `# ${article.title}\n\n`;
            }
            if (article.byline) {
              content += `By: ${article.byline}\n\n`;
            }
            if (article.excerpt && article.excerpt.length > 50) {
              content += `*${article.excerpt}*\n\n`;
            }
            // Use textContent for cleaner output (no HTML tags)
            content += article.textContent;
            
            // Clean up and truncate
            content = content
              .replace(/\n{3,}/g, '\n\n')
              .replace(/[ \t]+/g, ' ')
              .trim();
            
            if (content.length > 100) {
              log('Readability extracted', content.length, 'chars from:', url);
              return content.length > maxLength 
                ? content.substring(0, maxLength) + '...'
                : content;
            }
          }
        } catch (readabilityError) {
          logWarn('Readability parsing failed:', readabilityError.message);
        }
      }
      
      // Fallback to simple extraction
      return extractMainContentSimple(doc, maxLength);
      
    } catch (error) {
      logWarn('Error fetching page:', error.message);
      return null;
    }
  }
  
  /**
   * Simple fallback content extraction when Readability is unavailable or fails
   */
  function extractMainContentSimple(doc, maxLength = LIMITS.MAX_SIMPLE_CONTENT_LENGTH) {
    try {
      // If doc is a string (HTML), parse it first
      if (typeof doc === 'string') {
        const parser = new DOMParser();
        doc = parser.parseFromString(doc, 'text/html');
      }
      
      // Clone to avoid modifying original
      const docClone = doc.cloneNode(true);
      
      // Remove unwanted elements
      const removeSelectors = [
        'script', 'style', 'noscript', 'nav', 'footer', 'header', 'aside', 
        'form', '.ad', '.ads', '.sidebar', '.menu', '.nav', '.comment', '.comments',
        '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]'
      ];
      for (const selector of removeSelectors) {
        try {
          docClone.querySelectorAll(selector).forEach(el => el.remove());
        } catch (e) { }
      }
      
      // Try to find main content area
      const mainSelectors = ['article', 'main', '[role="main"]', '.content', '.article', '.post', '#content'];
      let mainEl = null;
      for (const selector of mainSelectors) {
        mainEl = docClone.querySelector(selector);
        if (mainEl && mainEl.textContent.trim().length > 200) break;
        mainEl = null;
      }
      
      const targetEl = mainEl || docClone.body;
      if (!targetEl) return null;
      
      // Get text from paragraphs and headings
      const elements = targetEl.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, blockquote');
      const texts = [];
      
      for (const el of elements) {
        const text = el.textContent.trim();
        if (text.length > 20) {
          if (/^H[1-6]$/.test(el.tagName)) {
            texts.push(`## ${text}`);
          } else {
            texts.push(text);
          }
        }
      }
      
      let content = texts.join('\n\n');
      
      // If we didn't get enough from structured elements, use all text
      if (content.length < 200 && targetEl.textContent) {
        content = targetEl.textContent
          .replace(/\s+/g, ' ')
          .trim();
      }
      
      content = content.substring(0, maxLength);
      return content.length > 50 ? content : null;
      
    } catch (e) {
      logWarn('Simple extraction failed:', e.message);
      return null;
    }
  }


  /**
   * Fetch content from multiple search results in parallel
   * Optimized for speed - uses shorter timeouts and settles quickly
   */
  async function fetchSearchResultsContent(searchResults, maxResults = LIMITS.MAX_FETCH_RESULTS, providerKey = null) {
    const startTime = Date.now();
    const useOllamaFetch = providerKey === 'ollama' && hasOllamaWebSearchKey();
    log('Fetching content from', Math.min(searchResults.length, maxResults), 'pages...',
        useOllamaFetch ? '(using Ollama web fetch)' : '(using local fetch)');
    
    // Use Promise.allSettled for faster results (don't wait for slow pages)
    const fetchPromises = searchResults.slice(0, maxResults).map(async (result, index) => {
      // Try Ollama web fetch first, fall back to local fetch
      let content = null;
      if (useOllamaFetch) {
        content = await fetchPageContentOllama(result.url);
      }
      if (!content) {
        content = await fetchPageContent(result.url);
      }
      return {
        ...result,
        content: content || result.snippet,
        index: index + 1 // 1-indexed for citations
      };
    });
    
    // Wait for all fetches with a timeout (longer when using Ollama API)
    const fetchTimeout = useOllamaFetch ? LIMITS.OLLAMA_WEBFETCH_TIMEOUT : LIMITS.ALL_PAGES_FETCH_TIMEOUT;
    const timeoutPromise = new Promise(resolve => 
      setTimeout(() => resolve('timeout'), fetchTimeout)
    );
    
    try {
      const raceResult = await Promise.race([
        Promise.allSettled(fetchPromises),
        timeoutPromise
      ]);
      
      if (raceResult === 'timeout') {
        logWarn('Content fetch timed out after', Date.now() - startTime, 'ms, using snippets');
        return searchResults.slice(0, maxResults).map((r, i) => ({ ...r, content: r.snippet, index: i + 1 }));
      }
      
      // Extract successful results, use snippets for failed ones
      const results = raceResult.map((settled, i) => {
        if (settled.status === 'fulfilled') {
          return settled.value;
        }
        return { ...searchResults[i], content: searchResults[i].snippet, index: i + 1 };
      });
      
      log('Content fetch completed in', Date.now() - startTime, 'ms');
      return results;
    } catch (error) {
      logWarn('Error fetching content:', error);
      return searchResults.slice(0, maxResults).map((r, i) => ({ ...r, content: r.snippet, index: i + 1 }));
    }
  }

  /**
   * Format search results for LLM context
   * Now includes actual page content for better answers
   * Instructs LLM to cite sources using [1], [2], etc.
   */
  function formatSearchResultsForLLM(searchResults, originalQuery) {
    if (!searchResults || searchResults.length === 0) {
      return null;
    }

    const currentDateTime = new Date().toLocaleString();
    
    // Build search results in XML format with content
    const searchResultsXml = searchResults.map((result) => {
      const idx = result.index || searchResults.indexOf(result) + 1;
      const contentSection = result.content && result.content !== result.snippet
        ? `\nContent:\n${result.content}`
        : `\nSnippet: ${result.snippet}`;
      
      return `<source id="[${idx}]" url="${result.url}" site="${result.source}">
Title: ${result.title}${contentSection}
</source>`;
    }).join('\n\n');

    // Enhanced prompt for better synthesis with numbered citations
    const context = `You are a helpful AI assistant with access to current web search results. Your task is to provide a comprehensive, accurate answer based on the information from these sources.

Current date and time: ${currentDateTime}

IMPORTANT CITATION INSTRUCTIONS:
- When stating facts from sources, cite them using the source number in brackets like [1], [2], etc.
- Place citations at the end of the sentence or clause that contains the information
- You can cite multiple sources for the same fact: [1][2]
- Example: "The company reported record profits in Q4 [1], while analysts predict continued growth [2]."
- DO NOT write out the full URL or source name - just use the number in brackets

Other instructions:
- Synthesize information from the sources to directly answer the user's question
- Extract and present the key facts, news, and information from the content
- If sources contain conflicting information, acknowledge this and cite both
- If the sources don't contain enough information to fully answer, say what you found

<web-sources>
${searchResultsXml}
</web-sources>

User's question: ${originalQuery}

Provide a direct, informative answer with citations:`;
    
    return context;
  }

  /**
   * Inject favicons into citation markers [1], [2], etc. and set data-url for click-to-open.
   * No separate source section – markers in the text show the site favicon only.
   */
  function injectFaviconsIntoCitationMarkers(messageElement, sources) {
    if (!messageElement || !sources || sources.length === 0) {
      return;
    }
    const domainForFavicon = (s) => (s && s.source) ? s.source : (s && s.url ? new URL(s.url).hostname.replace(/^www\./, '') : '');
    messageElement.querySelectorAll('.llm-citation-marker').forEach((marker) => {
      const idx = parseInt(marker.dataset.source, 10);
      const source = sources[idx - 1];
      if (!source || !source.url) return;
      marker.dataset.url = source.url;
      marker.title = source.title || source.source || source.url;
      const domain = domainForFavicon(source);
      if (!domain) return;
      const enc = encodeURIComponent(domain);
      const urls = [
        `https://www.google.com/s2/favicons?domain=${enc}&sz=32`,
        `https://icons.duckduckgo.com/ip3/${enc}.ico`
      ];
      const img = document.createElement('img');
      img.className = 'llm-citation-favicon';
      let urlIndex = 0;
      img.src = urls[0];
      img.alt = '';
      img.onerror = () => {
        urlIndex++;
        if (urlIndex < urls.length) {
          img.src = urls[urlIndex];
        } else {
          img.style.display = 'none';
        }
      };
      marker.appendChild(img);
    });
  }

  function activateLLMMode(urlbar, urlbarInput, providerKey) {
    isLLMMode = true;
    currentProvider = CONFIG.providers[providerKey];
    
    // Remove "/provider" from input and store query
    const newValue = urlbarInput.value.replace(/^\/\w+\s*/, "").trim();
    urlbarInput.value = newValue;
    currentQuery = newValue;
    
    // Set visual indicator with provider name
    urlbar.setAttribute("llm-mode-active", "true");
    urlbar.setAttribute("llm-provider", providerKey);
    
    // Use the native Zen #urlbar-label-box if it exists, or create it
    let labelBox = document.getElementById("urlbar-label-box");
    if (!labelBox) {
      // Create the label box element
      labelBox = document.createXULElement ? 
        document.createXULElement("label") : 
        document.createElement("label");
      labelBox.id = "urlbar-label-box";
      
      // Insert it in the urlbar (before the input container)
      const inputContainer = urlbar.querySelector(".urlbar-input-container");
      if (inputContainer && inputContainer.parentNode) {
        inputContainer.parentNode.insertBefore(labelBox, inputContainer);
      }
    }
    
    // Set provider name and show
    labelBox.textContent = currentProvider.name;
    labelBox.hidden = false;
    labelBox.style.display = "inline-block";
    
    // Save and change placeholder text
    originalPlaceholder = urlbarInput.getAttribute("placeholder") || "";
    // Use different placeholder for follow-ups vs initial query
    const placeholder = conversationHistory.length > 0 ? "Ask a follow-up..." : "Ask anything...";
    urlbarInput.setAttribute("placeholder", placeholder);
    
    // Hide native suggestions completely
    const urlbarView = document.querySelector(".urlbarView");
    if (urlbarView) {
      urlbarView.setAttribute("llm-mode-suppress-results", "true");
    }
    
    // Only hide the results container if there's no conversation yet
    if (conversationHistory.length === 0) {
      const urlbarViewBodyInner = document.querySelector(".urlbarView-body-inner");
      if (urlbarViewBodyInner) {
        urlbarViewBodyInner.style.display = "none";
      }
    } else {
      // If we have a conversation, make sure it's visible
      const urlbarViewBodyInner = document.querySelector(".urlbarView-body-inner");
      if (urlbarViewBodyInner) {
        urlbarViewBodyInner.style.display = "";
      }
    }
    
    // Focus input
    urlbarInput.focus();
    
    // Trigger Zen's native search mode animation (scale bounce + glow)
    triggerZenSearchModeAnimation(urlbar);
    
    log(`Activated with provider: ${providerKey}, existing messages: ${conversationHistory.length}`);
  }

  /**
   * Trigger LLM mode activation animation
   * - Scale/pulse effect on the urlbar (like Zen's native animation)
   * - Glow effect radiating from the provider pill
   */
  function triggerZenSearchModeAnimation(urlbar) {
    try {
      // Check if Zen's motion library is available
      const zenUI = window.gZenUIManager;
      
      // 1. Scale/pulse animation on the urlbar
      if (zenUI && zenUI.motion && urlbar.hasAttribute("breakout-extend")) {
        zenUI.motion.animate(
          urlbar, 
          { scale: [1, 0.98, 1] }, 
          { duration: 0.25 }
        );
        log('Urlbar pulse animation triggered');
      }
      
      // 2. Glow effect on the pill
      const labelBox = document.getElementById("urlbar-label-box");
      if (labelBox) {
        // Trigger glow animation via CSS attribute
        labelBox.setAttribute("animate-glow", "true");
        
        // Remove the attribute after the animation completes
        setTimeout(() => {
          requestAnimationFrame(() => {
            labelBox.removeAttribute("animate-glow");
          });
        }, LIMITS.ANIMATION_GLOW_DURATION);
        
        log('Pill glow animation triggered');
      }
      
    } catch (error) {
      logWarn('Failed to trigger animation:', error);
    }
  }

  function deactivateLLMMode(urlbar, urlbarInput, restoreURL = false) {
    // Persist the current conversation (if any) before clearing state
    maybeSaveConversationToHistory(urlbar);

    isLLMMode = false;
    currentProvider = null;
    currentQuery = "";
    
    // Abort any in-flight LLM request so we don't keep streaming in the background
    if (abortController) {
      try {
        abortController.abort();
      } catch (e) {
        // Ignore abort errors
      }
      abortController = null;
    }
    
    // Clear any partial assistant state and search sources
    currentAssistantMessage = "";
    currentSearchSources = [];
    historyIndex = -1;
    lastHistoryProviderKey = null;
    currentSessionId = null;
    
    // Always restore native blur handler and clear interaction flags on deactivation
    isClickingLink = false;
    isSelectingInContainer = false;
    restoreNativeBlur();
    
    // Clear conversation history
    conversationHistory = [];
    
    // Remove conversation container
    if (conversationContainer) {
      conversationContainer.remove();
      conversationContainer = null;
    }
    
    // Remove streaming result first
    if (streamingResultRow) {
      streamingResultRow.remove();
      streamingResultRow = null;
    }
    
    // Remove visual indicators
    urlbar.removeAttribute("llm-mode-active");
    urlbar.removeAttribute("llm-provider");
    urlbar.removeAttribute("llm-hint");
    urlbar.removeAttribute("is-llm-thinking");
    
    // Hide pill
    const labelBox = document.getElementById("urlbar-label-box");
    if (labelBox) {
      labelBox.hidden = true;
      labelBox.style.display = "none";
      labelBox.textContent = "";
    }
    
    // Restore placeholder (always restore, not just when originalPlaceholder exists)
    if (originalPlaceholder) {
      urlbarInput.setAttribute("placeholder", originalPlaceholder);
    } else {
      // If no original placeholder was saved, remove the custom one
      urlbarInput.removeAttribute("placeholder");
    }
    
    // Reset originalPlaceholder for next time
    originalPlaceholder = "";
    
    // Show urlbarView-body-inner again and remove suppression
    const urlbarViewBodyInner = document.querySelector(".urlbarView-body-inner");
    if (urlbarViewBodyInner) {
      urlbarViewBodyInner.style.display = "";
    }
    
    const urlbarView = document.querySelector(".urlbarView");
    if (urlbarView) {
      urlbarView.removeAttribute("llm-mode-suppress-results");
    }
    
    // Properly restore URL and clear input using Zen's native methods
    if (window.gURLBar) {
      try {
        if (restoreURL) {
          // Close the view first
          if (window.gURLBar.view && window.gURLBar.view.close) {
            window.gURLBar.view.close();
          }
          
          // Restore the URL
          window.gURLBar.handleRevert();
          
          // Update the internal value
          if (window.gURLBar.value !== urlbarInput.value) {
            urlbarInput.value = window.gURLBar.value;
          }
        } else {
          // Just clear
          urlbarInput.value = "";
          if (window.gURLBar.value !== "") {
            window.gURLBar.value = "";
          }
          
          // Trigger input event to restore suggestions
          const inputEvent = new Event('input', { bubbles: true });
          urlbarInput.dispatchEvent(inputEvent);
        }
      } catch (e) {
        logWarn("Cleanup failed:", e);
        urlbarInput.value = "";
      }
    } else {
      urlbarInput.value = "";
    }
    
    log("Deactivated");
  }

  function displayUserMessage(message) {
    // Get or create conversation container
    if (!conversationContainer || !conversationContainer.parentNode) {
      log("Creating/recreating conversation container");
      conversationContainer = createConversationContainer();
    }
    
    if (!conversationContainer) {
      logError("Failed to create conversation container");
      return;
    }
    
    // Create user message element
    const messageDiv = document.createElement("div");
    messageDiv.className = "llm-message llm-message-user";
    messageDiv.textContent = message;
    
    conversationContainer.appendChild(messageDiv);
    
    log("User message added. Total children:", conversationContainer.children.length);
    
    // Scroll so the user's follow-up message is at the top of the visible area.
    // Use double-rAF to ensure the DOM has been laid out and painted.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (messageDiv) {
          messageDiv.scrollIntoView({ block: 'start', behavior: 'smooth' });
          log("Scrolled to user message via scrollIntoView");
        }
      });
    });
  }

  function createConversationContainer() {
    // Get urlbar view container
    const urlbarView = document.querySelector(".urlbarView");
    if (!urlbarView) {
      logError("Could not find urlbarView");
      return null;
    }

    // Find results container
    let resultsContainer = urlbarView.querySelector(".urlbarView-results");
    if (!resultsContainer) {
      resultsContainer = urlbarView.querySelector(".urlbarView-body");
    }
    if (!resultsContainer) {
      logError("Could not find results container");
      return null;
    }
    
    // Check if container already exists
    let container = resultsContainer.querySelector(".llm-conversation-container");
    if (container) {
      log("Reusing existing conversation container");
      return container;
    }
    
    // Create conversation container
    container = document.createElement("div");
    container.className = "llm-conversation-container";
    // Make the container focusable so it can receive keyboard events (Ctrl+C)
    container.setAttribute("tabindex", "-1");
    log("Creating new conversation container");
    
    container.addEventListener("mousedown", (e) => {
      const target = e.target;
      const linkElement = target.tagName === 'A' ? target : target.closest('a');
      const citationMarker = target.classList?.contains('llm-citation-marker') ? target : target.closest('.llm-citation-marker');

      if (linkElement || citationMarker) {
        log("Container mousedown - link/citation detected, setting flag");
        isClickingLink = true;
        suppressNativeBlur();
        return;
      }

      // Suppress native blur so the panel stays open during text selection
      suppressNativeBlur();
      isSelectingInContainer = true;
      
      // Focus the container so it receives keyboard events (Ctrl+C for copy).
      // This must happen after suppressNativeBlur() so the input's blur
      // doesn't close the panel.
      container.focus({ preventScroll: true });
      
      log("Container mousedown - selection started, target:", target.tagName);
      e.stopPropagation();
    }, false);
    
    container.addEventListener("mouseup", (e) => {
      const target = e.target;
      const linkElement = target.tagName === 'A' ? target : target.closest('a');
      const citationMarker = target.classList?.contains('llm-citation-marker') ? target : target.closest('.llm-citation-marker');

      if (linkElement || citationMarker) {
        return; // Link/citation handler takes care of restoring blur
      }
      
      e.stopPropagation();
      
      // Keep the urlbar panel open. The container has focus so Ctrl+C will work.
      // Native blur stays suppressed until user clicks back on the input or types.
      if (isSelectingInContainer) {
        const urlbar = document.getElementById("urlbar");
        if (urlbar && isLLMMode) {
          urlbar.setAttribute("open", "true");
          urlbar.setAttribute("breakout-extend", "true");
        }
      }
    }, false);
    
    container.addEventListener("click", (e) => {
      const target = e.target;
      const citationMarker = target.classList?.contains('llm-citation-marker') ? target : target.closest('.llm-citation-marker');
      const linkElement = target.tagName === 'A' ? target : target.closest('a');

      // Handle citation marker clicks (works for both streaming and history-loaded content)
      if (citationMarker) {
        e.preventDefault();
        e.stopPropagation();
        const url = citationMarker.dataset.url || (currentSearchSources && currentSearchSources[parseInt(citationMarker.dataset.source, 10) - 1]?.url);
        if (url) {
          try {
            isClickingLink = true;
            suppressNativeBlur();
            const topWindow = window.top || window;
            const browser = topWindow.gBrowser || topWindow.getBrowser?.() || window.gBrowser;
            if (browser && browser.addTab) {
              browser.addTab(url, {
                triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
                inBackground: true
              });
              log('Opened citation source in background:', url);
            }
            citationMarker.classList.add('llm-citation-marker-highlight');
            setTimeout(() => citationMarker.classList.remove('llm-citation-marker-highlight'), LIMITS.ANIMATION_GLOW_DURATION);
            setTimeout(() => {
              const urlbarInput = document.getElementById("urlbar-input");
              const urlbar = document.getElementById("urlbar");
              if (urlbarInput && urlbar) {
                urlbar.setAttribute("open", "true");
                urlbarInput.focus();
              }
              isClickingLink = false;
              restoreNativeBlur();
            }, LIMITS.FOCUS_RESTORE_DELAY);
          } catch (err) {
            logError('Failed to open citation source:', err);
            isClickingLink = false;
            restoreNativeBlur();
          }
        }
        return;
      }

      // Handle markdown links (for history-loaded content; streaming uses contentDiv handler)
      if (linkElement && linkElement.href) {
        e.preventDefault();
        e.stopPropagation();
        try {
          const topWindow = window.top || window;
          const browser = topWindow.gBrowser || topWindow.getBrowser?.() || window.gBrowser;
          if (browser && browser.addTab) {
            browser.addTab(linkElement.href, {
              triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
              inBackground: true
            });
          } else if (topWindow.open) {
            topWindow.open(linkElement.href, '_blank');
          }
          setTimeout(() => {
            const urlbarInput = document.getElementById("urlbar-input");
            const urlbar = document.getElementById("urlbar");
            if (urlbarInput && urlbar) {
              urlbar.setAttribute("open", "true");
              urlbarInput.focus();
            }
            isClickingLink = false;
            restoreNativeBlur();
          }, LIMITS.FOCUS_RESTORE_DELAY);
        } catch (err) {
          logError('Failed to open link:', err);
          isClickingLink = false;
          restoreNativeBlur();
        }
        return;
      }

      if (!linkElement) {
        e.stopPropagation();
      }
    }, false);
    
    // Handle mouseup outside the container (user dragged selection beyond it)
    document.addEventListener("mouseup", () => {
      if (isSelectingInContainer) {
        const urlbar = document.getElementById("urlbar");
        if (urlbar && isLLMMode) {
          urlbar.setAttribute("open", "true");
          urlbar.setAttribute("breakout-extend", "true");
        }
      }
    }, true);

    resultsContainer.appendChild(container);
    
    // Show urlbarView-body-inner
    const urlbarViewBodyInner = document.querySelector(".urlbarView-body-inner");
    if (urlbarViewBodyInner) {
      urlbarViewBodyInner.style.display = "";
    }
    
    return container;
  }

  function createStreamingResultRow() {
    // Get or create conversation container
    if (!conversationContainer || !conversationContainer.parentNode) {
      log("Creating/recreating conversation container for assistant");
      conversationContainer = createConversationContainer();
    }
    
    if (!conversationContainer) {
      logError("Failed to create conversation container for assistant");
      return null;
    }

    // Create assistant message element
    const messageDiv = document.createElement("div");
    messageDiv.className = "llm-message llm-message-assistant";
    
    // Create content div for streaming text
    const contentDiv = document.createElement("div");
    contentDiv.className = "llm-message-content";
    contentDiv.textContent = "Thinking...";
    
    // Handle link clicks using mouseup event (more reliable than click in this context)
    const handleLinkInteraction = (e, eventType) => {
      const target = e.target;
      const link = target.tagName === 'A' ? target : target.closest('a');
      
      // Handle citation marker clicks
      const citationMarker = target.classList?.contains('llm-citation-marker') ? target : target.closest('.llm-citation-marker');
      if (citationMarker && eventType === 'click') {
        e.preventDefault();
        e.stopPropagation();
        const url = citationMarker.dataset.url || (currentSearchSources && currentSearchSources[parseInt(citationMarker.dataset.source, 10) - 1]?.url);
        if (url) {
          try {
            isClickingLink = true;
            suppressNativeBlur();
            const topWindow = window.top || window;
            const browser = topWindow.gBrowser || topWindow.getBrowser?.() || window.gBrowser;
            if (browser && browser.addTab) {
              browser.addTab(url, {
                triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
                inBackground: true
              });
              log('Opened citation source in background:', url);
            }
            citationMarker.classList.add('llm-citation-marker-highlight');
            setTimeout(() => citationMarker.classList.remove('llm-citation-marker-highlight'), LIMITS.ANIMATION_GLOW_DURATION);
            setTimeout(() => {
              const urlbarInput = document.getElementById("urlbar-input");
              const urlbar = document.getElementById("urlbar");
              if (urlbarInput && urlbar) {
                urlbar.setAttribute("open", "true");
                urlbarInput.focus();
              }
              isClickingLink = false;
              restoreNativeBlur();
            }, LIMITS.FOCUS_RESTORE_DELAY);
          } catch (err) {
            logError('Failed to open citation source:', err);
            isClickingLink = false;
            restoreNativeBlur();
          }
        }
        return;
      }
      
      if (link && link.href) {
        log(`Link ${eventType}:`, link.href);
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();

        if (eventType === 'mousedown') {
          isClickingLink = true;
          suppressNativeBlur();
        }
        
        // Only open on mouseup (acts like a click)
        if (eventType === 'mouseup') {
          try {
            const topWindow = window.top || window;
            const browser = topWindow.gBrowser || topWindow.getBrowser?.() || window.gBrowser;
            
            if (browser && browser.addTab) {
              browser.addTab(link.href, {
                triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
                inBackground: true
              });
              log('Successfully opened link in background');
            } else if (topWindow.open) {
              topWindow.open(link.href, '_blank');
              log('Opened using window.open');
            }
            
            // Keep urlbar open and focused
            setTimeout(() => {
              const urlbarInput = document.getElementById("urlbar-input");
              const urlbar = document.getElementById("urlbar");
              if (urlbarInput && urlbar) {
                urlbar.setAttribute("open", "true");
                urlbar.setAttribute("breakout-extend", "true");
                urlbarInput.focus();
              }
              isClickingLink = false;
              restoreNativeBlur();
              log('Refocused urlbar');
            }, LIMITS.FOCUS_RESTORE_DELAY);
          } catch (err) {
            logError('Failed to open link:', err);
            isClickingLink = false;
            restoreNativeBlur();
          }
        }
      }
    };
    
    // Use both mousedown and mouseup for complete control
    contentDiv.addEventListener('mousedown', (e) => handleLinkInteraction(e, 'mousedown'), true);
    contentDiv.addEventListener('mouseup', (e) => handleLinkInteraction(e, 'mouseup'), true);
    contentDiv.addEventListener('click', (e) => handleLinkInteraction(e, 'click'), true);
    
    messageDiv.appendChild(contentDiv);
    conversationContainer.appendChild(messageDiv);
    
    log("Assistant message added. Total children:", conversationContainer.children.length);
    
    return { row: messageDiv, title: contentDiv };
  }

  async function sendToLLM(urlbar, urlbarInput, query) {
    if (!currentProvider || !query.trim()) {
      return;
    }

    // Check API key for non-local providers
    if (currentProvider.apiKey !== null && currentProvider.apiKey === "") {
      // Try to load from preferences first
      const providerKey = urlbar.getAttribute("llm-provider");
      const prefKey = `extension.urlbar-llm.${providerKey}-api-key`;
      const savedKey = getPref(prefKey, "");
      
      if (savedKey) {
        currentProvider.apiKey = savedKey;
      } else {
        // Prompt user if not in preferences
        const key = prompt(`Enter API key for ${currentProvider.name} (or set in Sine settings):`);
        if (!key) {
          deactivateLLMMode(urlbar, urlbarInput);
          return;
        }
        currentProvider.apiKey = key;
        setPref(prefKey, key);
      }
    }

    // Create streaming result row
    const result = createStreamingResultRow();
    if (!result) {
      logError("Failed to create result row");
      return;
    }

    streamingResultRow = result.row;
    const titleElement = result.title;

    // Set thinking state
    urlbar.setAttribute("is-llm-thinking", "true");
    
    // Clear previous search sources
    currentSearchSources = [];

    // Abort any previous request
    if (abortController) {
      abortController.abort();
    }
    abortController = new AbortController();

    try {
      // Perform web search if enabled and the model decides it needs it
      let searchContext = null;
      let searchResultsForDisplay = null;
      const providerKey = urlbar.getAttribute("llm-provider");
      const supportsWebSearch = providerKey === 'openai' || providerKey === 'mistral' || providerKey === 'ollama' || providerKey === 'gemini';
      
      // Ask the LLM itself whether the query is within its knowledge scope
      let needsSearch = false;
      if (isWebSearchEnabled() && supportsWebSearch) {
        const isFollowUp = conversationHistory.length > 1;
        // Show evaluating status while the model classifies
        titleElement.innerHTML = '<span class="llm-status-line"><span class="llm-search-spinner"></span> Evaluating...</span>';
        needsSearch = await queryNeedsWebSearchLLM(query, isFollowUp, abortController.signal);
      }
      
      if (needsSearch) {
        // Show searching status with spinner
        titleElement.innerHTML = '<span class="llm-status-line"><span class="llm-search-spinner"></span> Searching...</span>';
        
        log('Web search triggered for query:', query);
        const startTime = Date.now();
        const searchResults = await searchWeb(query, LIMITS.MAX_SEARCH_RESULTS, providerKey);
        
        if (searchResults && searchResults.length > 0) {
          // Update status - fetching content
          titleElement.innerHTML = '<span class="llm-status-line"><span class="llm-search-spinner"></span> Reading sources...</span>';
          
          // Fetch actual page content from search results (faster now)
          const resultsWithContent = await fetchSearchResultsContent(searchResults, 3, providerKey);
          
          // Store for source pills display
          searchResultsForDisplay = resultsWithContent;
          currentSearchSources = resultsWithContent;
          
          searchContext = formatSearchResultsForLLM(resultsWithContent, query);
          log('Web search completed in', Date.now() - startTime, 'ms total');
        } else {
          log('Web search returned no results');
        }
      } else if (!supportsWebSearch && isWebSearchEnabled()) {
        log('Web search not supported for provider:', providerKey);
      } else {
        // Clear sources if no search was performed
        currentSearchSources = [];
      }

      // Clear spinner and show thinking text
      titleElement.textContent = "Thinking...";
      
      // Prepare messages: language instruction first, then conversation (and search context if any)
      // Strip non-API fields (e.g. sources) — providers only accept role + content
      const toApiMessage = (m) => ({ role: m.role, content: m.content });
      const languageSystemMessage = { role: "system", content: LANGUAGE_SYSTEM_INSTRUCTION };
      let messagesToSend;
      if (searchContext) {
        const lastUserMessageIndex = conversationHistory.length - 1;
        messagesToSend = [
          languageSystemMessage,
          ...conversationHistory.slice(0, lastUserMessageIndex).map(toApiMessage),
          { role: "system", content: searchContext },
          toApiMessage(conversationHistory[lastUserMessageIndex])
        ];
        log('Added web search context to messages');
      } else {
        messagesToSend = [ languageSystemMessage, ...conversationHistory.map(toApiMessage) ];
      }
      
      await streamResponse(messagesToSend, titleElement, abortController.signal);
      
      // Add assistant's response to conversation history (include sources for history/session store)
      const assistantEntry = {
        role: "assistant",
        content: currentAssistantMessage
      };
      if (currentSearchSources && currentSearchSources.length > 0) {
        assistantEntry.sources = currentSearchSources.map((s) => ({
          title: s.title,
          url: s.url,
          source: s.source,
          index: s.index
        }));
      }
      conversationHistory.push(assistantEntry);
      
      log("Conversation now has", conversationHistory.length, "messages");
      
      // Inject favicons only after streaming is complete and final DOM is rendered (deferred so no debounce can overwrite)
      if (currentSearchSources && currentSearchSources.length > 0) {
        setTimeout(() => {
          injectFaviconsIntoCitationMarkers(streamingResultRow, currentSearchSources);
        }, LIMITS.RENDER_DEBOUNCE + 20);
      }

      // Persist conversation after each assistant response (and on deactivate)
      maybeSaveConversationToHistory(urlbar);

      urlbar.removeAttribute("is-llm-thinking");
    } catch (error) {
      logError("LLM request error:", error);
      if (error.name === "AbortError") {
        titleElement.textContent = "Request cancelled";
      } else {
        const msg = (error?.message || String(error)).toLowerCase();
        const statusMatch = msg.match(/api error:\s*(\d+)/);
        const status = statusMatch ? parseInt(statusMatch[1], 10) : null;

        if (status === 401 || status === 403) {
          titleElement.textContent = "Invalid API key. Please check your settings and try again.";
        } else if (status === 429) {
          titleElement.textContent = "Rate limit exceeded. Please wait a moment and try again.";
        } else if (status >= 500) {
          titleElement.textContent = "Service temporarily unavailable. Please try again in a moment.";
        } else if (status === 400 || status === 404) {
          titleElement.textContent = "Request failed. Please try a different query.";
        } else if (/network|fetch|connection|timeout|refused/i.test(msg)) {
          titleElement.textContent = "Connection error. Please check your network and try again.";
        } else if (/api error|invalid|unauthorized/i.test(msg)) {
          titleElement.textContent = "API request failed. Please check your API key and try again.";
        } else {
          titleElement.textContent = "Something went wrong. Please try again.";
        }
      }
      urlbar.removeAttribute("is-llm-thinking");
    }
  }

  /**
   * Unified streaming response handler for all providers.
   * Supports both OpenAI-compatible SSE format and Ollama JSON format.
   * Uses debounced rendering to avoid O(n^2) re-parsing on every token.
   */
  async function streamResponse(messages, titleElement, signal) {
    const isOllama = currentProvider.name === "Ollama";
    const isGemini = currentProvider.name === "Gemini";

    // Build request URL and headers
    const base = isOllama ? currentProvider.baseUrl : currentProvider.baseUrl.replace(/\/+$/, "");
    let url = isOllama
      ? currentProvider.baseUrl
      : (base.endsWith('/chat/completions') ? base : base + "/chat/completions");
    if (isGemini && currentProvider.apiKey) {
      url += (url.includes("?") ? "&" : "?") + "key=" + encodeURIComponent(currentProvider.apiKey);
    }

    const headers = { "Content-Type": "application/json" };
    if (!isOllama) {
      headers["Authorization"] = `Bearer ${currentProvider.apiKey}`;
    }

    log(`Streaming request — URL: ${url}, Model: ${currentProvider.model}, Provider: ${currentProvider.name}, Messages: ${messages.length}`);

    const response = await fetchWithRetry(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: currentProvider.model,
        messages,
        stream: true
      })
    }, signal);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let accumulatedText = "";

    // Debounced rendering: batch rapid token updates into a single render pass
    let renderPending = false;
    let renderTimeoutId = null;
    const scheduleRender = () => {
      if (renderPending) return;
      renderPending = true;
      renderTimeoutId = setTimeout(() => {
        renderPending = false;
        renderTimeoutId = null;
        renderMarkdownToElement(accumulatedText, titleElement);
        const scrollContainer = document.querySelector(".urlbarView-body-inner");
        if (scrollContainer) {
          scrollContainer.scrollTop = scrollContainer.scrollHeight;
        }
      }, LIMITS.RENDER_DEBOUNCE);
    };
    const cancelPendingRender = () => {
      if (renderTimeoutId !== null) {
        clearTimeout(renderTimeoutId);
        renderTimeoutId = null;
        renderPending = false;
      }
    };

    /**
     * Extract delta text from a parsed JSON chunk.
     * Returns the text content or null, and whether the stream is done.
     */
    const extractDelta = (json) => {
      if (isOllama) {
        return { text: json.message?.content || null, done: !!json.done };
      }
      return { text: json.choices?.[0]?.delta?.content || null, done: false };
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop(); // Keep incomplete line in buffer

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        // OpenAI SSE format: lines starting with "data: "
        if (trimmed.startsWith("data: ")) {
          const data = trimmed.slice(6);
          if (data === "[DONE]") {
            cancelPendingRender();
            renderMarkdownToElement(accumulatedText, titleElement);
            return;
          }
          try {
            const { text } = extractDelta(JSON.parse(data));
            if (text) {
              accumulatedText += text;
              currentAssistantMessage = accumulatedText;
              scheduleRender();
            }
          } catch (e) { /* ignore parse errors */ }
        }
        // Ollama JSON format: each line is a complete JSON object
        else if (isOllama) {
          try {
            const json = JSON.parse(trimmed);
            const { text, done: streamDone } = extractDelta(json);
            if (text) {
              accumulatedText += text;
              currentAssistantMessage = accumulatedText;
              scheduleRender();
            }
            if (streamDone) {
              cancelPendingRender();
              renderMarkdownToElement(accumulatedText, titleElement);
              return;
            }
          } catch (e) { /* ignore parse errors */ }
        }
      }
    }

    cancelPendingRender();
    renderMarkdownToElement(accumulatedText, titleElement);
  }

  // Initialize when DOM is ready (only once)
  let initialized = false;
  function initOnce() {
    if (initialized) return;
    initialized = true;
    init();
  }
  
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initOnce);
  } else {
    initOnce();
  }
})();

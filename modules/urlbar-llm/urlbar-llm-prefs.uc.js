// ==UserScript==
// @include   main
// @loadOrder 1
// @ignorecache
// ==/UserScript==

// urlbar-llm-prefs.uc.js — constants, Services, getPref/setPref, loadConfig
(function () {
  "use strict";

  if (location.href !== "chrome://browser/content/browser.xhtml") return;
  if (window.urlbarLlmPrefs) return;

  // Timing and size limits (centralized constants)
  /** System instruction: language + multi-turn context (follow-ups, pronouns, prior topics) */
  const LANGUAGE_SYSTEM_INSTRUCTION =
    "Always respond in the same language the user used for their message. If the user writes in French, respond in French; if in Spanish, in Spanish; and so on. " +
    "This is a multi-turn conversation: read all prior user and assistant messages. Interpret short follow-ups (e.g. \"du coup\", \"and for that\", \"non mais…\") in light of earlier turns. Do not answer each message in isolation or repeat earlier answers unless asked.";

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
    /** Rolling context compression (ChatGPT-style long thread) */
    CONTEXT_CHAR_BUDGET: 28000,       // Compress when transcript exceeds ~7k tokens
    CONTEXT_RECENT_MESSAGES: 6,       // Keep last N messages verbatim (3 exchanges)
    CONTEXT_SUMMARY_INPUT_MAX: 3500,  // Max chars per message fed to summarizer
    CONTEXT_SUMMARY_MAX_TOKENS: 900,  // Max tokens for summary output
    /** Context-aware web search query generation */
    SEARCH_CLASSIFIER_TIMEOUT_MS: 8000,
    SEARCH_QUERY_GEN_TIMEOUT_MS: 12000,
    SEARCH_QUERY_MAX_LENGTH: 120,
    SEARCH_QUERY_CACHE_TTL: 5 * 60 * 1000,
    SEARCH_QUERY_CONTEXT_INPUT_MAX: 800, // Max chars per message in query-gen context
    SEARCH_QUERY_CONTEXT_MESSAGES: 6,    // Recent turns fed to query generator
    /** Provider model catalog (Zen Mods dropdowns) */
    MODELS_CACHE_TTL: 5 * 60 * 1000,     // Reuse listed models for 5 minutes
    MODELS_FETCH_TIMEOUT: 8000,          // Per-request timeout when listing models
    MODELS_MAX_PAGES: 10,                // Safety cap for paginated list endpoints
  };

  const CONTEXT_SUMMARY_HEADER =
    "Summary of earlier conversation (for context — do not repeat this verbatim to the user unless asked):";

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
        model: "mistral-large-2512"
      },
      openai: {
        name: "OpenAI",
        apiKey: "",
        baseUrl: "https://api.openai.com/v1/chat/completions",
        model: "gpt-5.3-chat-latest"
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
        model: "gemini-3.1-pro-preview"
      }
    },
    ollamaWebSearch: {
      apiKey: "" // Ollama API key for web search (https://ollama.com/settings/keys)
    },
    defaultProvider: "ollama"
  };


  // Global conversation history (urlbar is shared; one list, persisted in profile)
  const HISTORY_FILE_NAME = "urlbar-llm-history.json";
  const HISTORY_MAX_SESSIONS_PER_PROVIDER = 20;
  const HISTORY_MAX_MESSAGES_PER_SESSION = 50;
  const HISTORY_MAX_TITLE_LENGTH = 120;
  /** Per-message safety cap (no truncation below this); allows full conversation restore */
  const HISTORY_MAX_CONTENT_LENGTH = 500000;

  /** Synthetic history-picker rows under `.urlbarView-results` (see {@link getUrlbarResultsElement}) */
  const ATTR_LLM_HISTORY_ROW = "data-llm-history-row";

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

  function loadConfig() {
    // Check if enabled
    if (!isEnabled()) {
      return;
    }

    for (const [key, provider] of Object.entries(CONFIG.providers)) {
      // Load API keys
      if (key !== "ollama") {
        const prefKey = `extension.urlbar-llm.${key}-api-key`;
        provider.apiKey = (getPref(prefKey, "") || "").trim();
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

  window.urlbarLlmPrefs = {
    LIMITS,
    CONFIG,
    LANGUAGE_SYSTEM_INSTRUCTION,
    CONTEXT_SUMMARY_HEADER,
    OLLAMA_WEB_SEARCH_URL,
    OLLAMA_WEB_FETCH_URL,
    HISTORY_FILE_NAME,
    HISTORY_MAX_SESSIONS_PER_PROVIDER,
    HISTORY_MAX_MESSAGES_PER_SESSION,
    HISTORY_MAX_TITLE_LENGTH,
    HISTORY_MAX_CONTENT_LENGTH,
    ATTR_LLM_HISTORY_ROW,
    Services,
    prefsService,
    getPref,
    setPref,
    log,
    logWarn,
    logError,
    isEnabled,
    isWebSearchEnabled,
    loadConfig
  };
})();

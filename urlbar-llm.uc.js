// ==UserScript==
// @include   main
// @loadOrder 11
// @ignorecache
// ==/UserScript==

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
(function () {
  "use strict";

  if (location.href !== "chrome://browser/content/browser.xhtml") return;

  const LEAF_MODULE_FILES = [
    "modules/urlbar-llm/urlbar-llm-prefs.uc.js",
    "modules/urlbar-llm/urlbar-llm-store.uc.js",
    "modules/urlbar-llm/urlbar-llm-http.uc.js",
    "modules/urlbar-llm/urlbar-llm-history-store.uc.js",
    "modules/urlbar-llm/urlbar-llm-markdown.uc.js",
    "modules/urlbar-llm/urlbar-llm-session.uc.js",
    "modules/urlbar-llm/urlbar-llm-search.uc.js",
    "modules/urlbar-llm/urlbar-llm-models.uc.js",
    "modules/urlbar-llm/urlbar-llm-history-ui.uc.js",
    "modules/urlbar-llm/urlbar-llm-app.uc.js"
  ];

  function loadLeafModulesIfNeeded() {
    if (window.urlbarLlmPrefs && window.urlbarLlmApp) {
      return;
    }
    try {
      const currentScriptPath = String(Components.stack.filename || "").replace(/\\/g, "/");
      const slash = currentScriptPath.lastIndexOf("/");
      const root = slash === -1 ? "" : currentScriptPath.slice(0, slash + 1);
      const loader = Components.classes["@mozilla.org/moz/jssubscript-loader;1"]
        .getService(Components.interfaces.mozIJSSubScriptLoader);
      for (const rel of LEAF_MODULE_FILES) {
        try {
          loader.loadSubScript(root + rel, window);
        } catch (e) {
          console.error("[URLBar LLM] Failed to load " + rel, e);
        }
      }
    } catch (e) {
      console.error("[URLBar LLM] Could not load leaf modules:", e);
    }
  }

  loadLeafModulesIfNeeded();

  const REQUIRED_MODULES = [
    { name: "prefs", test: () => window.urlbarLlmPrefs?.getPref },
    { name: "store", test: () => window.urlbarLlmStore?.createStore },
    { name: "http", test: () => window.urlbarLlmHttp?.create },
    { name: "historyStore", test: () => window.urlbarLlmHistoryStore?.create },
    { name: "markdown", test: () => window.urlbarLlmMarkdown?.create },
    { name: "session", test: () => window.urlbarLlmSession?.create },
    { name: "search", test: () => window.urlbarLlmSearch?.create },
    { name: "models", test: () => window.urlbarLlmModels?.create },
    { name: "historyUi", test: () => window.urlbarLlmHistoryUi?.create },
    { name: "app", test: () => window.urlbarLlmApp?.create }
  ];

  function start() {
    if (window.__urlbarLlmBundleExecuted) {
      console.warn("[URLBar LLM] Bundle already executed in this window; skipping duplicate load.");
      return;
    }
    window.__urlbarLlmBundleExecuted = true;

    const prefs = window.urlbarLlmPrefs;
    const state = window.urlbarLlmStore.createStore();
    const api = {};
    const deps = { prefs, state, api };

    Object.assign(api, window.urlbarLlmHttp.create(deps));
    Object.assign(api, window.urlbarLlmHistoryStore.create(deps));
    Object.assign(api, window.urlbarLlmMarkdown.create(deps));
    Object.assign(api, window.urlbarLlmSession.create(deps));
    Object.assign(api, window.urlbarLlmSearch.create(deps));
    Object.assign(api, window.urlbarLlmModels.create(deps));
    Object.assign(api, window.urlbarLlmHistoryUi.create(deps));
    Object.assign(api, window.urlbarLlmApp.create(deps));

    const initOnce = () => {
      if (state.initialized) return;
      state.initialized = true;
      api.init();
    };

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", initOnce);
    } else {
      initOnce();
    }
  }

  (function tryInit(attempt) {
    const missing = REQUIRED_MODULES.filter((m) => !m.test()).map((m) => m.name);
    if (missing.length === 0) {
      start();
      return;
    }
    if (attempt < 40) {
      setTimeout(() => tryInit(attempt + 1), 50);
      return;
    }
    console.error(
      "[URLBar LLM] Missing modules after 2s: " + missing.join(", ") + ". Verify theme.json loadOrder."
    );
  })(0);
})();

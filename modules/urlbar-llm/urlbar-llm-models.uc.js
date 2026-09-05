// ==UserScript==
// @include   main
// @loadOrder 8
// @ignorecache
// ==/UserScript==

// urlbar-llm-models.uc.js — live provider model catalogs for Sine settings
(function () {
  "use strict";

  if (location.href !== "chrome://browser/content/browser.xhtml") return;

  window.urlbarLlmModels = {
    create(deps) {
      if (!deps?.prefs || !deps?.state || !deps?.api) {
        console.error("[URLBar LLM] urlbarLlmModels: missing deps");
        return {};
      }
      const {
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
      } = deps.prefs;
      const state = deps.state;
      const api = deps.api;
      const PROVIDER_MODEL_PREFS = {
        mistral: "extension.urlbar-llm.mistral-model",
        openai: "extension.urlbar-llm.openai-model",
        gemini: "extension.urlbar-llm.gemini-model",
        ollama: "extension.urlbar-llm.ollama-model"
      };

      /** @type {Map<string, { models: Array<{value: string, label: string}>, fetchedAt: number }>} */
      const providerModelCache = new Map();
      const watchedPreferencesDocuments = new WeakSet();
      const seenWarnings = new Set();
      const MODELS_FAILURE_CACHE_TTL = 60 * 1000;

      // Model lists are refreshed whenever the settings DOM changes, so an unreachable provider
      // would otherwise repeat the same warning indefinitely.
      function logWarnOnce(key, ...args) {
        if (seenWarnings.has(key)) {
          return;
        }
        seenWarnings.add(key);
        logWarn(...args);
      }

      function getWindowMediator() {
        return Components.classes["@mozilla.org/appshell/window-mediator;1"]
          .getService(Components.interfaces.nsIWindowMediator);
      }

      function getModelsListUrl(providerKey) {
        const provider = CONFIG.providers[providerKey];
        if (providerKey === "ollama") {
          try {
            const u = new URL(provider.baseUrl);
            return `${u.protocol}//${u.host}/api/tags`;
          } catch (e) {
            return "http://localhost:11434/api/tags";
          }
        }
        const base = String(provider.baseUrl || "").replace(/\/+$/, "");
        if (base.endsWith("/chat/completions")) {
          return base.slice(0, -"/chat/completions".length) + "/models";
        }
        return `${base}/models`;
      }

      function fetchJsonOnce(url, options = {}, timeoutMs = LIMITS.MODELS_FETCH_TIMEOUT) {
        return new Promise((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.timeout = timeoutMs;
          xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
              try {
                resolve(JSON.parse(xhr.responseText || "{}"));
              } catch (e) {
                reject(new Error(`Invalid JSON from model list: ${e.message}`));
              }
              return;
            }
            reject(
              new Error(
                `API error: ${xhr.status} ${xhr.statusText}${xhr.responseText ? " — " + String(xhr.responseText).slice(0, 200) : ""}`
              )
            );
          };
          xhr.onerror = () => reject(new Error(`Network error listing models: ${url}`));
          xhr.ontimeout = () => reject(new Error(`Timeout listing models: ${url}`));
          xhr.open(options.method || "GET", url, true);
          const headers = options.headers || {};
          for (const [name, value] of Object.entries(headers)) {
            xhr.setRequestHeader(name, value);
          }
          xhr.send(options.body || null);
        });
      }

      function normalizeModelId(id) {
        if (!id || typeof id !== "string") {
          return "";
        }
        return id.replace(/^models\//, "").replace(/^publishers\/[^/]+\/models\//, "");
      }

      function normalizeModelRows(rows) {
        const seen = new Set();
        const out = [];
        for (const row of rows || []) {
          const id = normalizeModelId(row.id || row.name || "");
          if (!id || seen.has(id)) {
            continue;
          }
          seen.add(id);
          const pretty = String(row.display_name || row.displayName || "").trim();
          out.push({ value: id, label: pretty && pretty !== id ? pretty : id });
        }
        out.sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }));
        return out;
      }

      async function fetchOpenAIStyleModelRows(url, headers, timeoutMs) {
        const all = [];
        let nextUrl = url;
        for (let page = 0; page < LIMITS.MODELS_MAX_PAGES && nextUrl; page++) {
          const data = await fetchJsonOnce(nextUrl, { headers }, timeoutMs);
          const batch = Array.isArray(data.data) ? data.data : [];
          all.push(...batch);
          if (data.has_more && data.last_id) {
            const u = new URL(url);
            u.searchParams.set("after", data.last_id);
            nextUrl = u.toString();
          } else {
            nextUrl = null;
          }
        }
        return all;
      }

      async function fetchGeminiNativeModelRows(apiKey, headers, timeoutMs) {
        const all = [];
        const base =
          "https://generativelanguage.googleapis.com/v1beta/models?pageSize=100&key=" +
          encodeURIComponent(apiKey);
        let pageUrl = base;
        for (let page = 0; page < LIMITS.MODELS_MAX_PAGES && pageUrl; page++) {
          const data = await fetchJsonOnce(pageUrl, { headers }, timeoutMs);
          all.push(...(data.models || []));
          const token = data.nextPageToken;
          pageUrl = token ? `${base}&pageToken=${encodeURIComponent(token)}` : null;
        }
        return all.map((m) => ({ id: m.name, displayName: m.displayName }));
      }

      async function fetchProviderModels(providerKey) {
        loadConfig();
        const provider = CONFIG.providers[providerKey];
        if (!provider) {
          return [];
        }
        const timeoutMs = LIMITS.MODELS_FETCH_TIMEOUT;
        const headers = { Accept: "application/json" };
        if (providerKey !== "ollama" && provider.apiKey) {
          headers.Authorization = `Bearer ${provider.apiKey}`;
        }

        if (providerKey === "ollama") {
          const data = await fetchJsonOnce(getModelsListUrl(providerKey), { headers }, timeoutMs);
          return normalizeModelRows(
            (data.models || []).map((m) => ({ id: m.name || m.model }))
          );
        }

        let url = getModelsListUrl(providerKey);
        if (providerKey === "gemini" && provider.apiKey) {
          url += (url.includes("?") ? "&" : "?") + "key=" + encodeURIComponent(provider.apiKey);
        }

        try {
          const rows = await fetchOpenAIStyleModelRows(url, headers, timeoutMs);
          const models = normalizeModelRows(rows);
          if (models.length || providerKey !== "gemini") {
            return models;
          }
        } catch (e) {
          if (providerKey !== "gemini") {
            throw e;
          }
          logWarn("Gemini OpenAI-compatible model list failed, trying native API:", e.message);
        }

        const rows = await fetchGeminiNativeModelRows(provider.apiKey, headers, timeoutMs);
        return normalizeModelRows(rows);
      }

      function isProviderConfigured(providerKey) {
        loadConfig();
        const provider = CONFIG.providers[providerKey];
        if (!provider) {
          return false;
        }
        return providerKey === "ollama" || !!provider.apiKey;
      }

      async function getProviderModels(providerKey) {
        if (!isProviderConfigured(providerKey)) {
          return [];
        }

        const cached = providerModelCache.get(providerKey);
        if (cached) {
          const ttl = cached.models.length ? LIMITS.MODELS_CACHE_TTL : MODELS_FAILURE_CACHE_TTL;
          if (Date.now() - cached.fetchedAt < ttl) {
            return cached.models;
          }
        }

        let models = [];
        try {
          models = await fetchProviderModels(providerKey);
          if (models.length) {
            seenWarnings.delete(`list:${providerKey}`);
          }
        } catch (e) {
          logWarnOnce(`list:${providerKey}`, `Could not list ${providerKey} models:`, e.message);
        }
        if (!models.length && cached?.models.length) {
          return cached.models;
        }
        providerModelCache.set(providerKey, { models, fetchedAt: Date.now() });
        return models;
      }

      function createXulMenuItem(doc, value, label) {
        let item;
        if (typeof doc.createXULElement === "function") {
          item = doc.createXULElement("menuitem");
        } else {
          item = doc.createElementNS(
            "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul",
            "menuitem"
          );
        }
        item.setAttribute("value", value);
        item.setAttribute("label", label);
        return item;
      }

      function getMenuPopup(menulist) {
        if (!menulist) {
          return null;
        }
        return (
          menulist.menupopup ||
          menulist.getElementsByTagName("menupopup")[0] ||
          menulist.querySelector("menupopup") ||
          [...menulist.children].find((child) => child.localName === "menupopup") ||
          null
        );
      }

      function findModelMenulist(doc, providerKey) {
        const pref = PROVIDER_MODEL_PREFS[providerKey];
        if (!doc || !pref) {
          return null;
        }

        const asMenulist = (el) => {
          if (!el) {
            return null;
          }
          if (el.localName === "menulist") {
            return el;
          }
          return el.getElementsByTagName("menulist")[0] || el.querySelector("menulist") || null;
        };

        return (
          asMenulist(doc.getElementById(`${pref}-popup-menulist`)) ||
          asMenulist(doc.getElementById(pref.replaceAll(".", "-"))) ||
          asMenulist(doc.querySelector(`[tooltiptext="${pref}"]`))
        );
      }

      function populateModelMenulist(doc, providerKey, models) {
        if (!doc || !models.length) {
          return false;
        }
        const pref = PROVIDER_MODEL_PREFS[providerKey];
        const menulist = findModelMenulist(doc, providerKey);
        if (!menulist) {
          return false;
        }
        const popup = getMenuPopup(menulist);
        if (!popup) {
          logWarnOnce(
            `popup:${providerKey}`,
            `Found ${providerKey} model control but no menupopup to fill`
          );
          return false;
        }

        const fallback = CONFIG.providers[providerKey]?.model || "";
        const saved = getPref(pref, fallback);
        const items = models.slice();
        if (saved && saved !== "none" && !items.some((m) => m.value === saved)) {
          items.unshift({ value: saved, label: saved });
        }

        const stamp = items.map((m) => m.value).join("\n");
        const currentValue = menulist.getAttribute("value") || menulist.value;
        if (menulist.getAttribute("data-llm-models-stamp") === stamp && currentValue === saved) {
          return true;
        }

        for (const child of [...popup.children]) {
          const value = child.getAttribute("value");
          if (value !== "none" && value !== "") {
            child.remove();
          }
        }
        const ownerDoc = popup.ownerDocument || doc;
        for (const model of items) {
          popup.appendChild(createXulMenuItem(ownerDoc, model.value, model.label));
        }

        const selected = items.find((m) => m.value === saved) || items[0];
        if (selected) {
          menulist.setAttribute("value", selected.value);
          menulist.setAttribute("label", selected.label);
          try {
            menulist.value = selected.value;
          } catch (e) { /* some XUL menulists only use attributes */ }
        }
        menulist.setAttribute("data-llm-models-stamp", stamp);
        log(`Filled ${providerKey} model dropdown with ${items.length} models`);
        return true;
      }

      async function fillModelDropdownsInDocument(doc) {
        if (!doc) {
          return;
        }
        await Promise.all(
          Object.keys(PROVIDER_MODEL_PREFS).map(async (providerKey) => {
            const models = await getProviderModels(providerKey);
            populateModelMenulist(doc, providerKey, models);
          })
        );
      }

      function isSettingsDocument(doc) {
        if (!doc) {
          return false;
        }
        try {
          const uri = doc.documentURI || doc.location?.href || "";
          if (uri.startsWith("about:preferences") || /preferences\.xhtml/i.test(uri)) {
            return true;
          }
        } catch (e) { /* ignore */ }
        try {
          return !!(
            doc.getElementById("sineModsList") ||
            doc.getElementById("zenThemeMarketplaceList") ||
            doc.getElementById("sineInstalledGroup") ||
            doc.querySelector("[data-category='paneSineMods']")
          );
        } catch (e) {
          return false;
        }
      }

      function collectPreferencesDocumentsFromWindow(win) {
        const docs = [];
        const seen = new Set();
        const add = (doc) => {
          if (doc && !seen.has(doc)) {
            seen.add(doc);
            docs.push(doc);
          }
        };
        if (!win) {
          return docs;
        }
        try {
          add(win.document);
        } catch (e) { /* ignore */ }
        try {
          const browsers = win.gBrowser?.browsers || [];
          for (const browser of browsers) {
            try {
              const spec = browser.currentURI?.spec || "";
              if (spec.startsWith("about:preferences") || /preferences|settings/i.test(spec)) {
                add(browser.contentDocument);
                add(browser.contentWindow?.document);
              }
            } catch (e) { /* ignore */ }
          }
        } catch (e) { /* ignore */ }
        return docs.filter(
          (doc) =>
            isSettingsDocument(doc) ||
            Object.keys(PROVIDER_MODEL_PREFS).some((key) => findModelMenulist(doc, key))
        );
      }

      function collectAllPreferencesDocuments() {
        const docs = [];
        const seen = new Set();
        const add = (doc) => {
          if (doc && !seen.has(doc)) {
            seen.add(doc);
            docs.push(doc);
          }
        };
        for (const doc of collectPreferencesDocumentsFromWindow(window)) {
          add(doc);
        }
        try {
          const enumerator = getWindowMediator().getEnumerator(null);
          while (enumerator.hasMoreElements()) {
            const win = enumerator.getNext();
            for (const doc of collectPreferencesDocumentsFromWindow(win)) {
              add(doc);
            }
          }
        } catch (e) { /* ignore */ }
        return docs;
      }

      function watchPreferencesDocument(doc) {
        if (!doc || watchedPreferencesDocuments.has(doc)) {
          return;
        }
        watchedPreferencesDocuments.add(doc);
        let fillTimer = null;
        const scheduleFill = () => {
          if (fillTimer) {
            return;
          }
          fillTimer = setTimeout(() => {
            fillTimer = null;
            fillModelDropdownsInDocument(doc).catch((e) => {
              logWarnOnce("fill", "Failed to fill model dropdowns:", e.message);
            });
          }, 150);
        };
        scheduleFill();
        setTimeout(scheduleFill, 500);
        setTimeout(scheduleFill, 1500);
        const root =
          doc.getElementById("sineModsList") ||
          doc.getElementById("sineInstalledGroup") ||
          doc.getElementById("zenThemeMarketplaceList") ||
          doc.getElementById("mainPrefPane") ||
          doc.documentElement;
        if (!root) {
          return;
        }
        const observer = new MutationObserver(scheduleFill);
        observer.observe(root, { childList: true, subtree: true });
      }

      function tryAttachPreferencesFromWindow(win) {
        if (!win) {
          return;
        }
        try {
          if (isSettingsDocument(win.document)) {
            watchPreferencesDocument(win.document);
          }
        } catch (e) { /* ignore */ }
        for (const doc of collectPreferencesDocumentsFromWindow(win)) {
          watchPreferencesDocument(doc);
        }
      }

      function scanOpenPreferencesDocuments() {
        for (const doc of collectAllPreferencesDocuments()) {
          watchPreferencesDocument(doc);
        }
      }

      async function refreshAndPopulateAllModelDropdowns(invalidateKeys = null) {
        const keys = invalidateKeys || Object.keys(PROVIDER_MODEL_PREFS);
        for (const key of keys) {
          providerModelCache.delete(key);
          seenWarnings.delete(`list:${key}`);
        }
        scanOpenPreferencesDocuments();
        const docs = collectAllPreferencesDocuments();
        if (!docs.length) {
          logWarnOnce("no-settings-doc", "No settings document found to fill model dropdowns");
        }
        await Promise.all(docs.map((doc) => fillModelDropdownsInDocument(doc)));
      }

      function providerKeyFromPrefName(name) {
        if (!name || typeof name !== "string") {
          return null;
        }
        const relative = name.startsWith("extension.urlbar-llm.")
          ? name.slice("extension.urlbar-llm.".length)
          : name;
        for (const key of Object.keys(PROVIDER_MODEL_PREFS)) {
          if (relative.startsWith(`${key}-`) || name.includes(`.${key}-`)) {
            return key;
          }
        }
        return null;
      }

      function setupModelListSync() {
        if (window._urlbarLlmModelListSync) {
          return;
        }
        window._urlbarLlmModelListSync = true;

        const modelPrefObserver = {
          observe(subject, topic, data) {
            if (topic !== "nsPref:changed") {
              return;
            }
            const name = String(data || "");
            if (name.endsWith("-model") || name.includes("-model")) {
              loadConfig();
            }
            if (name.endsWith("-api-key") && !name.includes("web-search") || name.endsWith("ollama-base-url")) {
              const key = name.endsWith("ollama-base-url") ? "ollama" : providerKeyFromPrefName(name);
              refreshAndPopulateAllModelDropdowns(key ? [key] : null).catch((e) => {
                logWarn("Failed to refresh model lists after pref change:", e.message);
              });
            }
          }
        };
        try {
          prefsService.addObserver("extension.urlbar-llm.", modelPrefObserver, false);
        } catch (e) {
          logWarn("Could not observe model-list prefs:", e.message);
        }

        if (window.gBrowser && typeof window.gBrowser.addTabsProgressListener === "function") {
          window.gBrowser.addTabsProgressListener({
            onLocationChange(browser, webProgress, request, location) {
              if (webProgress && !webProgress.isTopLevel) {
                return;
              }
              const spec = location?.spec || browser?.currentURI?.spec || "";
              if (!spec.startsWith("about:preferences")) {
                return;
              }
              const attach = () => {
                try {
                  const doc = browser.contentDocument || browser.contentWindow?.document;
                  if (doc) {
                    watchPreferencesDocument(doc);
                  }
                } catch (e) { /* ignore */ }
              };
              setTimeout(attach, 200);
              setTimeout(attach, 800);
              try {
                browser.addEventListener("DOMContentLoaded", attach, true);
                browser.addEventListener("load", attach, true);
              } catch (e) { /* ignore */ }
            }
          });
        }

        try {
          const windowListener = {
            onOpenWindow(xulWindow) {
              let domWindow = null;
              try {
                domWindow = xulWindow.docShell.domWindow;
              } catch (e) {
                try {
                  domWindow = xulWindow
                    .QueryInterface(Components.interfaces.nsIInterfaceRequestor)
                    .getInterface(Components.interfaces.nsIDOMWindow);
                } catch (e2) {
                  return;
                }
              }
              const onLoad = () => tryAttachPreferencesFromWindow(domWindow);
              try {
                if (domWindow.document?.readyState === "complete") {
                  onLoad();
                } else {
                  domWindow.addEventListener("load", onLoad, { once: true });
                }
              } catch (e) { /* ignore */ }
              setTimeout(onLoad, 500);
            },
            onCloseWindow() {},
            onWindowTitleChange() {}
          };
          getWindowMediator().addListener(windowListener);
        } catch (e) {
          logWarn("Could not watch preferences windows:", e.message);
        }

        try {
          const observerService = Components.classes["@mozilla.org/observer-service;1"]
            .getService(Components.interfaces.nsIObserverService);
          observerService.addObserver(
            {
              observe(subject) {
                const win = subject?.defaultView || subject;
                const attach = () => tryAttachPreferencesFromWindow(win);
                try {
                  win.addEventListener("load", attach, { once: true });
                } catch (e) { /* ignore */ }
                setTimeout(attach, 300);
                setTimeout(attach, 1200);
              }
            },
            "chrome-document-global-created",
            false
          );
        } catch (e) {
          logWarn("Could not observe chrome document creation:", e.message);
        }

        scanOpenPreferencesDocuments();
        Object.keys(PROVIDER_MODEL_PREFS).forEach((key) => {
          getProviderModels(key).catch((e) => {
            logWarnOnce(`prefetch:${key}`, `Could not prefetch ${key} models:`, e.message);
          });
        });
      }

      return {
        getWindowMediator,
        getModelsListUrl,
        fetchJsonOnce,
        normalizeModelId,
        normalizeModelRows,
        fetchOpenAIStyleModelRows,
        fetchGeminiNativeModelRows,
        fetchProviderModels,
        getProviderModels,
        createXulMenuItem,
        getMenuPopup,
        findModelMenulist,
        populateModelMenulist,
        fillModelDropdownsInDocument,
        isSettingsDocument,
        collectPreferencesDocumentsFromWindow,
        collectAllPreferencesDocuments,
        watchPreferencesDocument,
        tryAttachPreferencesFromWindow,
        scanOpenPreferencesDocuments,
        refreshAndPopulateAllModelDropdowns,
        providerKeyFromPrefName,
        setupModelListSync
      };
    }
  };
})();

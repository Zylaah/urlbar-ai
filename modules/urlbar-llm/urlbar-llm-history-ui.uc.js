// ==UserScript==
// @include   main
// @loadOrder 9
// @ignorecache
// ==/UserScript==

// urlbar-llm-history-ui.uc.js — urlbar history picker rows
(function () {
  "use strict";

  if (location.href !== "chrome://browser/content/browser.xhtml") return;

  window.urlbarLlmHistoryUi = {
    create(deps) {
      if (!deps?.prefs || !deps?.state || !deps?.api) {
        console.error("[URLBar LLM] urlbarLlmHistoryUi: missing deps");
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
      /**
       * Prefer `.urlbarView-results` under the active `.urlbarView` (same as the conversation
       * container). Using `#urlbar-results` first breaks on Zen/Fx when rows are reparented under
       * an inner `.urlbarView-results`, so strict direct-child checks failed to find history rows.
       */
      function getUrlbarResultsElement() {
        const urlbarView = document.querySelector(".urlbarView");
        if (urlbarView) {
          const inner = urlbarView.querySelector(".urlbarView-results");
          if (inner) {
            return inner;
          }
        }
        return document.querySelector("#urlbar-results") || document.querySelector(".urlbarView-results");
      }

      function removeLlmHistoryRowsFromResults() {
        const results = getUrlbarResultsElement();
        if (!results) {
          return;
        }
        results
          .querySelectorAll(`.urlbarView-row[${ATTR_LLM_HISTORY_ROW}]`)
          .forEach((el) => el.remove());
      }

      function isShowingHistoryList() {
        const results = getUrlbarResultsElement();
        if (!results) {
          return false;
        }
        return !!results.querySelector(`.urlbarView-row[${ATTR_LLM_HISTORY_ROW}]`);
      }

      function dismissHistoryList(urlbar, urlbarInput) {
        if (!isShowingHistoryList()) {
          return;
        }
        exitToEmptyLlmConversation(urlbar, urlbarInput);
        log("Dismissed history list, back to LLM mode");
      }

      /** Leave the current thread (and history picker) but stay in LLM mode. */
      function exitToEmptyLlmConversation(urlbar, urlbarInput) {
        removeLlmHistoryRowsFromResults();
        const providerKey = urlbar.getAttribute("llm-provider");
        api.discardLiveConversation(providerKey);
        urlbarInput.setAttribute("placeholder", "Ask anything...");
        const urlbarViewBodyInner = document.querySelector(".urlbarView-body-inner");
        if (urlbarViewBodyInner) {
          urlbarViewBodyInner.style.display = "none";
        }
        urlbarInput.focus();
      }

      /**
       * Builds a native urlbar result row (same surface as Firefox / Zen omnibox) for one history session.
       */
      function createNativeHistoryUrlbarRow(session, index, sessions, resultsEl, providerKey, urlbar, urlbarInput) {
        const row = document.createElement("div");
        row.className = "urlbarView-row";
        row.setAttribute("role", "presentation");
        row.setAttribute("type", "history");
        row.setAttribute("row-selectable", "");
        row.setAttribute(ATTR_LLM_HISTORY_ROW, "true");
        row.setAttribute("data-session-index", String(index));

        const rawTitle = session.title || "(untitled conversation)";

        let urlText = "";
        if (session.updatedAt || session.createdAt) {
          const ts = session.updatedAt || session.createdAt;
          try {
            urlText = new Date(ts).toLocaleString();
          } catch (e) {
            urlText = "";
          }
        }
        if (urlText) {
          row.setAttribute("has-url", "");
        }

        const rowInner = document.createElement("span");
        rowInner.className = "urlbarView-row-inner";
        rowInner.setAttribute("role", "option");
        rowInner.setAttribute("selectable", "");

        const noWrap = document.createElement("span");
        noWrap.className = "urlbarView-no-wrap";

        const faviconImg = document.createElement("img");
        faviconImg.className = "urlbarView-favicon";
        faviconImg.src = "chrome://browser/skin/zen-icons/history.svg";
        faviconImg.alt = "";
        faviconImg.setAttribute("aria-hidden", "true");

        const typeIcon = document.createElement("span");
        typeIcon.className = "urlbarView-type-icon";

        const tailPrefix = document.createElement("span");
        tailPrefix.className = "urlbarView-tail-prefix";
        tailPrefix.setAttribute("aria-hidden", "true");
        const tailStr = document.createElement("span");
        tailStr.className = "urlbarView-tail-prefix-string";
        const tailChar = document.createElement("span");
        tailChar.className = "urlbarView-tail-prefix-char";
        tailPrefix.appendChild(tailStr);
        tailPrefix.appendChild(tailChar);

        const titleEl = document.createElement("span");
        titleEl.className = "urlbarView-title urlbarView-overflowable";
        titleEl.setAttribute("dir", "auto");
        titleEl.setAttribute("title", rawTitle);
        titleEl.textContent = rawTitle;

        const tags = document.createElement("span");
        tags.className = "urlbarView-tags urlbarView-overflowable";

        const sep = document.createElement("span");
        sep.className = "urlbarView-title-separator";

        const action = document.createElement("span");
        action.className = "urlbarView-action";

        noWrap.appendChild(faviconImg);
        noWrap.appendChild(typeIcon);
        noWrap.appendChild(tailPrefix);
        noWrap.appendChild(titleEl);
        noWrap.appendChild(tags);
        noWrap.appendChild(sep);
        noWrap.appendChild(action);

        rowInner.appendChild(noWrap);

        if (urlText) {
          const urlEl = document.createElement("span");
          urlEl.className = "urlbarView-url";
          urlEl.textContent = urlText;
          rowInner.appendChild(urlEl);
        }

        const rowButtons = document.createElement("div");
        rowButtons.className = "urlbarView-row-buttons";

        const deleteButton = document.createElement("button");
        deleteButton.type = "button";
        deleteButton.className = "urlbarView-button llm-history-delete-button";
        deleteButton.textContent = "Delete";
        // Keep focus on the urlbar: a focused button would blur #urlbar-input and close the panel.
        deleteButton.addEventListener("mousedown", (e) => {
          e.preventDefault();
        });

        rowButtons.appendChild(deleteButton);
        row.appendChild(rowInner);
        row.appendChild(rowButtons);

        deleteButton.addEventListener("click", async (e) => {
          e.preventDefault();
          e.stopPropagation();
          const idxAttr = row.getAttribute("data-session-index");
          const idx = idxAttr ? parseInt(idxAttr, 10) : NaN;
          if (!Number.isFinite(idx) || idx < 0 || idx >= sessions.length) {
            return;
          }

          const targetId = sessions[idx].id;
          const stash = api.getStashedLiveConversation(providerKey);
          const deletedCurrent =
            state.currentSessionId === targetId ||
            (stash && stash.sessionId === targetId);

          try {
            await api.deleteSessionById(targetId);
            state.deletedSessionIds.add(targetId);
          } catch (err) {
            logWarn("Failed to delete session:", err);
            return;
          }

          row.remove();
          sessions.splice(idx, 1);

          const remainingItems = resultsEl.querySelectorAll(`.urlbarView-row[${ATTR_LLM_HISTORY_ROW}]`);
          remainingItems.forEach((el, newIndex) => {
            el.setAttribute("data-session-index", String(newIndex));
          });

          log("Deleted history session from provider:", providerKey, "session id:", targetId);

          if (deletedCurrent || !sessions.length) {
            api.discardLiveConversation(providerKey);
          }

          if (!sessions.length) {
            removeLlmHistoryRowsFromResults();
            urlbarInput.setAttribute("placeholder", "Ask anything...");
            const urlbarViewBodyInner = document.querySelector(".urlbarView-body-inner");
            if (urlbarViewBodyInner) {
              urlbarViewBodyInner.style.display = "none";
            }
          }

          requestAnimationFrame(() => {
            urlbar.setAttribute("open", "true");
            urlbar.setAttribute("breakout-extend", "true");
            urlbarInput.focus({ preventScroll: true });
          });
        });

        row.addEventListener("click", (e) => {
          if (e.target.closest("button")) {
            return;
          }
          const idxAttr = row.getAttribute("data-session-index");
          const idx = idxAttr ? parseInt(idxAttr, 10) : NaN;
          if (Number.isFinite(idx) && idx >= 0 && idx < sessions.length) {
            state.historyIndex = idx;
            state.lastHistoryProviderKey = providerKey;
            api.loadSessionIntoCurrentConversation(sessions[idx], urlbar, urlbarInput);
          }
        });

        return row;
      }

      async function showHistoryListForProvider(providerKey, urlbar, urlbarInput) {
        const sessions = await api.getProviderSessions(providerKey);
        if (!sessions.length) {
          log("No stored LLM history sessions to show for provider:", providerKey);
          return;
        }

        const resultsEl = getUrlbarResultsElement();
        if (!resultsEl) {
          logError("showHistoryListForProvider: no .urlbarView-results");
          return;
        }

        removeLlmHistoryRowsFromResults();

        if (state.conversationContainer && state.conversationContainer.parentNode) {
          state.conversationContainer.remove();
          state.conversationContainer = null;
        }

        sessions.forEach((session, index) => {
          resultsEl.appendChild(
            createNativeHistoryUrlbarRow(session, index, sessions, resultsEl, providerKey, urlbar, urlbarInput)
          );
        });

        const urlbarViewBodyInner = document.querySelector(".urlbarView-body-inner");
        if (urlbarViewBodyInner) {
          urlbarViewBodyInner.style.display = "";
        }

        urlbar.setAttribute("llm-mode-active", "true");
        urlbar.setAttribute("llm-provider", providerKey);
        urlbarInput.setAttribute("placeholder", "Select a conversation or ask a new question...");
        urlbarInput.focus();
      }

      return {
        getUrlbarResultsElement,
        removeLlmHistoryRowsFromResults,
        isShowingHistoryList,
        dismissHistoryList,
        exitToEmptyLlmConversation,
        createNativeHistoryUrlbarRow,
        showHistoryListForProvider
      };
    }
  };
})();

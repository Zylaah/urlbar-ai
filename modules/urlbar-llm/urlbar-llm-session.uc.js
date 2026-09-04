// ==UserScript==
// @include   main
// @loadOrder 6
// @ignorecache
// ==/UserScript==

// urlbar-llm-session.uc.js — live stash/restore, compression, save
(function () {
  "use strict";

  if (location.href !== "chrome://browser/content/browser.xhtml") return;

  window.urlbarLlmSession = {
    create(deps) {
      if (!deps?.prefs || !deps?.state || !deps?.api) {
        console.error("[URLBar LLM] urlbarLlmSession: missing deps");
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
       * Persist partial assistant text when a stream is cancelled mid-response.
       */
      function commitPartialAssistantToHistory(buffer) {
        const text = (buffer || "").trim();
        if (!text) {
          return;
        }
        const last = state.conversationHistory[state.conversationHistory.length - 1];
        if (last?.role === "assistant") {
          if ((last.content || "").trim() === text) {
            return;
          }
          last.content = buffer;
          log("Updated partial assistant response in conversation history");
          return;
        }
        if (last?.role === "user") {
          state.conversationHistory.push({ role: "assistant", content: buffer });
          log("Committed partial assistant response to conversation history");
        }
      }

      /**
       * Stop the active stream. When persistPartial is true, save buffered tokens first
       * (superseded turn, deactivate, or explicit cancel).
       */
      function interruptLlmStream({ persistPartial = false } = {}) {
        if (!state.llmStream) {
          return;
        }
        const { controller, buffer } = state.llmStream;
        if (persistPartial) {
          commitPartialAssistantToHistory(buffer);
        }
        try {
          controller.abort();
        } catch (e) {}
        state.llmStream = null;
      }

      /**
       * Start a new LLM stream. Any in-flight stream is interrupted and its partial text is saved.
       * @returns {{ signal: AbortSignal, generation: number }}
       */
      function beginLlmStream() {
        interruptLlmStream({ persistPartial: true });
        const generation = ++state.llmStreamGeneration;
        const controller = new AbortController();
        state.llmStream = { controller, buffer: "", generation };
        return { signal: controller.signal, generation };
      }

      /** Release the stream handle for a completed or abandoned turn. */
      function endLlmStream(generation) {
        if (state.llmStream?.generation === generation) {
          state.llmStream = null;
        }
      }

      /**
       * Drop the in-memory live conversation for a provider (stash, session id, rendered thread).
       * Does not touch the history-list rows; callers hide the panel if needed.
       */
      function discardLiveConversation(providerKey) {
        if (providerKey) {
          delete state.liveConversationsByProvider[providerKey];
        }
        state.conversationHistory = [];
        resetConversationContextSummary();
        state.currentSessionId = null;
        state.historyIndex = -1;
        if (state.conversationContainer && state.conversationContainer.parentNode) {
          state.conversationContainer.remove();
        }
        state.conversationContainer = null;
      }

      /**
       * Stash the live conversation together with the stored session id it belongs to.
       * Keeping the id is what prevents a restored conversation from being written back
       * to history as a brand new (duplicate) session on the next save.
       */
      function stashLiveConversation(providerKey) {
        if (!providerKey || !state.conversationHistory.length) {
          return;
        }
        state.liveConversationsByProvider[providerKey] = {
          messages: api.snapshotConversationHistory(),
          sessionId: state.currentSessionId
        };
        log("Stashed live conversation for provider:", providerKey, "messages:", state.conversationHistory.length, "sessionId:", state.currentSessionId);
      }

      /** Normalize legacy stash format (plain message array) to `{ messages, sessionId }` */
      function getStashedLiveConversation(providerKey) {
        const stored = state.liveConversationsByProvider[providerKey];
        if (!stored) {
          return null;
        }
        if (Array.isArray(stored)) {
          return { messages: stored, sessionId: null };
        }
        return stored;
      }

      function restoreLiveConversation(providerKey) {
        const stored = getStashedLiveConversation(providerKey);
        if (!stored || !stored.messages || !stored.messages.length) {
          return false;
        }
        if (stored.sessionId && state.deletedSessionIds.has(stored.sessionId)) {
          delete state.liveConversationsByProvider[providerKey];
          return false;
        }
        state.conversationHistory = stored.messages.map(api.cloneHistoryEntry);
        // Reuse the session this conversation was already saved under, so re-entering
        // LLM mode and continuing updates that session instead of forking a copy.
        state.currentSessionId = stored.sessionId || null;
        renderConversationFromHistory();
        log("Restored live conversation for provider:", providerKey, "messages:", state.conversationHistory.length, "sessionId:", state.currentSessionId);

        // If this thread was deleted from history, drop the leftover stash instead of resurrecting it.
        if (stored.sessionId) {
          api.sessionExistsById(stored.sessionId).then((exists) => {
            if (exists) {
              return;
            }
            if (state.currentSessionId !== stored.sessionId) {
              return;
            }
            log("Discarding restored conversation; session was deleted:", stored.sessionId);
            state.deletedSessionIds.add(stored.sessionId);
            discardLiveConversation(providerKey);
            const urlbarInput = document.getElementById("urlbar-input");
            if (urlbarInput) {
              urlbarInput.setAttribute("placeholder", "Ask anything...");
            }
            const urlbarViewBodyInner = document.querySelector(".urlbarView-body-inner");
            if (urlbarViewBodyInner && !api.isShowingHistoryList()) {
              urlbarViewBodyInner.style.display = "none";
            }
          }).catch(() => {});
        }
        return true;
      }

      function renderConversationFromHistory() {
        if (!state.conversationHistory.length) {
          return;
        }
        if (state.conversationContainer && state.conversationContainer.parentNode) {
          state.conversationContainer.remove();
        }
        state.conversationContainer = api.createConversationContainer();
        if (!state.conversationContainer) {
          return;
        }
        let lastAssistantSources = null;
        for (const msg of state.conversationHistory) {
          if (!msg || !msg.content) {
            continue;
          }
          if (msg.role === "user") {
            renderUserMessageFromHistory(msg.content);
          } else if (msg.role === "assistant") {
            const stored =
              msg.sources && Array.isArray(msg.sources) && msg.sources.length > 0 ? msg.sources : null;
            const pillsSources = stored || lastAssistantSources;
            renderAssistantMessageFromHistory(msg.content, pillsSources);
            if (stored) {
              lastAssistantSources = stored;
            }
          }
        }
        const urlbarViewBodyInner = document.querySelector(".urlbarView-body-inner");
        if (urlbarViewBodyInner) {
          urlbarViewBodyInner.style.display = "";
        }
      }

      function buildApiMessagesFromHistory(apiHistory, searchContext) {
        const toApiMessage = (m) => ({ role: m.role, content: m.content });
        const languageSystemMessage = { role: "system", content: LANGUAGE_SYSTEM_INSTRUCTION };
        if (searchContext) {
          const lastUserMessageIndex = apiHistory.length - 1;
          return [
            languageSystemMessage,
            ...apiHistory.slice(0, lastUserMessageIndex).map(toApiMessage),
            { role: "system", content: searchContext },
            toApiMessage(apiHistory[lastUserMessageIndex])
          ];
        }
        return [languageSystemMessage, ...apiHistory.map(toApiMessage)];
      }

      function resetConversationContextSummary() {
        state.conversationContextSummary = null;
        state.conversationContextSummaryEndIndex = 0;
        state.lastSessionSearchQuery = null;
      }

      function isContextCompressionEnabled() {
        return getPref("extension.urlbar-llm.context-compression-enabled", true);
      }

      function getContextCharBudget() {
        const pref = getPref("extension.urlbar-llm.context-char-budget", LIMITS.CONTEXT_CHAR_BUDGET);
        return Number.isFinite(pref) && pref > 4000 ? pref : LIMITS.CONTEXT_CHAR_BUDGET;
      }

      function getContextRecentMessages() {
        const pref = getPref("extension.urlbar-llm.context-recent-messages", LIMITS.CONTEXT_RECENT_MESSAGES);
        return Number.isFinite(pref) && pref >= 2 ? Math.floor(pref) : LIMITS.CONTEXT_RECENT_MESSAGES;
      }

      function estimateHistoryChars(messages) {
        if (!messages || !messages.length) {
          return 0;
        }
        return messages.reduce((sum, m) => sum + (typeof m.content === "string" ? m.content.length : 0), 0);
      }

      function clipTextForSummary(text, maxLen) {
        if (!text || text.length <= maxLen) {
          return text || "";
        }
        return text.slice(0, maxLen) + "…";
      }

      function formatTranscriptForSummary(messages) {
        return messages
          .map((m) => {
            const role = m.role === "assistant" ? "Assistant" : "User";
            const body = clipTextForSummary(m.content || "", LIMITS.CONTEXT_SUMMARY_INPUT_MAX);
            return `${role}: ${body}`;
          })
          .join("\n\n");
      }


      /**
       * Summarize older turns for rolling context compression.
       * @param {Array<{role: string, content: string}>} messages
       * @param {AbortSignal|null} signal
       * @returns {Promise<string>}
       */
      async function summarizeConversationMessages(messages, signal = null) {
        const transcript = formatTranscriptForSummary(messages);
        if (!transcript.trim()) {
          return "";
        }

        const summaryPrompt = [
          {
            role: "system",
            content:
              "You compress chat history so a language model can continue the conversation within a limited context window. " +
              "Produce a faithful summary preserving: user goals, constraints, decisions, proper names, technical terms, language/locale, and open questions. " +
              "Omit greetings, filler, and duplicated explanations. Use the same language as most of the transcript. " +
              "Use concise prose or bullet points. Do not invent facts not present in the transcript."
          },
          {
            role: "user",
            content: `Summarize this conversation:\n\n${transcript}`
          }
        ];

        return api.completeChatNonStreaming(summaryPrompt, signal, {
          maxTokens: LIMITS.CONTEXT_SUMMARY_MAX_TOKENS,
          temperature: 0.2
        });
      }

      /**
       * If history exceeds budget, replace older turns with a cached rolling summary + recent verbatim window.
       * Full transcript remains in state.conversationHistory / UI; only the API payload is compressed.
       * @param {Array<{role: string, content: string}>} apiHistory
       * @param {AbortSignal|null} signal
       * @param {HTMLElement|null} statusElement
       * @returns {Promise<Array<{role: string, content: string}>>}
       */
      async function prepareHistoryForApi(apiHistory, signal = null, statusElement = null) {
        if (!isContextCompressionEnabled() || !apiHistory || apiHistory.length === 0) {
          return apiHistory;
        }

        const recentKeep = getContextRecentMessages();
        const budget = getContextCharBudget();
        const totalChars = estimateHistoryChars(apiHistory);

        if (apiHistory.length <= recentKeep || totalChars <= budget) {
          return apiHistory;
        }

        const recentStart = apiHistory.length - recentKeep;
        const recentPart = apiHistory.slice(recentStart);
        const oldPart = apiHistory.slice(0, recentStart);
        if (!oldPart.length) {
          return apiHistory;
        }

        let summary = state.conversationContextSummary;
        if (!summary || state.conversationContextSummaryEndIndex !== recentStart) {
          log(
            "Context compression: summarizing",
            oldPart.length,
            "messages (",
            estimateHistoryChars(oldPart),
            "chars); keeping",
            recentPart.length,
            "recent"
          );
          if (statusElement) {
            statusElement.innerHTML =
              '<span class="llm-status-line"><span class="llm-search-spinner"></span> Condensing conversation...</span>';
          }
          try {
            summary = await summarizeConversationMessages(oldPart, signal);
            if (!summary) {
              throw new Error("Empty summary");
            }
            state.conversationContextSummary = summary;
            state.conversationContextSummaryEndIndex = recentStart;
            log("Context compression: summary cached for", recentStart, "messages (", summary.length, "chars)");
          } catch (err) {
            if (err.name === "AbortError") {
              throw err;
            }
            logWarn("Context compression failed, using truncated fallback:", err.message);
            summary = formatTranscriptForSummary(
              oldPart.map((m) => ({
                role: m.role,
                content: clipTextForSummary(m.content || "", 800)
              }))
            );
            state.conversationContextSummary = summary;
            state.conversationContextSummaryEndIndex = recentStart;
          }
        } else {
          log("Context compression: reusing cached summary for", recentStart, "messages");
        }

        return [{ role: "system", content: `${CONTEXT_SUMMARY_HEADER}\n\n${summary}` }, ...recentPart];
      }

      function buildSessionFromConversation(urlbar) {
        if (!state.conversationHistory || state.conversationHistory.length === 0) {
          log("Skipped building history session: empty state.conversationHistory");
          return null;
        }

        const providerKey = urlbar.getAttribute("llm-provider") || (state.currentProvider && Object.entries(CONFIG.providers).find(([key, p]) => p === state.currentProvider)?.[0]);
        if (!providerKey) {
          log("Skipped building history session: missing providerKey");
          return null;
        }

        // Find first non-empty user message for title
        let title = "";
        for (const msg of state.conversationHistory) {
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
        const msgs = state.conversationHistory
          .slice(-HISTORY_MAX_MESSAGES_PER_SESSION)
          .map((m) => {
            const out = { role: m.role, content: api.truncateContent(m.content) }; // truncateContent only caps at 500k as safety
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
        const id = state.currentSessionId || `${now}-${Math.random().toString(36).slice(2, 8)}`;
        return {
          id,
          providerKey,
          createdAt: state.currentSessionId ? undefined : now,
          updatedAt: now,
          title,
          messages: msgs
        };
      }

      /**
       * Persist the current conversation. When no session id is known (e.g. the conversation
       * was restored after leaving and re-entering LLM mode), reuse the stored session this
       * conversation already belongs to instead of writing a duplicate.
       * @returns {Promise<string|null>} the session id it was saved under
       */
      async function maybeSaveConversationToHistory(urlbar) {
        const session = buildSessionFromConversation(urlbar);
        if (!session) {
          log("History not saved: no session built from conversation");
          return null;
        }

        const fingerprintAtCall = api.messagesFingerprint(session.messages);

        if (state.deletedSessionIds.has(session.id)) {
          log("History not saved: session was deleted", session.id);
          return null;
        }

        if (!state.currentSessionId) {
          const existingId = await api.findExistingSessionIdForMessages(session.providerKey, session.messages);
          if (existingId) {
            if (state.deletedSessionIds.has(existingId)) {
              log("History not saved: matching session was deleted", existingId);
              return null;
            }
            session.id = existingId;
            session.createdAt = undefined; // putSession keeps the stored createdAt
            log("Reusing existing history session instead of creating a duplicate:", existingId);
          }
        }

        // Only adopt the id if the live conversation is still this one; a deactivate or a
        // history switch may have happened while the lookup above was pending.
        if (api.isSameOrEarlierConversation(fingerprintAtCall, api.messagesFingerprint(state.conversationHistory))) {
          state.currentSessionId = session.id;
        }

        // Keep any stashed copy pointing at the same session, so restoring it later updates it.
        const stash = getStashedLiveConversation(session.providerKey);
        if (stash && api.isSameOrEarlierConversation(fingerprintAtCall, api.messagesFingerprint(stash.messages))) {
          stash.sessionId = session.id;
          state.liveConversationsByProvider[session.providerKey] = stash;
        }

        await api.putSession(session);
        return session.id;
      }

      function renderUserMessageFromHistory(message) {
        if (!state.conversationContainer || !state.conversationContainer.parentNode) {
          state.conversationContainer = api.createConversationContainer();
          if (!state.conversationContainer) {
            return;
          }
        }
        const messageDiv = document.createElement("div");
        messageDiv.className = "llm-message llm-message-user";
        messageDiv.textContent = message;
        state.conversationContainer.appendChild(messageDiv);
      }

      function renderAssistantMessageFromHistory(message, sources) {
        if (!state.conversationContainer || !state.conversationContainer.parentNode) {
          state.conversationContainer = api.createConversationContainer();
          if (!state.conversationContainer) {
            return;
          }
        }

        const messageDiv = document.createElement("div");
        messageDiv.className = "llm-message llm-message-assistant";

        const contentDiv = document.createElement("div");
        contentDiv.className = "llm-message-content";

        api.renderMarkdownToElement(message, contentDiv);

        messageDiv.appendChild(contentDiv);
        state.conversationContainer.appendChild(messageDiv);
        if (sources && sources.length > 0) {
          messageDiv.dataset.citationSources = JSON.stringify(sources);
          api.injectFaviconsIntoCitationMarkers(messageDiv, sources);
        }
      }

      function loadSessionIntoCurrentConversation(session, urlbar, urlbarInput) {
        if (!session || !Array.isArray(session.messages)) {
          return;
        }

        resetConversationContextSummary();

        interruptLlmStream({ persistPartial: false });

        if (state.streamingResultRow) {
          state.streamingResultRow.remove();
          state.streamingResultRow = null;
        }

        api.removeLlmHistoryRowsFromResults();

        // Reset conversation container
        if (state.conversationContainer && state.conversationContainer.parentNode) {
          state.conversationContainer.remove();
        }
        state.conversationContainer = api.createConversationContainer();
        if (!state.conversationContainer) {
          return;
        }

        // Track this session so on deactivate we update it instead of creating a new one
        state.currentSessionId = session.id || null;

        // Replace in-memory history (keep sources for assistant messages; normalize structure for compatibility)
        state.conversationHistory = session.messages.map((m) => {
          const out = { role: m.role, content: m.content };
          if (m.role === "assistant" && m.sources && m.sources.length > 0) {
            out.sources = m.sources.map((s) => ({
              title: s.title,
              url: s.url || s.href || s.link,
              source: s.source,
              index: s.index
            })).filter((s) => s.url);
          }
          return out;
        });

        // Render messages (citation pills: follow-up assistants often have no `sources` in JSON when
        // there was no new web search — reuse the previous assistant's sources for favicon injection)
        let lastAssistantSources = null;
        for (const msg of state.conversationHistory) {
          if (!msg || !msg.content) {
            continue;
          }
          if (msg.role === "user") {
            renderUserMessageFromHistory(msg.content);
          } else if (msg.role === "assistant") {
            const stored =
              msg.sources && Array.isArray(msg.sources) && msg.sources.length > 0 ? msg.sources : null;
            const pillsSources = stored || lastAssistantSources;
            renderAssistantMessageFromHistory(msg.content, pillsSources);
            if (stored) {
              lastAssistantSources = stored;
            }
          }
        }

        // Ensure LLM mode visuals are active
        urlbar.setAttribute("llm-mode-active", "true");
        urlbar.setAttribute("llm-provider", session.providerKey);
        urlbarInput.setAttribute("placeholder", "Ask a follow-up...");
        urlbarInput.focus();
      }

      return {
        commitPartialAssistantToHistory,
        interruptLlmStream,
        beginLlmStream,
        endLlmStream,
        discardLiveConversation,
        stashLiveConversation,
        getStashedLiveConversation,
        restoreLiveConversation,
        renderConversationFromHistory,
        buildApiMessagesFromHistory,
        resetConversationContextSummary,
        isContextCompressionEnabled,
        getContextCharBudget,
        getContextRecentMessages,
        estimateHistoryChars,
        clipTextForSummary,
        formatTranscriptForSummary,
        summarizeConversationMessages,
        prepareHistoryForApi,
        buildSessionFromConversation,
        maybeSaveConversationToHistory,
        renderUserMessageFromHistory,
        renderAssistantMessageFromHistory,
        loadSessionIntoCurrentConversation
      };
    }
  };
})();

// ==UserScript==
// @include   main
// @loadOrder 2
// @ignorecache
// ==/UserScript==

// urlbar-llm-store.uc.js — mutable session state for one browser window
(function () {
  "use strict";

  if (location.href !== "chrome://browser/content/browser.xhtml") return;

  window.urlbarLlmStore = {
    createStore() {
      return {
        isLLMMode: false,
        currentProvider: null,
        currentQuery: "",
        streamingResultRow: null,
        llmStream: null,
        llmStreamGeneration: 0,
        originalPlaceholder: "",
        isClickingLink: false,
        isSelectingInContainer: false,
        conversationHistory: [],
        liveConversationsByProvider: {},
        conversationContainer: null,
        currentSearchSources: [],
        historyIndex: -1,
        lastHistoryProviderKey: null,
        currentSessionId: null,
        deletedSessionIds: new Set(),
        conversationContextSummary: null,
        conversationContextSummaryEndIndex: 0,
        lastSessionSearchQuery: null,
        initialized: false
      };
    }
  };
})();

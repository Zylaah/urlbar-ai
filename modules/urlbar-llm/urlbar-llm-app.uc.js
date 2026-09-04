// ==UserScript==
// @include   main
// @loadOrder 10
// @ignorecache
// ==/UserScript==

// urlbar-llm-app.uc.js — activate/deactivate, keys, send
(function () {
  "use strict";

  if (location.href !== "chrome://browser/content/browser.xhtml") return;

  window.urlbarLlmApp = {
    create(deps) {
      if (!deps?.prefs || !deps?.state || !deps?.api) {
        console.error("[URLBar LLM] urlbarLlmApp: missing deps");
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
      function init() {
        // Check if enabled
        if (!isEnabled()) {
          return;
        }

        loadConfig();
        api.setupModelListSync();

        // Migrate from JSON file to IndexedDB on first run
        api.migrateFromFileIfNeeded().catch(() => {});

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
          if (state.isSelectingInContainer) {
            state.isSelectingInContainer = false;
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
          if (state.isSelectingInContainer) {
            state.isSelectingInContainer = false;
            api.restoreNativeBlur();
          }
          
          if (state.isLLMMode) {
            // Update query while in LLM mode
            state.currentQuery = inputValue;
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
          if (state.isLLMMode) {
            e.stopPropagation();
            log("Paste event captured in LLM mode");
          }
        }, true);

        // Listen for Tab key to activate
        urlbarInput.addEventListener("keydown", (e) => {
          if (e.key === "Tab" && !state.isLLMMode) {
            const match = inputValue.match(/^\/(\w+)(\s|$)/);
            if (match) {
              e.preventDefault();
              e.stopPropagation();
              
              const providerKey = match[1].toLowerCase();
              if (CONFIG.providers[providerKey]) {
                activateLLMMode(urlbar, urlbarInput, providerKey);
              }
            }
          } else if (e.key === "Enter" && state.isLLMMode && !e.shiftKey) {
            e.preventDefault();
            e.stopPropagation();
            
            // Send query to LLM (follow-up or new)
            const query = state.currentQuery;
            if (query.trim()) {
              // If history list is visible, we're starting a new conversation (not opening one); clear list and session id
              const wasShowingHistoryList = api.isShowingHistoryList();
              if (wasShowingHistoryList) {
                api.removeLlmHistoryRowsFromResults();
                state.currentSessionId = null;
                state.conversationHistory = [];
                api.resetConversationContextSummary();
                // Drop the stashed live conversation too: this is a brand new conversation,
                // and a leftover stash would later be restored and re-saved as a copy.
                const activeProviderKey = urlbar.getAttribute("llm-provider");
                if (activeProviderKey) {
                  delete state.liveConversationsByProvider[activeProviderKey];
                }
              }

              // Add user message to conversation
              state.conversationHistory.push({
                role: "user",
                content: query
              });
              // Snapshot before any async work so blur/deactivate cannot wipe context mid-request
              const historyForApi = api.snapshotConversationHistory();
              
              // Clear the input immediately after sending
              state.currentQuery = "";
              urlbarInput.value = "";
              
              // Update placeholder for follow-ups
              urlbarInput.setAttribute("placeholder", "Ask a follow-up...");
              
              // Display user message and send to LLM
              api.displayUserMessage(query);
              // Reset history navigation when sending a new message
              state.historyIndex = -1;
              state.lastHistoryProviderKey = urlbar.getAttribute("llm-provider") || null;
              sendToLLM(urlbar, urlbarInput, query, historyForApi);
            }
          } else if (e.key === "Escape" && state.isLLMMode) {
            e.preventDefault();
            e.stopPropagation();
            // Exit LLM mode but keep urlbar open (like Backspace on empty input)
            deactivateLLMMode(urlbar, urlbarInput, false);
          } else if ((e.key === "Delete" || e.key === "Backspace") && state.isLLMMode) {
            // Exit LLM mode if input is empty and user presses Delete/Backspace
            const currentValue = urlbarInput.value || "";
            if (currentValue.trim() === "") {
              e.preventDefault();
              e.stopPropagation();
              deactivateLLMMode(urlbar, urlbarInput, false);
            }
          }
        }, true);

        // Alt+ArrowUp: window capture so history toggles while focus is on the conversation
        // (or copy buttons), not only on #urlbar-input — same as native shortcuts eating keydown.
        window.addEventListener(
          "keydown",
          (e) => {
            if (!state.isLLMMode || !e.altKey || e.key !== "ArrowUp") {
              return;
            }
            e.preventDefault();
            e.stopImmediatePropagation();
            if (api.isShowingHistoryList()) {
              log("Alt+ArrowUp dismissed history list");
              api.dismissHistoryList(urlbar, urlbarInput);
              return;
            }
            const providerKey = urlbar.getAttribute("llm-provider");
            if (!providerKey) {
              log("Alt+ArrowUp: no providerKey on urlbar");
              return;
            }
            api.getProviderSessions(providerKey).then((sessions) => {
              if (sessions.length) {
                log("Alt+ArrowUp showing history list for provider:", providerKey, "with", sessions.length, "sessions");
                api.showHistoryListForProvider(providerKey, urlbar, urlbarInput);
                return;
              }
              if (state.conversationHistory.length || state.conversationContainer) {
                log("Alt+ArrowUp: no stored sessions, leaving current conversation");
                api.exitToEmptyLlmConversation(urlbar, urlbarInput);
                return;
              }
              log("Alt+ArrowUp: no stored sessions for provider:", providerKey);
            });
          },
          true
        );

        // Clean up on blur (when urlbar loses focus)
        urlbarInput.addEventListener("blur", (e) => {
          // Don't deactivate if clicking a link or selecting text
          if (state.isClickingLink) {
            log("Blur ignored - clicking link");
            return;
          }
          if (state.isSelectingInContainer) {
            log("Blur ignored - selecting text in container");
            return;
          }
          
          // Don't deactivate if clicking inside the conversation container
          const llmContainer = document.querySelector(".llm-conversation-container");
          
          setTimeout(() => {
            // Double check we're not clicking a link or selecting text
            if (state.isClickingLink) {
              log("Blur ignored in timeout - clicking link");
              return;
            }
            if (state.isSelectingInContainer) {
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
            
            const onHistoryRow =
              (activeElement && activeElement.closest && activeElement.closest(`.urlbarView-row[${ATTR_LLM_HISTORY_ROW}]`)) ||
              (relatedTarget && relatedTarget.closest && relatedTarget.closest(`.urlbarView-row[${ATTR_LLM_HISTORY_ROW}]`));

            const clickedInsideLLM =
              (llmContainer &&
                (llmContainer.contains(activeElement) ||
                  llmContainer.contains(relatedTarget))) ||
              isLinkClick ||
              !!onHistoryRow;
            
            if (document.activeElement !== urlbarInput && state.isLLMMode && !clickedInsideLLM) {
              if (urlbar.hasAttribute("is-llm-thinking")) {
                log("Blur ignored - LLM request in progress");
                return;
              }
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
                if (state.isClickingLink || state.isSelectingInContainer) {
                  log("View hide ignored - clicking link or selecting text");
                  return;
                }
                const overLlmContent =
                  document.querySelector(".llm-conversation-container:hover") ||
                  document.querySelector(`.urlbarView-row[${ATTR_LLM_HISTORY_ROW}]:hover`);
                if (urlbarView.hidden && state.isLLMMode && !overLlmContent) {
                  if (urlbar.hasAttribute("is-llm-thinking")) {
                    log("View hide ignored - LLM request in progress");
                    return;
                  }
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
              if (!urlbar.hasAttribute("open") && state.isLLMMode) {
                if (state.isClickingLink || state.isSelectingInContainer) {
                  log("Urlbar close ignored - clicking link or selecting text");
                  return;
                }
                const overLlmContent =
                  document.querySelector(".llm-conversation-container:hover") ||
                  document.querySelector(`.urlbarView-row[${ATTR_LLM_HISTORY_ROW}]:hover`);
                if (!overLlmContent) {
                  if (urlbar.hasAttribute("is-llm-thinking")) {
                    log("Urlbar close ignored - LLM request in progress");
                    return;
                  }
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
          if (!state.isLLMMode && !api.isShowingHistoryList()) return;
          // Do not skip when state.isSelectingInContainer: after focusing the conversation
          // for copy/selection that flag stays true until input focus, which blocks
          // cleanup when the user clicks the page to dismiss the urlbar.
          // Do not skip when state.isClickingLink: link opens in a background tab and this flag
          // stays true for FOCUS_RESTORE_DELAY; an outside click should still dismiss LLM.

          const target = e.target;
          const urlbarView = document.querySelector(".urlbarView");
          const clickedInsideUrlbar = urlbar && urlbar.contains(target);
          const clickedInsideView = urlbarView && urlbarView.contains(target);
          if (clickedInsideUrlbar || clickedInsideView) return;

          log("Outside click detected, deactivating LLM mode and resetting urlbar");
          deactivateLLMMode(urlbar, urlbarInput, true);
        }, true);

        // Window blur: when browser loses focus (user clicks another app), ensure cleanup.
        // Fixes stuck state on first load when urlbar blur can miss or race.
        window.addEventListener("blur", function windowBlurHandler() {
          if (!state.isLLMMode || state.isClickingLink || state.isSelectingInContainer) return;
          const u = document.getElementById("urlbar");
          const ui = document.getElementById("urlbar-input");
          if (!u || !ui) return;
          setTimeout(() => {
            if (state.isLLMMode && document.activeElement !== ui) {
              log("Window blur deactivating LLM mode");
              deactivateLLMMode(u, ui, true);
            }
          }, LIMITS.BLUR_DELAY + 50);
        });
      }

      function showActivationHint(urlbar, providerKey) {
        const provider = CONFIG.providers[providerKey];
        // Could show a visual hint here
        urlbar.setAttribute("llm-hint", provider.name);
      }

      function activateLLMMode(urlbar, urlbarInput, providerKey) {
        loadConfig();
        state.isLLMMode = true;
        state.currentProvider = CONFIG.providers[providerKey];
        
        // Remove "/provider" from input and store query
        const newValue = urlbarInput.value.replace(/^\/\w+\s*/, "").trim();
        urlbarInput.value = newValue;
        state.currentQuery = newValue;
        
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
        labelBox.textContent = state.currentProvider.name;
        labelBox.hidden = false;
        labelBox.style.display = "inline-block";
        
        // Save and change placeholder text
        state.originalPlaceholder = urlbarInput.getAttribute("placeholder") || "";
        const restoredLive = api.restoreLiveConversation(providerKey);
        // Use different placeholder for follow-ups vs initial query
        const placeholder =
          state.conversationHistory.length > 0 ? "Ask a follow-up..." : "Ask anything...";
        urlbarInput.setAttribute("placeholder", placeholder);
        
        // Hide native suggestions completely
        const urlbarView = document.querySelector(".urlbarView");
        if (urlbarView) {
          urlbarView.setAttribute("llm-mode-suppress-results", "true");
        }
        
        // Only hide the results container if there's no conversation yet
        if (state.conversationHistory.length === 0 && !restoredLive) {
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
        
        log(`Activated with provider: ${providerKey}, existing messages: ${state.conversationHistory.length}`);
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
        api.maybeSaveConversationToHistory(urlbar).catch((e) => logWarn("History save failed:", e));

        const providerKey = urlbar.getAttribute("llm-provider");
        api.stashLiveConversation(providerKey);

        state.isLLMMode = false;
        state.currentProvider = null;
        state.currentQuery = "";
        
        api.interruptLlmStream({ persistPartial: true });

        state.currentSearchSources = [];
        state.historyIndex = -1;
        state.lastHistoryProviderKey = null;
        state.currentSessionId = null;
        
        // Always restore native blur handler and clear interaction flags on deactivation
        state.isClickingLink = false;
        state.isSelectingInContainer = false;
        api.restoreNativeBlur();
        
        // Clear conversation history
        state.conversationHistory = [];
        api.resetConversationContextSummary();
        
        // Remove conversation container
        if (state.conversationContainer) {
          state.conversationContainer.remove();
          state.conversationContainer = null;
        }

        api.removeLlmHistoryRowsFromResults();

        // Remove streaming result first
        if (state.streamingResultRow) {
          state.streamingResultRow.remove();
          state.streamingResultRow = null;
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
        
        // Restore placeholder (always restore, not just when state.originalPlaceholder exists)
        if (state.originalPlaceholder) {
          urlbarInput.setAttribute("placeholder", state.originalPlaceholder);
        } else {
          // If no original placeholder was saved, remove the custom one
          urlbarInput.removeAttribute("placeholder");
        }
        
        // Reset state.originalPlaceholder for next time
        state.originalPlaceholder = "";
        
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

        // Always remove floating/breakout state – prevents urlbar stuck "half-floating"
        // when blur cleanup runs before gURLBar is ready (e.g. on first load)
        urlbar.removeAttribute("breakout-extend");
        urlbar.removeAttribute("open");

        log("Deactivated");
      }

      async function sendToLLM(urlbar, urlbarInput, query, historyForApi = null) {
        loadConfig();
        if (!state.currentProvider || !query.trim()) {
          return;
        }

        const apiHistory = historyForApi || api.snapshotConversationHistory();
        log(
          "sendToLLM with",
          apiHistory.length,
          "history messages for API (in-memory:",
          state.conversationHistory.length,
          ")"
        );

        // Check API key for non-local providers
        if (state.currentProvider.apiKey !== null && state.currentProvider.apiKey === "") {
          // Try to load from preferences first
          const providerKey = urlbar.getAttribute("llm-provider");
          const prefKey = `extension.urlbar-llm.${providerKey}-api-key`;
          const savedKey = getPref(prefKey, "");
          
          if (savedKey) {
            state.currentProvider.apiKey = savedKey;
          } else {
            // Prompt user if not in preferences
            const key = prompt(`Enter API key for ${state.currentProvider.name} (or set in Sine settings):`);
            if (!key) {
              deactivateLLMMode(urlbar, urlbarInput);
              return;
            }
            state.currentProvider.apiKey = key;
            setPref(prefKey, key);
          }
        }

        // Create streaming result row
        const result = api.createStreamingResultRow();
        if (!result) {
          logError("Failed to create result row");
          return;
        }

        state.streamingResultRow = result.row;
        const titleElement = result.title;

        // Set thinking state
        urlbar.setAttribute("is-llm-thinking", "true");

        const { signal, generation: streamGeneration } = api.beginLlmStream();
        state.currentSearchSources = [];

        try {
          // Perform web search if enabled and the model decides it needs it
          let searchContext = null;
          let searchResultsForDisplay = null;
          const providerKey = urlbar.getAttribute("llm-provider");
          const supportsWebSearch = providerKey === 'openai' || providerKey === 'mistral' || providerKey === 'ollama' || providerKey === 'gemini';
          
          // Ask the LLM itself whether the query is within its knowledge scope
          let needsSearch = false;
          let searchQuery = query;
          let searchQueryFromExplicit = false;
          if (isWebSearchEnabled() && supportsWebSearch) {
            const isFollowUp = apiHistory.length > 1;

            // Follow-up where user explicitly asks to search: skip classifier; query may still be refined below
            if (isFollowUp && api.isExplicitSearchRequest(query)) {
              const resolved = api.resolveExplicitFollowUpSearchQuery(query);
              if (resolved.length > 0) {
                needsSearch = true;
                searchQuery = resolved;
                searchQueryFromExplicit = true;
                log("Explicit search request on follow-up, initial query:", searchQuery);
              }
            }

            if (!needsSearch) {
              titleElement.innerHTML =
                '<span class="llm-status-line"><span class="llm-search-spinner"></span> Evaluating...</span>';
              needsSearch = await api.queryNeedsWebSearchLLM(query, isFollowUp, signal, apiHistory);
            }
          }

          if (needsSearch) {
            if (!searchQueryFromExplicit) {
              titleElement.innerHTML =
                '<span class="llm-status-line"><span class="llm-search-spinner"></span> Planning search...</span>';
              searchQuery = await api.generateWebSearchQueryLLM(query, apiHistory, signal);
            } else if (api.isContextAwareSearchQueryEnabled()) {
              titleElement.innerHTML =
                '<span class="llm-status-line"><span class="llm-search-spinner"></span> Planning search...</span>';
              const refined = await api.generateWebSearchQueryLLM(query, apiHistory, signal);
              if (refined) {
                searchQuery = refined;
              }
            }

            const previousSearchQuery = state.lastSessionSearchQuery;
            state.lastSessionSearchQuery = searchQuery;
            if (searchQuery === previousSearchQuery && previousSearchQuery) {
              log("Search query unchanged from previous turn, reusing cached web results if available");
            }

            titleElement.innerHTML =
              '<span class="llm-status-line"><span class="llm-search-spinner"></span> Searching...</span>';

            log("Web search triggered for query:", searchQuery);
            const startTime = Date.now();
            const searchResults = await api.searchWeb(searchQuery, LIMITS.MAX_SEARCH_RESULTS, providerKey);
            
            if (searchResults && searchResults.length > 0) {
              // Update status - fetching content
              titleElement.innerHTML = '<span class="llm-status-line"><span class="llm-search-spinner"></span> Reading sources...</span>';
              
              // Fetch actual page content from search results (faster now)
              const resultsWithContent = await api.fetchSearchResultsContent(searchResults, 3, providerKey);
              
              // Store for source pills display
              searchResultsForDisplay = resultsWithContent;
              state.currentSearchSources = resultsWithContent;
              
              searchContext = api.formatSearchResultsForLLM(resultsWithContent, searchQuery);
              log('Web search completed in', Date.now() - startTime, 'ms total');
            } else {
              log('Web search returned no results');
            }
          } else if (!supportsWebSearch && isWebSearchEnabled()) {
            log('Web search not supported for provider:', providerKey);
          } else {
            // Clear sources if no search was performed
            state.currentSearchSources = [];
          }

          // Clear spinner and show thinking text
          titleElement.textContent = "Thinking...";

          const historyForPayload = await api.prepareHistoryForApi(
            apiHistory,
            signal,
            titleElement
          );
          const messagesToSend = api.buildApiMessagesFromHistory(historyForPayload, searchContext);
          if (searchContext) {
            log("Added web search context to messages");
          }
          log(
            "API payload:",
            messagesToSend.length,
            "messages (history was",
            apiHistory.length,
            historyForPayload.length !== apiHistory.length ? ", compressed" : "",
            ")"
          );
          
          await api.streamResponse(messagesToSend, titleElement, signal);
          
          // Add assistant's response to conversation history (include sources for history/session store)
          const assistantEntry = {
            role: "assistant",
            content: state.llmStream?.buffer || ""
          };
          if (state.currentSearchSources && state.currentSearchSources.length > 0) {
            assistantEntry.sources = state.currentSearchSources.map((s) => ({
              title: s.title,
              url: s.url,
              source: s.source,
              index: s.index
            }));
          }
          state.conversationHistory.push(assistantEntry);

          // Snapshot for pills: this turn's stored sources, or prior assistant sources (no new search).
          // Do not read `state.currentSearchSources` inside delayed inject — the next user send clears it.
          const sourcesForCitationPills =
            assistantEntry.sources && assistantEntry.sources.length > 0
              ? assistantEntry.sources.map((s) => ({ ...s }))
              : api.getEffectiveCitationSources();
          
          log("Conversation now has", state.conversationHistory.length, "messages");
          
          // Citation favicons: run after layout + debounce tail so the final renderMarkdownToElement
          // pass does not wipe injected <img> nodes.
          const rowToInject = state.streamingResultRow;
          const runCitationInject = () => {
            if (!rowToInject || !rowToInject.isConnected) {
              return;
            }
            if (!rowToInject.querySelector(".llm-citation-marker")) {
              return;
            }
            if (!sourcesForCitationPills.length) {
              return;
            }
            rowToInject.dataset.citationSources = JSON.stringify(sourcesForCitationPills);
            api.injectFaviconsIntoCitationMarkers(rowToInject, sourcesForCitationPills);
          };
          requestAnimationFrame(() => {
            requestAnimationFrame(runCitationInject);
          });
          setTimeout(runCitationInject, LIMITS.RENDER_DEBOUNCE + 80);

          // Persist conversation after each assistant response (and on deactivate)
          api.maybeSaveConversationToHistory(urlbar).catch((e) => logWarn("History save failed:", e));
          const activeProviderKey = urlbar.getAttribute("llm-provider");
          api.stashLiveConversation(activeProviderKey);

          urlbar.removeAttribute("is-llm-thinking");
        } catch (error) {
          logError("LLM request error:", error);
          if (error.name === "AbortError") {
            if (state.llmStream?.generation === streamGeneration) {
              api.commitPartialAssistantToHistory(state.llmStream.buffer);
              titleElement.textContent = "Request cancelled";
            }
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
        } finally {
          api.endLlmStream(streamGeneration);
        }
      }

      return {
        init,
        setupEventListeners,
        showActivationHint,
        activateLLMMode,
        triggerZenSearchModeAnimation,
        deactivateLLMMode,
        sendToLLM
      };
    }
  };
})();

// ==UserScript==
// @include   main
// @loadOrder 7
// @ignorecache
// ==/UserScript==

// urlbar-llm-search.uc.js — web search, query generation, page fetch
(function () {
  "use strict";

  if (location.href !== "chrome://browser/content/browser.xhtml") return;

  window.urlbarLlmSearch = {
    create(deps) {
      if (!deps?.prefs || !deps?.state || !deps?.api) {
        console.error("[URLBar LLM] urlbarLlmSearch: missing deps");
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

      function resolveModRoot() {
        const currentScriptPath = String(Components.stack.filename || "").replace(/\\/g, "/");
        const marker = "/modules/urlbar-llm/";
        const idx = currentScriptPath.lastIndexOf(marker);
        if (idx !== -1) {
          return currentScriptPath.slice(0, idx + 1);
        }
        const slash = currentScriptPath.lastIndexOf("/");
        return slash === -1 ? "" : currentScriptPath.slice(0, slash + 1);
      }

      // ============================================
      // Load Mozilla Readability for content extraction
      // ============================================
      let ReadabilityClass = null;
      
      // Try to load Readability.js from the same directory as this script
      try {
        // Derive the directory from this script's own path
        const readabilityPath = resolveModRoot() + "Readability.js";
        const scope = {};
        Services.scriptloader.loadSubScript(readabilityPath, scope);
        ReadabilityClass = scope.Readability;
        log("Loaded Mozilla Readability from", readabilityPath);
      } catch (e) {
        logWarn("Could not load Readability.js:", e.message);
        // Readability will be null, fallback extraction will be used
      }

      /**
       * Detects when the user explicitly asks to search (e.g. "Tu peux chercher sur internet?")
       */
      function isExplicitSearchRequest(query) {
        const t = query.trim().toLowerCase();
        const patterns = [
          /\b(cherche|search|recherche)\s+(sur\s+)?(internet|le\s+web|the\s+web)/i,
          /\b(tu\s+peux|can\s+you|pourrais[- ]tu)\s+chercher/i,
          /\b(can\s+you|could\s+you)\s+search\s+(the\s+)?(internet|web)/i,
          /\blook\s+it\s+up\b/i,
          /\b(fais|do)\s+une\s+recherche\b/i,
        ];
        return patterns.some((re) => re.test(t));
      }

      /**
       * Strip common "please search the web" preambles so the search API gets a concise query.
       * If no pattern matches, returns the trimmed original text.
       * @param {string} rawQuery
       * @returns {string}
       */
      function explicitFollowUpSearchQuery(rawQuery) {
        let q = (rawQuery || "").trim();
        if (!q) {
          return "";
        }
        const stripPatterns = [
          /^(please\s+)?(can\s+you|could\s+you|would\s+you)\s+search\s+(the\s+)?(internet|web)\s+(for\s+)?/i,
          /^(please\s+)?(can\s+you|could\s+you)\s+(look\s+it\s+up|find\s+(info|information)\s+about)\s*/i,
          /^(tu\s+peux|pourrais[- ]tu|veux[- ]tu)\s+chercher\s+(sur\s+)?(internet|le\s+web)\s*(pour\s+)?/i,
          /^(fais|faites|do)\s+(une\s+)?recherche\s+(sur\s+)?/i,
          /^search\s+(the\s+)?(internet|web)\s+(for\s+)?/i,
          /^cherche\s+(sur\s+)?(internet|le\s+web)\s*(pour\s+)?/i,
          /^recherche\s+(sur\s+)?(internet|le\s+web)\s*/i,
          /^look\s+(it\s+)?up\s*:?\s*/i,
          /^informe[- ]toi\s+(sur\s+)?/i,
          /^informez[- ]vous\s+(sur\s+)?/i,
        ];
        for (const re of stripPatterns) {
          const next = q.replace(re, "").trim();
          if (next.length > 0 && next.length < q.length) {
            return next;
          }
        }
        return q;
      }

      /**
       * Resolves the web search string for an explicit-search follow-up: prefer the topic in this
       * message (after stripping intent phrases), else the previous user turn, else the raw input.
       * @param {string} query - Current user message (already appended to state.conversationHistory)
       * @returns {string}
       */
      function resolveExplicitFollowUpSearchQuery(query) {
        const extracted = explicitFollowUpSearchQuery(query);
        if (extracted.length >= 2) {
          return extracted;
        }
        const users = state.conversationHistory.filter(
          (m) => m && m.role === "user" && typeof m.content === "string"
        );
        if (users.length >= 2) {
          const prev = users[users.length - 2].content.trim();
          if (prev.length >= 2) {
            return prev;
          }
        }
        return (query || "").trim();
      }

      function isContextAwareSearchQueryEnabled() {
        return getPref("extension.urlbar-llm.context-search-query-enabled", true);
      }

      function formatTranscriptForSearchQuery(messages) {
        if (!messages || !messages.length) {
          return "";
        }
        return messages
          .map((m) => {
            const role = m.role === "assistant" ? "Assistant" : "User";
            const body = api.clipTextForSummary(m.content || "", LIMITS.SEARCH_QUERY_CONTEXT_INPUT_MAX);
            return `${role}: ${body}`;
          })
          .join("\n");
      }

      /**
       * Normalize model output into a single search-engine query string.
       * @param {string} raw
       * @returns {string}
       */
      function sanitizeSearchQuery(raw) {
        if (!raw || typeof raw !== "string") {
          return "";
        }
        let q = raw
          .split(/\r?\n/)[0]
          .replace(/^["'`]+|["'`]+$/g, "")
          .replace(/^(search query|query|recherche)\s*:\s*/i, "")
          .replace(/^["'`]+|["'`]+$/g, "")
          .trim();
        q = q.replace(/\s+/g, " ");
        if (q.length > LIMITS.SEARCH_QUERY_MAX_LENGTH) {
          q = q.slice(0, LIMITS.SEARCH_QUERY_MAX_LENGTH).trim();
        }
        return q.length >= 2 ? q : "";
      }

      function buildSearchQueryCacheKey(apiHistory, userQuery) {
        const recent = (apiHistory || []).slice(-LIMITS.SEARCH_QUERY_CONTEXT_MESSAGES);
        const payload = JSON.stringify({
          q: userQuery,
          r: recent.map((m) => ({
            role: m.role,
            c: (m.content || "").slice(0, 200)
          }))
        });
        let hash = 0;
        for (let i = 0; i < payload.length; i++) {
          hash = ((hash << 5) - hash + payload.charCodeAt(i)) | 0;
        }
        return String(hash);
      }

      /**
       * Heuristic search string when LLM query generation fails or is disabled.
       * @param {string} userQuery
       * @param {Array<{role: string, content: string}>} apiHistory
       * @returns {string}
       */
      function resolveFallbackSearchQuery(userQuery, apiHistory) {
        const q = (userQuery || "").trim();
        if (q.length >= 40) {
          return q.slice(0, LIMITS.SEARCH_QUERY_MAX_LENGTH);
        }
        const extracted = explicitFollowUpSearchQuery(q);
        if (extracted.length >= 2 && extracted.length < q.length) {
          return extracted.slice(0, LIMITS.SEARCH_QUERY_MAX_LENGTH);
        }
        if (apiHistory && apiHistory.length > 1) {
          const users = apiHistory.filter(
            (m) => m && m.role === "user" && typeof m.content === "string"
          );
          if (users.length >= 2) {
            const prev = users[users.length - 2].content.trim();
            if (prev.length >= 3) {
              const combined = `${prev} ${q}`.replace(/\s+/g, " ").trim();
              return combined.slice(0, LIMITS.SEARCH_QUERY_MAX_LENGTH);
            }
          }
        }
        return q.slice(0, LIMITS.SEARCH_QUERY_MAX_LENGTH);
      }

      // Cache for LLM-generated search queries (avoids duplicate API calls within a session)
      const searchQueryGenCache = new Map();

      function cacheSearchQueryGen(key, query) {
        if (searchQueryGenCache.size >= LIMITS.MAX_CACHE_SIZE) {
          const oldestKey = searchQueryGenCache.keys().next().value;
          searchQueryGenCache.delete(oldestKey);
        }
        searchQueryGenCache.set(key, { query, timestamp: Date.now() });
      }

      /**
       * Ask the LLM for a concise, context-aware web search query (sequential step before searchWeb).
       * @param {string} userQuery - Current user message (last entry in apiHistory)
       * @param {Array<{role: string, content: string}>} apiHistory
       * @param {AbortSignal|null} signal
       * @returns {Promise<string>}
       */
      async function generateWebSearchQueryLLM(userQuery, apiHistory, signal = null) {
        const fallback = resolveFallbackSearchQuery(userQuery, apiHistory);

        if (!isContextAwareSearchQueryEnabled()) {
          log("Context-aware search query disabled, using fallback:", fallback);
          return fallback;
        }

        const cacheKey = buildSearchQueryCacheKey(apiHistory, userQuery);
        const cached = searchQueryGenCache.get(cacheKey);
        if (cached && Date.now() - cached.timestamp < LIMITS.SEARCH_QUERY_CACHE_TTL) {
          log("Using cached generated search query:", cached.query);
          return cached.query;
        }

        const priorMessages = (apiHistory || []).slice(0, -1).slice(-LIMITS.SEARCH_QUERY_CONTEXT_MESSAGES);
        const transcript = formatTranscriptForSearchQuery(priorMessages);

        const prompt = [
          {
            role: "system",
            content:
              "You write concise web search queries for a search engine. " +
              "Use the conversation context to resolve pronouns and follow-ups (e.g. \"du coup\", \"that\", \"it\"). " +
              "Include proper nouns, technical terms, and disambiguation. " +
              "Prefer keywords over full sentences. Match the user's language when it helps results. " +
              "Reply with ONLY the search query — no quotes, no explanation, no markdown."
          },
          {
            role: "user",
            content: transcript
              ? `Conversation so far:\n${transcript}\n\nLatest user message:\n${userQuery}\n\nSearch query:`
              : `User message:\n${userQuery}\n\nSearch query:`
          }
        ];

        try {
          const raw = await api.withLlmStepTimeout(
            (sig) =>
              api.completeChatNonStreaming(prompt, sig, {
                maxTokens: 80,
                temperature: 0
              }),
            LIMITS.SEARCH_QUERY_GEN_TIMEOUT_MS,
            signal
          );
          const query = sanitizeSearchQuery(raw);
          if (!query) {
            throw new Error("empty search query from model");
          }
          log("Generated search query:", query, transcript ? "(with context)" : "(no prior context)");
          cacheSearchQueryGen(cacheKey, query);
          state.lastSessionSearchQuery = query;
          return query;
        } catch (err) {
          if (err.name === "AbortError") {
            throw err;
          }
          logWarn("Search query generation failed, using fallback:", err.message, "→", fallback);
          return fallback;
        }
      }

      /**
       * Heuristic: queries that look like lookups (specific person, thing, etc.)
       * The classifier often returns ANSWER for these, but the model then says it doesn't know.
       */
      function looksLikeLookupQuery(query) {
        const t = query.trim().toLowerCase();
        const lookupPatterns = [
          /^(qui est|who is|who's)\b/i,
          /^(qu'est[- ]ce que|c'est quoi|what is|what's)\b/i,
          /^(informe[- ]toi|informez[- ]vous|cherche|search for|look up|find (info|information) about)\b/i,
          /^(biographie|biography|bio) (de|of|sur|about)\b/i,
        ];
        return lookupPatterns.some((re) => re.test(t));
      }

      /**
       * LLM-based web search classification
       * Asks the model itself whether the question is within its knowledge scope.
       * If not, triggers a web search. This replaces pure heuristic detection.
       * @param {Array<{role: string, content: string}>} [apiHistory] - For follow-up context in classifier
       */
      async function queryNeedsWebSearchLLM(query, isFollowUp = false, signal = null, apiHistory = null) {
        // Heuristic override: "Qui est X", "Who is X", etc. often get ANSWER but the model then says it doesn't know
        if (looksLikeLookupQuery(query)) {
          log('Lookup-style query, forcing web search:', query);
          return true;
        }

        // Ask the LLM to classify the query
        log('Asking model to classify query for web search need:', query);

        const followUpHint = isFollowUp
          ? `\n\nThis may be a follow-up in an ongoing chat (short wording is normal). If it needs current events, recent data, verification, or anything time-sensitive or niche, reply SEARCH. Do not assume earlier messages already gave enough web context for this turn.`
          : "";

        let userContent = query;
        if (isFollowUp && apiHistory && apiHistory.length > 1) {
          const snippet = formatTranscriptForSearchQuery(
            apiHistory.slice(0, -1).slice(-4)
          );
          if (snippet) {
            userContent = `Recent conversation:\n${snippet}\n\nLatest message:\n${query}`;
          }
        }

        const classificationPrompt = [
          {
            role: "system",
            content: `You are a classifier. The user will give you a question or request. Decide whether you can answer it confidently and accurately from your own training knowledge, or whether it requires web search.

    Reply with ONLY one word:
    - "SEARCH" if: the question is about a specific person (named individual), niche/obscure topic, current events, recent news, things you might not have detailed info about, or when in doubt
    - "ANSWER" ONLY if you are very confident you have accurate, detailed information (e.g. well-known historical figures, common knowledge facts)

    When uncertain, prefer SEARCH. Do NOT explain. Just reply with one word.${followUpHint}`
          },
          {
            role: "user",
            content: userContent
          }
        ];

        try {
          const responseText = await api.withLlmStepTimeout(
            (sig) =>
              api.completeChatNonStreaming(classificationPrompt, sig, {
                maxTokens: 5,
                temperature: 0
              }),
            LIMITS.SEARCH_CLASSIFIER_TIMEOUT_MS,
            signal
          );

          log('Model classification response:', responseText);

          const needsSearch = responseText.trim().toUpperCase().includes("SEARCH");
          log('Model decided:', needsSearch ? 'needs web search' : 'can answer from knowledge');
          return needsSearch;

        } catch (err) {
          if (err.name === "AbortError") {
            throw err;
          }
          // If classification fails (timeout, network error, etc.), fall back to no search
          logWarn('Classification request failed, defaulting to no search:', err.message);
          return false;
        }
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
       * Sources for citation pills: this turn's `state.currentSearchSources`, or the last assistant
       * message in history that still has `sources` (follow-up with no new web search).
       */
      function getEffectiveCitationSources() {
        if (state.currentSearchSources && state.currentSearchSources.length > 0) {
          return state.currentSearchSources.map((s) => ({ ...s }));
        }
        for (let i = state.conversationHistory.length - 1; i >= 0; i--) {
          const m = state.conversationHistory[i];
          if (m.role === "assistant" && m.sources && m.sources.length > 0) {
            return m.sources.map((s) => ({ ...s }));
          }
        }
        return [];
      }

      return {
        isExplicitSearchRequest,
        explicitFollowUpSearchQuery,
        resolveExplicitFollowUpSearchQuery,
        isContextAwareSearchQueryEnabled,
        formatTranscriptForSearchQuery,
        sanitizeSearchQuery,
        buildSearchQueryCacheKey,
        resolveFallbackSearchQuery,
        cacheSearchQueryGen,
        generateWebSearchQueryLLM,
        looksLikeLookupQuery,
        queryNeedsWebSearchLLM,
        cacheSet,
        searchWeb,
        searchDuckDuckGoDirect,
        hasOllamaWebSearchKey,
        searchOllamaWeb,
        fetchPageContentOllama,
        parseDuckDuckGoHTML,
        parseResultElement,
        cleanDDGUrl,
        fetchPageContent,
        extractMainContentSimple,
        fetchSearchResultsContent,
        formatSearchResultsForLLM,
        getEffectiveCitationSources
      };
    }
  };
})();

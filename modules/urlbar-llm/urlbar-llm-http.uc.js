// ==UserScript==
// @include   main
// @loadOrder 3
// @ignorecache
// ==/UserScript==

// urlbar-llm-http.uc.js — retryable fetch, non-streaming chat, SSE streaming
(function () {
  "use strict";

  if (location.href !== "chrome://browser/content/browser.xhtml") return;

  window.urlbarLlmHttp = {
    create(deps) {
      if (!deps?.prefs || !deps?.state || !deps?.api) {
        console.error("[URLBar LLM] urlbarLlmHttp: missing deps");
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

      /**
       * Non-streaming chat completion (classification, summarization, etc.).
       * @param {Array<{role: string, content: string}>} messages
       * @param {AbortSignal|null} signal
       * @param {{ maxTokens?: number, temperature?: number }} [options]
       * @returns {Promise<string>}
       */
      async function completeChatNonStreaming(messages, signal = null, options = {}) {
        const maxTokens = options.maxTokens ?? 512;
        const temperature = options.temperature ?? 0.2;

        if (state.currentProvider.name === "Ollama") {
          const response = await fetchWithRetry(state.currentProvider.baseUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              model: state.currentProvider.model,
              messages,
              stream: false,
              options: { temperature, num_predict: maxTokens }
            })
          }, signal);
          const json = await response.json();
          return (json.message?.content || "").trim();
        }

        const base = state.currentProvider.baseUrl.replace(/\/+$/, "");
        let url = base.endsWith("/chat/completions") ? base : base + "/chat/completions";
        const isGemini = state.currentProvider.name === "Gemini";
        if (isGemini && state.currentProvider.apiKey) {
          url += (url.includes("?") ? "&" : "?") + "key=" + encodeURIComponent(state.currentProvider.apiKey);
        }
        const headers = {
          "Content-Type": "application/json",
          Authorization: `Bearer ${state.currentProvider.apiKey}`
        };
        const response = await fetchWithRetry(url, {
          method: "POST",
          headers,
          body: JSON.stringify({
            model: state.currentProvider.model,
            messages,
            stream: false,
            max_tokens: maxTokens,
            temperature
          })
        }, signal);
        const json = await response.json();
        return (json.choices?.[0]?.message?.content || "").trim();
      }

      /**
       * Race an LLM step against a timeout. Parent abort cancels the step; timeout rejects with Error.
       * @template T
       * @param {(signal: AbortSignal|null) => Promise<T>} fn
       * @param {number} timeoutMs
       * @param {AbortSignal|null} parentSignal
       * @returns {Promise<T>}
       */
      async function withLlmStepTimeout(fn, timeoutMs, parentSignal = null) {
        if (parentSignal?.aborted) {
          throw new DOMException("Aborted", "AbortError");
        }
        let timer = null;
        const timeoutPromise = new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`LLM step timed out after ${timeoutMs}ms`)),
            timeoutMs
          );
        });
        try {
          return await Promise.race([fn(parentSignal), timeoutPromise]);
        } finally {
          if (timer !== null) {
            clearTimeout(timer);
          }
        }
      }



      /**
       * Unified streaming response handler for all providers.
       * Supports both OpenAI-compatible SSE format and Ollama JSON format.
       * Uses debounced rendering to avoid O(n^2) re-parsing on every token.
       */
      async function streamResponse(messages, titleElement, signal) {
        const isOllama = state.currentProvider.name === "Ollama";
        const isGemini = state.currentProvider.name === "Gemini";

        // Build request URL and headers
        const base = isOllama ? state.currentProvider.baseUrl : state.currentProvider.baseUrl.replace(/\/+$/, "");
        let url = isOllama
          ? state.currentProvider.baseUrl
          : (base.endsWith('/chat/completions') ? base : base + "/chat/completions");
        if (isGemini && state.currentProvider.apiKey) {
          url += (url.includes("?") ? "&" : "?") + "key=" + encodeURIComponent(state.currentProvider.apiKey);
        }

        const headers = { "Content-Type": "application/json" };
        if (!isOllama) {
          headers["Authorization"] = `Bearer ${state.currentProvider.apiKey}`;
        }

        log(`Streaming request — URL: ${url}, Model: ${state.currentProvider.model}, Provider: ${state.currentProvider.name}, Messages: ${messages.length}`);

        const response = await fetchWithRetry(url, {
          method: "POST",
          headers,
          body: JSON.stringify({
            model: state.currentProvider.model,
            messages,
            stream: true
          })
        }, signal);

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let accumulatedText = state.llmStream?.buffer || "";

        const appendStreamText = (text) => {
          accumulatedText += text;
          if (state.llmStream) {
            state.llmStream.buffer = accumulatedText;
          }
          scheduleRender();
        };

        // Debounced rendering: batch rapid token updates into a single render pass
        let renderPending = false;
        let renderTimeoutId = null;
        const scheduleRender = () => {
          if (renderPending) return;
          renderPending = true;
          renderTimeoutId = setTimeout(() => {
            renderPending = false;
            renderTimeoutId = null;
            api.renderMarkdownToElement(accumulatedText, titleElement);
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
                api.renderMarkdownToElement(accumulatedText, titleElement);
                return;
              }
              try {
                const { text } = extractDelta(JSON.parse(data));
                if (text) {
                  appendStreamText(text);
                }
              } catch (e) { /* ignore parse errors */ }
            }
            // Ollama JSON format: each line is a complete JSON object
            else if (isOllama) {
              try {
                const json = JSON.parse(trimmed);
                const { text, done: streamDone } = extractDelta(json);
                if (text) {
                  appendStreamText(text);
                }
                if (streamDone) {
                  cancelPendingRender();
                  api.renderMarkdownToElement(accumulatedText, titleElement);
                  return;
                }
              } catch (e) { /* ignore parse errors */ }
            }
          }
        }

        cancelPendingRender();
        api.renderMarkdownToElement(accumulatedText, titleElement);
      }

      return {
        fetchWithRetry,
        sleepWithAbort,
        completeChatNonStreaming,
        withLlmStepTimeout,
        streamResponse
      };
    }
  };
})();

/**
 * URL Bar LLM Integration for Zen Browser
 * 
 * Usage:
 * 1. Type "@provider" (e.g., "@mistral", "@openai", "@ollama")
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

  // Configuration
  const CONFIG = {
    providers: {
      mistral: {
        name: "Mistral AI",
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
        name: "Ollama (Local)",
        apiKey: null, // Not needed for local
        baseUrl: "http://localhost:11434/api/generate",
        model: "mistral"
      },
      gemini: {
        name: "Google Gemini",
        apiKey: "",
        baseUrl: "https://generativelanguage.googleapis.com/v1beta/models",
        model: "gemini-pro"
      }
    },
    defaultProvider: "ollama"
  };

  // State
  let isLLMMode = false;
  let currentProvider = null;
  let currentQuery = "";
  let streamingResultRow = null;
  let abortController = null;

  // Get preferences - Direct access to preference service using Components
  const prefsService = Components.classes["@mozilla.org/preferences-service;1"]
    .getService(Components.interfaces.nsIPrefBranch);
  
  // Create a minimal Services-like object
  const Services = {
    prefs: prefsService
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
      console.error("[URLBar LLM] Failed to set preference:", e);
    }
  }

  // Check if LLM is enabled
  function isEnabled() {
    return getPref("extension.urlbar-llm.enabled", true);
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
      "http://localhost:11434/api"
    );
  }

  // Initialize when browser window loads
  function init() {
    // Check if enabled
    if (!isEnabled()) {
      return;
    }

    loadConfig();
    
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
    console.log("[URLBar LLM] Initialized");
  }

  function setupEventListeners(urlbar, urlbarInput) {
    let inputValue = "";
    let lastInputTime = Date.now();

    // Listen for input changes
    urlbarInput.addEventListener("input", (e) => {
      inputValue = e.target.value;
      lastInputTime = Date.now();
      
      if (isLLMMode) {
        // Update query while in LLM mode
        currentQuery = inputValue;
      } else {
        // Check for "@provider" pattern
        const match = inputValue.match(/^@(\w+)(\s|$)/);
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

    // Listen for Tab key to activate
    urlbarInput.addEventListener("keydown", (e) => {
      if (e.key === "Tab" && !isLLMMode) {
        const match = inputValue.match(/^@(\w+)(\s|$)/);
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
        
        // Send query to LLM
        sendToLLM(urlbar, urlbarInput, currentQuery);
      } else if (e.key === "Escape" && isLLMMode) {
        e.preventDefault();
        e.stopPropagation();
        deactivateLLMMode(urlbar, urlbarInput);
      }
    }, true);

    // Clean up on blur
    urlbarInput.addEventListener("blur", () => {
      // Don't deactivate immediately, allow time for clicks
      setTimeout(() => {
        if (document.activeElement !== urlbarInput) {
          // deactivateLLMMode(urlbar, urlbarInput);
        }
      }, 200);
    });
  }

  function showActivationHint(urlbar, providerKey) {
    const provider = CONFIG.providers[providerKey];
    // Could show a visual hint here
    urlbar.setAttribute("llm-hint", provider.name);
  }

  function activateLLMMode(urlbar, urlbarInput, providerKey) {
    isLLMMode = true;
    currentProvider = CONFIG.providers[providerKey];
    
    // Remove "@provider" from input and store query
    const newValue = urlbarInput.value.replace(/^@\w+\s*/, "").trim();
    urlbarInput.value = newValue;
    currentQuery = newValue;
    
    // If there's already text, show it
    if (newValue) {
      // Query is ready to send
    }
    
    // Set visual indicator with provider name
    urlbar.setAttribute("llm-mode-active", "true");
    urlbar.setAttribute("llm-provider", providerKey);
    urlbar.setAttribute("llm-provider-name", currentProvider.name);
    
    // Get identity box to add pill
    const identityBox = urlbar.querySelector("#identity-box");
    if (identityBox) {
      identityBox.setAttribute("llm-provider-name", currentProvider.name);
    }
    
    // Hide native suggestions if preference enabled
    if (getPref("extension.urlbar-llm.hide-suggestions", true)) {
      const urlbarView = document.querySelector(".urlbarView");
      if (urlbarView) {
        urlbarView.style.display = "none";
      }
    }
    
    // Focus input
    urlbarInput.focus();
    
    console.log(`[URLBar LLM] Activated with provider: ${providerKey}`);
  }

  function deactivateLLMMode(urlbar, urlbarInput) {
    isLLMMode = false;
    currentProvider = null;
    currentQuery = "";
    
    // Remove visual indicators
    urlbar.removeAttribute("llm-mode-active");
    urlbar.removeAttribute("llm-provider");
    urlbar.removeAttribute("llm-provider-name");
    urlbar.removeAttribute("llm-hint");
    
    // Remove pill from identity box
    const identityBox = urlbar.querySelector("#identity-box");
    if (identityBox) {
      identityBox.removeAttribute("llm-provider-name");
    }
    
    // Show native suggestions again
    if (getPref("extension.urlbar-llm.hide-suggestions", true)) {
      const urlbarView = document.querySelector(".urlbarView");
      if (urlbarView) {
        urlbarView.style.display = "";
      }
    }
    
    // Remove streaming result
    if (streamingResultRow) {
      streamingResultRow.remove();
      streamingResultRow = null;
    }
    
    // Clear input
    urlbarInput.value = "";
    
    console.log("[URLBar LLM] Deactivated");
  }

  function createStreamingResultRow() {
    // Get urlbar view container
    const urlbarView = document.querySelector(".urlbarView");
    if (!urlbarView) {
      // Create urlbar view if it doesn't exist (shouldn't happen, but safety)
      return null;
    }

    // Find or create results container
    let resultsContainer = urlbarView.querySelector(".urlbarView-results");
    if (!resultsContainer) {
      resultsContainer = urlbarView.querySelector(".urlbarView-body");
    }
    if (!resultsContainer) {
      console.error("[URLBar LLM] Could not find results container");
      return null;
    }

    // Create result row matching urlbar style
    const row = document.createElement("div");
    row.className = "urlbarView-row urlbarView-row-llm";
    row.setAttribute("type", "llm-response");
    row.setAttribute("selectable", "true");
    
    // Create inner structure similar to native results (no icon)
    const rowInner = document.createElement("div");
    rowInner.className = "urlbarView-row-inner";
    
    // Content container (no icon)
    const content = document.createElement("div");
    content.className = "urlbarView-no-wrap";
    content.style.width = "100%";
    
    // Title (streaming text goes here)
    const title = document.createElement("div");
    title.className = "urlbarView-title";
    title.style.whiteSpace = "pre-wrap";
    title.style.wordBreak = "break-word";
    const maxHeight = getPref("extension.urlbar-llm.max-result-height", 300);
    title.style.maxHeight = `${maxHeight}px`;
    title.style.overflowY = "auto";
    title.textContent = "Thinking...";
    
    content.appendChild(title);
    rowInner.appendChild(content);
    row.appendChild(rowInner);
    
    // Insert at top of results
    resultsContainer.insertBefore(row, resultsContainer.firstChild);
    
    // Show urlbar view if hidden
    urlbarView.style.display = "";
    
    return { row, title };
  }

  async function sendToLLM(urlbar, urlbarInput, query) {
    if (!currentProvider || !query.trim()) {
      return;
    }

    // Check API key for non-local providers
    if (currentProvider.apiKey === "" && currentProvider.name !== "Ollama (Local)") {
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
      console.error("[URLBar LLM] Failed to create result row");
      return;
    }

    streamingResultRow = result.row;
    const titleElement = result.title;

    // Set thinking state
    urlbar.setAttribute("is-llm-thinking", "true");
    titleElement.textContent = "Thinking...";

    // Abort any previous request
    if (abortController) {
      abortController.abort();
    }
    abortController = new AbortController();

    try {
      let accumulatedText = "";
      
      if (currentProvider.name === "Ollama (Local)") {
        // Ollama uses different API format
        await streamOllamaResponse(query, titleElement, abortController.signal);
      } else if (currentProvider.name === "Google Gemini") {
        // Gemini uses different API format
        await streamGeminiResponse(query, titleElement, abortController.signal);
      } else {
        // Standard OpenAI-compatible API
        await streamOpenAIResponse(query, titleElement, abortController.signal);
      }

      urlbar.removeAttribute("is-llm-thinking");
    } catch (error) {
      if (error.name === "AbortError") {
        titleElement.textContent = "Request cancelled";
      } else {
        console.error("[URLBar LLM] Error:", error);
        titleElement.textContent = `Error: ${error.message}`;
      }
      urlbar.removeAttribute("is-llm-thinking");
    }
  }

  async function streamOpenAIResponse(query, titleElement, signal) {
    const response = await fetch(currentProvider.baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${currentProvider.apiKey}`
      },
      body: JSON.stringify({
        model: currentProvider.model,
        messages: [
          { role: "user", content: query }
        ],
        stream: true
      }),
      signal
    });

    if (!response.ok) {
      throw new Error(`API error: ${response.status} ${response.statusText}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let accumulatedText = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop(); // Keep incomplete line in buffer

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const data = line.slice(6);
          if (data === "[DONE]") {
            return;
          }
          try {
            const json = JSON.parse(data);
            const delta = json.choices?.[0]?.delta?.content;
            if (delta) {
              accumulatedText += delta;
              titleElement.textContent = accumulatedText;
              // Auto-scroll to bottom
              titleElement.scrollTop = titleElement.scrollHeight;
            }
          } catch (e) {
            // Ignore parse errors
          }
        }
      }
    }
  }

  async function streamOllamaResponse(query, titleElement, signal) {
    const response = await fetch(currentProvider.baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: currentProvider.model,
        prompt: query,
        stream: true
      }),
      signal
    });

    if (!response.ok) {
      throw new Error(`Ollama API error: ${response.status} ${response.statusText}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let accumulatedText = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop();

      for (const line of lines) {
        if (line.trim()) {
          try {
            const json = JSON.parse(line);
            const delta = json.response;
            if (delta) {
              accumulatedText += delta;
              titleElement.textContent = accumulatedText;
              titleElement.scrollTop = titleElement.scrollHeight;
            }
            if (json.done) {
              return;
            }
          } catch (e) {
            // Ignore parse errors
          }
        }
      }
    }
  }

  async function streamGeminiResponse(query, titleElement, signal) {
    const url = `${currentProvider.baseUrl}/${currentProvider.model}:streamGenerateContent?key=${currentProvider.apiKey}`;
    
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        contents: [{
          parts: [{
            text: query
          }]
        }]
      }),
      signal
    });

    if (!response.ok) {
      throw new Error(`Gemini API error: ${response.status} ${response.statusText}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let accumulatedText = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop();

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const data = line.slice(6);
          if (data === "[DONE]") {
            return;
          }
          try {
            const json = JSON.parse(data);
            const candidates = json.candidates || [];
            for (const candidate of candidates) {
              const content = candidate.content;
              if (content && content.parts) {
                for (const part of content.parts) {
                  if (part.text) {
                    accumulatedText += part.text;
                    titleElement.textContent = accumulatedText;
                    titleElement.scrollTop = titleElement.scrollHeight;
                  }
                }
              }
            }
          } catch (e) {
            // Ignore parse errors
          }
        }
      }
    }
  }

  // Initialize when DOM is ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  // Also initialize for new windows
  window.addEventListener("load", init);
})();

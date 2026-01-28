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
      }
      // Gemini temporarily disabled - OpenAI-compatible API not yet available
      // gemini: {
      //   name: "Google Gemini",
      //   apiKey: "",
      //   baseUrl: "https://generativelanguage.googleapis.com/v1/openai",
      //   model: "gemini-1.5-flash"
      // }
    },
    defaultProvider: "ollama"
  };

  // State
  let isLLMMode = false;
  let currentProvider = null;
  let currentQuery = "";
  let streamingResultRow = null;
  let abortController = null;
  let originalPlaceholder = "";
  let isClickingLink = false; // Track if we're currently clicking a link
  let conversationHistory = []; // Store conversation messages for follow-ups
  let conversationContainer = null; // Container for all messages
  let currentAssistantMessage = ""; // Track current streaming response

  // Get preferences - Direct access to preference service using Components
  const prefsService = Components.classes["@mozilla.org/preferences-service;1"]
    .getService(Components.interfaces.nsIPrefBranch);
  
  const scriptSecurityManager = Components.classes["@mozilla.org/scriptsecuritymanager;1"]
    .getService(Components.interfaces.nsIScriptSecurityManager);
  
  // Create a minimal Services-like object
  const Services = {
    prefs: prefsService,
    scriptSecurityManager: scriptSecurityManager
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
    // Check if already initialized to prevent duplicate listeners
    if (urlbar._llmInitialized) {
      console.log("[URLBar LLM] Already initialized, skipping duplicate setup");
      return;
    }
    urlbar._llmInitialized = true;
    
    let inputValue = "";
    let lastInputTime = Date.now();

    // Listen for input changes
    urlbarInput.addEventListener("input", (e) => {
      inputValue = e.target.value;
      lastInputTime = Date.now();
      
      if (isLLMMode) {
        // Update query while in LLM mode
        currentQuery = inputValue;
        // Prevent native urlbar from processing results
        e.stopPropagation();
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
        
        // Send query to LLM (follow-up or new)
        const query = currentQuery;
        if (query.trim()) {
          // Add user message to conversation
          conversationHistory.push({
            role: "user",
            content: query
          });
          
          // Clear the input immediately after sending
          currentQuery = "";
          urlbarInput.value = "";
          
          // Display user message and send to LLM
          displayUserMessage(query);
          sendToLLM(urlbar, urlbarInput, query);
        }
      } else if (e.key === "Escape" && isLLMMode) {
        e.preventDefault();
        e.stopPropagation();
        deactivateLLMMode(urlbar, urlbarInput, true);
      } else if ((e.key === "Delete" || e.key === "Backspace") && isLLMMode) {
        // Exit LLM mode if input is empty and user presses Delete/Backspace
        const currentValue = urlbarInput.value || "";
        if (currentValue.trim() === "") {
          e.preventDefault();
          e.stopPropagation();
          deactivateLLMMode(urlbar, urlbarInput, false);
        }
      }
    }, true);

    // Clean up on blur (when urlbar loses focus)
    urlbarInput.addEventListener("blur", (e) => {
      // Don't deactivate if clicking a link
      if (isClickingLink) {
        console.log("[URLBar LLM] Blur ignored - clicking link");
        return;
      }
      
      // Don't deactivate if clicking inside the conversation container
      const llmContainer = document.querySelector(".llm-conversation-container");
      
      setTimeout(() => {
        // Double check we're not clicking a link
        if (isClickingLink) {
          console.log("[URLBar LLM] Blur ignored in timeout - clicking link");
          return;
        }
        
        // Check if focus moved to something inside the LLM conversation
        const activeElement = document.activeElement;
        const relatedTarget = e.relatedTarget;
        
        // Check if the related target is a link (clicking on a link)
        const isLinkClick = relatedTarget && relatedTarget.tagName === 'A';
        
        const clickedInsideLLM = llmContainer && (
          llmContainer.contains(activeElement) || 
          llmContainer.contains(relatedTarget) ||
          isLinkClick
        );
        
        if (document.activeElement !== urlbarInput && isLLMMode && !clickedInsideLLM) {
          console.log("[URLBar LLM] Blur deactivating - activeElement:", activeElement?.tagName, "relatedTarget:", relatedTarget?.tagName);
          deactivateLLMMode(urlbar, urlbarInput, true);
        } else if (clickedInsideLLM) {
          console.log("[URLBar LLM] Blur ignored - clicked inside LLM container or link");
        }
      }, 300);
    });

    // Listen for urlbar panel closing (when urlbar is not "floating" anymore)
    const urlbarView = document.querySelector(".urlbarView");
    if (urlbarView) {
      // Watch for view panel closing/hiding
      const observer = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
          if (mutation.type === "attributes" && mutation.attributeName === "hidden") {
            // Panel is now hidden
            // Don't deactivate if we're clicking a link or in the conversation
            if (isClickingLink) {
              console.log("[URLBar LLM] View hide ignored - clicking link");
              return;
            }
            const llmContainer = document.querySelector(".llm-conversation-container");
            if (urlbarView.hidden && isLLMMode && !llmContainer?.matches(':hover')) {
              console.log("[URLBar LLM] View hidden, deactivating");
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

    // Also listen for when urlbar closes (unfocused state)
    urlbar.addEventListener("DOMAttrModified", (e) => {
      if (e.attrName === "open" && !urlbar.hasAttribute("open") && isLLMMode) {
        // Don't deactivate if clicking a link or inside conversation
        if (isClickingLink) {
          console.log("[URLBar LLM] Urlbar close ignored - clicking link");
          return;
        }
        const llmContainer = document.querySelector(".llm-conversation-container");
        if (!llmContainer?.matches(':hover')) {
          console.log("[URLBar LLM] Urlbar closed, deactivating");
          deactivateLLMMode(urlbar, urlbarInput, true);
        }
      }
    });
  }

  function showActivationHint(urlbar, providerKey) {
    const provider = CONFIG.providers[providerKey];
    // Could show a visual hint here
    urlbar.setAttribute("llm-hint", provider.name);
  }

  // Render markdown as DOM elements (avoids XHTML parsing issues)
  function renderMarkdownToElement(text, element) {
    if (!text) {
      element.textContent = "";
      return;
    }
    
    // Clear existing content
    element.textContent = "";
    
    // Split by code blocks first to handle them separately
    const parts = [];
    let lastIndex = 0;
    const codeBlockRegex = /```(\w+)?\n([\s\S]*?)```/g;
    let match;
    
    while ((match = codeBlockRegex.exec(text)) !== null) {
      // Add text before code block
      if (match.index > lastIndex) {
        parts.push({ type: 'text', content: text.slice(lastIndex, match.index) });
      }
      // Add code block
      parts.push({ type: 'code', lang: match[1], content: match[2] });
      lastIndex = match.index + match[0].length;
    }
    // Add remaining text
    if (lastIndex < text.length) {
      parts.push({ type: 'text', content: text.slice(lastIndex) });
    }
    
    // Render each part
    for (const part of parts) {
      if (part.type === 'code') {
        const pre = document.createElement('pre');
        const code = document.createElement('code');
        if (part.lang) {
          code.className = `language-${part.lang}`;
        }
        code.textContent = part.content.trim();
        pre.appendChild(code);
        element.appendChild(pre);
      } else {
        // Parse inline markdown in text
        const span = document.createElement('span');
        span.innerHTML = parseInlineMarkdown(part.content);
        element.appendChild(span);
      }
    }
    
    // Handle link clicks - open in background tab without closing urlbar
    const links = element.querySelectorAll('a');
    links.forEach(link => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        
        isClickingLink = true; // Set flag to prevent blur deactivation
        
        const href = link.getAttribute('href');
        console.log('[URLBar LLM] Link clicked:', href);
        
        if (href && window.gBrowser) {
          // Open in background tab
          try {
            const systemPrincipal = Services.scriptSecurityManager.getSystemPrincipal();
            window.gBrowser.loadOneTab(href, {
              inBackground: true,
              triggeringPrincipal: systemPrincipal,
              relatedToCurrent: true
            });
            console.log('[URLBar LLM] Opened link in background:', href);
            
            // Keep urlbar focused and open
            const urlbarInput = document.getElementById("urlbar-input");
            if (urlbarInput) {
              setTimeout(() => {
                // Re-focus the urlbar
                urlbarInput.focus();
                
                // Ensure the urlbar stays open by setting the open attribute
                const urlbar = document.getElementById("urlbar");
                if (urlbar && !urlbar.hasAttribute("open")) {
                  urlbar.setAttribute("open", "true");
                }
                
                isClickingLink = false; // Clear flag after refocus
                console.log('[URLBar LLM] Refocused urlbar and kept it open');
              }, 50); // Increased timeout for more reliable refocus
            } else {
              isClickingLink = false;
            }
          } catch (err) {
            console.error('[URLBar LLM] Failed to open link:', err);
            isClickingLink = false;
            // Fallback: try simple approach
            try {
              window.openUILinkIn(href, 'tab', { inBackground: true });
            } catch (err2) {
              console.error('[URLBar LLM] Fallback also failed:', err2);
            }
          }
        } else {
          isClickingLink = false;
        }
        return false;
      }, true);
    });
  }
  
  function parseInlineMarkdown(text) {
    let html = escapeHtml(text);
    
    // Inline code (`code`) - do this first to protect code content
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
    
    // Bold (**text** or __text__) - must be before italic to avoid conflicts
    html = html.replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/__([^_]+?)__/g, '<strong>$1</strong>');
    
    // Italic (*text* or _text_) - only match complete pairs
    // Use word boundaries to avoid matching partial bold syntax
    // Only match if there's a complete opening and closing marker
    html = html.replace(/\b_([^_<>]+?)_\b/g, '<em>$1</em>');
    // For asterisk, make sure it's not part of bold (not preceded/followed by another *)
    html = html.replace(/(?<![*\\])\*([^*<>\s][^*<>]*?)\*(?![*])/g, '<em>$1</em>');
    
    // Headers (# Header) - must be in order from most # to least
    html = html.replace(/^###### (.+)$/gm, '<h6>$1</h6>');
    html = html.replace(/^##### (.+)$/gm, '<h5>$1</h5>');
    html = html.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
    html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
    html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
    
    // Lists (- item or * item)
    html = html.replace(/^[\-\*] (.+)$/gm, '<li>$1</li>');
    html = html.replace(/^(\d+)\. (.+)$/gm, '<li>$2</li>');
    html = html.replace(/(<li>[\s\S]*?<\/li>\n?)+/g, (match) => `<ul>${match}</ul>`);
    
    // Links [text](url)
    html = html.replace(/\[([^\]]+)\]\(([^\)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    
    // Line breaks
    html = html.replace(/\n/g, '<br/>');
    
    return html;
  }

  function escapeHtml(text) {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function activateLLMMode(urlbar, urlbarInput, providerKey) {
    isLLMMode = true;
    currentProvider = CONFIG.providers[providerKey];
    
    // Remove "@provider" from input and store query
    const newValue = urlbarInput.value.replace(/^@\w+\s*/, "").trim();
    urlbarInput.value = newValue;
    currentQuery = newValue;
    
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
    labelBox.textContent = currentProvider.name;
    labelBox.hidden = false;
    labelBox.style.display = "inline-block";
    
    // Save and change placeholder text
    originalPlaceholder = urlbarInput.getAttribute("placeholder") || "";
    urlbarInput.setAttribute("placeholder", "Ask anything...");
    
    // Hide native suggestions completely
    const urlbarView = document.querySelector(".urlbarView");
    if (urlbarView) {
      urlbarView.setAttribute("llm-mode-suppress-results", "true");
    }
    
    // Only hide the results container if there's no conversation yet
    if (conversationHistory.length === 0) {
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
    
    console.log(`[URLBar LLM] Activated with provider: ${providerKey}, existing messages: ${conversationHistory.length}`);
  }

  function deactivateLLMMode(urlbar, urlbarInput, restoreURL = false) {
    isLLMMode = false;
    currentProvider = null;
    currentQuery = "";
    
    // Clear conversation history
    conversationHistory = [];
    
    // Remove conversation container
    if (conversationContainer) {
      conversationContainer.remove();
      conversationContainer = null;
    }
    
    // Remove streaming result first
    if (streamingResultRow) {
      streamingResultRow.remove();
      streamingResultRow = null;
    }
    
    // Remove visual indicators
    urlbar.removeAttribute("llm-mode-active");
    urlbar.removeAttribute("llm-provider");
    urlbar.removeAttribute("llm-hint");
    
    // Hide pill
    const labelBox = document.getElementById("urlbar-label-box");
    if (labelBox) {
      labelBox.hidden = true;
      labelBox.style.display = "none";
      labelBox.textContent = "";
    }
    
    // Restore placeholder (always restore, not just when originalPlaceholder exists)
    if (originalPlaceholder) {
      urlbarInput.setAttribute("placeholder", originalPlaceholder);
    } else {
      // If no original placeholder was saved, remove the custom one
      urlbarInput.removeAttribute("placeholder");
    }
    
    // Reset originalPlaceholder for next time
    originalPlaceholder = "";
    
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
        console.warn("[URLBar LLM] Cleanup failed:", e);
        urlbarInput.value = "";
      }
    } else {
      urlbarInput.value = "";
    }
    
    console.log("[URLBar LLM] Deactivated");
  }

  function displayUserMessage(message) {
    // Get or create conversation container
    if (!conversationContainer || !conversationContainer.parentNode) {
      console.log("[URLBar LLM] Creating/recreating conversation container");
      conversationContainer = createConversationContainer();
    }
    
    if (!conversationContainer) {
      console.error("[URLBar LLM] Failed to create conversation container");
      return;
    }
    
    // Create user message element
    const messageDiv = document.createElement("div");
    messageDiv.className = "llm-message llm-message-user";
    messageDiv.textContent = message;
    
    conversationContainer.appendChild(messageDiv);
    
    console.log("[URLBar LLM] User message added. Total children:", conversationContainer.children.length);
    
    // Scroll to bottom
    setTimeout(() => {
      const urlbarViewBodyInner = document.querySelector(".urlbarView-body-inner");
      if (urlbarViewBodyInner) {
        urlbarViewBodyInner.scrollTop = urlbarViewBodyInner.scrollHeight;
      }
    }, 10);
  }

  function createConversationContainer() {
    // Get urlbar view container
    const urlbarView = document.querySelector(".urlbarView");
    if (!urlbarView) {
      console.error("[URLBar LLM] Could not find urlbarView");
      return null;
    }

    // Find results container
    let resultsContainer = urlbarView.querySelector(".urlbarView-results");
    if (!resultsContainer) {
      resultsContainer = urlbarView.querySelector(".urlbarView-body");
    }
    if (!resultsContainer) {
      console.error("[URLBar LLM] Could not find results container");
      return null;
    }
    
    // Check if container already exists
    let container = resultsContainer.querySelector(".llm-conversation-container");
    if (container) {
      console.log("[URLBar LLM] Reusing existing conversation container");
      return container;
    }
    
    // Create conversation container
    container = document.createElement("div");
    container.className = "llm-conversation-container";
    console.log("[URLBar LLM] Creating new conversation container");
    
    // Stop events from propagating to prevent urlbar from closing (except for links)
    container.addEventListener("mousedown", (e) => {
      const target = e.target;
      const isLink = target.tagName === 'A' || target.closest('a');
      
      if (!isLink) {
        e.stopPropagation();
        console.log("[URLBar LLM] Container mousedown blocked, target:", target.tagName);
      } else {
        console.log("[URLBar LLM] Container mousedown allowed for link");
      }
    }, true);
    
    container.addEventListener("mouseup", (e) => {
      const target = e.target;
      const isLink = target.tagName === 'A' || target.closest('a');
      
      if (!isLink) {
        e.stopPropagation();
        console.log("[URLBar LLM] Container mouseup blocked, target:", target.tagName);
      } else {
        console.log("[URLBar LLM] Container mouseup allowed for link");
      }
    }, true);
    
    container.addEventListener("click", (e) => {
      const target = e.target;
      const isLink = target.tagName === 'A' || target.closest('a');
      
      // Don't stop propagation for links (they have their own handler)
      if (!isLink) {
        e.stopPropagation();
        console.log("[URLBar LLM] Container click blocked, target:", target.tagName);
      } else {
        console.log("[URLBar LLM] Container click allowed for link");
      }
    }, true);
    
    resultsContainer.appendChild(container);
    
    // Show urlbarView-body-inner
    const urlbarViewBodyInner = document.querySelector(".urlbarView-body-inner");
    if (urlbarViewBodyInner) {
      urlbarViewBodyInner.style.display = "";
    }
    
    return container;
  }

  function createStreamingResultRow() {
    // Get or create conversation container
    if (!conversationContainer || !conversationContainer.parentNode) {
      console.log("[URLBar LLM] Creating/recreating conversation container for assistant");
      conversationContainer = createConversationContainer();
    }
    
    if (!conversationContainer) {
      console.error("[URLBar LLM] Failed to create conversation container for assistant");
      return null;
    }

    // Create assistant message element
    const messageDiv = document.createElement("div");
    messageDiv.className = "llm-message llm-message-assistant";
    
    // Create content div for streaming text
    const contentDiv = document.createElement("div");
    contentDiv.className = "llm-message-content";
    contentDiv.textContent = "Thinking...";
    
    messageDiv.appendChild(contentDiv);
    conversationContainer.appendChild(messageDiv);
    
    console.log("[URLBar LLM] Assistant message added. Total children:", conversationContainer.children.length);
    
    return { row: messageDiv, title: contentDiv };
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
        await streamOllamaResponse(conversationHistory, titleElement, abortController.signal);
      } else {
        // Standard OpenAI-compatible API (works for OpenAI, Mistral, Gemini)
        await streamOpenAIResponse(conversationHistory, titleElement, abortController.signal);
      }
      
      // Add assistant's response to conversation history
      conversationHistory.push({
        role: "assistant",
        content: currentAssistantMessage
      });
      
      console.log("[URLBar LLM] Conversation now has", conversationHistory.length, "messages");

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

  async function streamOpenAIResponse(messages, titleElement, signal) {
    // Add /chat/completions if not already in the URL
    const url = currentProvider.baseUrl.endsWith('/chat/completions') 
      ? currentProvider.baseUrl 
      : `${currentProvider.baseUrl}/chat/completions`;
    
    console.log(`[URLBar LLM] Request URL: ${url}`);
    console.log(`[URLBar LLM] Model: ${currentProvider.model}`);
    console.log(`[URLBar LLM] Provider: ${currentProvider.name}`);
    console.log(`[URLBar LLM] Conversation history: ${messages.length} messages`);
    
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${currentProvider.apiKey}`
      },
      body: JSON.stringify({
        model: currentProvider.model,
        messages: messages, // Use full conversation history
        stream: true
      }),
      signal
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      console.error(`[URLBar LLM] API error response:`, errorText);
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
              currentAssistantMessage = accumulatedText; // Track for conversation history
              renderMarkdownToElement(accumulatedText, titleElement);
              // Auto-scroll to bottom
              const urlbarViewBodyInner = document.querySelector(".urlbarView-body-inner");
              if (urlbarViewBodyInner) {
                urlbarViewBodyInner.scrollTop = urlbarViewBodyInner.scrollHeight;
              }
            }
          } catch (e) {
            // Ignore parse errors
          }
        }
      }
    }
  }

  async function streamOllamaResponse(messages, titleElement, signal) {
    // Convert messages to Ollama format (it uses a simple prompt)
    // Build context from conversation history
    let prompt = "";
    for (const msg of messages) {
      if (msg.role === "user") {
        prompt += `User: ${msg.content}\n\n`;
      } else if (msg.role === "assistant") {
        prompt += `Assistant: ${msg.content}\n\n`;
      }
    }
    prompt += "Assistant: "; // Prompt for next response
    
    console.log(`[URLBar LLM] Ollama prompt length: ${prompt.length} chars`);
    
    const response = await fetch(currentProvider.baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: currentProvider.model,
        prompt: prompt,
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
              currentAssistantMessage = accumulatedText; // Track for conversation history
              renderMarkdownToElement(accumulatedText, titleElement);
              // Auto-scroll to bottom
              const urlbarViewBodyInner = document.querySelector(".urlbarView-body-inner");
              if (urlbarViewBodyInner) {
                urlbarViewBodyInner.scrollTop = urlbarViewBodyInner.scrollHeight;
              }
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
    const url = `${currentProvider.baseUrl}/models/${currentProvider.model}:streamGenerateContent?key=${currentProvider.apiKey}`;
    
    console.log(`[URLBar LLM] Gemini URL: ${url.replace(currentProvider.apiKey, 'API_KEY')}`);
    
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
      const errorText = await response.text().catch(() => '');
      console.error(`[URLBar LLM] Gemini error response:`, errorText);
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
        if (line.trim()) {
          try {
            const json = JSON.parse(line);
            const candidates = json.candidates || [];
            for (const candidate of candidates) {
              const content = candidate.content;
              if (content && content.parts) {
                for (const part of content.parts) {
                  if (part.text) {
                    accumulatedText += part.text;
                    renderMarkdownToElement(accumulatedText, titleElement);
                    titleElement.scrollTop = titleElement.scrollHeight;
                  }
                }
              }
            }
          } catch (e) {
            // Ignore parse errors during streaming
            console.debug("[URLBar LLM] Gemini parse error:", e);
          }
        }
      }
    }
  }

  // Initialize when DOM is ready (only once)
  let initialized = false;
  function initOnce() {
    if (initialized) return;
    initialized = true;
    init();
  }
  
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initOnce);
  } else {
    initOnce();
  }
})();

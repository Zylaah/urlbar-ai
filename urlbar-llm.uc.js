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
        name: "Mistral",
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
        name: "Ollama",
        apiKey: null, // Not needed for local
        baseUrl: "http://localhost:11434/api/chat",
        model: "mistral"
      }
      // Gemini temporarily disabled
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
  let currentSearchSources = []; // Track sources used for current response

  // ============================================
  // Load Mozilla Readability for content extraction
  // ============================================
  let ReadabilityClass = null;
  
  // Try to load Readability.js from the same directory
  try {
    // For fx-autoconfig, scripts are in chrome://userchrome/content/js/
    const scriptPath = "chrome://userchrome/content/js/Readability.js";
    const scope = {};
    Services.scriptloader.loadSubScript(scriptPath, scope);
    ReadabilityClass = scope.Readability;
    console.log("[URLBar LLM] Loaded Mozilla Readability from", scriptPath);
  } catch (e) {
    console.warn("[URLBar LLM] Could not load Readability.js:", e.message);
    // Readability will be null, fallback extraction will be used
  }

  // Get preferences - Direct access to preference service using Components
  const prefsService = Components.classes["@mozilla.org/preferences-service;1"]
    .getService(Components.interfaces.nsIPrefBranch);
  
  const scriptSecurityManager = Components.classes["@mozilla.org/scriptsecuritymanager;1"]
    .getService(Components.interfaces.nsIScriptSecurityManager);
  
  const scriptLoader = Components.classes["@mozilla.org/moz/jssubscript-loader;1"]
    .getService(Components.interfaces.mozIJSSubScriptLoader);
  
  // Create a minimal Services-like object
  const Services = {
    prefs: prefsService,
    scriptSecurityManager: scriptSecurityManager,
    scriptloader: scriptLoader
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

  // Check if web search is enabled
  function isWebSearchEnabled() {
    return getPref("extension.urlbar-llm.web-search-enabled", true);
  }

  /**
   * Robust web search detection
   * Combines language-agnostic structural patterns with multilingual keywords
   * Inspired by Hana's lightweightWebSearchEnhancer
   */
  function queryNeedsWebSearchFast(query, isFollowUp = false) {
    const trimmedQuery = query.trim();
    const lowerQuery = trimmedQuery.toLowerCase();
    const wordCount = trimmedQuery.split(/\s+/).length;
    
    // Skip search for follow-up messages in a conversation
    if (isFollowUp) {
      console.log('[URLBar LLM] No search: follow-up message');
      return false;
    }
    
    // ========================================
    // 1. CLEAR "NO SEARCH" PATTERNS (check first)
    // ========================================
    
    // Code/programming patterns (universal syntax)
    const codePatterns = [
      /[{}\[\]();]/, // Brackets, braces, semicolons
      /\b(function|const|let|var|class|def|import|return|if|else|for|while)\b/,
      /\b(console\.|print\(|System\.|std::)/,
      /\.(js|ts|py|java|cpp|c|go|rs|rb|php|html|css|json|xml|yaml|md)$/i,
      /^```/, // Code block markers
    ];
    
    for (const pattern of codePatterns) {
      if (pattern.test(trimmedQuery)) {
        console.log('[URLBar LLM] No search: code pattern');
        return false;
      }
    }
    
    // Mathematical expressions (universal)
    if (/\d+\s*[\+\-\*\/\^]\s*\d+/.test(trimmedQuery) || /[∫∑∏√π∞]/.test(trimmedQuery)) {
      console.log('[URLBar LLM] No search: math expression');
      return false;
    }
    
    // Creative task keywords (multilingual)
    const creativeKeywords = [
      // English
      'write me', 'create a', 'generate', 'compose', 'draft', 'make me',
      'help me write', 'help me create', 'rewrite', 'rephrase',
      // French
      'écris-moi', 'écris moi', 'crée', 'génère', 'compose', 'rédige',
      'aide-moi à écrire', 'reformule',
      // German
      'schreib mir', 'erstelle', 'verfasse',
      // Spanish
      'escríbeme', 'crea', 'genera', 'redacta',
      // Italian
      'scrivimi', 'crea', 'genera',
      // Portuguese
      'escreva', 'crie', 'gere'
    ];
    
    if (creativeKeywords.some(kw => lowerQuery.includes(kw))) {
      console.log('[URLBar LLM] No search: creative task');
      return false;
    }
    
    // Very long queries (>40 words) are usually creative/conversational
    if (wordCount > 40) {
      console.log('[URLBar LLM] No search: very long query');
      return false;
    }
    
    // ========================================
    // 2. CLEAR "NEEDS SEARCH" PATTERNS
    // ========================================
    
    // Recent/current keywords (multilingual)
    const recentKeywords = [
      // English
      'latest', 'recent', 'current', 'today', 'now', 'breaking', 'news', 'update',
      'this week', 'this month', 'this year', 'last week', 'last month',
      // French
      'dernier', 'dernière', 'récent', 'actuel', 'actuelle', "aujourd'hui", 
      'maintenant', 'actualité', 'mise à jour', 'cette semaine', 'ce mois',
      // German
      'aktuell', 'neueste', 'heute', 'jetzt', 'diese woche', 'nachrichten',
      // Spanish
      'último', 'última', 'reciente', 'actual', 'hoy', 'ahora', 'noticias',
      // Italian
      'ultimo', 'ultima', 'recente', 'attuale', 'oggi', 'adesso', 'notizie',
      // Portuguese
      'último', 'última', 'recente', 'atual', 'hoje', 'agora', 'notícias'
    ];
    
    if (recentKeywords.some(kw => lowerQuery.includes(kw))) {
      console.log('[URLBar LLM] Needs search: recent/current keyword');
      return true;
    }
    
    // Recent years (dynamic)
    const currentYear = new Date().getFullYear();
    for (let y = currentYear - 1; y <= currentYear + 1; y++) {
      if (trimmedQuery.includes(String(y))) {
        console.log('[URLBar LLM] Needs search: year', y);
        return true;
      }
    }
    
    // Factual question keywords (multilingual)
    const factualKeywords = [
      // English
      'who is', 'who are', 'who was', 'what is the', 'what are the',
      'when is', 'when was', 'when did', 'where is', 'where are',
      'how much', 'how many', 'what happened', 'what time',
      // French
      'qui est', 'qui sont', "c'est quoi", "qu'est-ce que", 'quand est',
      'où est', 'où sont', 'combien', "qu'est-il arrivé",
      // German
      'wer ist', 'was ist', 'wann ist', 'wo ist', 'wie viel',
      // Spanish
      'quién es', 'qué es', 'cuándo es', 'dónde está', 'cuánto',
      // Italian
      'chi è', 'cosa è', "cos'è", 'quando è', 'dove è', 'quanto'
    ];
    
    if (factualKeywords.some(kw => lowerQuery.includes(kw))) {
      console.log('[URLBar LLM] Needs search: factual question keyword');
      return true;
    }
    
    // Prices, currencies (universal)
    if (/[$€£¥₹]\s*\d|\d+\s*[$€£¥₹]|\d+\s*(USD|EUR|GBP|BTC|ETH)\b/i.test(trimmedQuery)) {
      console.log('[URLBar LLM] Needs search: price/currency pattern');
      return true;
    }
    
    // URLs or domain patterns
    if (/\b\w+\.(com|org|net|io|ai|gov|edu|co|fr|de|es|it|uk)\b/i.test(trimmedQuery)) {
      console.log('[URLBar LLM] Needs search: URL/domain');
      return true;
    }
    
    // Question mark with short query
    if (/\?$/.test(trimmedQuery) && wordCount <= 12) {
      console.log('[URLBar LLM] Needs search: short question');
      return true;
    }
    
    // Multiple proper nouns (names, places, companies)
    const words = trimmedQuery.split(/\s+/);
    let properNounCount = 0;
    for (let i = 1; i < words.length; i++) {
      if (/^[A-Z][a-zÀ-ÿ]/.test(words[i]) && !/[.!?]$/.test(words[i-1] || '')) {
        properNounCount++;
      }
    }
    if (properNounCount >= 2) {
      console.log('[URLBar LLM] Needs search: multiple proper nouns');
      return true;
    }
    
    // Short lookup queries (2-5 words, starts with capital, not a command)
    if (wordCount >= 2 && wordCount <= 5) {
      const isCommand = /^(write|create|make|help|explain|translate|tell|give|show|list)/i.test(trimmedQuery);
      const startsCapital = /^[A-Z]/.test(trimmedQuery);
      
      if (!isCommand && startsCapital) {
        console.log('[URLBar LLM] Needs search: short lookup query');
        return true;
      }
    }
    
    // Single capitalized term (1-3 words) - likely looking something up
    if (wordCount <= 3 && /^[A-Z]/.test(trimmedQuery) && !/^(I|A|The|Le|La|Der|Die|Das|El|Il)\s/i.test(trimmedQuery)) {
      console.log('[URLBar LLM] Needs search: capitalized lookup');
      return true;
    }
    
    // ========================================
    // 3. DEFAULT: Search for short queries, skip for long ones
    // ========================================
    if (wordCount <= 8) {
      console.log('[URLBar LLM] Default: short query, trying search');
      return true;
    }
    
    console.log('[URLBar LLM] Default: longer query, skipping search');
    return false;
  }

  /**
   * LLM-based web search classification
   * Asks the model itself whether the question is within its knowledge scope.
   * If not, triggers a web search. This replaces pure heuristic detection.
   */
  async function queryNeedsWebSearchLLM(query, isFollowUp = false, signal = null) {
    // Never search on follow-ups (the model already has context)
    if (isFollowUp) {
      console.log('[URLBar LLM] No search: follow-up message');
      return false;
    }

    // Ask the LLM to classify the query
    console.log('[URLBar LLM] Asking model to classify query for web search need:', query);

    const classificationPrompt = [
      {
        role: "system",
        content: `You are a classifier. The user will give you a question or request. You must decide whether you can answer it confidently and accurately from your own training knowledge, or whether it requires up-to-date or real-time information from the web (e.g. current events, live prices, recent news, very specific/niche facts you're unsure about, information after your knowledge cutoff).

Reply with ONLY one word:
- "SEARCH" if you need web search to answer accurately
- "ANSWER" if you can answer confidently from your own knowledge

Do NOT explain. Just reply with one word.`
      },
      {
        role: "user",
        content: query
      }
    ];

    try {
      let responseText = "";

      if (currentProvider.name === "Ollama") {
        // Ollama native API (non-streaming)
        const response = await fetch(currentProvider.baseUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: currentProvider.model,
            messages: classificationPrompt,
            stream: false
          }),
          signal
        });
        if (!response.ok) throw new Error(`Ollama classify error: ${response.status}`);
        const json = await response.json();
        responseText = (json.message?.content || "").trim().toUpperCase();
      } else {
        // OpenAI-compatible API (non-streaming)
        const url = currentProvider.baseUrl.endsWith('/chat/completions')
          ? currentProvider.baseUrl
          : `${currentProvider.baseUrl}/chat/completions`;

        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${currentProvider.apiKey}`
          },
          body: JSON.stringify({
            model: currentProvider.model,
            messages: classificationPrompt,
            stream: false,
            max_tokens: 5,
            temperature: 0
          }),
          signal
        });
        if (!response.ok) throw new Error(`Classify API error: ${response.status}`);
        const json = await response.json();
        responseText = (json.choices?.[0]?.message?.content || "").trim().toUpperCase();
      }

      console.log('[URLBar LLM] Model classification response:', responseText);

      // The model replied SEARCH or ANSWER
      const needsSearch = responseText.includes("SEARCH");
      console.log('[URLBar LLM] Model decided:', needsSearch ? 'needs web search' : 'can answer from knowledge');
      return needsSearch;

    } catch (err) {
      // If classification fails (timeout, network error, etc.), fall back to no search
      // so the model still answers from its own knowledge
      console.warn('[URLBar LLM] Classification request failed, defaulting to no search:', err.message);
      return false;
    }
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
      "http://localhost:11434/api/chat"
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
          
          // Update placeholder for follow-ups
          urlbarInput.setAttribute("placeholder", "Ask a follow-up...");
          
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
        
        // Check if the related target is a link (clicking on a link or its children)
        const isLinkClick = relatedTarget && (
          relatedTarget.tagName === 'A' || 
          (relatedTarget.closest && relatedTarget.closest('a'))
        );
        
        const clickedInsideLLM = llmContainer && (
          llmContainer.contains(activeElement) || 
          llmContainer.contains(relatedTarget) ||
          isLinkClick
        );
        
        // Don't deactivate if we're clicking a link
        if (isClickingLink) {
          console.log("[URLBar LLM] Blur ignored - isClickingLink flag set");
          return;
        }
        
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
    
    // Split by code blocks and tables first to handle them separately
    const parts = [];
    let lastIndex = 0;
    
    // Combined regex for code blocks and tables
    const codeBlockRegex = /```(\w+)?\n([\s\S]*?)```/g;
    const tableRegex = /(?:^|\n)((?:\|[^\n]+\|\r?\n)+)/g;
    
    // First pass: extract code blocks
    let codeMatches = [];
    let match;
    while ((match = codeBlockRegex.exec(text)) !== null) {
      codeMatches.push({ index: match.index, end: match.index + match[0].length, type: 'code', lang: match[1], content: match[2] });
    }
    
    // Second pass: extract tables (only if not inside code blocks)
    let tableMatches = [];
    while ((match = tableRegex.exec(text)) !== null) {
      const tableStart = match.index + (match[0].startsWith('\n') ? 1 : 0);
      const tableEnd = match.index + match[0].length;
      
      // Check if this table is inside a code block
      const insideCodeBlock = codeMatches.some(cb => tableStart >= cb.index && tableEnd <= cb.end);
      if (!insideCodeBlock) {
        const tableContent = match[1].trim();
        // Validate it's actually a table (has at least 2 rows and separator row)
        const rows = tableContent.split('\n').filter(r => r.trim());
        if (rows.length >= 2) {
          const hasValidSeparator = rows.some(row => /^\|[\s\-:|]+\|$/.test(row.trim()));
          if (hasValidSeparator) {
            tableMatches.push({ index: tableStart, end: tableEnd, type: 'table', content: tableContent });
          }
        }
      }
    }
    
    // Combine and sort all matches
    const allMatches = [...codeMatches, ...tableMatches].sort((a, b) => a.index - b.index);
    
    // Build parts array
    for (const m of allMatches) {
      if (m.index > lastIndex) {
        parts.push({ type: 'text', content: text.slice(lastIndex, m.index) });
      }
      parts.push(m);
      lastIndex = m.end;
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
      } else if (part.type === 'table') {
        const table = parseMarkdownTable(part.content);
        if (table) {
          element.appendChild(table);
        }
      } else {
        // Parse inline markdown in text
        const span = document.createElement('span');
        span.innerHTML = parseInlineMarkdown(part.content);
        element.appendChild(span);
      }
    }
    
    // Don't attach individual link handlers - we'll use event delegation on the message element instead
  }
  
  // Parse markdown table and return a DOM table element
  function parseMarkdownTable(tableText) {
    try {
      const rows = tableText.split('\n').filter(r => r.trim());
      if (rows.length < 2) return null;
      
      // Find the separator row (contains only |, -, :, and spaces)
      let separatorIndex = -1;
      let alignments = [];
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i].trim();
        if (/^\|[\s\-:|]+\|$/.test(row)) {
          separatorIndex = i;
          // Parse alignments from separator
          const cells = row.split('|').filter(c => c.trim() !== '');
          alignments = cells.map(cell => {
            const trimmed = cell.trim();
            if (trimmed.startsWith(':') && trimmed.endsWith(':')) return 'center';
            if (trimmed.endsWith(':')) return 'right';
            return 'left';
          });
          break;
        }
      }
      
      if (separatorIndex === -1) return null;
      
      const table = document.createElement('table');
      table.className = 'llm-markdown-table';
      
      // Header rows (before separator)
      if (separatorIndex > 0) {
        const thead = document.createElement('thead');
        for (let i = 0; i < separatorIndex; i++) {
          const tr = document.createElement('tr');
          const cells = parseTableRow(rows[i]);
          cells.forEach((cell, idx) => {
            const th = document.createElement('th');
            th.innerHTML = parseInlineMarkdown(cell);
            if (alignments[idx]) {
              th.style.textAlign = alignments[idx];
            }
            tr.appendChild(th);
          });
          thead.appendChild(tr);
        }
        table.appendChild(thead);
      }
      
      // Body rows (after separator)
      if (separatorIndex < rows.length - 1) {
        const tbody = document.createElement('tbody');
        for (let i = separatorIndex + 1; i < rows.length; i++) {
          const tr = document.createElement('tr');
          const cells = parseTableRow(rows[i]);
          cells.forEach((cell, idx) => {
            const td = document.createElement('td');
            td.innerHTML = parseInlineMarkdown(cell);
            if (alignments[idx]) {
              td.style.textAlign = alignments[idx];
            }
            tr.appendChild(td);
          });
          tbody.appendChild(tr);
        }
        table.appendChild(tbody);
      }
      
      return table;
    } catch (e) {
      console.warn('[URLBar LLM] Failed to parse table:', e);
      return null;
    }
  }
  
  // Parse a single table row into cells
  function parseTableRow(row) {
    // Remove leading/trailing pipes and split
    const trimmed = row.trim();
    const withoutPipes = trimmed.startsWith('|') ? trimmed.slice(1) : trimmed;
    const withoutEndPipe = withoutPipes.endsWith('|') ? withoutPipes.slice(0, -1) : withoutPipes;
    return withoutEndPipe.split('|').map(cell => cell.trim());
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
    
    // Citation markers [1], [2], etc. - convert to styled spans with data attribute
    // Match [1], [2], [3] etc. but not [text](url) links which were already converted
    html = html.replace(/\[(\d+)\](?!\()/g, '<span class="llm-citation-marker" data-source="$1">$1</span>');
    
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

  /**
   * Web search using DuckDuckGo HTML
   * In Firefox chrome context, we have elevated privileges and can fetch directly
   * Based on the approach used in Hana browser extension
   */
  
  // Search results cache
  const searchCache = new Map();
  const CACHE_TIMEOUT = 30 * 60 * 1000; // 30 minutes
  
  async function searchWeb(query, limit = 5) {
    if (!isWebSearchEnabled()) {
      return null;
    }

    const startTime = Date.now();
    console.log('[URLBar LLM] Searching for:', query);
    
    // Check cache first
    const cacheKey = `${query}:${limit}`;
    const cached = searchCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TIMEOUT) {
      console.log('[URLBar LLM] Using cached results for:', query);
      return cached.results;
    }

    try {
      // Try DuckDuckGo HTML search (direct fetch - works in chrome context)
      const results = await searchDuckDuckGoDirect(query, limit);
      
      if (results && results.length > 0) {
        // Cache results
        searchCache.set(cacheKey, { results, timestamp: Date.now() });
        console.log('[URLBar LLM] Search completed in', Date.now() - startTime, 'ms, found', results.length, 'results');
        return results;
      }
      
      // Fallback to SearXNG if DDG fails
      console.log('[URLBar LLM] DDG failed, trying SearXNG...');
      const searxResults = await searchSearXNG(query, limit);
      
      if (searxResults && searxResults.length > 0) {
        searchCache.set(cacheKey, { results: searxResults, timestamp: Date.now() });
        return searxResults;
      }
      
      console.warn('[URLBar LLM] All search methods failed');
      return null;

    } catch (error) {
      console.error('[URLBar LLM] Web search failed:', error);
      return null;
    }
  }
  
  // Keep the old function name for compatibility
  const searchDuckDuckGo = searchWeb;
  
  /**
   * Direct DuckDuckGo search using XMLHttpRequest
   * XMLHttpRequest in chrome context bypasses CORS restrictions
   */
  async function searchDuckDuckGoDirect(query, limit = 5) {
    return new Promise((resolve) => {
      const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
      console.log('[URLBar LLM] Fetching DuckDuckGo:', url);
      
      const xhr = new XMLHttpRequest();
      xhr.timeout = 8000;
      
      xhr.onload = function() {
        if (xhr.status === 200) {
          const html = xhr.responseText;
          console.log('[URLBar LLM] Got DuckDuckGo HTML, length:', html.length);
          
          if (html && html.length > 1000 && html.includes('result')) {
            const results = parseDuckDuckGoHTML(html, limit);
            resolve(results.length > 0 ? results : null);
          } else {
            console.warn('[URLBar LLM] DuckDuckGo returned invalid response');
            resolve(null);
          }
        } else {
          console.warn('[URLBar LLM] DuckDuckGo HTTP error:', xhr.status);
          resolve(null);
        }
      };
      
      xhr.onerror = function() {
        console.warn('[URLBar LLM] DuckDuckGo request error');
        resolve(null);
      };
      
      xhr.ontimeout = function() {
        console.warn('[URLBar LLM] DuckDuckGo request timeout');
        resolve(null);
      };
      
      xhr.open('GET', url, true);
      xhr.setRequestHeader('Accept', 'text/html,application/xhtml+xml');
      xhr.send();
    });
  }
  
  /**
   * Fallback to SearXNG public instances
   */
  async function searchSearXNG(query, limit = 5) {
    const instances = [
      'https://searx.be',
      'https://search.ononoki.org',
      'https://searx.tiekoetter.com'
    ];
    
    for (const instance of instances) {
      try {
        const searchUrl = `${instance}/search?q=${encodeURIComponent(query)}&format=json&categories=general`;
        
        const response = await Promise.race([
          fetch(searchUrl, { headers: { 'Accept': 'application/json' } }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000))
        ]);
        
        if (!response.ok) continue;
        
        const data = await response.json();
        
        if (data.results && data.results.length > 0) {
          const results = data.results.slice(0, limit).map((r, i) => {
            let source = '';
            try {
              source = new URL(r.url).hostname.replace('www.', '');
            } catch (e) {
              source = r.engine || 'unknown';
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
            console.log('[URLBar LLM] SearXNG found', results.length, 'results from', instance);
            return results;
          }
        }
      } catch (e) {
        console.warn('[URLBar LLM] SearXNG instance failed:', instance, e.message);
      }
    }
    
    return null;
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
          console.log('[URLBar LLM] Found', elements.length, 'results with selector:', selector);
          
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
        console.log('[URLBar LLM] Trying uddg link extraction...');
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
      
      console.log('[URLBar LLM] Parsed', results.length, 'results from DuckDuckGo');
      return results.slice(0, limit);
      
    } catch (error) {
      console.error('[URLBar LLM] Failed to parse DuckDuckGo HTML:', error);
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
      console.warn('[URLBar LLM] Error cleaning URL:', e);
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
  async function fetchPageContent(url, maxLength = 3000, timeout = 3500) {
    try {
      // Use CORS proxy with timeout
      const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);
      
      const response = await fetch(proxyUrl, {
        headers: {
          'Accept': 'text/html,application/xhtml+xml',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Firefox/120.0'
        },
        signal: controller.signal
      });
      
      clearTimeout(timeoutId);
      
      if (!response.ok) {
        return null;
      }
      
      const html = await response.text();
      if (!html || html.length < 100) {
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
              console.log('[URLBar LLM] Readability extracted', content.length, 'chars from:', url);
              return content.length > maxLength 
                ? content.substring(0, maxLength) + '...'
                : content;
            }
          }
        } catch (readabilityError) {
          console.warn('[URLBar LLM] Readability parsing failed:', readabilityError.message);
        }
      }
      
      // Fallback to simple extraction
      return extractMainContentSimple(doc, maxLength);
      
    } catch (error) {
      console.warn('[URLBar LLM] Error fetching page:', error.message);
      return null;
    }
  }
  
  /**
   * Simple fallback content extraction when Readability is unavailable or fails
   */
  function extractMainContentSimple(doc, maxLength = 2500) {
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
      console.warn('[URLBar LLM] Simple extraction failed:', e.message);
      return null;
    }
  }


  /**
   * Fetch content from multiple search results in parallel
   * Optimized for speed - uses shorter timeouts and settles quickly
   */
  async function fetchSearchResultsContent(searchResults, maxResults = 3) {
    const startTime = Date.now();
    console.log('[URLBar LLM] Fetching content from', Math.min(searchResults.length, maxResults), 'pages...');
    
    // Use Promise.allSettled for faster results (don't wait for slow pages)
    const fetchPromises = searchResults.slice(0, maxResults).map(async (result, index) => {
      const content = await fetchPageContent(result.url, 2000, 3000);
      return {
        ...result,
        content: content || result.snippet,
        index: index + 1 // 1-indexed for citations
      };
    });
    
    // Wait for all fetches with a shorter timeout (4 seconds max)
    const timeoutPromise = new Promise(resolve => 
      setTimeout(() => resolve('timeout'), 4000)
    );
    
    try {
      const raceResult = await Promise.race([
        Promise.allSettled(fetchPromises),
        timeoutPromise
      ]);
      
      if (raceResult === 'timeout') {
        console.warn('[URLBar LLM] Content fetch timed out after', Date.now() - startTime, 'ms, using snippets');
        return searchResults.slice(0, maxResults).map((r, i) => ({ ...r, content: r.snippet, index: i + 1 }));
      }
      
      // Extract successful results, use snippets for failed ones
      const results = raceResult.map((settled, i) => {
        if (settled.status === 'fulfilled') {
          return settled.value;
        }
        return { ...searchResults[i], content: searchResults[i].snippet, index: i + 1 };
      });
      
      console.log('[URLBar LLM] Content fetch completed in', Date.now() - startTime, 'ms');
      return results;
    } catch (error) {
      console.warn('[URLBar LLM] Error fetching content:', error);
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
   * Display source pills at the bottom of a message
   * Creates clickable pills showing the sources used
   */
  function displaySourcePills(messageElement, sources) {
    if (!messageElement || !sources || sources.length === 0) {
      return;
    }
    
    // Check if pills already exist
    let existingPills = messageElement.querySelector('.llm-source-pills');
    if (existingPills) {
      existingPills.remove();
    }
    
    // Create pills container
    const pillsContainer = document.createElement('div');
    pillsContainer.className = 'llm-source-pills';
    
    // Add label
    const label = document.createElement('span');
    label.className = 'llm-source-pills-label';
    label.textContent = 'Sources';
    pillsContainer.appendChild(label);
    
    // Create a pill for each source
    sources.forEach((source, i) => {
      const pill = document.createElement('a');
      pill.className = 'llm-source-pill';
      pill.href = source.url;
      pill.target = '_blank';
      pill.rel = 'noopener';
      pill.title = source.title;
      
      // Add index number
      const indexSpan = document.createElement('span');
      indexSpan.className = 'llm-source-pill-index';
      indexSpan.textContent = source.index || (i + 1);
      pill.appendChild(indexSpan);
      
      // Add favicon
      const favicon = document.createElement('img');
      favicon.className = 'llm-source-pill-favicon';
      favicon.src = `https://www.google.com/s2/favicons?domain=${source.source}&sz=16`;
      favicon.alt = '';
      favicon.onerror = () => { favicon.style.display = 'none'; };
      pill.appendChild(favicon);
      
      // Add source name
      const sourceName = document.createElement('span');
      sourceName.className = 'llm-source-pill-name';
      sourceName.textContent = source.source;
      pill.appendChild(sourceName);
      
      // Handle click - open in background tab
      pill.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        isClickingLink = true;
      });
      
      pill.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        
        try {
          const topWindow = window.top || window;
          const browser = topWindow.gBrowser || topWindow.getBrowser?.() || window.gBrowser;
          
          if (browser && browser.addTab) {
            browser.addTab(source.url, {
              triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
              inBackground: true
            });
            console.log('[URLBar LLM] Opened source in background:', source.url);
          } else if (topWindow.open) {
            topWindow.open(source.url, '_blank');
          }
          
          // Keep urlbar open
          setTimeout(() => {
            const urlbarInput = document.getElementById("urlbar-input");
            const urlbar = document.getElementById("urlbar");
            if (urlbarInput && urlbar) {
              urlbar.setAttribute("open", "true");
              urlbarInput.focus();
            }
            isClickingLink = false;
          }, 100);
        } catch (err) {
          console.error('[URLBar LLM] Failed to open source:', err);
          isClickingLink = false;
        }
      });
      
      pillsContainer.appendChild(pill);
    });
    
    messageElement.appendChild(pillsContainer);
    
    // Scroll to show pills
    setTimeout(() => {
      const urlbarViewBodyInner = document.querySelector(".urlbarView-body-inner");
      if (urlbarViewBodyInner) {
        urlbarViewBodyInner.scrollTop = urlbarViewBodyInner.scrollHeight;
      }
    }, 50);
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
    // Use different placeholder for follow-ups vs initial query
    const placeholder = conversationHistory.length > 0 ? "Ask a follow-up..." : "Ask anything...";
    urlbarInput.setAttribute("placeholder", placeholder);
    
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
    
    // Trigger Zen's native search mode animation (scale bounce + glow)
    triggerZenSearchModeAnimation(urlbar);
    
    console.log(`[URLBar LLM] Activated with provider: ${providerKey}, existing messages: ${conversationHistory.length}`);
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
        console.log('[URLBar LLM] Urlbar pulse animation triggered');
      }
      
      // 2. Glow effect on the pill
      const labelBox = document.getElementById("urlbar-label-box");
      if (labelBox) {
        // Trigger glow animation via CSS attribute
        labelBox.setAttribute("animate-glow", "true");
        
        // Remove the attribute after the animation completes (1 second)
        setTimeout(() => {
          requestAnimationFrame(() => {
            labelBox.removeAttribute("animate-glow");
          });
        }, 1000);
        
        console.log('[URLBar LLM] Pill glow animation triggered');
      }
      
    } catch (error) {
      console.warn('[URLBar LLM] Failed to trigger animation:', error);
    }
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
    
    // Stop events from propagating to prevent urlbar from closing
    // For links, we need special handling to allow them to work
    container.addEventListener("mousedown", (e) => {
      const target = e.target;
      const linkElement = target.tagName === 'A' ? target : target.closest('a');
      
      if (linkElement) {
        console.log("[URLBar LLM] Container mousedown - link detected, setting flag");
        // Set flag immediately to prevent blur from deactivating
        isClickingLink = true;
        // Don't stop propagation for links
        return;
      }
      
      e.stopPropagation();
      console.log("[URLBar LLM] Container mousedown blocked, target:", target.tagName);
    }, false); // Changed to bubble phase
    
    container.addEventListener("mouseup", (e) => {
      const target = e.target;
      const linkElement = target.tagName === 'A' ? target : target.closest('a');
      
      if (linkElement) {
        console.log("[URLBar LLM] Container mouseup - link detected, not blocking");
        // Don't stop propagation for links
        return;
      }
      
      e.stopPropagation();
      console.log("[URLBar LLM] Container mouseup blocked, target:", target.tagName);
    }, false); // Changed to bubble phase
    
    container.addEventListener("click", (e) => {
      const target = e.target;
      const linkElement = target.tagName === 'A' ? target : target.closest('a');
      
      if (linkElement) {
        console.log("[URLBar LLM] Container click - link detected, not blocking");
        // Don't stop propagation for links
        return;
      }
      
      e.stopPropagation();
      console.log("[URLBar LLM] Container click blocked, target:", target.tagName);
    }, false); // Changed to bubble phase
    
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
    
    // Handle link clicks using mouseup event (more reliable than click in this context)
    const handleLinkInteraction = (e, eventType) => {
      const target = e.target;
      const link = target.tagName === 'A' ? target : target.closest('a');
      
      // Handle citation marker clicks
      const citationMarker = target.classList?.contains('llm-citation-marker') ? target : target.closest('.llm-citation-marker');
      if (citationMarker && eventType === 'click') {
        e.preventDefault();
        e.stopPropagation();
        
        const sourceIndex = parseInt(citationMarker.dataset.source, 10);
        if (sourceIndex && currentSearchSources && currentSearchSources[sourceIndex - 1]) {
          const source = currentSearchSources[sourceIndex - 1];
          
          // Open the source URL in background tab
          try {
            isClickingLink = true;
            const topWindow = window.top || window;
            const browser = topWindow.gBrowser || topWindow.getBrowser?.() || window.gBrowser;
            
            if (browser && browser.addTab) {
              browser.addTab(source.url, {
                triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
                inBackground: true
              });
              console.log('[URLBar LLM] Opened source', sourceIndex, 'in background:', source.url);
            }
            
            // Highlight the corresponding pill briefly
            const pillsContainer = messageDiv.querySelector('.llm-source-pills');
            if (pillsContainer) {
              const pills = pillsContainer.querySelectorAll('.llm-source-pill');
              const pill = pills[sourceIndex - 1];
              if (pill) {
                pill.classList.add('llm-source-pill-highlight');
                setTimeout(() => pill.classList.remove('llm-source-pill-highlight'), 1000);
              }
            }
            
            setTimeout(() => {
              const urlbarInput = document.getElementById("urlbar-input");
              const urlbar = document.getElementById("urlbar");
              if (urlbarInput && urlbar) {
                urlbar.setAttribute("open", "true");
                urlbarInput.focus();
              }
              isClickingLink = false;
            }, 100);
          } catch (err) {
            console.error('[URLBar LLM] Failed to open citation source:', err);
            isClickingLink = false;
          }
        }
        return;
      }
      
      if (link && link.href) {
        console.log(`[URLBar LLM] Link ${eventType}:`, link.href);
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        
        // Only open on mouseup (acts like a click)
        if (eventType === 'mouseup') {
          try {
            const topWindow = window.top || window;
            const browser = topWindow.gBrowser || topWindow.getBrowser?.() || window.gBrowser;
            
            if (browser && browser.addTab) {
              browser.addTab(link.href, {
                triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
                inBackground: true
              });
              console.log('[URLBar LLM] Successfully opened link in background');
            } else if (topWindow.open) {
              topWindow.open(link.href, '_blank');
              console.log('[URLBar LLM] Opened using window.open');
            }
            
            // Keep urlbar open and focused
            setTimeout(() => {
              const urlbarInput = document.getElementById("urlbar-input");
              const urlbar = document.getElementById("urlbar");
              if (urlbarInput && urlbar) {
                urlbar.setAttribute("open", "true");
                urlbar.setAttribute("breakout-extend", "true");
                urlbarInput.focus();
              }
              isClickingLink = false;
              console.log('[URLBar LLM] Refocused urlbar');
            }, 100);
          } catch (err) {
            console.error('[URLBar LLM] Failed to open link:', err);
            isClickingLink = false;
          }
        }
      }
    };
    
    // Use both mousedown and mouseup for complete control
    contentDiv.addEventListener('mousedown', (e) => handleLinkInteraction(e, 'mousedown'), true);
    contentDiv.addEventListener('mouseup', (e) => handleLinkInteraction(e, 'mouseup'), true);
    contentDiv.addEventListener('click', (e) => handleLinkInteraction(e, 'click'), true);
    
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
    
    // Clear previous search sources
    currentSearchSources = [];

    // Abort any previous request
    if (abortController) {
      abortController.abort();
    }
    abortController = new AbortController();

    try {
      // Perform web search if enabled and the model decides it needs it
      let searchContext = null;
      let searchResultsForDisplay = null;
      const providerKey = urlbar.getAttribute("llm-provider");
      const supportsWebSearch = providerKey === 'openai' || providerKey === 'mistral';
      
      // Ask the LLM itself whether the query is within its knowledge scope
      let needsSearch = false;
      if (isWebSearchEnabled() && supportsWebSearch) {
        const isFollowUp = conversationHistory.length > 1;
        // Show evaluating status while the model classifies
        titleElement.innerHTML = '<span class="llm-search-spinner"></span> Evaluating...';
        needsSearch = await queryNeedsWebSearchLLM(query, isFollowUp, abortController.signal);
      }
      
      if (needsSearch) {
        // Show searching status with spinner
        titleElement.innerHTML = '<span class="llm-search-spinner"></span> Searching...';
        
        console.log('[URLBar LLM] Web search triggered for query:', query);
        const startTime = Date.now();
        const searchResults = await searchDuckDuckGo(query);
        
        if (searchResults && searchResults.length > 0) {
          // Update status - fetching content
          titleElement.innerHTML = '<span class="llm-search-spinner"></span> Reading sources...';
          
          // Fetch actual page content from search results (faster now)
          const resultsWithContent = await fetchSearchResultsContent(searchResults, 3);
          
          // Store for source pills display
          searchResultsForDisplay = resultsWithContent;
          currentSearchSources = resultsWithContent;
          
          searchContext = formatSearchResultsForLLM(resultsWithContent, query);
          console.log('[URLBar LLM] Web search completed in', Date.now() - startTime, 'ms total');
        } else {
          console.log('[URLBar LLM] Web search returned no results');
        }
      } else if (!supportsWebSearch && isWebSearchEnabled()) {
        console.log('[URLBar LLM] Web search not supported for provider:', providerKey);
      } else {
        // Clear sources if no search was performed
        currentSearchSources = [];
      }

      // Clear spinner and show thinking text
      titleElement.textContent = "Thinking...";
      
      // Prepare messages with search context if available
      let messagesToSend = conversationHistory;
      if (searchContext) {
        // Insert search context as a system message before the last user message
        const lastUserMessageIndex = conversationHistory.length - 1;
        messagesToSend = [
          ...conversationHistory.slice(0, lastUserMessageIndex),
          {
            role: "system",
            content: searchContext
          },
          conversationHistory[lastUserMessageIndex]
        ];
        console.log('[URLBar LLM] Added web search context to messages');
      }
      
      let accumulatedText = "";
      
      if (currentProvider.name === "Ollama") {
        // Ollama uses native /api/chat endpoint
        await streamOllamaResponse(messagesToSend, titleElement, abortController.signal);
      } else {
        // Standard OpenAI-compatible API (works for OpenAI, Mistral, Gemini)
        await streamOpenAIResponse(messagesToSend, titleElement, abortController.signal);
      }
      
      // Add assistant's response to conversation history
      conversationHistory.push({
        role: "assistant",
        content: currentAssistantMessage
      });
      
      console.log("[URLBar LLM] Conversation now has", conversationHistory.length, "messages");
      
      // Display source pills if we have search sources
      if (currentSearchSources && currentSearchSources.length > 0) {
        displaySourcePills(streamingResultRow, currentSearchSources);
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
    // Use native Ollama /api/chat endpoint with messages format
    console.log(`[URLBar LLM] Ollama request URL: ${currentProvider.baseUrl}`);
    console.log(`[URLBar LLM] Ollama model: ${currentProvider.model}`);
    console.log(`[URLBar LLM] Ollama messages: ${messages.length}`);
    
    const response = await fetch(currentProvider.baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: currentProvider.model,
        messages: messages,
        stream: true
      }),
      signal
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      console.error(`[URLBar LLM] Ollama API error response:`, errorText);
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
            // Native /api/chat returns message.content
            const delta = json.message?.content;
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

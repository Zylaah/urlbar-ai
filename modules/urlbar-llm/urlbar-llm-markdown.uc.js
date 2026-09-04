// ==UserScript==
// @include   main
// @loadOrder 5
// @ignorecache
// ==/UserScript==

// urlbar-llm-markdown.uc.js — vendors, markdown render, conversation DOM
(function () {
  "use strict";

  if (location.href !== "chrome://browser/content/browser.xhtml") return;

  window.urlbarLlmMarkdown = {
    create(deps) {
      if (!deps?.prefs || !deps?.state || !deps?.api) {
        console.error("[URLBar LLM] urlbarLlmMarkdown: missing deps");
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

      // Suppress/restore the native urlbar blur handler.
      // This follows the same pattern Firefox uses in UrlbarController.focusOnUnifiedSearchButton()
      // to prevent the panel from closing when focus temporarily leaves the input.
      function suppressNativeBlur() {
        if (window.gURLBar && window.gURLBar.inputField) {
          window.gURLBar.inputField.removeEventListener("blur", window.gURLBar);
        }
      }
      function restoreNativeBlur() {
        if (window.gURLBar && window.gURLBar.inputField) {
          window.gURLBar.inputField.addEventListener("blur", window.gURLBar);
        }
      }

      /**
       * Refocus `#urlbar-input` and restore native blur handling when LLM mode is still active.
       * Used after links/citations and code-block copy — skips if
       * the user already left LLM (e.g. clicked outside during `FOCUS_RESTORE_DELAY`).
       * Clears `state.isSelectingInContainer` so outside-click dismissal works as expected.
       * @param {object} [options]
       * @param {boolean} [options.extendBreakout] – set urlbar `breakout-extend` (streaming row)
       */
      function refocusUrlbarAfterLinkIfStillInLlmMode(options = {}) {
        const extendBreakout = options.extendBreakout === true;
        state.isSelectingInContainer = false;
        if (!state.isLLMMode) {
          state.isClickingLink = false;
          restoreNativeBlur();
          return;
        }
        const urlbarInput = document.getElementById("urlbar-input");
        const urlbar = document.getElementById("urlbar");
        if (urlbarInput && urlbar) {
          urlbar.setAttribute("open", "true");
          if (extendBreakout) {
            urlbar.setAttribute("breakout-extend", "true");
          }
          urlbarInput.focus();
        }
        state.isClickingLink = false;
        restoreNativeBlur();
        if (extendBreakout) {
          log("Refocused urlbar");
        }
      }

      // ============================================
      // Load marked (markdown parser), DOMPurify (sanitizer), highlight.js (syntax highlighting)
      // ============================================
      let markedLib = null;
      let DOMPurifyLib = null;
      let hljsLib = null;
      try {
        const vendorsDir = resolveModRoot() + "vendors/";
        Services.scriptloader.loadSubScript(vendorsDir + "marked.min.js");
        Services.scriptloader.loadSubScript(vendorsDir + "purify.min.js");
        markedLib = (typeof marked !== "undefined") ? marked : null;
        DOMPurifyLib = (typeof DOMPurify !== "undefined") ? DOMPurify : null;
        if (markedLib && DOMPurifyLib) {
          log("Loaded marked and DOMPurify from", vendorsDir);
        } else {
          markedLib = null;
          DOMPurifyLib = null;
          logWarn("marked or DOMPurify failed to load, using fallback markdown parser");
        }
        try {
          Services.scriptloader.loadSubScript(vendorsDir + "highlight.min.js");
          hljsLib = (typeof hljs !== "undefined") ? hljs : null;
          if (hljsLib) {
            log("Loaded highlight.js from", vendorsDir);
          } else {
            logWarn("highlight.js failed to expose hljs; code blocks will render without highlighting");
          }
        } catch (hlErr) {
          logWarn("Could not load highlight.js:", hlErr.message, "- code blocks will render without highlighting");
        }
      } catch (e) {
        logWarn("Could not load marked/DOMPurify:", e.message, "- using fallback markdown parser");
      }

      /**
       * Tighten model output before Markdown parse: trim trailing spaces per line and collapse
       * excessive blank lines (outside fenced ``` blocks) so GFM does not emit huge `<p>` gaps
       * or extra thematic breaks from inconsistent spacing.
       */
      /**
       * Ensure fenced code blocks are balanced so marked closes them correctly.
       * Fixes "whole message renders as a code block" when a closing fence is missing
       * (mid-stream, or when the model forgets/mangles it) and de-indents fence-only lines
       * so a leading-whitespace fence still terminates the block.
       */
      /**
       * Remove accidental leading indentation inside a code block (common when the LLM
       * indents ``` fences inside lists or numbered steps). Preserves relative indent
       * when lines differ; strips only the minimum shared prefix on non-empty lines.
       */
      function stripCommonLeadingIndent(text) {
        if (!text || typeof text !== "string") {
          return text;
        }
        const lines = text.replace(/\r\n/g, "\n").split("\n");
        const nonEmpty = lines.filter((line) => line.trim().length > 0);
        if (!nonEmpty.length) {
          return "";
        }

        const minIndent = nonEmpty.reduce((min, line) => {
          const prefix = line.match(/^[ \t]*/);
          const len = prefix ? prefix[0].length : 0;
          return Math.min(min, len);
        }, Infinity);

        if (!Number.isFinite(minIndent) || minIndent === 0) {
          return lines.map((line) => line.trimEnd()).join("\n").trim();
        }

        return lines
          .map((line) => {
            if (!line.trim()) {
              return "";
            }
            return line.slice(minIndent).trimEnd();
          })
          .join("\n")
          .trim();
      }

      /** Dedent the body of a ```…``` chunk before marked parses it. */
      function normalizeFencedCodeChunk(chunk) {
        if (!chunk || typeof chunk !== "string") {
          return chunk;
        }
        const m = chunk.match(/^(`{3,})([^\n]*)\n?([\s\S]*?)\n?`{3,}\s*$/);
        if (!m) {
          return chunk;
        }
        const fence = m[1];
        const info = m[2];
        const body = stripCommonLeadingIndent(m[3]);
        return `${fence}${info}\n${body}\n${fence}`;
      }

      function balanceCodeFences(text) {
        if (!text || typeof text !== "string") {
          return text;
        }
        // De-indent lines that are nothing but a fence (``` or ~~~), optionally with a language.
        let out = text.replace(/^[ \t]+(`{3,}|~{3,})([^\n`]*)$/gm, "$1$2");

        // Count top-level fence markers (at line start). Odd count => an unterminated block.
        const fenceLines = out.match(/^(`{3,}|~{3,})/gm) || [];
        if (fenceLines.length % 2 === 1) {
          const last = fenceLines[fenceLines.length - 1];
          const closer = last[0].repeat(last.length); // match the marker char/length of the opener
          if (!/\n$/.test(out)) {
            out += "\n";
          }
          out += closer + "\n";
        }
        return out;
      }

      function normalizeAssistantMarkdownText(text) {
        if (text == null || typeof text !== "string") {
          return text;
        }
        text = balanceCodeFences(text);
        const chunks = text.split(/(```[\s\S]*?```)/g);
        for (let i = 0; i < chunks.length; i++) {
          if (i % 2 === 1) {
            chunks[i] = normalizeFencedCodeChunk(chunks[i]);
            continue;
          }
          chunks[i] = chunks[i]
            .replace(/\r\n/g, "\n")
            .replace(/^[ \t]+$/gm, "")
            // GFM hard line breaks (two+ trailing spaces before \n) → extra <br> in output
            .replace(/[ \t]{2,}\n/g, "\n")
            .replace(/\n{3,}/g, "\n\n");
        }
        return chunks.join("");
      }

      /**
       * Replace thematic breaks (<hr>) with a line break that survives post-processing.
       * A lone <br> between blocks is stripped by compactAssistantMarkdownHtmlString and
       * normalizeAssistantContentDom; wrap it in a minimal paragraph with a marked <br>.
       */
      function replaceHorizontalRulesWithBreaks(html) {
        if (!html || typeof html !== "string") {
          return html;
        }
        return html.replace(
          /<hr\b[^>]*\/?>/gi,
          '<p class="llm-markdown-gap"><br class="llm-hr-break" /></p>'
        );
      }

      /**
       * browser.xhtml is XML; assigning innerHTML rejects HTML5 void tags like <br>.
       * Self-close void elements so marked/DOMPurify output parses in chrome UI.
       */
      function normalizeHtmlFragmentForXul(html) {
        if (!html || typeof html !== "string") {
          return html;
        }
        const voidTags =
          "area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr";
        return html.replace(
          new RegExp(`<(${voidTags})\\b([^>]*?)(?:\\s*/)?>`, "gi"),
          (_match, tag, attrs) => {
            const name = tag.toLowerCase();
            const trimmed = (attrs || "").trim();
            return trimmed ? `<${name} ${trimmed}/>` : `<${name}/>`;
          }
        );
      }

      /**
       * Strip noisy <br> between block-level tags (model/marked often emits these).
       */
      function compactAssistantMarkdownHtmlString(html) {
        if (!html || typeof html !== "string") {
          return html;
        }
        let h = html;
        const br = String.raw`<br\s*/?>`;
        const ws = String.raw`\s*`;
        h = h.replace(new RegExp(`</(ul|ol|h[1-6]|p|blockquote|table|pre)>${ws}(?:${br}${ws})+`, "gi"), "</$1>");
        h = h.replace(new RegExp(`(?:${br}${ws})+<(ul|ol|h[1-6]|p|blockquote|table|pre)\\b`, "gi"), "<$1");
        h = h.replace(new RegExp(`</li>${ws}(?:${br}${ws})+`, "gi"), "</li>");
        h = h.replace(new RegExp(`(?:${br}${ws})+<li\\b`, "gi"), "<li");
        h = h.replace(new RegExp(`(?:${br}${ws})+<hr\\b`, "gi"), "<hr");
        h = h.replace(/<hr([^>]*)\/?>(?:\s*<br\s*\/?>\s*)+/gi, "<hr$1/>");
        h = h.replace(/(?:<br\s*\/?>\s*){3,}/gi, "<br /><br />");
        let prev;
        do {
          prev = h;
          const m = h.match(/^\s*<span([^>]*)>([\s\S]*)<\/span>\s*$/i);
          if (
            m &&
            !/\bllm-citation-marker\b/i.test(m[1]) &&
            /<(h[1-6]|ul|ol|hr|blockquote|pre|table)\b/i.test(m[2])
          ) {
            h = m[2].trim();
          }
        } while (h !== prev);
        return h;
      }

      /**
       * Unwrap phrasing-only <span>s that incorrectly wrap block markup (breaks our `> * + *` CSS),
       * then drop leftover <br> between block siblings.
       */
      function normalizeAssistantContentDom(root) {
        if (!root) {
          return;
        }
        const blockTag = /^(UL|OL|LI|H[1-6]|HR|P|BLOCKQUOTE|PRE|TABLE|DIV)$/i;
        const isCodeWrapper = (el) =>
          el && el.classList && el.classList.contains("llm-code-block-wrapper");

        let again = true;
        while (again) {
          again = false;
          const spans = [...root.querySelectorAll("span")].filter(
            (s) =>
              !s.classList.contains("llm-citation-marker") &&
              !s.classList.contains("llm-citation-fallback")
          );
          for (const span of spans) {
            if (!span.querySelector("h1,h2,h3,h4,h5,h6,ul,ol,hr,blockquote,pre,table")) {
              continue;
            }
            const parent = span.parentNode;
            if (!parent) {
              continue;
            }
            while (span.firstChild) {
              parent.insertBefore(span.firstChild, span);
            }
            parent.removeChild(span);
            again = true;
            break;
          }
        }

        // Drop redundant <br> between block siblings (not every br touching a block).
        // Skips whitespace-only text nodes; preserves intra-paragraph line breaks.
        const isBlockEl = (el) =>
          el && el.nodeType === 1 && (blockTag.test(el.tagName) || isCodeWrapper(el));
        const meaningfulSibling = (node, dir) => {
          let n = dir === "prev" ? node.previousSibling : node.nextSibling;
          while (n) {
            if (n.nodeType === 3) {
              if (n.textContent.trim()) {
                return n;
              }
              n = dir === "prev" ? n.previousSibling : n.nextSibling;
              continue;
            }
            return n;
          }
          return null;
        };
        [...root.querySelectorAll("br")].forEach((br) => {
          if (br.classList.contains("llm-hr-break")) {
            return;
          }
          const prev = meaningfulSibling(br, "prev");
          const next = meaningfulSibling(br, "next");
          const prevBlock = prev && prev.nodeType === 1 && isBlockEl(prev);
          const nextBlock = next && next.nodeType === 1 && isBlockEl(next);

          if (prevBlock && (nextBlock || !next)) {
            br.remove();
            return;
          }
          if (!prev && nextBlock) {
            br.remove();
            return;
          }
          if (
            prev &&
            prev.nodeType === 1 &&
            prev.tagName === "LI" &&
            next &&
            next.nodeType === 1 &&
            next.tagName === "LI"
          ) {
            br.remove();
          }
        });
      }

      // Render markdown as DOM elements (uses marked + DOMPurify when available, fallback to custom parser)
      function renderMarkdownToElement(text, element) {
        if (!text) {
          element.textContent = "";
          return;
        }
        text = normalizeAssistantMarkdownText(text);
        element.textContent = "";

        if (markedLib && DOMPurifyLib) {
          // Use marked (CommonMark/GFM) + DOMPurify for robust, secure rendering
          try {
            const rawHtml = markedLib.parse(text, { gfm: true, breaks: false });
            // Post-process: citation markers [1], [2] -> styled spans (favicon injected later)
            const withCitations = rawHtml.replace(/\[(\d+)\](?!\()/g, '<span class="llm-citation-marker" data-source="$1"></span>');
            // Add CSS classes and link attributes for our styling/behavior
            const withClasses = withCitations
              .replace(/<table>/g, '<table class="llm-markdown-table">')
              .replace(/<a href=/g, '<a target="_blank" rel="noopener" href=');
            const compacted = compactAssistantMarkdownHtmlString(
              replaceHorizontalRulesWithBreaks(withClasses.trim())
            );
            const sanitized = DOMPurifyLib.sanitize(compacted, {
              ALLOWED_URI_REGEXP: /^https?:\/\//i,
              ADD_ATTR: ["target", "rel", "data-source", "class"]
            });
            element.innerHTML = normalizeHtmlFragmentForXul(sanitized.trim());
            attachCopyButtonsToCodeBlocks(element);
            normalizeAssistantContentDom(element);
          } catch (e) {
            logWarn("marked/DOMPurify render failed, using fallback:", e.message);
            renderMarkdownFallback(text, element);
          }
        } else {
          renderMarkdownFallback(text, element);
        }
      }

      /** Extract the language token from a <code class="language-xxx"> element. */
      function getCodeLanguage(code) {
        const cls = (code && code.className) || "";
        const m = cls.match(/(?:^|\s)language-([\w+#-]+)/i);
        return m ? m[1].toLowerCase() : "";
      }

      /** Friendly display name for a language token. */
      function displayLanguageName(lang) {
        if (!lang) return "code";
        const map = {
          js: "javascript",
          ts: "typescript",
          sh: "bash",
          shell: "bash",
          zsh: "bash",
          py: "python",
          rb: "ruby",
          yml: "yaml",
          md: "markdown",
          "c++": "cpp",
          "c#": "csharp",
          cs: "csharp",
          ps: "powershell",
          ps1: "powershell",
        };
        return map[lang] || lang;
      }

      /** Run highlight.js over a <code> element (operates on its text only — safe post-sanitize). */
      function normalizeCodeElementText(code) {
        if (!code) return;
        const normalized = stripCommonLeadingIndent(code.textContent || "");
        if (normalized !== code.textContent) {
          code.textContent = normalized;
        }
      }

      function highlightCodeElement(code, lang) {
        if (!hljsLib || !code) return;
        try {
          const raw = code.textContent || "";
          const canHighlight = lang && typeof hljsLib.getLanguage === "function" && hljsLib.getLanguage(lang);
          const result = canHighlight
            ? hljsLib.highlight(raw, { language: lang, ignoreIllegals: true })
            : (typeof hljsLib.highlightAuto === "function" ? hljsLib.highlightAuto(raw) : null);
          if (result && typeof result.value === "string") {
            code.innerHTML = result.value;
            code.classList.add("hljs");
          }
        } catch (e) {
          // Leave the plain (already-sanitized) text in place on any failure.
        }
      }

      function copyTextToClipboard(text, onDone) {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(onDone).catch(() => {});
          return;
        }
        try {
          const ta = document.createElement("textarea");
          ta.value = text;
          ta.style.position = "fixed";
          ta.style.left = "-9999px";
          document.body.appendChild(ta);
          ta.select();
          document.execCommand("copy");
          document.body.removeChild(ta);
          onDone();
        } catch (err) {}
      }

      function attachCopyButtonsToCodeBlocks(container) {
        if (!container) return;
        container.querySelectorAll('pre').forEach((pre) => {
          const code = pre.querySelector('code');
          if (!code) return;

          const lang = getCodeLanguage(code);

          const wrapper = document.createElement('div');
          wrapper.className = 'llm-code-block-wrapper';
          pre.parentNode.insertBefore(wrapper, pre);

          // Header bar: language (left) + Copy button (right)
          const header = document.createElement('div');
          header.className = 'llm-code-header';

          const langLabel = document.createElement('span');
          langLabel.className = 'llm-code-lang';
          const langIcon = document.createElement('span');
          langIcon.className = 'llm-code-lang-icon';
          langIcon.setAttribute('aria-hidden', 'true');
          const langText = document.createElement('span');
          langText.className = 'llm-code-lang-text';
          langText.textContent = displayLanguageName(lang);
          langLabel.appendChild(langIcon);
          langLabel.appendChild(langText);

          const btn = document.createElement('button');
          btn.className = 'llm-code-copy-btn';
          btn.type = 'button';
          btn.setAttribute('aria-label', 'Copy code');
          const btnIcon = document.createElement('span');
          btnIcon.className = 'llm-code-copy-icon';
          btnIcon.setAttribute('aria-hidden', 'true');
          const btnText = document.createElement('span');
          btnText.className = 'llm-code-copy-text';
          btnText.textContent = 'Copy';
          btn.appendChild(btnIcon);
          btn.appendChild(btnText);
          btn.addEventListener('mousedown', (e) => {
            e.preventDefault();
          });

          header.appendChild(langLabel);
          header.appendChild(btn);

          wrapper.appendChild(header);
          wrapper.appendChild(pre);

          normalizeCodeElementText(code);
          // Syntax highlighting (after move into wrapper; operates on text only)
          highlightCodeElement(code, lang);

          btn.addEventListener('click', () => {
            const text = code.textContent || '';
            const showCopied = () => {
              btn.classList.add('llm-copy-copied');
              btnText.textContent = 'Copied';
              btn.setAttribute('aria-label', 'Copied');
              setTimeout(() => {
                btn.classList.remove('llm-copy-copied');
                btnText.textContent = 'Copy';
                btn.setAttribute('aria-label', 'Copy code');
              }, 1500);
            };
            const afterCopy = () => {
              showCopied();
              setTimeout(() => refocusUrlbarAfterLinkIfStillInLlmMode(), LIMITS.FOCUS_RESTORE_DELAY);
            };
            copyTextToClipboard(text, afterCopy);
          });
        });
      }

      // Fallback markdown parser (custom regex-based) when marked/DOMPurify aren't available
      function renderMarkdownFallback(text, element) {
        const parts = [];
        let lastIndex = 0;
        const codeBlockRegex = /```(\w+)?\n([\s\S]*?)```/g;
        const tableRegex = /(?:^|\n)((?:\|[^\n]+\|\r?\n)+)/g;
        let match;
        let codeMatches = [];
        while ((match = codeBlockRegex.exec(text)) !== null) {
          codeMatches.push({ index: match.index, end: match.index + match[0].length, type: 'code', lang: match[1], content: match[2] });
        }
        let tableMatches = [];
        while ((match = tableRegex.exec(text)) !== null) {
          const tableStart = match.index + (match[0].startsWith('\n') ? 1 : 0);
          const tableEnd = match.index + match[0].length;
          const insideCodeBlock = codeMatches.some(cb => tableStart >= cb.index && tableEnd <= cb.end);
          if (!insideCodeBlock) {
            const tableContent = match[1].trim();
            const rows = tableContent.split('\n').filter(r => r.trim());
            if (rows.length >= 2) {
              const hasValidSeparator = rows.some(row => /^\|[\s\-:|]+\|$/.test(row.trim()));
              if (hasValidSeparator) {
                tableMatches.push({ index: tableStart, end: tableEnd, type: 'table', content: tableContent });
              }
            }
          }
        }
        const allMatches = [...codeMatches, ...tableMatches].sort((a, b) => a.index - b.index);
        for (const m of allMatches) {
          if (m.index > lastIndex) {
            parts.push({ type: 'text', content: text.slice(lastIndex, m.index) });
          }
          parts.push(m);
          lastIndex = m.end;
        }
        if (lastIndex < text.length) {
          parts.push({ type: 'text', content: text.slice(lastIndex) });
        }
        for (const part of parts) {
          if (part.type === 'code') {
            const pre = document.createElement('pre');
            const code = document.createElement('code');
            if (part.lang) code.className = `language-${part.lang}`;
            code.textContent = stripCommonLeadingIndent(part.content);
            pre.appendChild(code);
            element.appendChild(pre);
          } else if (part.type === 'table') {
            const table = parseMarkdownTable(part.content);
            if (table) element.appendChild(table);
          } else {
            const span = document.createElement('span');
            span.innerHTML = normalizeHtmlFragmentForXul(parseInlineMarkdown(part.content));
            element.appendChild(span);
          }
        }
        attachCopyButtonsToCodeBlocks(element);
        normalizeAssistantContentDom(element);
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
                th.innerHTML = normalizeHtmlFragmentForXul(parseInlineMarkdown(cell));
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
                td.innerHTML = normalizeHtmlFragmentForXul(parseInlineMarkdown(cell));
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
          logWarn('Failed to parse table:', e);
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
        
        // Bold-italic (***text*** or ___text___) - must be before bold and italic
        html = html.replace(/\*\*\*([^*]+?)\*\*\*/g, '<strong><em>$1</em></strong>');
        html = html.replace(/___([^_]+?)___/g, '<strong><em>$1</em></strong>');
        
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
        
        // Links [text](url) - only allow http/https to prevent javascript: injection
        html = html.replace(/\[([^\]]+)\]\(([^\)]+)\)/g, (match, text, url) => {
          const trimmedUrl = url.trim().toLowerCase();
          if (trimmedUrl.startsWith('http://') || trimmedUrl.startsWith('https://')) {
            return `<a href="${url}" target="_blank" rel="noopener">${text}</a>`;
          }
          return text; // Strip unsafe links, keep text
        });
        
        // Citation markers [1], [2], etc. - convert to styled spans (favicon injected later by injectFaviconsIntoCitationMarkers)
        // Match [1], [2], [3] etc. but not [text](url) links which were already converted
        html = html.replace(/\[(\d+)\](?!\()/g, '<span class="llm-citation-marker" data-source="$1"></span>');
        
        // Horizontal rule (---, ***, ___) → preserved line break (see replaceHorizontalRulesWithBreaks)
        html = html.replace(
          /^(?:---+|\*\*\*+|___+)\s*$/gm,
          '<p class="llm-markdown-gap"><br class="llm-hr-break" /></p>'
        );
        
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
       * Inject favicons into citation markers [1], [2], etc. and set data-url for click-to-open.
       * No separate source section – markers in the text show the site favicon only.
       */
      function injectFaviconsIntoCitationMarkers(messageElement, sources) {
        if (!messageElement || !sources || sources.length === 0) {
          return;
        }
        if (!messageElement.isConnected) {
          return; // Row was removed (e.g. user sent new message or deactivated)
        }
        const getSourceUrl = (s) => s && (s.url || s.href || s.link || '');
        const domainForFavicon = (s) => {
          if (s && s.source) return s.source;
          const url = getSourceUrl(s);
          if (url) {
            try {
              return new URL(url).hostname.replace(/^www\./, '');
            } catch (e) {
              return '';
            }
          }
          return '';
        };
        messageElement.querySelectorAll('.llm-citation-marker').forEach((marker) => {
          marker.querySelectorAll(".llm-citation-favicon, .llm-citation-fallback").forEach((el) => el.remove());
          const idx = parseInt(marker.dataset.source, 10);
          const source = sources[idx - 1];
          const url = getSourceUrl(source);
          if (!source || !url) return;
          marker.dataset.url = url;
          marker.title = source.title || source.source || url;
          const domain = domainForFavicon(source);
          if (!domain) return;
          const enc = encodeURIComponent(domain);
          const urls = [
            `https://www.google.com/s2/favicons?domain=${enc}&sz=32`,
            `https://icons.duckduckgo.com/ip3/${enc}.ico`
          ];
          const img = document.createElement('img');
          img.className = 'llm-citation-favicon';
          let urlIndex = 0;
          img.src = urls[0];
          img.alt = '';
          img.onerror = () => {
            urlIndex++;
            if (urlIndex < urls.length) {
              img.src = urls[urlIndex];
            } else {
              img.remove();
              const fallback = document.createElement('span');
              fallback.className = 'llm-citation-fallback';
              fallback.textContent = idx;
              fallback.title = marker.title || '';
              marker.appendChild(fallback);
            }
          };
          marker.appendChild(img);
        });
      }

      function displayUserMessage(message) {
        // Get or create conversation container
        if (!state.conversationContainer || !state.conversationContainer.parentNode) {
          log("Creating/recreating conversation container");
          state.conversationContainer = createConversationContainer();
        }
        
        if (!state.conversationContainer) {
          logError("Failed to create conversation container");
          return;
        }
        
        // Create user message element
        const messageDiv = document.createElement("div");
        messageDiv.className = "llm-message llm-message-user";
        messageDiv.textContent = message;
        
        state.conversationContainer.appendChild(messageDiv);
        
        log("User message added. Total children:", state.conversationContainer.children.length);
        
        // Scroll so the user's follow-up message is at the top of the visible area.
        // Use double-rAF to ensure the DOM has been laid out and painted.
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            if (messageDiv) {
              messageDiv.scrollIntoView({ block: 'start', behavior: 'smooth' });
              log("Scrolled to user message via scrollIntoView");
            }
          });
        });
      }

      function createConversationContainer() {
        // Get urlbar view container
        const urlbarView = document.querySelector(".urlbarView");
        if (!urlbarView) {
          logError("Could not find urlbarView");
          return null;
        }

        // Find results container
        let resultsContainer = urlbarView.querySelector(".urlbarView-results");
        if (!resultsContainer) {
          resultsContainer = urlbarView.querySelector(".urlbarView-body");
        }
        if (!resultsContainer) {
          logError("Could not find results container");
          return null;
        }
        
        // Check if container already exists
        let container = resultsContainer.querySelector(".llm-conversation-container");
        if (container) {
          log("Reusing existing conversation container");
          return container;
        }
        
        // Create conversation container
        container = document.createElement("div");
        container.className = "llm-conversation-container";
        // Make the container focusable so it can receive keyboard events (Ctrl+C)
        container.setAttribute("tabindex", "-1");
        log("Creating new conversation container");
        
        container.addEventListener("mousedown", (e) => {
          const target = e.target;
          const linkElement = target.tagName === 'A' ? target : target.closest('a');
          const citationMarker = target.classList?.contains('llm-citation-marker') ? target : target.closest('.llm-citation-marker');

          if (linkElement || citationMarker) {
            log("Container mousedown - link/citation detected, setting flag");
            state.isClickingLink = true;
            suppressNativeBlur();
            return;
          }

          // Suppress native blur so the panel stays open during text selection
          suppressNativeBlur();
          state.isSelectingInContainer = true;
          
          // Focus the container so it receives keyboard events (Ctrl+C for copy).
          // This must happen after suppressNativeBlur() so the input's blur
          // doesn't close the panel.
          container.focus({ preventScroll: true });
          
          log("Container mousedown - selection started, target:", target.tagName);
          e.stopPropagation();
        }, false);
        
        container.addEventListener("mouseup", (e) => {
          const target = e.target;
          const linkElement = target.tagName === 'A' ? target : target.closest('a');
          const citationMarker = target.classList?.contains('llm-citation-marker') ? target : target.closest('.llm-citation-marker');

          if (linkElement || citationMarker) {
            return; // Link/citation handler takes care of restoring blur
          }
          
          e.stopPropagation();
          
          // Keep the urlbar panel open. The container has focus so Ctrl+C will work.
          // Native blur stays suppressed until user clicks back on the input or types.
          if (state.isSelectingInContainer) {
            const urlbar = document.getElementById("urlbar");
            if (urlbar && state.isLLMMode) {
              urlbar.setAttribute("open", "true");
              urlbar.setAttribute("breakout-extend", "true");
            }
          }
        }, false);
        
        container.addEventListener("click", (e) => {
          const target = e.target;
          const citationMarker = target.classList?.contains('llm-citation-marker') ? target : target.closest('.llm-citation-marker');
          const linkElement = target.tagName === 'A' ? target : target.closest('a');

          // Handle citation marker clicks (works for both streaming and history-loaded content)
          if (citationMarker) {
            e.preventDefault();
            e.stopPropagation();
            let url = citationMarker.dataset.url ||
              (state.currentSearchSources && state.currentSearchSources[parseInt(citationMarker.dataset.source, 10) - 1]?.url);
            if (!url) {
              const msgDiv = citationMarker.closest('.llm-message-assistant');
              const stored = msgDiv?.dataset?.citationSources;
              if (stored) {
                try {
                  const sources = JSON.parse(stored);
                  const s = sources[parseInt(citationMarker.dataset.source, 10) - 1];
                  url = s && (s.url || s.href || s.link);
                } catch (err) {}
              }
            }
            if (url) {
              try {
                state.isClickingLink = true;
                suppressNativeBlur();
                const topWindow = window.top || window;
                const browser = topWindow.gBrowser || topWindow.getBrowser?.() || window.gBrowser;
                if (browser && browser.addTab) {
                  browser.addTab(url, {
                    triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
                    inBackground: true
                  });
                  log('Opened citation source in background:', url);
                }
                citationMarker.classList.add('llm-citation-marker-highlight');
                setTimeout(() => citationMarker.classList.remove('llm-citation-marker-highlight'), LIMITS.ANIMATION_GLOW_DURATION);
                setTimeout(() => refocusUrlbarAfterLinkIfStillInLlmMode(), LIMITS.FOCUS_RESTORE_DELAY);
              } catch (err) {
                logError('Failed to open citation source:', err);
                state.isClickingLink = false;
                restoreNativeBlur();
              }
            }
            return;
          }

          // Handle markdown links (for history-loaded content; streaming uses contentDiv handler)
          if (linkElement && linkElement.href) {
            e.preventDefault();
            e.stopPropagation();
            try {
              const topWindow = window.top || window;
              const browser = topWindow.gBrowser || topWindow.getBrowser?.() || window.gBrowser;
              if (browser && browser.addTab) {
                browser.addTab(linkElement.href, {
                  triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
                  inBackground: true
                });
              } else if (topWindow.open) {
                topWindow.open(linkElement.href, '_blank');
              }
              setTimeout(() => refocusUrlbarAfterLinkIfStillInLlmMode(), LIMITS.FOCUS_RESTORE_DELAY);
            } catch (err) {
              logError('Failed to open link:', err);
              state.isClickingLink = false;
              restoreNativeBlur();
            }
            return;
          }

          if (!linkElement) {
            e.stopPropagation();
          }
        }, false);
        
        // Handle mouseup outside the container (user dragged selection beyond it)
        document.addEventListener("mouseup", () => {
          if (state.isSelectingInContainer) {
            const urlbar = document.getElementById("urlbar");
            if (urlbar && state.isLLMMode) {
              urlbar.setAttribute("open", "true");
              urlbar.setAttribute("breakout-extend", "true");
            }
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
        if (!state.conversationContainer || !state.conversationContainer.parentNode) {
          log("Creating/recreating conversation container for assistant");
          state.conversationContainer = createConversationContainer();
        }
        
        if (!state.conversationContainer) {
          logError("Failed to create conversation container for assistant");
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
            const url = citationMarker.dataset.url || (state.currentSearchSources && state.currentSearchSources[parseInt(citationMarker.dataset.source, 10) - 1]?.url);
            if (url) {
              try {
                state.isClickingLink = true;
                suppressNativeBlur();
                const topWindow = window.top || window;
                const browser = topWindow.gBrowser || topWindow.getBrowser?.() || window.gBrowser;
                if (browser && browser.addTab) {
                  browser.addTab(url, {
                    triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
                    inBackground: true
                  });
                  log('Opened citation source in background:', url);
                }
                citationMarker.classList.add('llm-citation-marker-highlight');
                setTimeout(() => citationMarker.classList.remove('llm-citation-marker-highlight'), LIMITS.ANIMATION_GLOW_DURATION);
                setTimeout(() => refocusUrlbarAfterLinkIfStillInLlmMode(), LIMITS.FOCUS_RESTORE_DELAY);
              } catch (err) {
                logError('Failed to open citation source:', err);
                state.isClickingLink = false;
                restoreNativeBlur();
              }
            }
            return;
          }
          
          if (link && link.href) {
            log(`Link ${eventType}:`, link.href);
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();

            if (eventType === 'mousedown') {
              state.isClickingLink = true;
              suppressNativeBlur();
            }
            
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
                  log('Successfully opened link in background');
                } else if (topWindow.open) {
                  topWindow.open(link.href, '_blank');
                  log('Opened using window.open');
                }
                
                // Keep urlbar open and focused
                setTimeout(
                  () => refocusUrlbarAfterLinkIfStillInLlmMode({ extendBreakout: true }),
                  LIMITS.FOCUS_RESTORE_DELAY
                );
              } catch (err) {
                logError('Failed to open link:', err);
                state.isClickingLink = false;
                restoreNativeBlur();
              }
            }
          }
        };
        
        // Use both mousedown and mouseup for complete control
        contentDiv.addEventListener('mousedown', (e) => handleLinkInteraction(e, 'mousedown'), true);
        contentDiv.addEventListener('mouseup', (e) => handleLinkInteraction(e, 'mouseup'), true);
        contentDiv.addEventListener('click', (e) => handleLinkInteraction(e, 'click'), true);
        
        messageDiv.appendChild(contentDiv);
        state.conversationContainer.appendChild(messageDiv);
        
        log("Assistant message added. Total children:", state.conversationContainer.children.length);
        
        return { row: messageDiv, title: contentDiv };
      }

      return {
        suppressNativeBlur,
        restoreNativeBlur,
        refocusUrlbarAfterLinkIfStillInLlmMode,
        stripCommonLeadingIndent,
        normalizeFencedCodeChunk,
        balanceCodeFences,
        normalizeAssistantMarkdownText,
        replaceHorizontalRulesWithBreaks,
        normalizeHtmlFragmentForXul,
        compactAssistantMarkdownHtmlString,
        normalizeAssistantContentDom,
        renderMarkdownToElement,
        getCodeLanguage,
        displayLanguageName,
        normalizeCodeElementText,
        highlightCodeElement,
        copyTextToClipboard,
        attachCopyButtonsToCodeBlocks,
        renderMarkdownFallback,
        parseMarkdownTable,
        parseTableRow,
        parseInlineMarkdown,
        escapeHtml,
        injectFaviconsIntoCitationMarkers,
        displayUserMessage,
        createConversationContainer,
        createStreamingResultRow
      };
    }
  };
})();

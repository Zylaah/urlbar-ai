// ==UserScript==
// @include   main
// @loadOrder 4
// @ignorecache
// ==/UserScript==

// urlbar-llm-history-store.uc.js — IndexedDB session persistence
(function () {
  "use strict";

  if (location.href !== "chrome://browser/content/browser.xhtml") return;

  window.urlbarLlmHistoryStore = {
    create(deps) {
      if (!deps?.prefs || !deps?.state || !deps?.api) {
        console.error("[URLBar LLM] urlbarLlmHistoryStore: missing deps");
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
      // ============================================
      // Global conversation history (IndexedDB)
      // ============================================
      const HISTORY_DB_NAME = "urlbar-llm-history";
      const HISTORY_DB_VERSION = 1;
      const HISTORY_STORE_NAME = "sessions";

      function openHistoryDB() {
        return new Promise((resolve, reject) => {
          const req = indexedDB.open(HISTORY_DB_NAME, HISTORY_DB_VERSION);
          req.onerror = () => reject(req.error);
          req.onsuccess = () => resolve(req.result);
          req.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(HISTORY_STORE_NAME)) {
              const store = db.createObjectStore(HISTORY_STORE_NAME, { keyPath: "id" });
              store.createIndex("providerKey", "providerKey", { unique: false });
              store.createIndex("providerUpdated", ["providerKey", "updatedAt"], { unique: false });
            }
          };
        });
      }

      /** Get all sessions for a provider, newest first */
      function getProviderSessions(providerKey) {
        return new Promise((resolve, reject) => {
          if (!providerKey) {
            resolve([]);
            return;
          }
          openHistoryDB().then((db) => {
            const tx = db.transaction(HISTORY_STORE_NAME, "readonly");
            const store = tx.objectStore(HISTORY_STORE_NAME);
            const index = store.index("providerKey");
            const req = index.getAll(IDBKeyRange.only(providerKey));
            req.onsuccess = () => {
              const sessions = (req.result || [])
                .filter((s) => s && s.providerKey === providerKey)
                .map(repairLegacyStoredSession);
              sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
              db.close();
              // Collapse copies left behind by older builds (and clean them out of the store)
              const { kept, duplicateIds } = dedupeProviderSessions(sessions);
              if (duplicateIds.length) {
                log("Removing", duplicateIds.length, "duplicate history sessions for provider:", providerKey);
                Promise.all(duplicateIds.map((id) => deleteSessionById(id).catch(() => {}))).catch(() => {});
              }
              log("Loaded LLM history from IndexedDB");
              resolve(kept);
            };
            req.onerror = () => {
              db.close();
              reject(req.error);
            };
          }).catch(reject);
        });
      }

      /** Save or update a session; prunes per-provider excess */
      function putSession(session) {
        if (!session || !session.providerKey) return Promise.resolve();
        return openHistoryDB().then((db) => {
          return new Promise((resolve, reject) => {
            const tx = db.transaction(HISTORY_STORE_NAME, "readwrite");
            const store = tx.objectStore(HISTORY_STORE_NAME);
            const getReq = store.get(session.id);
            getReq.onsuccess = () => {
              const existing = getReq.result;
              const toSave = {
                id: session.id,
                providerKey: session.providerKey,
                createdAt: existing?.createdAt || session.createdAt || session.updatedAt || Date.now(),
                updatedAt: session.updatedAt || Date.now(),
                title: session.title,
                messages: session.messages
              };
              store.put(toSave);
              tx.oncomplete = () => {
                db.close();
                pruneSessionsForProvider(session.providerKey).then(resolve).catch(reject);
              };
            };
            getReq.onerror = () => {
              db.close();
              reject(getReq.error);
            };
            tx.onerror = () => {
              db.close();
              reject(tx.error);
            };
          });
        }).then(() => {
          log("Saved LLM session to IndexedDB:", session.id);
        }).catch((e) => {
          logWarn("Error saving LLM history:", e);
        });
      }

      function pruneSessionsForProvider(providerKey) {
        return openHistoryDB().then((db) => new Promise((resolve, reject) => {
          const tx = db.transaction(HISTORY_STORE_NAME, "readwrite");
          const store = tx.objectStore(HISTORY_STORE_NAME);
          const index = store.index("providerKey");
          const req = index.getAll(IDBKeyRange.only(providerKey));
          req.onsuccess = () => {
            const sessions = (req.result || []).filter((s) => s && s.providerKey === providerKey);
            sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
            if (sessions.length > HISTORY_MAX_SESSIONS_PER_PROVIDER) {
              const toRemove = sessions.slice(HISTORY_MAX_SESSIONS_PER_PROVIDER);
              toRemove.forEach((s) => store.delete(s.id));
            }
          };
          req.onerror = () => { db.close(); reject(req.error); };
          tx.oncomplete = () => { db.close(); resolve(); };
          tx.onerror = () => { db.close(); reject(tx.error); };
        }));
      }

      /** Delete a session by id */
      function deleteSessionById(id) {
        return openHistoryDB().then((db) => {
          return new Promise((resolve, reject) => {
            const tx = db.transaction(HISTORY_STORE_NAME, "readwrite");
            const store = tx.objectStore(HISTORY_STORE_NAME);
            store.delete(id);
            tx.oncomplete = () => { db.close(); resolve(); };
            tx.onerror = () => { db.close(); reject(tx.error); };
          });
        });
      }

      function sessionExistsById(id) {
        if (!id) {
          return Promise.resolve(false);
        }
        return openHistoryDB().then((db) => new Promise((resolve, reject) => {
          const tx = db.transaction(HISTORY_STORE_NAME, "readonly");
          const store = tx.objectStore(HISTORY_STORE_NAME);
          const req = store.get(id);
          let exists = false;
          req.onsuccess = () => {
            exists = !!req.result;
          };
          req.onerror = () => { db.close(); reject(req.error); };
          tx.oncomplete = () => { db.close(); resolve(exists); };
          tx.onerror = () => { db.close(); reject(tx.error); };
        }));
      }

      /** One-time migration from JSON file if it exists */
      function migrateFromFileIfNeeded() {
        try {
          const dirSvc = Components.classes["@mozilla.org/file/directory_service;1"]
            .getService(Components.interfaces.nsIProperties);
          const profD = dirSvc.get("ProfD", Components.interfaces.nsIFile);
          const file = profD.clone();
          file.append(HISTORY_FILE_NAME);
          if (!file.exists()) return Promise.resolve();
          const converter = Components.classes["@mozilla.org/intl/converter-input-stream;1"]
            .createInstance(Components.interfaces.nsIConverterInputStream);
          const fileStream = Components.classes["@mozilla.org/network/file-input-stream;1"]
            .createInstance(Components.interfaces.nsIFileInputStream);
          fileStream.api.init(file, 0x01, 0, 0);
          converter.api.init(fileStream, "UTF-8", 8192, Components.interfaces.nsIConverterInputStream.DEFAULT_REPLACEMENT_CHARACTER);
          const parts = [];
          const out = {};
          let n;
          while ((n = converter.readString(8192, out)) > 0) parts.push(String(out.value));
          converter.close();
          fileStream.close();
          const data = JSON.parse(parts.join(""));
          const sessions = Array.isArray(data?.sessions) ? data.sessions : [];
          if (!sessions.length) {
            file.remove(false);
            return Promise.resolve();
          }
          return openHistoryDB().then((db) => {
            return new Promise((resolve, reject) => {
              const tx = db.transaction(HISTORY_STORE_NAME, "readwrite");
              const store = tx.objectStore(HISTORY_STORE_NAME);
              sessions.forEach((s) => { if (s && s.id && s.providerKey) store.put(s); });
              tx.oncomplete = () => {
                db.close();
                try { file.remove(false); } catch (e) {}
                log("Migrated", sessions.length, "sessions from file to IndexedDB");
                resolve();
              };
              tx.onerror = () => { db.close(); reject(tx.error); };
            });
          });
        } catch (e) {
          return Promise.resolve();
        }
      }

      function getCurrentTab() {
        try {
          const topWin = window.top || window;
          const browser = topWin.gBrowser || topWin.getBrowser?.();
          return browser?.selectedTab || null;
        } catch (e) {
          return null;
        }
      }

      /** Safety cap only (500k); normal messages are stored in full for complete conversation restore */
      function truncateContent(content) {
        if (!content || typeof content !== "string") {
          return "";
        }
        if (content.length > HISTORY_MAX_CONTENT_LENGTH) {
          return content.slice(0, HISTORY_MAX_CONTENT_LENGTH) + "...";
        }
        return content;
      }

      function cloneHistoryEntry(message) {
        if (!message) {
          return message;
        }
        const out = { role: message.role, content: message.content };
        if (message.role === "assistant" && message.sources && message.sources.length > 0) {
          out.sources = message.sources.map((s) => ({
            title: s.title,
            url: s.url,
            source: s.source,
            index: s.index
          }));
        }
        return out;
      }

      function snapshotConversationHistory() {
        return state.conversationHistory.map(cloneHistoryEntry);
      }

      /** Stable identity of a message list, used to detect duplicate / continued sessions */
      function messagesFingerprint(messages) {
        if (!Array.isArray(messages)) {
          return "";
        }
        return messages
          .filter((m) => m && m.content)
          .map((m) => `${m.role}\u0001${(m.content || "").trim()}`)
          .join("\u0000");
      }

      /** True when `shorterFp` is the same conversation as `longerFp`, or an earlier state of it */
      function isSameOrEarlierConversation(shorterFp, longerFp) {
        if (!shorterFp || !longerFp) {
          return false;
        }
        return shorterFp === longerFp || longerFp.startsWith(shorterFp + "\u0000");
      }

      /**
       * Find a stored session that this conversation already belongs to (identical messages,
       * or the same conversation before the latest turns were appended).
       * @returns {Promise<string|null>} session id to update, or null to create a new one
       */
      async function findExistingSessionIdForMessages(providerKey, messages) {
        if (!providerKey || !messages || !messages.length) {
          return null;
        }
        let sessions;
        try {
          sessions = await getProviderSessions(providerKey);
        } catch (e) {
          logWarn("Could not look up existing sessions for dedupe:", e);
          return null;
        }
        const fp = messagesFingerprint(messages);
        for (const session of sessions) {
          if (isSameOrEarlierConversation(messagesFingerprint(session.messages), fp)) {
            return session.id;
          }
        }
        return null;
      }

      /**
       * Collapse sessions that are duplicates of, or earlier states of, a newer session.
       * Returns the sessions to display plus the ids of the redundant ones.
       */
      function dedupeProviderSessions(sessions) {
        const kept = [];
        const duplicateIds = [];
        // `sessions` is newest first, so a later (older) session that is a prefix of an
        // already kept one is the leftover copy created before the session id was reused.
        for (const session of sessions) {
          const fp = messagesFingerprint(session.messages);
          const supersededBy = kept.find((k) => isSameOrEarlierConversation(fp, messagesFingerprint(k.messages)));
          if (supersededBy && fp) {
            duplicateIds.push(session.id);
            continue;
          }
          kept.push(session);
        }
        return { kept, duplicateIds };
      }

      /**
       * Repair sessions saved before stream lifecycle was fixed (duplicate assistant after user).
       */
      function repairLegacyDuplicateMessages(messages) {
        if (!Array.isArray(messages) || !messages.length) {
          return messages || [];
        }
        const out = [];
        for (const m of messages) {
          if (!m || !m.content) {
            continue;
          }
          const prev = out[out.length - 1];
          const prevPrev = out[out.length - 2];
          if (
            m.role === "assistant" &&
            prev?.role === "user" &&
            prevPrev?.role === "assistant" &&
            (prevPrev.content || "").trim() === (m.content || "").trim()
          ) {
            continue;
          }
          out.push(m);
        }
        return out;
      }

      function repairLegacyStoredSession(session) {
        if (!session || !Array.isArray(session.messages)) {
          return session;
        }
        const repaired = repairLegacyDuplicateMessages(session.messages);
        if (repaired.length === session.messages.length) {
          return session;
        }
        return { ...session, messages: repaired };
      }

      return {
        openHistoryDB,
        getProviderSessions,
        putSession,
        pruneSessionsForProvider,
        deleteSessionById,
        sessionExistsById,
        migrateFromFileIfNeeded,
        getCurrentTab,
        truncateContent,
        cloneHistoryEntry,
        snapshotConversationHistory,
        messagesFingerprint,
        isSameOrEarlierConversation,
        findExistingSessionIdForMessages,
        dedupeProviderSessions,
        repairLegacyDuplicateMessages,
        repairLegacyStoredSession
      };
    }
  };
})();

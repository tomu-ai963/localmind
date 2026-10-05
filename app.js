"use strict";

/* =========================================================================
   LocalMind — BYOK ローカルチャット
   全データは localStorage のみ。将来の Tauri 移行を見据え、
   APIキー / 資格情報まわりの処理を credentialStore に分離している。
   ========================================================================= */

/* ----------------------- ストレージキー ----------------------- */
const KEYS = {
  apiKey: "lm_api_key",
  model:  "lm_model",
  system: "lm_system",
  chats:  "lm_chats",
};
const DEFAULT_MODEL = "claude-sonnet-5-5";
/* output_config.effort を固定で送るモデル（コスト・速度優先）。
   Haiku 4.5 は effort 非対応のため含めない。 */
const MODEL_EFFORT = {
  "claude-sonnet-5-5": "low",
  "claude-opus-5-5":   "low",
};
const API_URL = "https://api.anthropic.com/v1/messages";
const MAX_TOKENS = 8192;
const RETRY_MAX = 3;         // 429/5xx 時の最大再試行回数（初回リクエストを除く）
const RETRY_BASE_MS = 1000;  // 再試行待機の基準時間（指数バックオフ）
const RETRY_CAP_MS = 8000;   // 再試行待機の上限
const STORAGE_LIMIT = 5 * 1024 * 1024; // 約5MB

/* =========================================================================
   credentialStore — APIキー（=資格情報）の抽象化レイヤ
   Tauri 化の際は、この実装だけを OS キーチェーン版へ差し替えればよい。
   ========================================================================= */
const credentialStore = {
  getApiKey()      { return localStorage.getItem(KEYS.apiKey) || ""; },
  setApiKey(value) {
    if (value) localStorage.setItem(KEYS.apiKey, value);
    else       localStorage.removeItem(KEYS.apiKey);
  },
  hasApiKey()      { return !!this.getApiKey(); },
  clearApiKey()    { localStorage.removeItem(KEYS.apiKey); },
};

/* ----------------------- 設定（非機密）の読み書き ----------------------- */
const settingsStore = {
  getModel()  { return localStorage.getItem(KEYS.model) || DEFAULT_MODEL; },
  setModel(m) { localStorage.setItem(KEYS.model, m); },
  getSystem() { return localStorage.getItem(KEYS.system) || ""; },
  setSystem(s){ localStorage.setItem(KEYS.system, s); },
};

/* ----------------------- チャットデータの読み書き ----------------------- */
const chatStore = {
  load() {
    try { return JSON.parse(localStorage.getItem(KEYS.chats)) || []; }
    catch { return []; }
  },
  save(chats) {
    localStorage.setItem(KEYS.chats, JSON.stringify(chats));
    updateStorageUsage();
  },
};

/* ----------------------- アプリ状態 ----------------------- */
let chats = chatStore.load();       // [{id, title, messages:[{role,content}], createdAt}]
let activeId = null;
let isSending = false;

/* ----------------------- DOM 参照 ----------------------- */
const $ = (id) => document.getElementById(id);
const chatListEl = $("chat-list");
const messagesEl = $("messages");
const inputEl    = $("input");
const sendBtn    = $("send-btn");
const overlay    = $("modal-overlay");
const sidebar    = $("sidebar");

/* =========================================================================
   ユーティリティ
   ========================================================================= */
function uid() {
  return "c_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/* 簡易マークダウン：コードブロック・インラインコード・太字・改行 */
function renderMarkdown(text) {
  const blocks = [];
  // ```code``` を退避
  let t = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const i = blocks.length;
    blocks.push(
      `<div class="code-block">` +
      `<button class="copy-btn" type="button" aria-label="コードをコピー" title="コピー">⧉</button>` +
      `<pre><code>${escapeHtml(code.replace(/\n$/, ""))}</code></pre>` +
      `</div>`);
    return `\u0000${i}\u0000`;
  });
  t = escapeHtml(t);
  t = t.replace(/`([^`\n]+)`/g, (_, c) => `<code class="inline">${c}</code>`);
  t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  // 段落／改行
  t = t.split(/\n{2,}/).map(p => `<p>${p.replace(/\n/g, "<br>")}</p>`).join("");
  // コードブロックを戻す
  t = t.replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[i]);
  return t;
}

function currentChat() {
  return chats.find(c => c.id === activeId) || null;
}

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // clipboard API が使えない環境向けフォールバック
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch {}
    ta.remove();
    return ok;
  }
}

/* =========================================================================
   ストレージ容量チェック
   ========================================================================= */
/* 同一オリジンの他アプリのデータを数えないよう、lm_ プレフィックスのキーのみ集計する */
const KEY_PREFIX = "lm_";
function bytesUsed() {
  let total = 0;
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k || !k.startsWith(KEY_PREFIX)) continue;
    total +=(k.length + (localStorage.getItem(k) || "").length) * 2; // UTF-16
  }
  return total;
}
function updateStorageUsage() {
  const used = bytesUsed();
  const pct = used / STORAGE_LIMIT;
  $("storage-usage").textContent = (used / 1024 / 1024).toFixed(2) + " MB";
  const warnEl = $("storage-warning");
  if (pct >= 0.8) {
    warnEl.style.display = "block";
    warnEl.textContent = `⚠ ローカル保存容量が上限（約5MB）に近づいています（${Math.round(pct*100)}%使用）。古いチャットの削除やエクスポートを検討してください。`;
  } else {
    warnEl.style.display = "none";
  }
}

/* =========================================================================
   サイドバー：チャット一覧の描画
   ========================================================================= */
function renderChatList() {
  const sorted = [...chats].sort((a, b) => b.createdAt - a.createdAt);
  chatListEl.innerHTML = "";
  sorted.forEach(chat => {
    const item = document.createElement("div");
    item.className = "chat-item" + (chat.id === activeId ? " active" : "");
    const title = chat.title || "新しいチャット";
    item.innerHTML = `
      <span class="title" role="button" tabindex="0">${escapeHtml(title)}</span>
      <button class="del" title="削除" aria-label="チャット「${escapeHtml(title)}」を削除">×</button>`;
    const titleEl = item.querySelector(".title");
    const openChat = () => {
      activeId = chat.id;
      closeSidebarMobile();
      render();
    };
    titleEl.addEventListener("click", openChat);
    titleEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openChat();
      }
    });
    item.querySelector(".del").addEventListener("click", (e) => {
      e.stopPropagation();
      deleteChat(chat.id);
    });
    chatListEl.appendChild(item);
  });
}

function deleteChat(id) {
  const target = chats.find(c => c.id === id);
  if (!target) return;
  const title = target.title || "新しいチャット";
  if (!confirm(`チャット「${title}」を削除しますか？この操作は取り消せません。`)) return;
  chats = chats.filter(c => c.id !== id);
  if (activeId === id) activeId = null;
  chatStore.save(chats);
  render();
}

/* =========================================================================
   メッセージ表示
   ========================================================================= */
function renderMessages() {
  const chat = currentChat();
  messagesEl.innerHTML = "";

  if (!chat) {
    const empty = document.createElement("div");
    empty.id = "empty-state";
    empty.innerHTML = `
      <h1>LocalMind</h1>
      <p>あなたのAPIキーで動く、ローカル保存のチャット。</p>
      <p>${credentialStore.hasApiKey()
            ? "下の入力欄からメッセージを送ると、新しいチャットが始まります。"
            : "まず ⚙ から Anthropic APIキー を設定してください。"}</p>`;
    messagesEl.appendChild(empty);
    return;
  }

  chat.messages.forEach(m => appendMessageEl(m.role, m.content, { truncated: m.truncated }));
  scrollToBottom();
}

function appendMessageEl(role, content, opts = {}) {
  const row = document.createElement("div");
  row.className = "msg-row " + role;
  const roleLabel = role === "user" ? "あなた" : "LocalMind";
  const body = opts.loading
    ? `<div class="loading-dots"><span></span><span></span><span></span></div>`
    : (role === "assistant" ? renderMarkdown(content)
                            : `<div>${escapeHtml(content).replace(/\n/g,"<br>")}</div>`);
  row.innerHTML = `
    <div class="msg-inner">
      <div class="msg-role">${roleLabel}</div>
      <div class="msg-content${opts.error ? " error-msg" : ""}">${body}</div>${opts.truncated
        ? `<div class="retry-note">⚠ 回答が長すぎたため途中で終了しました</div>` : ""}${opts.unsaved
        ? `<div class="retry-note unsaved-note">⚠ この応答は保存されていません（${escapeHtml(opts.unsaved)}）</div>` : ""}
    </div>`;
  messagesEl.appendChild(row);
  return row;
}

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

/* =========================================================================
   全体再描画
   ========================================================================= */
function render() {
  renderChatList();
  renderMessages();
  updateStorageUsage();
}

/* =========================================================================
   送信・API呼び出し
   ========================================================================= */
function newChat() {
  activeId = null;
  render();
  inputEl.focus();
}

async function sendMessage() {
  if (isSending) return;
  const text = inputEl.value.trim();
  if (!text) return;

  if (!credentialStore.hasApiKey()) {
    openSettings();
    flashSystemNote("APIキーが未設定です。⚙ から設定してください。");
    return;
  }

  // 必要なら新規チャットを作成
  let chat = currentChat();
  if (!chat) {
    chat = { id: uid(), title: "", messages: [], createdAt: Date.now() };
    chats.push(chat);
    activeId = chat.id;
  }

  // ユーザーメッセージを追加。保存できなければ追加前に戻し、入力欄はそのまま残す
  const userMsg = { role: "user", content: text };
  chat.messages.push(userMsg);
  const userSaveError = saveChatsOrRollback(() => discardMessage(chat, userMsg));
  if (userSaveError) {
    render();
    appendMessageEl("assistant", userSaveError, { error: true });
    scrollToBottom();
    return;
  }
  inputEl.value = "";
  autoGrow();
  renderChatList();
  if ($("empty-state")) renderMessages();
  appendMessageEl("user", text);
  scrollToBottom();

  // ローディング表示
  isSending = true;
  sendBtn.disabled = true;
  const loadingRow = appendMessageEl("assistant", "", { loading: true });
  scrollToBottom();

  let reply, truncated;
  try {
    ({ text: reply, truncated } = await callAnthropic(chat.messages, (attempt, max) => {
      const content = loadingRow.querySelector(".msg-content");
      content.innerHTML =
        `<div class="loading-dots"><span></span><span></span><span></span></div>` +
        `<div class="retry-note">一時的なエラーのため再試行しています…（${attempt}/${max}）</div>`;
    }));
  } catch (err) {
    // 失敗したユーザーメッセージは履歴から外し（user が連続しないように）、入力欄に戻す。
    // エラー表示は画面にだけ出し、履歴には保存しない
    loadingRow.remove();
    discardMessage(chat, userMsg);
    try { chatStore.save(chats); } catch {} // 削除方向の保存なので容量超過は起きない想定
    inputEl.value = inputEl.value.trim() ? text + "\n" + inputEl.value : text;
    autoGrow();
    render();
    appendMessageEl("assistant", err.message, { error: true });
    scrollToBottom();
    finishSending();
    return;
  }

  // 途中終了の印は content に混ぜず、任意フィールドとして保存する（API には送らない）
  const assistantMsg = { role: "assistant", content: reply };
  if (truncated) assistantMsg.truncated = true;
  chat.messages.push(assistantMsg);

  // タイトル自動生成（最初のAI返答の先頭20文字）
  const prevTitle = chat.title;
  if (!chat.title) {
    chat.title = reply.replace(/\s+/g, " ").trim().slice(0, 20) || "新しいチャット";
  }
  // 保存できなくても、料金を払って得た応答は画面に残し「未保存」と注記する
  const replySaveError = saveChatsOrRollback(() => {
    discardMessage(chat, assistantMsg);
    chat.title = prevTitle;
  });

  loadingRow.remove();
  appendMessageEl("assistant", reply, { truncated, unsaved: replySaveError });
  renderChatList();
  scrollToBottom();
  finishSending();
}

function finishSending() {
  isSending = false;
  sendBtn.disabled = false;
  inputEl.focus();
}

/* メッセージを履歴から外す。チャットが空になったらチャットごと削除する */
function discardMessage(chat, msg) {
  const i = chat.messages.lastIndexOf(msg);
  if (i !== -1) chat.messages.splice(i, 1);
  if (chat.messages.length === 0) {
    chats = chats.filter(c => c !== chat);
    if (activeId === chat.id) activeId = null;
  }
}

/* chats を保存する。失敗したら rollback() でメモリ上の変更を戻し、表示用のエラー文を返す。
   setItem が失敗した時点で localStorage 側は書き換わっていない。成功時は "" */
const QUOTA_MESSAGE = "保存容量が足りません。古いチャットを削除するかエクスポートしてください";
function saveChatsOrRollback(rollback) {
  try {
    chatStore.save(chats);
    return "";
  } catch (e) {
    rollback();
    return isQuotaError(e) ? QUOTA_MESSAGE : "保存に失敗しました。";
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/* この会話の履歴のみを送信（他チャットのデータは一切含めない）
   429/5xx は指数バックオフ＋ジッターで最大 RETRY_MAX 回まで再試行する。
   onRetry(attempt, max) は再試行のたびに呼ばれる（UI表示用）。 */
async function callAnthropic(messages, onRetry) {
  const apiKey = credentialStore.getApiKey();
  const model  = settingsStore.getModel();
  const system = settingsStore.getSystem();

  const body = {
    model,
    max_tokens: MAX_TOKENS,
    messages: messages.map(m => ({ role: m.role, content: m.content })),
  };
  if (system && system.trim()) body.system = system;
  if (MODEL_EFFORT[model]) body.output_config = { effort: MODEL_EFFORT[model] };

  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(API_URL, {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify(body),
      });
    } catch (networkErr) {
      throw new Error("ネットワークエラー: APIに接続できませんでした。接続状況を確認してください。");
    }

    if (res.ok) {
      const data = await res.json();
      const parts = (data.content || []).filter(p => p.type === "text").map(p => p.text);
      return {
        text: parts.join("\n") || "(空の応答が返されました)",
        truncated: data.stop_reason === "max_tokens",
      };
    }

    // 429/5xx のみ再試行対象（400/401/403 などは即エラー）
    const retryable = res.status === 429 || res.status >= 500;
    if (retryable && attempt < RETRY_MAX) {
      const base = Math.min(RETRY_BASE_MS * 2 ** attempt, RETRY_CAP_MS);
      const wait = base + Math.random() * base * 0.5; // ジッター: +0〜50%
      if (onRetry) onRetry(attempt + 1, RETRY_MAX);
      await sleep(wait);
      continue;
    }

    let detail = "";
    try { const j = await res.json(); detail = j.error?.message || ""; } catch {}
    if (res.status === 401)
      throw new Error("APIキーが無効です。設定を確認してください。");
    if (res.status === 429)
      throw new Error(`レート制限が続いています（${RETRY_MAX}回再試行しました）。しばらく待ってから再度お試しください。`);
    if (res.status >= 500)
      throw new Error(`サーバーエラー（${res.status}）が続いています（${RETRY_MAX}回再試行しました）。しばらく待ってから再度お試しください。`);
    throw new Error(`エラー (${res.status}): ${detail || res.statusText}`);
  }
}

/* 入力欄に一時的なシステム注記を出す（軽量） */
function flashSystemNote(msg) {
  inputEl.placeholder = msg;
  setTimeout(() => {
    inputEl.placeholder = "メッセージを入力…（Enterで送信 / Shift+Enterで改行）";
  }, 4000);
}

/* =========================================================================
   設定モーダル
   ========================================================================= */
/* 通常の APIキーは sk-ant-api03-… 形式。管理用キー（sk-ant-admin01-…）は
   組織全体を操作できるため、ブラウザに保存させない */
const API_KEY_PREFIX = "sk-ant-api";
const ADMIN_KEY_PREFIX = "sk-ant-admin";

function validateApiKey(key) {
  if (key.startsWith(ADMIN_KEY_PREFIX))
    return "これは管理用キー（Admin API キー）です。組織全体を操作できるため保存できません。通常の APIキーを入力してください。";
  if (!key.startsWith(API_KEY_PREFIX))
    return `APIキーの形式が正しくありません（「${API_KEY_PREFIX}」で始まる必要があります）。`;
  return "";
}

/* 保存済みキーは入力欄に書き戻さず、末尾4文字だけを表示する */
function renderKeyStatus() {
  const statusEl = $("key-status");
  const key = credentialStore.getApiKey();
  if (key) {
    statusEl.textContent = `✓ 設定済み（末尾 …${key.slice(-4)}）`;
    statusEl.classList.add("set");
    $("set-key").placeholder = "変更する場合のみ新しいキーを入力";
  } else {
    statusEl.textContent = "未設定";
    statusEl.classList.remove("set");
    $("set-key").placeholder = "sk-ant-api03-...";
  }
  $("clear-key-btn").hidden = !key;
}

function openSettings() {
  $("set-key").value    = "";
  $("key-error").textContent = "";
  setImportStatus("", false);
  renderKeyStatus();
  $("set-model").value  = settingsStore.getModel();
  $("set-system").value = settingsStore.getSystem();
  overlay.classList.add("open");
}
function closeSettings() {
  $("set-key").value = "";
  overlay.classList.remove("open");
}

function saveSettings() {
  // 入力があったときだけ上書き。空欄なら既存のキーを維持する
  const newKey = $("set-key").value.trim();
  if (newKey) {
    const error = validateApiKey(newKey);
    if (error) {
      $("key-error").textContent = error;
      $("set-key").focus();
      return;
    }
    credentialStore.setApiKey(newKey);
  }
  $("key-error").textContent = "";
  settingsStore.setModel($("set-model").value);
  settingsStore.setSystem($("set-system").value);
  closeSettings();
  render();
}

/* =========================================================================
   データ管理：エクスポート / インポート / 全削除
   ========================================================================= */
function exportData() {
  const dump = {
    exportedAt: new Date().toISOString(),
    app: "LocalMind",
    model: settingsStore.getModel(),
    system: settingsStore.getSystem(),
    chats: chats,
    // 注意：APIキーはセキュリティ上エクスポートに含めない
  };
  const blob = new Blob([JSON.stringify(dump, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "localmind-export-" + new Date().toISOString().slice(0,10) + ".json";
  a.click();
  URL.revokeObjectURL(url);
}

/* -------- インポート：エクスポートした JSON からチャットを「追加」する --------
   取り込むのは chats だけ。model / system / APIキーはファイルにあっても無視する。
   読み込んだオブジェクトはそのまま使わず、許可したフィールドだけで組み立て直す。 */
const IMPORT_MAX_BYTES = 5 * 1024 * 1024;
const IMPORT_MAX_CHATS = 1000;
const IMPORT_MAX_MESSAGES = 1000;
const IMPORT_MAX_TITLE = 200;
const FORBIDDEN_KEYS = ["__proto__", "constructor", "prototype"];

function setImportStatus(msg, isError) {
  const el = $("import-status");
  el.textContent = msg;
  el.classList.toggle("error", !!isError);
}

function isPlainObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/* 1件のチャットを検証し、新しいオブジェクトとして返す。不正なら null */
function sanitizeImportedChat(raw) {
  if (!isPlainObject(raw)) return null;

  let title = "";
  if (raw.title !== undefined && raw.title !== null) {
    if (typeof raw.title !== "string" || raw.title.length > IMPORT_MAX_TITLE) return null;
    title = raw.title;
  }

  const createdAt = (typeof raw.createdAt === "number" && Number.isFinite(raw.createdAt))
    ? raw.createdAt : Date.now();

  if (!Array.isArray(raw.messages) || raw.messages.length > IMPORT_MAX_MESSAGES) return null;
  const messages = [];
  for (const m of raw.messages) {
    if (!isPlainObject(m)) return null;
    if (m.role !== "user" && m.role !== "assistant") return null;
    if (typeof m.content !== "string") return null;
    if (m.truncated !== undefined && typeof m.truncated !== "boolean") return null;
    const msg = { role: m.role, content: m.content };
    if (m.truncated === true) msg.truncated = true;
    messages.push(msg);
  }

  // id は既存チャットとの衝突を避けるため必ず振り直す
  return { id: uid(), title, messages, createdAt };
}

/* ファイル全体を検証する。{ error } または { valid, skipped } を返す */
function parseImportFile(text) {
  let foundForbidden = false;
  let root;
  try {
    root = JSON.parse(text, function (key, value) {
      if (FORBIDDEN_KEYS.includes(key)) foundForbidden = true;
      return value;
    });
  } catch {
    return { error: "JSON の形式が正しくないため読み込めません。" };
  }
  if (foundForbidden)
    return { error: "不正なキー（__proto__ など）を含むため読み込めません。" };
  if (!isPlainObject(root) || root.app !== "LocalMind" || !Array.isArray(root.chats))
    return { error: "LocalMind のエクスポートファイルではありません。" };
  if (root.chats.length > IMPORT_MAX_CHATS)
    return { error: `チャットが多すぎます（上限 ${IMPORT_MAX_CHATS} 件）。` };

  const valid = [];
  let skipped = 0;
  for (const raw of root.chats) {
    const chat = sanitizeImportedChat(raw);
    if (chat) valid.push(chat);
    else skipped++;
  }
  return { valid, skipped };
}

function isQuotaError(e) {
  return e instanceof DOMException &&
    (e.name === "QuotaExceededError" || e.name === "NS_ERROR_DOM_QUOTA_REACHED" ||
     e.code === 22 || e.code === 1014);
}

async function importData(file) {
  setImportStatus("", false);
  if (file.size > IMPORT_MAX_BYTES) {
    setImportStatus("ファイルが大きすぎます（上限 5MB）。", true);
    return;
  }

  let text;
  try { text = await file.text(); }
  catch {
    setImportStatus("ファイルを読み込めませんでした。", true);
    return;
  }

  const result = parseImportFile(text);
  if (result.error) {
    setImportStatus(result.error, true);
    return;
  }
  const { valid, skipped } = result;
  if (valid.length === 0) {
    setImportStatus(`追加できるチャットがありません（${skipped}件スキップ）。`, true);
    return;
  }

  const skipNote = skipped ? `（不正な${skipped}件はスキップします）` : "";
  if (!confirm(`${valid.length}件のチャットを追加します${skipNote}。よろしいですか？`)) return;

  const before = chats;
  chats = before.concat(valid);
  try {
    chatStore.save(chats);
  } catch (e) {
    // setItem が失敗した時点で localStorage は書き換わっていない。メモリ上の状態だけ戻す
    chats = before;
    render();
    setImportStatus(isQuotaError(e)
      ? "保存容量が足りません。インポートを取り消しました。"
      : "保存に失敗しました。インポートを取り消しました。", true);
    return;
  }
  render();
  setImportStatus(`${valid.length}件追加・${skipped}件スキップ`, false);
}

function wipeAll() {
  if (!confirm("すべてのチャット・設定・APIキーを完全に削除します。よろしいですか？")) return;
  Object.values(KEYS).forEach(k => localStorage.removeItem(k));
  chats = [];
  activeId = null;
  closeSettings();
  render();
}

/* =========================================================================
   入力欄オートグロー
   ========================================================================= */
function autoGrow() {
  inputEl.style.height = "auto";
  inputEl.style.height = Math.min(inputEl.scrollHeight, 200) + "px";
}

/* =========================================================================
   モバイル：サイドバー開閉
   ========================================================================= */
function closeSidebarMobile() { sidebar.classList.remove("open"); }

/* =========================================================================
   イベント結線
   ========================================================================= */
$("new-chat-btn").addEventListener("click", newChat);
$("settings-btn").addEventListener("click", openSettings);
$("close-settings").addEventListener("click", closeSettings);
$("save-settings").addEventListener("click", saveSettings);
$("clear-key-btn").addEventListener("click", () => {
  if (!confirm("保存されているAPIキーを削除しますか？")) return;
  credentialStore.clearApiKey();
  renderKeyStatus();
  render();
});
$("export-btn").addEventListener("click", exportData);
$("import-btn").addEventListener("click", () => $("import-file").click());
$("import-file").addEventListener("change", async (e) => {
  const input = e.target;
  const file = input.files && input.files[0];
  // 同じファイルを再選択しても change が発火するよう、読み込み後に空にする
  try { if (file) await importData(file); }
  finally { input.value = ""; }
});
$("wipe-btn").addEventListener("click", wipeAll);
$("menu-btn").addEventListener("click", () => sidebar.classList.toggle("open"));
$("send-btn").addEventListener("click", sendMessage);

/* コードブロックのコピー（動的生成のためイベント委譲） */
messagesEl.addEventListener("click", async (e) => {
  const btn = e.target.closest(".copy-btn");
  if (!btn) return;
  const codeEl = btn.parentElement.querySelector("pre code");
  if (!codeEl) return;
  const ok = await copyToClipboard(codeEl.textContent);
  btn.textContent = ok ? "✓" : "✗";
  btn.classList.add("copied");
  setTimeout(() => {
    btn.textContent = "⧉";
    btn.classList.remove("copied");
  }, 1500);
});

overlay.addEventListener("click", (e) => { if (e.target === overlay) closeSettings(); });

inputEl.addEventListener("input", autoGrow);
inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

/* =========================================================================
   起動
   ========================================================================= */
/* 旧モデルIDが localStorage に残っている場合、新IDへ書き換える */
const MODEL_MIGRATIONS = {
  "claude-sonnet-4-6": "claude-sonnet-5-5",
  "claude-sonnet-5":   "claude-sonnet-5-5",
  "claude-opus-4-8":   "claude-opus-5-5",
};
function migrateModelSetting() {
  const stored = localStorage.getItem(KEYS.model);
  if (stored && MODEL_MIGRATIONS[stored]) {
    settingsStore.setModel(MODEL_MIGRATIONS[stored]);
  }
}

function init() {
  migrateModelSetting();
  render();
  // 初回起動（APIキー未設定）なら設定画面を表示
  if (!credentialStore.hasApiKey()) openSettings();
  inputEl.focus();
}
init();

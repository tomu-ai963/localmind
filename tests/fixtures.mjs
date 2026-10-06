// 共通フィクスチャ：API モック・ダイアログ記録・CSP 違反の収集と各種ヘルパー
import { test as base, expect } from "@playwright/test";

export { expect };
export const API = "https://api.anthropic.com/v1/messages";
export const KEY = "sk-ant-api03-" + "x".repeat(20) + "TEST"; // テスト用のダミー値
export const QUOTA_MESSAGE = "保存容量が足りません。古いチャットを削除するかエクスポートしてください";

export const ok = (text, stop = "end_turn") =>
  ({ status: 200, body: { content: [{ type: "text", text }], stop_reason: stop } });
export const err = (status, message = "bad request") =>
  ({ status, body: { type: "error", error: { message } } });

export function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

export const noConsecutiveUser = (msgs) =>
  msgs.every((m, i) => i === 0 || !(m.role === "user" && msgs[i - 1].role === "user"));

class App {
  constructor(page, state) {
    this.page = page;
    this.state = state;
  }
  /** API 応答を順に積む。要素は ok()/err() の戻り値、{ abort: true }、または gate 付き */
  respond(...items) { this.state.queue.push(...items); }
  get requests() { return this.state.requests; }
  get lastRequest() { return this.state.requests.at(-1); }

  /** APIキー（と任意のチャット）を入れた状態で開く */
  async start({ chats, key = KEY } = {}) {
    await this.page.goto("/");
    await this.page.evaluate(({ chats, key }) => {
      localStorage.clear();
      if (key) localStorage.setItem("lm_api_key", key);
      if (chats) localStorage.setItem("lm_chats", JSON.stringify(chats));
    }, { chats, key });
    await this.page.reload();
  }

  ls(key) { return this.page.evaluate((k) => localStorage.getItem(k), key); }
  async chats() { return JSON.parse((await this.ls("lm_chats")) || "[]"); }
  memoryChats() { return this.page.evaluate(() => chats); }

  async waitIdle() {
    await this.page.waitForFunction(() => !document.getElementById("send-btn").disabled);
  }
  /** 入力して Enter。応答を待ち、この送信で発生したリクエスト数を返す */
  async send(text, { wait = true } = {}) {
    await this.page.fill("#input", text);
    const n = this.requests.length;
    await this.page.press("#input", "Enter");
    if (wait) await this.waitIdle();
    return this.requests.length - n;
  }

  chatItems() { return this.page.locator(".chat-item"); }
  async openChat(title) {
    await this.page.locator(".chat-item .title", { hasText: title }).first().click();
  }
  errorRows() { return this.page.locator("#messages .error-msg"); }
  assistantRows() { return this.page.locator("#messages .msg-row.assistant"); }
  assistantTexts() { return this.page.locator("#messages .msg-row.assistant .msg-content"); }
  userRows() { return this.page.locator("#messages .msg-row.user"); }

  async openSettings() {
    if (!(await this.page.locator("#modal-overlay.open").count())) await this.page.click("#settings-btn");
  }
  /** インポート。file は { name, content } または生の文字列。結果表示の文言を返す */
  async importFile(file) {
    await this.openSettings();
    await this.page.evaluate(() => { document.getElementById("import-status").textContent = ""; });
    const [chooser] = await Promise.all([
      this.page.waitForEvent("filechooser"),
      this.page.click("#import-btn"),
    ]);
    const content = typeof file === "string" ? file
      : typeof file.content === "string" ? file.content : JSON.stringify(file.content);
    await chooser.setFiles({ name: file.name || "import.json", mimeType: "application/json", buffer: Buffer.from(content) });
    await this.page.waitForFunction(() => document.getElementById("import-status").textContent !== "");
    return this.page.locator("#import-status").textContent();
  }
  /** エクスポートしてファイル内容（文字列）を返す */
  async exportFile() {
    await this.openSettings();
    const [dl] = await Promise.all([this.page.waitForEvent("download"), this.page.click("#export-btn")]);
    const fs = await import("node:fs/promises");
    return fs.readFile(await dl.path(), "utf8");
  }

  /** 同一オリジンの localStorage を容量いっぱいまで埋め、空きを free 文字だけ残す */
  fillStorage(free) {
    return this.page.evaluate((free) => {
      localStorage.removeItem("zz_filler");
      let lo = 0, hi = 12_000_000;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        try { localStorage.setItem("zz_filler", "f".repeat(mid)); lo = mid; }
        catch { hi = mid - 1; }
      }
      localStorage.setItem("zz_filler", "f".repeat(Math.max(0, lo - free)));
    }, free);
  }
  freeStorage() { return this.page.evaluate(() => localStorage.removeItem("zz_filler")); }
}

export const test = base.extend({
  app: async ({ page }, use) => {
    const state = { requests: [], queue: [], csp: [], alerts: [], confirms: [], confirmAnswer: true };

    await page.exposeFunction("__cspViolation", (v) => state.csp.push(v));
    await page.addInitScript(() => {
      document.addEventListener("securitypolicyviolation", (e) =>
        window.__cspViolation(`${e.violatedDirective} ${e.blockedURI}`));
    });
    page.on("console", (m) => { if (/Content Security Policy/i.test(m.text())) state.csp.push(m.text()); });
    page.on("dialog", async (d) => {
      if (d.type() === "alert") { state.alerts.push(d.message()); return d.dismiss(); }
      if (d.type() === "confirm") {
        state.confirms.push(d.message());
        return state.confirmAnswer ? d.accept() : d.dismiss();
      }
      return d.dismiss();
    });

    await page.route(API, async (route) => {
      const req = route.request();
      state.requests.push({ body: JSON.parse(req.postData()), headers: req.headers() });
      const r = state.queue.shift() || ok("default");
      if (r.gate) await r.gate;
      if (r.abort) return route.abort();
      await route.fulfill({
        status: r.status,
        contentType: "application/json",
        body: JSON.stringify(r.body),
        headers: { "access-control-allow-origin": "*" },
      });
    });

    await use(new App(page, state));

    expect(state.csp, "CSP 違反が 0 件であること").toEqual([]);
    expect(state.alerts, "alert が出ていないこと").toEqual([]);
  },
});

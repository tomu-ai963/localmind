// データ管理：エクスポート・全削除・インポート
import { test, expect, KEY } from "./fixtures.mjs";

const SEED = [
  { id: "c_a", title: "最初のチャット", createdAt: 1700000000000, messages: [
    { role: "user", content: "こんにちは\n改行あり" },
    { role: "assistant", content: "```js\nconsole.log(1)\n```\n**太字**" },
  ]},
  { id: "c_b", title: "長い回答", createdAt: 1700000500000, messages: [
    { role: "user", content: "長く" },
    { role: "assistant", content: "途中まで…", truncated: true },
  ]},
  { id: "c_c", title: "", createdAt: 1700001000000, messages: [{ role: "user", content: "😀 絵文字 & <tag>" }] },
];
const stripId = (cs) => cs.map(({ id, ...rest }) => rest);
const valid = (over = {}) => ({ title: "ok", createdAt: 1, messages: [{ role: "user", content: "hi" }], ...over });
const file = (content, name = "import.json") => ({ name, content });

test("エクスポートに chats・model・system が入り、APIキーは入らない", async ({ app }) => {
  await app.start({ chats: SEED });
  const dump = JSON.parse(await app.exportFile());
  expect(dump.app).toBe("LocalMind");
  expect(dump.chats).toEqual(SEED);
  expect(dump).toHaveProperty("model");
  expect(dump).toHaveProperty("system");
  expect(JSON.stringify(dump)).not.toContain(KEY);
});

test("全削除でチャット・設定・APIキーがすべて消える", async ({ app, page }) => {
  await app.start({ chats: SEED });
  await page.evaluate(() => { localStorage.setItem("lm_model", "claude-opus-5-5"); localStorage.setItem("lm_system", "s"); });
  await app.openSettings();
  await page.click("#wipe-btn");
  for (const k of ["lm_api_key", "lm_model", "lm_system", "lm_chats"]) expect(await app.ls(k)).toBeNull();
  await expect(app.chatItems()).toHaveCount(0);
});

test("エクスポート → 全削除 → インポートで内容が完全に元に戻る（id は振り直し）", async ({ app, page }) => {
  await app.start({ chats: SEED });
  const exported = await app.exportFile();
  await page.click("#wipe-btn");
  await page.evaluate((k) => localStorage.setItem("lm_api_key", k), KEY);

  expect(await app.importFile(file(exported))).toBe("3件追加・0件スキップ");
  expect(app.state.confirms.at(-1)).toMatch(/^3件のチャットを追加します/);
  const restored = await app.chats();
  expect(stripId(restored)).toEqual(stripId(SEED));
  expect(restored.map((c) => c.id)).not.toContain("c_a");
  await expect(app.chatItems()).toHaveCount(3);
});

test("同じファイルを 2 回インポートすると重複して追加され、id は別々", async ({ app }) => {
  await app.start({ chats: SEED });
  const exported = await app.exportFile();
  expect(await app.importFile(file(exported))).toBe("3件追加・0件スキップ");
  expect(await app.importFile(file(exported))).toBe("3件追加・0件スキップ");
  const cs = await app.chats();
  expect(cs).toHaveLength(9);
  expect(new Set(cs.map((c) => c.id)).size).toBe(9);
});

test("XSS ペイロードは実行されず文字として表示される", async ({ app, page }) => {
  await app.start();
  const XSS1 = "<img src=x onerror=alert(1)>";
  const XSS2 = "<script>alert(2)</script>";
  await app.importFile(file({ app: "LocalMind", chats: [{
    title: XSS1 + XSS2, createdAt: 1800000000000, messages: [
      { role: "user", content: XSS1 + "\n" + XSS2 },
      { role: "assistant", content: `${XSS2} \`${XSS1}\` **${XSS1}**\n\`\`\`\n${XSS2}\n\`\`\`` },
    ]}]}));
  await page.click("#close-settings");
  await app.openChat("<img");
  await expect(page.locator("#messages img, #messages script, #chat-list img, #chat-list script")).toHaveCount(0);
  await expect(page.locator(".chat-item .title").first()).toHaveText(XSS1 + XSS2);
  await expect(page.locator("#messages")).toContainText(XSS1);
  await expect(page.locator("#messages")).toContainText(XSS2);
  // alert と CSP 違反が 0 件であることはフィクスチャの後処理で検証する
});

test.describe("不正なファイルの拒否・スキップ（既存データは変わらない）", () => {
  const cases = [
    ["壊れた JSON", '{"app":"LocalMind","chats":[{', /JSON の形式/],
    ["app が違う", { app: "OtherApp", chats: [valid()] }, /LocalMind のエクスポートファイルではありません/],
    ["chats が配列でない", { app: "LocalMind", chats: {} }, /LocalMind のエクスポートファイルではありません/],
    ["ルートが配列", [{ app: "LocalMind" }], /LocalMind のエクスポートファイルではありません/],
    ["role が system", { app: "LocalMind", chats: [valid({ messages: [{ role: "system", content: "x" }] })] }, /追加できるチャットがありません（1件スキップ）/],
    ["content が数値", { app: "LocalMind", chats: [valid({ messages: [{ role: "user", content: 123 }] })] }, /追加できるチャットがありません（1件スキップ）/],
    ["truncated が文字列", { app: "LocalMind", chats: [valid({ messages: [{ role: "assistant", content: "x", truncated: "yes" }] })] }, /1件スキップ/],
    ["title が 201 文字", { app: "LocalMind", chats: [valid({ title: "あ".repeat(201) })] }, /1件スキップ/],
    ["メッセージ 1001 件", { app: "LocalMind", chats: [valid({ messages: Array.from({ length: 1001 }, () => ({ role: "user", content: "x" })) })] }, /1件スキップ/],
    ["チャット 1001 件", { app: "LocalMind", chats: Array.from({ length: 1001 }, () => valid()) }, /多すぎます/],
    ["__proto__ キー（ルート）", '{"app":"LocalMind","__proto__":{"polluted":1},"chats":[{"title":"t","createdAt":1,"messages":[]}]}', /不正なキー/],
    ["__proto__ キー（チャット）", '{"app":"LocalMind","chats":[{"title":"t","createdAt":1,"messages":[],"__proto__":{"isAdmin":true}}]}', /不正なキー/],
    ["__proto__ キー（メッセージ）", '{"app":"LocalMind","chats":[{"title":"t","createdAt":1,"messages":[{"role":"user","content":"x","__proto__":{"a":1}}]}]}', /不正なキー/],
  ];
  for (const [name, content, expected] of cases) {
    test(name, async ({ app, page }) => {
      await app.start({ chats: SEED });
      const before = await app.ls("lm_chats");
      expect(await app.importFile(file(content))).toMatch(expected);
      expect(await app.ls("lm_chats")).toBe(before);
      expect(app.state.confirms).toHaveLength(0);
      expect(await page.evaluate(() => ({}).polluted === undefined && ({}).isAdmin === undefined)).toBe(true);
    });
  }

  test("5MB を超えるファイルは読み込む前に拒否する", async ({ app }) => {
    await app.start({ chats: SEED });
    const before = await app.ls("lm_chats");
    const big = JSON.stringify({ app: "LocalMind", chats: [valid({ messages: [{ role: "user", content: "a".repeat(5 * 1024 * 1024) }] })] });
    expect(await app.importFile(file(big))).toMatch(/大きすぎます/);
    expect(await app.ls("lm_chats")).toBe(before);
  });
});

test("正常・不正の混在ファイル：有効分だけ追加し、欠けた値は既定値で補う", async ({ app }) => {
  await app.start({ chats: SEED });
  const t0 = Date.now();
  const status = await app.importFile(file({ app: "LocalMind", chats: [
    { createdAt: "not-a-number", messages: [{ role: "user", content: "title なし" }], extra: "捨てる" },
    valid({ messages: [{ role: "system", content: "x" }] }),
    null,
  ]}));
  expect(status).toBe("1件追加・2件スキップ");
  const added = (await app.chats()).at(-1);
  expect(Object.keys(added).sort()).toEqual(["createdAt", "id", "messages", "title"]);
  expect(added.title).toBe("");
  expect(added.createdAt).toBeGreaterThanOrEqual(t0);
  expect(added.createdAt).toBeLessThanOrEqual(Date.now() + 1000);
});

test("確認ダイアログでキャンセルすると何も追加されない", async ({ app }) => {
  await app.start({ chats: SEED });
  const before = await app.ls("lm_chats");
  app.state.confirmAnswer = false;
  await app.openSettings();
  const [chooser] = await Promise.all([app.page.waitForEvent("filechooser"), app.page.click("#import-btn")]);
  await chooser.setFiles({ name: "a.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ app: "LocalMind", chats: [valid()] })) });
  await expect.poll(() => app.state.confirms.length).toBe(1);
  expect(await app.ls("lm_chats")).toBe(before);
});

test("apiKey・model・system を含むファイルでも、保存済みの値は変わらない", async ({ app, page }) => {
  await app.start({ chats: SEED });
  await page.evaluate(() => { localStorage.setItem("lm_model", "claude-haiku-4-5"); localStorage.setItem("lm_system", "元のプロンプト"); });
  const status = await app.importFile(file({
    app: "LocalMind", apiKey: "sk-ant-api03-EVILEVIL", lm_api_key: "sk-ant-api03-EVIL2",
    model: "claude-opus-5-5", system: "乗っ取り", chats: [valid({ apiKey: "sk-ant-api03-EVIL3" })],
  }));
  expect(status).toBe("1件追加・0件スキップ");
  expect(await app.ls("lm_api_key")).toBe(KEY);
  expect(await app.ls("lm_model")).toBe("claude-haiku-4-5");
  expect(await app.ls("lm_system")).toBe("元のプロンプト");
  expect(await app.ls("lm_chats")).not.toContain("EVIL");
});

test("本文に __proto__ や constructor.prototype という文字列があっても正常に取り込める", async ({ app, page }) => {
  await app.start();
  const TEXT = "__proto__ や constructor.prototype について教えて";
  const REPLY = "`__proto__` は …\n```js\nObject.prototype.__proto__ === null\n```";
  const status = await app.importFile(file({ app: "LocalMind", chats: [{
    title: TEXT, createdAt: 1700000000000, messages: [{ role: "user", content: TEXT }, { role: "assistant", content: REPLY }],
  }]}));
  expect(status).toBe("1件追加・0件スキップ");
  const [c] = await app.chats();
  expect([c.title, c.messages[0].content, c.messages[1].content]).toEqual([TEXT, TEXT, REPLY]);
  await page.click("#close-settings");
  await app.openChat("__proto__");
  await expect(page.locator("#messages")).toContainText("Object.prototype.__proto__ === null");
});

test("容量を超えるインポートは取り消され、既存データが元のまま残る", async ({ app, page }) => {
  await app.start({ chats: [...SEED, { id: "c_big", title: "大きい既存チャット", createdAt: 1, messages: [{ role: "user", content: "b".repeat(2_500_000) }] }] });
  const before = await app.ls("lm_chats");
  const content = JSON.stringify({ app: "LocalMind", chats: [valid({ title: "巨大", messages: [{ role: "user", content: "q".repeat(4_500_000) }] })] });
  expect(Buffer.byteLength(content)).toBeLessThanOrEqual(5 * 1024 * 1024);

  expect(await app.importFile(file(content))).toMatch(/保存容量が足りません/);
  expect(await app.ls("lm_chats")).toBe(before);
  await expect(app.chatItems()).toHaveCount(4);
  expect(await page.evaluate(() => JSON.stringify(chats).includes("巨大"))).toBe(false);
  await page.reload();
  await expect(app.chatItems()).toHaveCount(4);
});

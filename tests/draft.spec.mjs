// 送信中に別のチャットへ切り替えて失敗したときの下書き復元
import { test, expect, err, deferred } from "./fixtures.mjs";

const CHATS = [
  { id: "c_src", title: "送信元チャット", createdAt: 1700000000000, messages: [
    { role: "user", content: "既存の質問" },
    { role: "assistant", content: "既存の応答" },
  ]},
  { id: "c_other", title: "別のチャット", createdAt: 1700000500000, messages: [
    { role: "user", content: "別の質問" },
    { role: "assistant", content: "別の応答" },
  ]},
];

/** 送信元で送信 → 送信中に otherAction() で移動 → API を失敗させる */
async function failWhileAway(app, text, otherAction) {
  const gate = deferred();
  app.respond({ ...err(401), gate: gate.promise });
  await app.send(text, { wait: false });
  await otherAction();
  gate.resolve();
  await app.waitIdle();
}

const allStorage = (page) => page.evaluate(() => JSON.stringify({ ...localStorage }));

test("送信元を開くと、入力欄が空なら失敗した質問が下書きとして戻る", async ({ app, page }) => {
  await app.start({ chats: CHATS });
  await app.openChat("送信元チャット");
  await failWhileAway(app, "失敗した質問", () => app.openChat("別のチャット"));

  await expect(page.locator("#toast")).toBeVisible();
  await expect(page.locator("#toast")).toHaveText("『送信元チャット』への送信に失敗しました");
  await expect(page.locator("#input")).toHaveValue(""); // 切り替え先の入力欄には入れない
  await expect(app.errorRows()).toHaveCount(0);
  expect(await app.chats()).toEqual(CHATS); // 失敗した質問は履歴に残らない
  expect(await allStorage(page)).not.toContain("失敗した質問"); // 下書きは localStorage に保存しない

  await app.openChat("送信元チャット");
  await expect(page.locator("#input")).toHaveValue("失敗した質問");

  // 一度戻した下書きは消える（別のチャットを経由して開き直しても再度は入らない）
  await page.fill("#input", "");
  await app.openChat("別のチャット");
  await app.openChat("送信元チャット");
  await expect(page.locator("#input")).toHaveValue("");
});

test("入力欄に文字があるときは上書きせず、空にしてから開き直すと戻る", async ({ app, page }) => {
  await app.start({ chats: CHATS });
  await app.openChat("送信元チャット");
  await failWhileAway(app, "保留される質問", async () => {
    await app.openChat("別のチャット");
    await page.fill("#input", "書きかけ");
  });

  await app.openChat("送信元チャット");
  await expect(page.locator("#input")).toHaveValue("書きかけ");

  await page.fill("#input", "");
  await app.openChat("別のチャット");
  await app.openChat("送信元チャット");
  await expect(page.locator("#input")).toHaveValue("保留される質問");
});

test("下書きはリロードで消える（メモリ上のみ）", async ({ app, page }) => {
  await app.start({ chats: CHATS });
  await app.openChat("送信元チャット");
  await failWhileAway(app, "消える下書き", () => app.openChat("別のチャット"));
  await page.reload();
  await app.openChat("送信元チャット");
  await expect(page.locator("#input")).toHaveValue("");
});

test("「新しいチャット」を押した後に最初のメッセージが失敗すると、新しいチャットの入力欄に戻る", async ({ app, page }) => {
  await app.start({ chats: CHATS });
  await page.click("#new-chat-btn");
  await failWhileAway(app, "最初の質問", () => page.click("#new-chat-btn"));

  await expect(page.locator("#toast")).toHaveText("『新しいチャット』への送信に失敗しました");
  await expect(app.chatItems()).toHaveCount(2); // 空になったチャットは残らない
  await expect(page.locator("#input")).toHaveValue("最初の質問");
});

test("新規チャットの失敗中に既存チャットを開いていた場合は、「新しいチャット」を押したときに戻る", async ({ app, page }) => {
  await app.start({ chats: CHATS });
  await page.click("#new-chat-btn");
  await failWhileAway(app, "新規の質問", () => app.openChat("別のチャット"));

  await expect(page.locator("#input")).toHaveValue("");
  await page.click("#new-chat-btn");
  await expect(page.locator("#input")).toHaveValue("新規の質問");
});

test("通知のタイトルは文字として表示される（HTML として解釈しない）", async ({ app, page }) => {
  const XSS = "<img src=x onerror=alert(1)>";
  await app.start({ chats: [{ ...CHATS[0], title: XSS }, CHATS[1]] });
  await app.openChat("<img");
  await failWhileAway(app, "質問", () => app.openChat("別のチャット"));
  await expect(page.locator("#toast")).toHaveText(`『${XSS}』への送信に失敗しました`);
  await expect(page.locator("#toast img")).toHaveCount(0);
});

test("通知はしばらくすると消える", async ({ app, page }) => {
  await app.start({ chats: CHATS });
  await app.openChat("送信元チャット");
  await failWhileAway(app, "質問", () => app.openChat("別のチャット"));
  await expect(page.locator("#toast")).toBeVisible();
  await expect(page.locator("#toast")).toBeHidden({ timeout: 8000 });
});

test("チャットを削除すると、そのチャットの下書きも消える", async ({ app, page }) => {
  await app.start({ chats: CHATS });
  await app.openChat("送信元チャット");
  await failWhileAway(app, "削除される下書き", () => app.openChat("別のチャット"));
  await page.locator(".chat-item", { hasText: "送信元チャット" }).locator(".del").click();
  expect(await page.evaluate(() => drafts.has("c_src"))).toBe(false);
});

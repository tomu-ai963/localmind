// localStorage の容量超過（送信時）
import { test, expect, ok, deferred, noConsecutiveUser, QUOTA_MESSAGE } from "./fixtures.mjs";

const EXISTING = [
  { id: "c_old", title: "既存チャット", createdAt: 1700000000000, messages: [
    { role: "user", content: "既存の質問" },
    { role: "assistant", content: "既存の応答" },
  ]},
];
const LONG_TEXT = "長い質問".repeat(500);
const BIG_REPLY = "大きな応答".repeat(10_000);
const UNSAVED_NOTE = "⚠ この質問と応答は保存されていません";

test.describe("ユーザーメッセージの保存で容量超過", () => {
  test("既存チャット: API を呼ばず、元の状態に戻して容量不足を表示する", async ({ app, page }) => {
    await app.start({ chats: EXISTING });
    await app.openChat("既存チャット");
    await app.fillStorage(50);
    const before = await app.ls("lm_chats");

    expect(await app.send(LONG_TEXT)).toBe(0);
    await expect(app.errorRows().last()).toHaveText(QUOTA_MESSAGE);
    expect(await app.ls("lm_chats")).toBe(before);
    expect(await app.memoryChats()).toEqual(EXISTING);
    await expect(page.locator("#input")).toHaveValue(LONG_TEXT);

    await page.reload();
    expect(await app.chats()).toEqual(EXISTING);
    await expect(app.chatItems()).toHaveCount(1);
  });

  test("新規チャット: 空のチャットが一覧に残らない", async ({ app }) => {
    await app.start({ chats: EXISTING });
    await app.fillStorage(50);
    const before = await app.ls("lm_chats");

    expect(await app.send(LONG_TEXT)).toBe(0);
    await expect(app.chatItems()).toHaveCount(1);
    expect(await app.memoryChats()).toEqual(EXISTING);
    expect(await app.ls("lm_chats")).toBe(before);
  });
});

test.describe("応答の保存で容量超過", () => {
  test("応答は表示して注記を出し、質問も履歴から外して保存し直す", async ({ app, page }) => {
    await app.start({ chats: EXISTING });
    await app.openChat("既存チャット");
    await app.fillStorage(3000);
    app.respond(ok(BIG_REPLY));

    expect(await app.send("短い質問")).toBe(1);
    const last = app.assistantRows().last();
    await expect(last.locator(".msg-content")).toContainText("大きな応答大きな応答");
    await expect(last.locator(".unsaved-note")).toContainText(UNSAVED_NOTE);

    expect(await app.chats()).toEqual(EXISTING); // 質問も応答も残らない
    expect(await app.memoryChats()).toEqual(EXISTING);

    await page.reload();
    expect(await app.chats()).toEqual(EXISTING);
    await expect(app.chatItems()).toHaveCount(1);
  });

  test("保存に失敗した後に再送信しても、API に送る messages の user が連続しない", async ({ app }) => {
    await app.start({ chats: EXISTING });
    await app.openChat("既存チャット");
    await app.fillStorage(3000);
    app.respond(ok(BIG_REPLY));
    await app.send("保存されない質問");

    await app.freeStorage();
    app.respond(ok("今度は保存される"));
    await app.send("もう一度の質問");

    const sent = app.lastRequest.body.messages;
    expect(noConsecutiveUser(sent)).toBe(true);
    expect(sent.map((m) => m.content)).toEqual(["既存の質問", "既存の応答", "もう一度の質問"]);
    expect((await app.chats())[0].messages.map((m) => m.content))
      .toEqual(["既存の質問", "既存の応答", "もう一度の質問", "今度は保存される"]);
  });

  test("新規チャットの最初の応答で失敗すると、チャットごと消えて注記が出る", async ({ app }) => {
    await app.start({ chats: EXISTING });
    await app.fillStorage(3000);
    app.respond(ok(BIG_REPLY));
    await app.send("最初の質問");

    await expect(app.page.locator(".unsaved-note")).toHaveCount(1);
    await expect(app.chatItems()).toHaveCount(1); // 既存チャットだけ（タイトル自動生成も巻き戻し）
    expect(await app.chats()).toEqual(EXISTING);
  });

  test("送信中に別チャットへ切り替えていた場合、注記は出さずデータも残さない", async ({ app, page }) => {
    await app.start({ chats: EXISTING });
    const gate = deferred();
    app.respond({ ...ok(BIG_REPLY), gate: gate.promise });
    await app.fillStorage(3000);
    await app.send("切り替える質問", { wait: false });

    await app.openChat("既存チャット");
    gate.resolve();
    await app.waitIdle();

    await expect(page.locator(".unsaved-note")).toHaveCount(0);
    await expect(page.locator("#messages")).not.toContainText("大きな応答");
    await expect(app.chatItems()).toHaveCount(1);
    expect(await app.chats()).toEqual(EXISTING);
  });
});

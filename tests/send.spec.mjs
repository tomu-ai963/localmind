// 送信・再試行・コピー・送信エラー・送信中のチャット切り替え
import { test, expect, ok, err, deferred, noConsecutiveUser, KEY } from "./fixtures.mjs";

const EXISTING = [
  { id: "c_old", title: "既存チャット", createdAt: 1700000000000, messages: [
    { role: "user", content: "既存の質問" },
    { role: "assistant", content: "既存の応答" },
  ]},
];

test.describe("送信", () => {
  test("送信すると user と応答が保存され、タイトルが自動生成される", async ({ app, page }) => {
    await app.start();
    app.respond(ok("こんにちは！\n```js\nconsole.log('copy me')\n```"));
    expect(await app.send("はじめまして")).toBe(1);

    const cs = await app.chats();
    expect(cs).toHaveLength(1);
    expect(cs[0].messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(cs[0].title).toBe("こんにちは！ ```js console");
    expect(app.lastRequest.body.messages).toEqual([{ role: "user", content: "はじめまして" }]);
    expect(app.lastRequest.headers["x-api-key"]).toBe(KEY);
    await expect(page.locator("#input")).toHaveValue("");
    await expect(app.chatItems()).toHaveCount(1);
  });

  test("max_tokens で終わった応答に途中終了の注記が付き、truncated が保存される", async ({ app, page }) => {
    await app.start();
    app.respond(ok("途中まで", "max_tokens"));
    await app.send("長く");
    await expect(page.locator(".retry-note")).toHaveText("⚠ 回答が長すぎたため途中で終了しました");
    expect((await app.chats())[0].messages[1]).toEqual({ role: "assistant", content: "途中まで", truncated: true });
  });

  test("APIキー未設定なら送信せず設定画面を開く", async ({ app, page }) => {
    await app.start({ key: null });
    await page.click("#close-settings");
    await page.fill("#input", "キーなし");
    await page.press("#input", "Enter");
    await expect(page.locator("#modal-overlay")).toHaveClass(/open/);
    expect(app.requests).toHaveLength(0);
    expect(await app.ls("lm_chats")).toBeNull();
  });
});

test("コードブロックのコピーボタンでクリップボードにコピーされる", async ({ app, page }) => {
  await app.start();
  app.respond(ok("```js\nconsole.log('copy me')\n```"));
  await app.send("コード");
  await page.hover(".code-block");
  await page.click(".copy-btn");
  await expect(page.locator(".copy-btn")).toHaveText("✓");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("console.log('copy me')");
  await expect(page.locator(".copy-btn")).toHaveText("⧉", { timeout: 3000 });
});

test.describe("再試行", () => {
  test("529 → 529 → 200 で 3 回目に成功する", async ({ app }) => {
    await app.start();
    app.respond(err(529), err(529), ok("再試行後の応答"));
    expect(await app.send("再試行テスト")).toBe(3);
    expect((await app.chats())[0].messages.at(-1).content).toBe("再試行後の応答");
  });

  test("429 が続くと 4 回試行して失敗し、user は残らない", async ({ app, page }) => {
    await app.start({ chats: EXISTING });
    await app.openChat("既存チャット");
    app.respond(err(429), err(429), err(429), err(429));
    expect(await app.send("レート制限")).toBe(4);
    await expect(app.errorRows().last()).toContainText("レート制限が続いています");
    expect(await app.chats()).toEqual(EXISTING);
    await expect(page.locator("#input")).toHaveValue("レート制限");
  });
});

test.describe("送信エラー", () => {
  for (const [status, expected] of [[400, "エラー (400)"], [401, "APIキーが無効"]]) {
    test(`${status}: user が履歴に残らず、入力欄に元のテキストが戻る`, async ({ app, page }) => {
      await app.start({ chats: EXISTING });
      await app.openChat("既存チャット");
      app.respond(err(status, "invalid request"));
      await app.send(`失敗するメッセージ ${status}`);

      expect(await app.chats()).toEqual(EXISTING);
      await expect(page.locator("#input")).toHaveValue(`失敗するメッセージ ${status}`);
      await expect(app.errorRows().last()).toContainText(expected);
      await expect(app.userRows()).toHaveText([/既存の質問/]);
      expect(await app.ls("lm_chats")).not.toContain("invalid");
    });
  }

  test("エラー後の再送信で、API に送る messages の user が連続しない", async ({ app }) => {
    await app.start({ chats: EXISTING });
    await app.openChat("既存チャット");
    app.respond(err(401), ok("今度は成功"));
    await app.send("失敗→再送");
    await app.page.press("#input", "Enter"); // 入力欄に戻ったテキストをそのまま再送信
    await app.waitIdle();

    const sent = app.lastRequest.body.messages;
    expect(noConsecutiveUser(sent)).toBe(true);
    expect(sent.map((m) => m.content)).toEqual(["既存の質問", "既存の応答", "失敗→再送"]);
    const saved = (await app.chats())[0].messages;
    expect(saved.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
  });

  test("最初のメッセージでエラーになっても空のチャットが残らない", async ({ app, page }) => {
    await app.start({ chats: EXISTING });
    app.respond(err(401));
    await app.send("最初の一言");
    await expect(app.chatItems()).toHaveCount(1);
    expect(await app.chats()).toEqual(EXISTING);
    await expect(page.locator("#input")).toHaveValue("最初の一言");
    await expect(app.errorRows().last()).toContainText("APIキーが無効");

    app.respond(ok("新チャットの応答"));
    await page.press("#input", "Enter");
    await app.waitIdle();
    await expect(app.chatItems()).toHaveCount(2);
    expect((await app.chats()).at(-1).messages.map((m) => m.content)).toEqual(["最初の一言", "新チャットの応答"]);
  });

  test("ネットワークエラーでも user は残らず入力欄に戻る", async ({ app, page }) => {
    await app.start();
    app.respond({ abort: true });
    await app.send("ネットワーク断");
    expect(await app.ls("lm_chats")).toBe("[]");
    await expect(app.chatItems()).toHaveCount(0);
    await expect(page.locator("#input")).toHaveValue("ネットワーク断");
    await expect(app.errorRows().last()).toContainText("ネットワークエラー");
  });

  test("送信中に入力欄へ書いた内容は、エラー後も消えない", async ({ app, page }) => {
    await app.start();
    const gate = deferred();
    app.respond({ ...err(400), gate: gate.promise });
    await app.send("元の質問", { wait: false });
    await page.fill("#input", "送信中に書いた続き");
    gate.resolve();
    await app.waitIdle();
    await expect(page.locator("#input")).toHaveValue("元の質問\n送信中に書いた続き");
  });
});

test.describe("送信中のチャット切り替え", () => {
  const TWO = [
    ...EXISTING,
    { id: "c_other", title: "別のチャット", createdAt: 1700000500000, messages: [
      { role: "user", content: "別の質問" },
      { role: "assistant", content: "別の応答" },
    ]},
  ];

  test("応答は切り替え先に出ず、送信元のチャットに保存される", async ({ app, page }) => {
    await app.start({ chats: TWO });
    await app.openChat("既存チャット");
    const gate = deferred();
    app.respond({ ...ok("送信元への応答"), gate: gate.promise });
    await app.send("送信元の質問", { wait: false });

    await app.openChat("別のチャット");
    gate.resolve();
    await app.waitIdle();

    await expect(page.locator("#messages")).not.toContainText("送信元への応答");
    await expect(app.assistantTexts()).toHaveText(["別の応答"]);
    const source = (await app.chats()).find((c) => c.id === "c_old");
    expect(source.messages.map((m) => m.content)).toEqual(["既存の質問", "既存の応答", "送信元の質問", "送信元への応答"]);

    await app.openChat("既存チャット");
    await expect(app.assistantRows().last()).toContainText("送信元への応答");
  });

  test("エラーは切り替え先に出ず、送信元から user だけが外れる", async ({ app, page }) => {
    await app.start({ chats: TWO });
    await app.openChat("既存チャット");
    const gate = deferred();
    app.respond({ ...err(401), gate: gate.promise });
    await app.send("失敗する質問", { wait: false });

    await app.openChat("別のチャット");
    await page.fill("#input", "別チャットで書きかけ");
    gate.resolve();
    await app.waitIdle();

    await expect(app.errorRows()).toHaveCount(0);
    await expect(page.locator("#input")).toHaveValue("別チャットで書きかけ"); // 切り替え先の入力欄は触らない
    expect(await app.chats()).toEqual(TWO);
  });

  test("「新しいチャット」を押した場合も、応答は出ずにサイドバーにだけ反映される", async ({ app, page }) => {
    await app.start();
    const gate = deferred();
    app.respond({ ...ok("最初の応答です"), gate: gate.promise });
    await app.send("最初の質問", { wait: false });

    await page.click("#new-chat-btn");
    gate.resolve();
    await app.waitIdle();

    await expect(page.locator("#empty-state")).toBeVisible();
    await expect(app.assistantRows()).toHaveCount(0);
    await expect(app.chatItems()).toHaveCount(1);
    await expect(app.chatItems().first()).toContainText("最初の応答です"); // 自動生成タイトル

    await app.openChat("最初の応答です");
    await expect(app.assistantTexts()).toHaveText(["最初の応答です"]);
  });

  test("「新しいチャット」を押した後に最初のメッセージが失敗すると、チャットはサイドバーから消える", async ({ app, page }) => {
    await app.start();
    const gate = deferred();
    app.respond({ ...err(401), gate: gate.promise });
    await app.send("消える質問", { wait: false });
    await expect(app.chatItems()).toHaveCount(1);

    await page.click("#new-chat-btn");
    gate.resolve();
    await app.waitIdle();

    await expect(app.chatItems()).toHaveCount(0);
    await expect(app.errorRows()).toHaveCount(0);
    expect(await app.ls("lm_chats")).toBe("[]");
  });
});

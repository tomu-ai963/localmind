import { defineConfig, devices } from "@playwright/test";

const PORT = 4173;

export default defineConfig({
  testDir: "tests",
  timeout: 60_000, // 429 の再試行を使い切るテストで約 10 秒待つため
  fullyParallel: true,
  reporter: "list",
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    acceptDownloads: true,
    permissions: ["clipboard-read", "clipboard-write"],
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  // _headers の CSP を付けて静的配信するテスト用サーバー
  webServer: {
    command: "node tests/server.mjs",
    url: `http://127.0.0.1:${PORT}/`,
    env: { PORT: String(PORT) },
    reuseExistingServer: !process.env.CI,
  },
});

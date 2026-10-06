// テスト用の静的サーバー。public/ の中だけを、public/_headers の "/*" ブロックを付けて配信する
// （本番の Cloudflare Workers 静的アセットと同じ配信範囲・同じ CSP で検証するため）
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PUBLIC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
const PORT = Number(process.env.PORT || 4173);

const headers = {};
for (const line of fs.readFileSync(path.join(PUBLIC, "_headers"), "utf8").split(/\r?\n/).slice(1)) {
  const m = line.match(/^\s+([^:]+):\s*(.*)$/);
  if (m) headers[m[1]] = m[2];
}

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p === "/") p = "/index.html";
  const file = path.join(PUBLIC, p);
  // public/ の外と _headers 自体は返さない（Workers 静的アセットも _headers は配信しない）
  const inside = file.startsWith(PUBLIC + path.sep);
  if (!inside || path.basename(file) === "_headers" || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404);
    return res.end();
  }
  res.writeHead(200, { ...headers, "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
}).listen(PORT, "127.0.0.1", () => console.log(`test server: http://127.0.0.1:${PORT}/`));

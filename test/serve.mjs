/**
 * 本機預覽伺服器（不需 wrangler）：node test/serve.mjs [port] [password] [subscriptionUrl]
 * 用 MockKV 跑 Worker，供瀏覽器截圖與模擬器 App 連線測試。
 * 例：node test/serve.mjs 8787 test "http://85.237.207.56:5050/channel?type=m3u&token=..."
 */
import http from "node:http";
import worker from "../src/index.js";
import { MockKV } from "./mockkv.mjs";

const port = parseInt(process.argv[2] || "8787", 10);
const password = process.argv[3] || "test";
const subscriptionUrl = process.argv[4] || "";

const seed = {};
if (subscriptionUrl) {
  seed.config = {
    version: 3,
    subscriptionUrl,
    pollIntervalMinutes: 180,
    forceRefresh: false,
    autostart: true,
    notice: "歡迎使用偉電視，有問題請聯絡家人",
    requireActivation: false,
    fontScale: "auto",
    showClock: true,
    otaEnabled: false,
    updatedAt: new Date().toISOString(),
  };
  // 一些示範裝置，讓管理頁有東西看
  const now = Date.now();
  seed["dev:tv-a1b2c3d4"] = { id: "tv-a1b2c3d4", nick: "客廳電視", m: "MiBOX4", v: "1.0.0.24", ip: "218.166.1.2", firstSeen: new Date(now - 30 * 86400000).toISOString(), lastSeen: new Date(now - 60000).toISOString(), lastWrite: new Date(now - 60000).toISOString(), count: 412, blocked: false, msg: "", msgLevel: "info", authorized: true, expireAt: "", lastOk: true, lastCount: 119, lastResultAt: new Date(now - 3600000).toISOString(), now: "民視新聞台", nowAt: new Date(now - 120000).toISOString(), fs: "large" };
  seed["dev:tv-9f8e7d6c"] = { id: "tv-9f8e7d6c", nick: "阿嬤房", m: "Q-BOX", v: "1.0.0.21", ip: "1.160.2.3", firstSeen: new Date(now - 60 * 86400000).toISOString(), lastSeen: new Date(now - 5 * 3600000).toISOString(), count: 1290, blocked: false, msg: "記得吃藥", msgLevel: "warn", authorized: true, expireAt: new Date(now + 20 * 86400000).toISOString(), lastOk: true, lastCount: 118, lastResultAt: new Date(now - 5 * 3600000).toISOString(), cmd: { id: "cabc", type: "tune", arg: "12", at: new Date(now - 60000).toISOString() } };
  seed["dev:tv-00aa11bb"] = { id: "tv-00aa11bb", nick: "", m: "X96mini", v: "1.0.0.24", ip: "36.230.1.1", firstSeen: new Date(now - 3 * 86400000).toISOString(), lastSeen: new Date(now - 3 * 86400000).toISOString(), count: 7, blocked: true, msg: "", msgLevel: "info", authorized: false, expireAt: "" };
  seed["code:48213957"] = { code: "48213957", status: "unused", device: null, note: "王先生", days: 0, createdAt: new Date(now - 86400000).toISOString(), usedAt: "", expireAt: "" };
  seed["code:90817263"] = { code: "90817263", status: "used", device: "tv-9f8e7d6c", note: "阿嬤房", days: 30, createdAt: new Date(now - 10 * 86400000).toISOString(), usedAt: new Date(now - 9 * 86400000).toISOString(), expireAt: new Date(now + 20 * 86400000).toISOString() };
}
const env = { CONFIG_KV: new MockKV(seed), ADMIN_PASSWORD: password };

const server = http.createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : null;
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
    headers.set("cf-connecting-ip", req.socket.remoteAddress || "127.0.0.1");
    const url = `http://${req.headers.host || "localhost:" + port}${req.url}`;
    const init = { method: req.method, headers };
    if (body && req.method !== "GET" && req.method !== "HEAD") init.body = body;
    const request = new Request(url, init);
    const response = await worker.fetch(request, env, {});
    const out = Buffer.from(await response.arrayBuffer());
    const h = {};
    response.headers.forEach((v, k) => { h[k] = v; });
    res.writeHead(response.status, h);
    res.end(out);
    console.log(new Date().toISOString().slice(11, 19), req.method, req.url, response.status, out.length);
  } catch (err) {
    console.error(err);
    res.writeHead(500);
    res.end("error");
  }
});
server.listen(port, "0.0.0.0", () => {
  console.log(`WeiTV worker preview on http://localhost:${port}  (admin pw: ${password}, kv writes counter live)`);
});

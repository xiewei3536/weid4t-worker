/**
 * Worker 端到端測試（Node 18+，零依賴）：node test/run.mjs
 * 用 MockKV 模擬 KV，直接呼叫 worker.fetch 驗證所有端點與相容性。
 */
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { MockKV } from "./mockkv.mjs";

const ORIGIN = "https://weitv.test";
const PASS = "secret-pw";
let passed = 0;
const failures = [];

function makeEnv(seed, opts) {
  return { CONFIG_KV: new MockKV(seed), ADMIN_PASSWORD: PASS, STREAM_PROBE: "off", ...(opts || {}) };
}

/** Worker 連 IP 網址時會改連 sslip.io / nip.io 的對應網域（Cloudflare 不准 Worker 直連 IP）；mock 一律還原成 IP 寫法比對 */
function unIp(url) {
  return String(url)
    .replace(/\/\/(\d{1,3})-(\d{1,3})-(\d{1,3})-(\d{1,3})\.sslip\.io/, "//$1.$2.$3.$4")
    .replace(/\/\/(\d{1,3}(?:\.\d{1,3}){3})\.nip\.io/, "//$1");
}
const basic = "Basic " + Buffer.from("admin:" + PASS).toString("base64");

async function call(env, path, init) {
  init = init || {};
  const headers = new Headers(init.headers || {});
  if (init.auth !== false && path.startsWith("/admin")) headers.set("Authorization", basic);
  if (init.json !== false && path.startsWith("/admin") && (init.method || "GET") === "POST") headers.set("X-Requested-With", "fetch");
  if (!headers.has("cf-connecting-ip")) headers.set("cf-connecting-ip", init.ip || "1.2.3.4");
  let body = init.body;
  if (body && typeof body === "object" && !(body instanceof FormData) && !(body instanceof Uint8Array)) {
    const fd = new FormData();
    for (const [k, v] of Object.entries(body)) fd.append(k, String(v));
    body = fd;
  }
  const req = new Request(ORIGIN + path, { method: init.method || "GET", headers, body });
  const res = await worker.fetch(req, env, {});
  const ct = res.headers.get("content-type") || "";
  const text = await res.text();
  let json = null;
  if (ct.includes("json")) {
    try { json = JSON.parse(text); } catch (_) {}
  }
  return { status: res.status, headers: res.headers, text, json, ct };
}

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log("  ✓", name);
  } catch (err) {
    failures.push([name, err]);
    console.log("  ✕", name, "\n     ", (err && err.message) || err);
  }
}

console.log("WeiTV worker tests");

await test("首頁與 robots", async () => {
  const env = makeEnv();
  const r = await call(env, "/");
  assert.equal(r.status, 200);
  assert.match(r.text, /偉電視/);
  assert.equal((await call(env, "/robots.txt")).status, 200);
  assert.equal((await call(env, "/nope")).status, 404);
});

await test("/api/config 預設值與新欄位，且相容舊 App 欄位", async () => {
  const env = makeEnv();
  const r = await call(env, "/api/config");
  assert.equal(r.status, 200);
  const c = r.json;
  for (const k of ["version", "subscriptionUrl", "pollIntervalMinutes", "forceRefresh", "notice", "blocked", "message",
    "messageLevel", "autostart", "authorized", "expireAt", "requireActivation", "activationTitle", "activationText",
    "codeDigits", "marquee", "contactText", "contactQrUrl"]) {
    assert.ok(k in c, "缺少舊欄位 " + k);
  }
  assert.equal(c.authorized, true);
  assert.equal(c.fontScale, "auto");
  assert.equal(c.showClock, false);
  assert.equal(c.otaEnabled, true);
  assert.equal(c.cmd, null);
  assert.ok(Math.abs(c.serverTimeMs - Date.now()) < 5000);
  assert.equal(r.headers.get("access-control-allow-origin"), "*");
});

await test("舊 KV 設定缺新欄位時自動補齊", async () => {
  const env = makeEnv({ config: { version: 7, subscriptionUrl: "http://x/y", requireActivation: true, codeDigits: 6 } });
  const c = (await call(env, "/api/config")).json;
  assert.equal(c.version, 7);
  assert.equal(c.codeDigits, 6);
  assert.equal(c.fontScale, "auto");
  assert.equal(c.requireActivation, true);
  assert.equal(c.subscriptionUrl, "", "需授權但沒 id → 不給源");
});

await test("裝置登記與 KV 寫入節流", async () => {
  const env = makeEnv({ config: { version: 1, subscriptionUrl: "http://src/list.m3u" } });
  const kv = env.CONFIG_KV;
  let r = await call(env, "/api/config?id=tv-1&m=BoxA&v=1.0.0.24");
  assert.equal(r.json.subscriptionUrl, "http://src/list.m3u");
  const w1 = kv.writes;
  assert.equal(w1, 2, "新裝置寫一次（＋新裝置登記限速計數一次）");
  await call(env, "/api/config?id=tv-1&m=BoxA&v=1.0.0.24");
  await call(env, "/api/config?id=tv-1&m=BoxA&v=1.0.0.24");
  assert.equal(kv.writes, w1, "10 分內無變化不再寫");
  await call(env, "/api/config?id=tv-1&m=BoxA&v=1.0.0.24&ok=1&ch=119");
  assert.equal(kv.writes, w1 + 1, "帶 ok 回報就寫");
  const dev = await kv.get("dev:tv-1", { type: "json" });
  assert.equal(dev.lastOk, true);
  assert.equal(dev.lastCount, 119);
  await call(env, "/api/config?id=tv-1&m=BoxA&v=1.0.0.25");
  assert.equal(kv.writes, w1 + 2, "版本變了就寫");
  await call(env, "/api/config?id=tv-1&m=BoxA&v=1.0.0.25&now=%E6%B0%91%E8%A6%96");
  assert.equal(kv.writes, w1 + 2, "剛寫過 3 分內換台不寫");
  // 模擬上次寫入在 11 分鐘前
  const d2 = await kv.get("dev:tv-1", { type: "json" });
  d2.lastWrite = new Date(Date.now() - 11 * 60000).toISOString();
  await kv.put("dev:tv-1", JSON.stringify(d2));
  const w2 = kv.writes;
  await call(env, "/api/config?id=tv-1&m=BoxA&v=1.0.0.25&now=%E4%B8%AD%E8%A6%96");
  assert.equal(kv.writes, w2 + 1, "超過 10 分就寫");
  const d3 = await kv.get("dev:tv-1", { type: "json" });
  assert.equal(d3.now, "中視");
  assert.equal(d3.ip, "1.2.3.4");
});

await test("管理頁驗證：未登入 401、密碑錯 401、未設密碼顯示設定頁", async () => {
  const env = makeEnv();
  assert.equal((await call(env, "/admin", { auth: false })).status, 401);
  const bad = await call(env, "/admin", { auth: false, headers: { Authorization: "Basic " + Buffer.from("a:wrong").toString("base64") } });
  assert.equal(bad.status, 401);
  const ok = await call(env, "/admin");
  assert.equal(ok.status, 200);
  assert.match(ok.text, /管理中心/);
  assert.match(ok.text, /data-panel="devices"/);
  const nopw = await call({ CONFIG_KV: new MockKV() }, "/admin", { auth: false });
  assert.equal(nopw.status, 200);
  assert.match(nopw.text, /ADMIN_PASSWORD/);
  // fetch 模式未登入 → JSON relogin
  const j = await call(env, "/admin/partial?name=overview", { auth: false, headers: { "X-Requested-With": "fetch" } });
  assert.equal(j.status, 401);
  assert.equal(j.json.relogin, true);
});

await test("CSRF：跨站 POST 被拒", async () => {
  const env = makeEnv();
  const r = await call(env, "/admin/save", { method: "POST", body: { _fields: "system" }, headers: { "Sec-Fetch-Site": "cross-site" } });
  assert.equal(r.status, 403);
  const r2 = await call(env, "/admin/save", { method: "POST", body: { _fields: "system" }, headers: { Origin: "https://evil.example" } });
  assert.equal(r2.status, 403);
  const r3 = await call(env, "/admin/save", { method: "POST", body: { _fields: "system", pollIntervalMinutes: "60" }, headers: { "Sec-Fetch-Site": "same-origin", Origin: ORIGIN } });
  assert.equal(r3.status, 200);
});

await test("儲存直播源（JSON）→ 盒子拿到新網址；格式錯誤被擋", async () => {
  const env = makeEnv();
  const bad = await call(env, "/admin/save", { method: "POST", body: { _fields: "source", subscriptionUrl: "ftp://x" } });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.ok, false);
  const r = await call(env, "/admin/save", { method: "POST", body: { _fields: "source", subscriptionUrl: "http://85.237.207.56:5050/channel?type=m3u&token=abc" } });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.version, 2);
  assert.ok(r.json.refresh.includes("overview"));
  const c = (await call(env, "/api/config?id=tv-9")).json;
  assert.equal(c.subscriptionUrl, "http://85.237.207.56:5050/channel?type=m3u&token=abc");
});

await test("傳統表單（非 JSON）儲存回結果頁", async () => {
  const env = makeEnv();
  const r = await call(env, "/admin/save", { method: "POST", json: false, body: { _fields: "notice", notice: "hi", noticeHours: "0" } });
  assert.equal(r.status, 200);
  assert.match(r.ct, /text\/html/);
  assert.match(r.text, /返回管理中心/);
});

await test("系統設定：字體 / 時鐘 / OTA 開關下發", async () => {
  const env = makeEnv();
  const r = await call(env, "/admin/save", { method: "POST", body: { _fields: "system", pollIntervalMinutes: "5", fontScale: "large", showClock: "on", autostart: "on" } });
  assert.equal(r.json.ok, true);
  const c = (await call(env, "/api/config?id=tv-1")).json;
  assert.equal(c.pollIntervalMinutes, 10, "下限 10 分");
  assert.equal(c.fontScale, "large");
  assert.equal(c.showClock, true);
  assert.equal(c.otaEnabled, false, "未勾選 → 停用");
  assert.equal(c.forceRefresh, false);
  const u = (await call(env, "/api/update")).json;
  assert.equal(u.version, 0);
  const bad = await call(env, "/admin/save", { method: "POST", body: { _fields: "system", pollIntervalMinutes: "60", fontScale: "huge", otaEnabled: "on" } });
  assert.equal((await call(env, "/api/config")).json.fontScale, "auto", "非法值回 auto");
  assert.equal(bad.json.ok, true);
});

await test("裝置字體覆蓋與遠端指令（送出 → 下發 → ack）", async () => {
  const env = makeEnv();
  await call(env, "/api/config?id=tv-1&m=Box&v=1");
  let r = await call(env, "/admin/device", { method: "POST", body: { id: "tv-1", action: "fontscale", value: "xlarge" } });
  assert.equal(r.json.ok, true);
  assert.equal((await call(env, "/api/config?id=tv-1")).json.fontScale, "xlarge");
  r = await call(env, "/admin/device", { method: "POST", body: { id: "tv-1", action: "fontscale", value: "" } });
  assert.equal((await call(env, "/api/config?id=tv-1")).json.fontScale, "auto");

  r = await call(env, "/admin/device", { method: "POST", body: { id: "tv-1", action: "cmd", value: "tune", arg: "abc" } });
  assert.equal(r.json.ok, false, "切台需數字");
  r = await call(env, "/admin/device", { method: "POST", body: { id: "tv-1", action: "cmd", value: "tune", arg: "12" } });
  assert.equal(r.json.ok, true);
  let c = (await call(env, "/api/config?id=tv-1")).json;
  assert.ok(c.cmd && c.cmd.type === "tune" && c.cmd.arg === "12", "應下發 tune 12");
  const cmdId = c.cmd.id;
  c = (await call(env, "/api/config?id=tv-1")).json;
  assert.equal(c.cmd.id, cmdId, "未 ack 前重複下發同一指令");
  c = (await call(env, "/api/config?id=tv-1&ack=" + cmdId)).json;
  assert.equal(c.cmd, null, "ack 後清除");
  const adm = await env.CONFIG_KV.get("devadm:tv-1", { type: "json" });
  assert.equal(adm.lastAck.id, cmdId);
  assert.equal(adm.lastAck.type, "tune");
  assert.equal(adm.cmd, null);
  // 過期指令不下發
  adm.cmd = { id: "old", type: "reload", arg: "", at: new Date(Date.now() - 7 * 3600000).toISOString() };
  await env.CONFIG_KV.put("devadm:tv-1", JSON.stringify(adm));
  assert.equal((await call(env, "/api/config?id=tv-1")).json.cmd, null);
  // 群發
  await call(env, "/api/config?id=tv-2&m=Box&v=1");
  r = await call(env, "/admin/device", { method: "POST", body: { action: "cmd_all", value: "reload" } });
  assert.match(r.json.message, /2 台/);
  assert.equal((await call(env, "/api/config?id=tv-2")).json.cmd.type, "reload");
  r = await call(env, "/admin/device", { method: "POST", body: { id: "tv-2", action: "clearcmd" } });
  assert.equal((await call(env, "/api/config?id=tv-2")).json.cmd, null);
});

await test("啟動碼授權完整流程 + 撤銷 + 限速", async () => {
  const env = makeEnv({ config: { version: 1, subscriptionUrl: "http://src/list.m3u" } });
  let r = await call(env, "/admin/save", { method: "POST", body: { _fields: "auth", requireActivation: "on", codeDigits: "6", activationTitle: "歡迎", activationText: "請輸入" } });
  assert.equal(r.json.ok, true);
  let c = (await call(env, "/api/config?id=tv-2&m=B&v=1")).json;
  assert.equal(c.authorized, false);
  assert.equal(c.subscriptionUrl, "");
  assert.equal(c.codeDigits, 6);

  r = await call(env, "/admin/codes", { method: "POST", body: { action: "gen_batch", count: "2", days: "30", note: "測試" } });
  assert.equal(r.json.ok, true);
  assert.equal(r.json.codes.length, 2);
  assert.match(r.json.codes[0], /^\d{6}$/);
  const [code1, code2] = r.json.codes;

  let a = await call(env, "/api/activate?id=tv-2&code=000000");
  assert.equal(a.json.ok, false);
  a = await call(env, "/api/activate?id=tv-2&code=" + code1);
  assert.equal(a.json.ok, true, JSON.stringify(a.json));
  const days = (Date.parse(a.json.expireAt) - Date.now()) / 86400000;
  assert.ok(days > 29.9 && days < 30.1, "30 天到期");
  c = (await call(env, "/api/config?id=tv-2&m=B&v=1")).json;
  assert.equal(c.authorized, true);
  assert.equal(c.subscriptionUrl, "http://src/list.m3u");
  // 同碼重裝可再用；別台不可
  assert.equal((await call(env, "/api/activate?id=tv-2&code=" + code1)).json.ok, true);
  assert.equal((await call(env, "/api/activate?id=tv-3&code=" + code1)).json.ok, false);
  // 撤銷 → 裝置停用
  r = await call(env, "/admin/codes", { method: "POST", body: { action: "revoke", code: code1 } });
  assert.equal(r.json.ok, true);
  assert.equal((await call(env, "/api/config?id=tv-2")).json.authorized, false);
  // 直接授權 / 撤銷 / 封鎖
  r = await call(env, "/admin/device", { method: "POST", body: { id: "tv-2", action: "authorize", value: "0" } });
  assert.equal((await call(env, "/api/config?id=tv-2")).json.authorized, true);
  r = await call(env, "/admin/device", { method: "POST", body: { id: "tv-2", action: "block" } });
  c = (await call(env, "/api/config?id=tv-2")).json;
  assert.equal(c.blocked, true);
  assert.equal(c.subscriptionUrl, "");
  await call(env, "/admin/device", { method: "POST", body: { id: "tv-2", action: "unblock" } });
  assert.equal((await call(env, "/api/config?id=tv-2")).json.blocked, false);
  // authorize_all
  await call(env, "/api/config?id=tv-5");
  r = await call(env, "/admin/device", { method: "POST", body: { action: "authorize_all", value: "0" } });
  assert.equal((await call(env, "/api/config?id=tv-5")).json.authorized, true);
  // 刪除未用碼
  r = await call(env, "/admin/codes", { method: "POST", body: { action: "delete_unused_all" } });
  assert.match(r.json.message, /1 組/);
  assert.equal(await env.CONFIG_KV.get("code:" + code2), null);
  // 限速：同 IP 31 次
  let last = null;
  for (let i = 0; i < 31; i++) last = await call(env, "/api/activate?id=tv-7&code=123456", { ip: "9.9.9.9" });
  assert.equal(last.status, 429);
  assert.equal((await call(env, "/api/activate?id=tv-7&code=123456", { ip: "8.8.8.8" })).status, 200, "別的 IP 不受影響");
});

await test("公告 / 跑馬燈到期過濾與立即停止", async () => {
  const env = makeEnv();
  await call(env, "/admin/save", { method: "POST", body: { _fields: "marquee", marquee: "今晚維護", marqueeMinutes: "30" } });
  let c = (await call(env, "/api/config")).json;
  assert.equal(c.marquee, "今晚維護");
  await call(env, "/admin/save", { method: "POST", body: { _fields: "notice", notice: "客服 0912", noticeHours: "0" } });
  c = (await call(env, "/api/config")).json;
  assert.equal(c.notice, "客服 0912");
  // 過期
  const cfg = await env.CONFIG_KV.get("config", { type: "json" });
  cfg.marqueeUntil = new Date(Date.now() - 1000).toISOString();
  await env.CONFIG_KV.put("config", JSON.stringify(cfg));
  assert.equal((await call(env, "/api/config")).json.marquee, "");
  await call(env, "/admin/save", { method: "POST", body: { _fields: "marquee", marquee: "again", marqueeMinutes: "5" } });
  assert.equal((await call(env, "/api/config")).json.marquee, "again");
  const r = await call(env, "/admin/system", { method: "POST", body: { action: "clear_marquee" } });
  assert.equal(r.json.ok, true);
  assert.equal((await call(env, "/api/config")).json.marquee, "");
  const r2 = await call(env, "/admin/system", { method: "POST", body: { action: "clear_notice" } });
  assert.equal(r2.json.ok, true);
  assert.equal((await call(env, "/api/config")).json.notice, "");
});

await test("QR 上傳 / 取圖 / 移除", async () => {
  const env = makeEnv();
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const fd = new FormData();
  fd.append("file", new Blob([png], { type: "image/png" }), "qr.png");
  let r = await call(env, "/admin/upload", { method: "POST", body: fd });
  assert.equal(r.json.ok, true, r.text);
  const c = (await call(env, "/api/config")).json;
  assert.match(c.contactQrUrl, /\/asset\/qr\?v=1$/);
  const img = await call(env, "/asset/qr");
  assert.equal(img.status, 200);
  assert.equal(img.ct, "image/png");
  r = await call(env, "/admin/upload", { method: "POST", body: { action: "remove" } });
  assert.equal(r.json.ok, true);
  assert.equal((await call(env, "/asset/qr")).status, 404);
  assert.equal((await call(env, "/api/config")).json.contactQrUrl, "");
});

await test("裝置：傳話 / 暱稱 / 自啟 / 刪除 / 清舊", async () => {
  const env = makeEnv();
  await call(env, "/api/config?id=tv-1&m=Box&v=1.0.0.24");
  let r = await call(env, "/admin/device", { method: "POST", body: { id: "tv-1", action: "message", value: "請重開機", level: "warn" } });
  assert.equal(r.json.ok, true);
  let c = (await call(env, "/api/config?id=tv-1")).json;
  assert.equal(c.message, "請重開機");
  assert.equal(c.messageLevel, "warn");
  await call(env, "/admin/device", { method: "POST", body: { id: "tv-1", action: "clearmsg" } });
  assert.equal((await call(env, "/api/config?id=tv-1")).json.message, "");
  await call(env, "/admin/device", { method: "POST", body: { id: "tv-1", action: "rename", value: "客廳" } });
  assert.equal((await call(env, "/api/config?id=tv-1")).json.deviceNick, "客廳");
  await call(env, "/admin/device", { method: "POST", body: { id: "tv-1", action: "autostart", value: "off" } });
  assert.equal((await call(env, "/api/config?id=tv-1")).json.autostart, false);
  await new Promise((r) => setTimeout(r, 5));   // 盒子之後在設定頁改開 → 最後改的贏
  await call(env, "/api/config?id=tv-1&as=1");
  assert.equal((await call(env, "/api/config?id=tv-1")).json.autostart, true);
  // 清 30 天未上線
  const old = { id: "tv-old", lastSeen: new Date(Date.now() - 40 * 86400000).toISOString(), firstSeen: "2026-01-01T00:00:00Z" };
  await env.CONFIG_KV.put("dev:tv-old", JSON.stringify(old));
  r = await call(env, "/admin/device", { method: "POST", body: { action: "delete_stale" } });
  assert.match(r.json.message, /1 台/);
  assert.equal(await env.CONFIG_KV.get("dev:tv-old"), null);
  r = await call(env, "/admin/device", { method: "POST", body: { id: "tv-1", action: "delete" } });
  assert.equal(r.json.ok, true);
  assert.equal(await env.CONFIG_KV.get("dev:tv-1"), null);
  r = await call(env, "/admin/device", { method: "POST", body: { id: "tv-x", action: "block" } });
  assert.equal(r.json.ok, false);
});

await test("局部刷新與匯出", async () => {
  const env = makeEnv();
  await call(env, "/api/config?id=tv-77&m=MiBox&v=1.0.0.24&now=%E6%B0%91%E8%A6%96");
  const p = await call(env, "/admin/partial?name=devices");
  assert.equal(p.status, 200);
  assert.match(p.text, /tv-77/);
  assert.match(p.text, /MiBox/);
  assert.match(p.text, /民視/);
  assert.equal(p.headers.get("x-config-version"), "1");
  for (const n of ["overview", "codes", "source", "auth", "notice", "system"]) {
    assert.equal((await call(env, "/admin/partial?name=" + n)).status, 200, n);
  }
  assert.equal((await call(env, "/admin/partial?name=zzz")).status, 404);
  const csv = await call(env, "/admin/export?what=devices");
  assert.equal(csv.status, 200);
  assert.match(csv.ct, /text\/csv/);
  assert.match(csv.text, /tv-77/);
  const csv2 = await call(env, "/admin/export?what=codes");
  assert.match(csv2.text, /啟動碼/);
});

await test("對時與健康檢查", async () => {
  const env = makeEnv();
  const t = (await call(env, "/api/time")).json;
  assert.ok(Math.abs(t.now - Date.now()) < 3000);
  const h = await call(env, "/api/health");
  assert.equal(h.status, 200);
  assert.equal(h.json.ok, true);
});

await test("HTML 跳脫：惡意暱稱不會注入", async () => {
  const env = makeEnv();
  await call(env, "/api/config?id=tv-1");
  await call(env, "/admin/device", { method: "POST", body: { id: "tv-1", action: "rename", value: '<img src=x onerror=alert(1)>' } });
  const p = await call(env, "/admin/partial?name=devices");
  assert.ok(!p.text.includes("<img src=x"), "應被跳脫");
  assert.ok(p.text.includes("&lt;img"));
});

await test("總覽顯示直播源伺服器看門狗狀態（status.json）", async () => {
  const env = makeEnv({ config: { version: 1, subscriptionUrl: "http://1.2.3.4:5050/channel?type=m3u&token=x" } });
  const realFetch = globalThis.fetch;
  let hit = 0;
  globalThis.fetch = async (url, init) => {
    if (unIp(url) === "http://1.2.3.4:5050/status.json?token=x") {
      hit++;
      return new Response(JSON.stringify({ healthy: false, consecutive_failures: 3, reason: "upstream", public_ip: "187.15.1.1", checked_at_ms: Date.now() - 60000, last_action: "restart_gluetun_hop", last_action_at: new Date(Date.now() - 30000).toISOString(), epg_updated: "2026-09-09 06:17:46 +08:00" }), { headers: { "Content-Type": "application/json" } });
    }
    return realFetch(url, init);
  };
  try {
    const p = await call(env, "/admin/partial?name=overview");
    assert.equal(hit, 1);
    assert.match(p.text, /直播源伺服器 <b>異常<\/b>/);
    assert.match(p.text, /187\.15\.1\.1/);
    assert.match(p.text, /更換出口節點/);
    // 健康 + 過期回報
    globalThis.fetch = async (url, init) => String(url).includes("/status.json")
      ? new Response(JSON.stringify({ healthy: true, consecutive_failures: 0, public_ip: "1.1.1.1", checked_at_ms: Date.now() - 2 * 3600000 }), { headers: { "Content-Type": "application/json" } })
      : realFetch(url, init);
    const p2 = await call(env, "/admin/partial?name=overview");
    assert.match(p2.text, /沒再回報/);
    // 沒有 status.json（第三方源）→ 不顯示、不出錯
    globalThis.fetch = async (url, init) => String(url).includes("/status.json") ? new Response("nf", { status: 404 }) : realFetch(url, init);
    const p3 = await call(env, "/admin/partial?name=overview");
    assert.ok(!p3.text.includes("直播源伺服器"));
  } finally {
    globalThis.fetch = realFetch;
  }
});

const TOK = "123456789:AAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
function tgMock(tg, statusFn, realFetch) {
  return async (url, init) => {
    const u = unIp(url);
    if (u.startsWith("https://api.telegram.org/bot")) {
      tg.push(JSON.parse(init.body).text);
      return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
    }
    if (u.includes("/status.json")) {
      const s = statusFn ? statusFn(u) : null;
      return s ? new Response(JSON.stringify(s), { headers: { "Content-Type": "application/json" } }) : new Response("nf", { status: 404 });
    }
    return realFetch(url, init);
  };
}

await test("/api/config 沒帶裝置編號不給直播源；管理員專用欄位（Telegram token）不外流", async () => {
  const env = makeEnv({ config: { version: 1, subscriptionUrl: "http://src/list.m3u", tgBotToken: TOK, tgChatId: "5", alertsEnabled: true } });
  const c = (await call(env, "/api/config")).json;
  assert.equal(c.subscriptionUrl, "");
  for (const k of ["tgBotToken", "tgChatId", "alertsEnabled", "alertSourceMin", "alertQuiet", "alertBoxFail"]) assert.ok(!(k in c), "不該外流 " + k);
  const c2 = (await call(env, "/api/config?id=tv-1")).json;
  assert.equal(c2.subscriptionUrl, "http://src/list.m3u");
  assert.ok(!("tgBotToken" in c2));
  const h = (await call(env, "/api/health")).json;
  assert.match(h.build, /^\d+\.\d+/);
});

await test("心跳回報播放健康（pe / le / up）→ 裝置卡與總覽顯示", async () => {
  const env = makeEnv({ config: { version: 1, subscriptionUrl: "http://src/list.m3u" } });
  await call(env, "/api/config?id=tv-1&m=Box&v=1.0.0.26&now=%E6%B0%91%E8%A6%96&pe=0&up=5");
  let dev = await env.CONFIG_KV.get("dev:tv-1", { type: "json" });
  assert.equal(dev.pe, 0);
  assert.equal(dev.up, 5);
  const w = env.CONFIG_KV.writes;
  await call(env, "/api/config?id=tv-1&m=Box&v=1.0.0.26&now=%E6%B0%91%E8%A6%96&pe=4&le=HTTP%20500&up=6");
  assert.equal(env.CONFIG_KV.writes, w + 1, "重連達 3 次要立刻寫");
  dev = await env.CONFIG_KV.get("dev:tv-1", { type: "json" });
  assert.equal(dev.pe, 4);
  assert.equal(dev.le, "HTTP 500");
  const p = await call(env, "/admin/partial?name=devices");
  assert.match(p.text, /重連 4 次/);
  assert.match(p.text, /HTTP 500/);
  const o = await call(env, "/admin/partial?name=overview");
  assert.match(o.text, /播放不穩/);
  assert.match(o.text, /head-card (yellow|red)/);
  // 恢復 → 正常
  await call(env, "/api/config?id=tv-1&m=Box&v=1.0.0.26&pe=0");
  dev = await env.CONFIG_KV.get("dev:tv-1", { type: "json" });
  assert.equal(dev.pe, 0);
  assert.equal(dev.le, "");
});

await test("管理密碼連錯 20 次 → 429；其他 IP 與未帶帳密不受影響", async () => {
  const env = makeEnv();
  const wrong = "Basic " + Buffer.from("a:wrong").toString("base64");
  let last = null;
  for (let i = 0; i < 21; i++) last = await call(env, "/admin", { auth: false, headers: { Authorization: wrong }, ip: "7.7.7.7" });
  assert.equal(last.status, 429);
  assert.equal((await call(env, "/admin", { auth: false, headers: { Authorization: wrong }, ip: "6.6.6.6" })).status, 401);
  assert.equal((await call(env, "/admin", { auth: false, ip: "7.7.7.7" })).status, 401, "瀏覽器第一次沒帶帳密不算猜錯");
  assert.equal((await call(env, "/admin", { ip: "5.5.5.5" })).status, 200);
  const j = await call(env, "/admin/partial?name=overview", { auth: false, headers: { Authorization: wrong, "X-Requested-With": "fetch" }, ip: "7.7.7.7" });
  assert.equal(j.status, 429);
  assert.equal(j.json.ok, false);
});

await test("警示設定：驗證 / 儲存 / token 留空不清除 / 測試發送（mock Telegram）/ 操作紀錄", async () => {
  const env = makeEnv({ config: { version: 1, subscriptionUrl: "http://src/list.m3u" } });
  const realFetch = globalThis.fetch;
  const tg = [];
  globalThis.fetch = tgMock(tg, null, realFetch);
  try {
    let r = await call(env, "/admin/save", { method: "POST", body: { _fields: "alerts", alertsEnabled: "on", tgBotToken: "bad", tgChatId: "5" } });
    assert.equal(r.json.ok, false, "token 格式錯要擋");
    r = await call(env, "/admin/save", { method: "POST", body: { _fields: "alerts", alertsEnabled: "on", tgBotToken: TOK, tgChatId: "abc" } });
    assert.equal(r.json.ok, false, "chat id 非數字要擋");
    r = await call(env, "/admin/save", { method: "POST", body: { _fields: "alerts", alertsEnabled: "on", tgBotToken: TOK, tgChatId: "123456", alertSourceMin: "3", alertDeviceOfflineMin: "10", alertQuiet: "23-7", alertBoxFail: "on" } });
    assert.equal(r.json.ok, true, r.text);
    let cfg = await env.CONFIG_KV.get("config", { type: "json" });
    assert.equal(cfg.tgBotToken, TOK);
    assert.equal(cfg.alertSourceMin, 5, "下限 5 分");
    assert.equal(cfg.alertDeviceOfflineMin, 30, "下限 30 分");
    assert.equal(cfg.alertQuiet, "23-7");
    r = await call(env, "/admin/save", { method: "POST", body: { _fields: "alerts", alertsEnabled: "on", tgBotToken: "", tgChatId: "123456", alertSourceMin: "10", alertDeviceOfflineMin: "180" } });
    assert.equal(r.json.ok, true);
    cfg = await env.CONFIG_KV.get("config", { type: "json" });
    assert.equal(cfg.tgBotToken, TOK, "留空維持原 token");
    assert.equal(cfg.alertQuiet, "");
    r = await call(env, "/admin/alerts", { method: "POST", body: { action: "test" } });
    assert.equal(r.json.ok, true, r.text);
    assert.equal(tg.length, 1);
    assert.match(tg[0], /測試訊息/);
    const p = await call(env, "/admin/partial?name=alerts");
    assert.equal(p.status, 200);
    assert.match(p.text, /已啟用/);
    assert.ok(!p.text.includes(TOK), "token 不得回填到畫面");
    const s = await call(env, "/admin/partial?name=system");
    assert.match(s.text, /儲存警示設定/);
    assert.match(s.text, /Telegram 測試訊息/);
    // 清 token → 開著警示會被擋
    r = await call(env, "/admin/save", { method: "POST", body: { _fields: "alerts", alertsEnabled: "on", clearTg: "on", tgChatId: "123456" } });
    assert.equal(r.json.ok, false);
    r = await call(env, "/admin/save", { method: "POST", body: { _fields: "alerts", clearTg: "on", tgChatId: "123456" } });
    assert.equal(r.json.ok, true);
    assert.equal((await env.CONFIG_KV.get("config", { type: "json" })).tgBotToken, "");
  } finally {
    globalThis.fetch = realFetch;
  }
});

await test("監控：直播源異常達門檻才通知、不重複；恢復通知含中斷時間；沒回報另一種訊息；歷史色條", async () => {
  const env = makeEnv({ config: { version: 1, subscriptionUrl: "http://1.2.3.4:5050/channel?type=m3u&token=x", alertsEnabled: true, tgBotToken: TOK, tgChatId: "99", alertSourceMin: 10 } });
  const realFetch = globalThis.fetch;
  const tg = [];
  let T = Date.parse("2026-09-10T04:00:00Z"); // 台灣 12:00
  let status = { healthy: true, consecutive_failures: 0, public_ip: "1.1.1.1" };
  globalThis.fetch = tgMock(tg, (u) => (u === "http://1.2.3.4:5050/status.json?token=x" ? { ...status, checked_at_ms: status.checked_at_ms || T - 30000 } : null), realFetch);
  const { runMonitorTick } = await import("../src/monitor.js");
  try {
    let r = await runMonitorTick(env, T);
    assert.equal(r.state, "ok");
    assert.equal(tg.length, 0);
    status = { healthy: false, consecutive_failures: 1, reason: "api_blocked", public_ip: "1.1.1.1", last_action: "hop_api_blocked" };
    T += 5 * 60000; r = await runMonitorTick(env, T);
    assert.equal(r.state, "bad");
    assert.equal(tg.length, 0, "剛壞不吵");
    T += 5 * 60000; status.consecutive_failures = 2; r = await runMonitorTick(env, T);
    assert.equal(tg.length, 0, "5 分鐘未達 10 分門檻");
    T += 5 * 60000; status.consecutive_failures = 3; r = await runMonitorTick(env, T);
    assert.equal(tg.length, 1, "達門檻發一次");
    assert.match(tg[0], /直播源異常/);
    assert.match(tg[0], /封鎖/);
    assert.match(tg[0], /1\.1\.1\.1/);
    T += 5 * 60000; r = await runMonitorTick(env, T);
    assert.equal(tg.length, 1, "持續異常不重複發");
    status = { healthy: true, consecutive_failures: 0, public_ip: "2.2.2.2", last_action: "hop_api_blocked" };
    T += 5 * 60000; r = await runMonitorTick(env, T);
    assert.equal(r.state, "ok");
    assert.equal(tg.length, 2);
    assert.match(tg[1], /已恢復/);
    assert.match(tg[1], /約 20 分鐘/);
    const st = await env.CONFIG_KV.get("mon:state", { type: "json" });
    assert.ok(st.hist.length >= 3, "歷史至少 3 段");
    assert.equal(st.log.length, 2);
    assert.equal(st.log[0].status, "sent");
    assert.equal(st.src.downSince, 0);
    const o = await call(env, "/admin/partial?name=overview");
    assert.match(o.text, /class="hist"/);
    assert.match(o.text, /可用率/);
    assert.match(o.text, /直播源恢復/);
    // 看門狗沒回報（status.json 3 小時沒更新）→ 10 分後通知
    status = { healthy: true, consecutive_failures: 0, public_ip: "2.2.2.2", checked_at_ms: T - 3 * 3600000 };
    T += 5 * 60000; r = await runMonitorTick(env, T);
    assert.equal(r.state, "stale");
    assert.equal(tg.length, 2);
    T += 10 * 60000; r = await runMonitorTick(env, T);
    assert.equal(tg.length, 3);
    assert.match(tg[2], /沒回報/);
    const a = await call(env, "/admin/partial?name=alerts");
    assert.match(a.text, /看門狗沒回報/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

await test("監控：重點盒子離線 / 回來、載入失敗每小時一則、未監控盒子不吵、靜音時段只記錄", async () => {
  const env = makeEnv({ config: { version: 1, subscriptionUrl: "http://src/x", alertsEnabled: true, tgBotToken: TOK, tgChatId: "1", alertDeviceOfflineMin: 60 } });
  const realFetch = globalThis.fetch;
  const tg = [];
  globalThis.fetch = tgMock(tg, null, realFetch);
  const { runMonitorTick } = await import("../src/monitor.js");
  try {
    let T = Date.parse("2026-09-10T04:00:00Z");
    await env.CONFIG_KV.put("dev:tv-a", JSON.stringify({ id: "tv-a", nick: "客廳", lastSeen: new Date(T - 2 * 3600000).toISOString(), watch: true, now: "民視" }));
    await env.CONFIG_KV.put("dev:tv-b", JSON.stringify({ id: "tv-b", lastSeen: new Date(T - 2 * 3600000).toISOString() }));
    await env.CONFIG_KV.put("dev:tv-c", JSON.stringify({ id: "tv-c", nick: "阿嬤房", lastSeen: new Date(T - 60000).toISOString(), lastOk: false, lastResultAt: new Date(T - 120000).toISOString() }));
    let r = await runMonitorTick(env, T);
    assert.equal(tg.length, 2, JSON.stringify(tg));
    assert.ok(tg.some((t) => /重點盒子離線/.test(t) && /客廳/.test(t)));
    assert.ok(tg.some((t) => /載入頻道失敗/.test(t) && /阿嬤房/.test(t)));
    assert.ok(!tg.some((t) => /tv-b/.test(t)), "未監控的盒子不通知");
    T += 5 * 60000; r = await runMonitorTick(env, T);
    assert.equal(tg.length, 2, "一小時內不重複");
    await env.CONFIG_KV.put("dev:tv-a", JSON.stringify({ id: "tv-a", nick: "客廳", lastSeen: new Date(T).toISOString(), watch: true, now: "中視" }));
    T += 5 * 60000; r = await runMonitorTick(env, T);
    assert.equal(tg.length, 3);
    assert.match(tg[2], /回來了/);
    // 裝置分頁可切換重點監控
    r = await call(env, "/admin/device", { method: "POST", body: { id: "tv-b", action: "watch", value: "on" } });
    assert.equal(r.json.ok, true);
    assert.equal((await env.CONFIG_KV.get("devadm:tv-b", { type: "json" })).watch, true);
    const d = await call(env, "/admin/partial?name=devices");
    assert.match(d.text, /重點監控/);
    // 靜音時段（台灣 12:00 落在 0-23）→ 不發只記錄
    r = await call(env, "/admin/save", { method: "POST", body: { _fields: "alerts", alertsEnabled: "on", tgChatId: "1", alertSourceMin: "10", alertDeviceOfflineMin: "60", alertQuiet: "0-23" } });
    assert.equal(r.json.ok, true, r.text);
    T += 5 * 60000; r = await runMonitorTick(env, T);   // tv-b 已離線 2 小時且剛設監控
    assert.equal(tg.length, 3, "靜音不發");
    const st = await env.CONFIG_KV.get("mon:state", { type: "json" });
    assert.equal(st.log[0].status, "muted");
    assert.match(st.log[0].text, /tv-b/);
    const a = await call(env, "/admin/partial?name=alerts");
    assert.match(a.text, /靜音時段未發/);
    assert.match(a.text, /重點監控的盒子/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

await test("設定版本歷史 → 還原；匯出 / 匯入設定 JSON；操作紀錄", async () => {
  const env = makeEnv({ config: { version: 1, subscriptionUrl: "http://a/1" } });
  await call(env, "/admin/save", { method: "POST", body: { _fields: "source", subscriptionUrl: "http://a/2" } });
  await call(env, "/admin/save", { method: "POST", body: { _fields: "source", subscriptionUrl: "http://a/3" } });
  const hist = await env.CONFIG_KV.get("cfghist", { type: "json" });
  assert.equal(hist.length, 2);
  assert.equal(hist[0].subscriptionUrl, "http://a/2");
  assert.equal(hist[1].subscriptionUrl, "http://a/1");
  const s = await call(env, "/admin/partial?name=system");
  assert.match(s.text, /還原成這版/);
  assert.match(s.text, /http:\/\/a\/2/);
  let r = await call(env, "/admin/system", { method: "POST", body: { action: "restore_config", idx: "1" } });
  assert.equal(r.json.ok, true, r.text);
  let c = (await call(env, "/api/config?id=tv-1")).json;
  assert.equal(c.subscriptionUrl, "http://a/1");
  assert.equal(c.version, 4);
  r = await call(env, "/admin/system", { method: "POST", body: { action: "restore_config", idx: "9" } });
  assert.equal(r.json.ok, false);
  const ex = await call(env, "/admin/export?what=config");
  assert.equal(ex.status, 200);
  assert.match(ex.ct, /json/);
  const exported = JSON.parse(ex.text);
  assert.equal(exported.subscriptionUrl, "http://a/1");
  exported.subscriptionUrl = "http://b/9";
  exported.notice = "匯入的公告";
  exported.bogus = 1;
  const fd = new FormData();
  fd.append("action", "import_config");
  fd.append("file", new Blob([JSON.stringify(exported)], { type: "application/json" }), "cfg.json");
  r = await call(env, "/admin/upload", { method: "POST", body: fd });
  assert.equal(r.json.ok, true, r.text);
  c = (await call(env, "/api/config?id=tv-1")).json;
  assert.equal(c.subscriptionUrl, "http://b/9");
  assert.equal(c.notice, "匯入的公告");
  assert.ok(!("bogus" in c));
  assert.equal(c.version, 5);
  const fd2 = new FormData();
  fd2.append("action", "import_config");
  fd2.append("file", new Blob(["not json"], { type: "application/json" }), "x.json");
  r = await call(env, "/admin/upload", { method: "POST", body: fd2 });
  assert.equal(r.json.ok, false);
  const audit = await env.CONFIG_KV.get("audit", { type: "json" });
  assert.ok(audit.length >= 4);
  assert.match(audit[0].what, /匯入設定/);
  assert.equal(audit[0].ip, "1.2.3.4");
  const s2 = await call(env, "/admin/partial?name=system");
  assert.match(s2.text, /匯入設定/);
  r = await call(env, "/admin/system", { method: "POST", body: { action: "clear_audit" } });
  assert.equal(r.json.ok, true);
});

await test("Cron scheduled 入口會執行監控並寫入狀態；靜音時段判定", async () => {
  const env = makeEnv({ config: { version: 1, subscriptionUrl: "http://src/x" } });
  const realFetch = globalThis.fetch;
  globalThis.fetch = tgMock([], null, realFetch);
  try {
    const tasks = [];
    await worker.scheduled({ cron: "*/5 * * * *", scheduledTime: Date.now() }, env, { waitUntil: (p) => tasks.push(p) });
    await Promise.all(tasks);
    const st = await env.CONFIG_KV.get("mon:state", { type: "json" });
    assert.ok(st && st.lastTick > 0);
    assert.equal(st.src.state, "none");
    const r = await call(env, "/admin/alerts", { method: "POST", body: { action: "run" } });
    assert.equal(r.json.ok, true);
    assert.match(r.json.message, /無看門狗資料/);
  } finally {
    globalThis.fetch = realFetch;
  }
  const { inQuietHours } = await import("../src/monitor.js");
  const at = (h) => Date.parse("2026-09-10T00:00:00Z") + ((h - 8 + 24) % 24) * 3600000; // 台灣 h 點
  assert.equal(inQuietHours("23-7", at(2)), true);
  assert.equal(inQuietHours("23-7", at(23)), true);
  assert.equal(inQuietHours("23-7", at(7)), false);
  assert.equal(inQuietHours("23-7", at(12)), false);
  assert.equal(inQuietHours("9-18", at(12)), true);
  assert.equal(inQuietHours("", at(12)), false);
  assert.equal(inQuietHours("abc", at(12)), false);
});

await test("2.2：舊版單一 dev: 紀錄自動搬家到 devadm:，授權不中斷；心跳不再蓋掉管理員欄位", async () => {
  const env = makeEnv({
    config: { version: 9, subscriptionUrl: "http://src/list.m3u", requireActivation: true },
    "dev:tv-old": { id: "tv-old", nick: "客廳", m: "Box", v: "1.0.0.25", ip: "1.1.1.1", firstSeen: "2026-09-01T00:00:00Z", lastSeen: "2026-09-10T00:00:00Z", count: 5, blocked: false, msg: "", msgLevel: "info", authorized: true, expireAt: "", watch: true, cmd: { id: "c1", type: "reload", arg: "", at: new Date().toISOString() } },
  });
  const c = (await call(env, "/api/config?id=tv-old&m=Box&v=1.0.0.26")).json;
  assert.equal(c.authorized, true, "舊資料的授權要沿用");
  assert.equal(c.subscriptionUrl, "http://src/list.m3u");
  assert.equal(c.deviceNick, "客廳");
  assert.equal(c.cmd && c.cmd.id, "c1", "舊資料裡的待送指令要保留");
  const adm = await env.CONFIG_KV.get("devadm:tv-old", { type: "json" });
  assert.equal(adm.authorized, true);
  assert.equal(adm.watch, true);
  const dev = await env.CONFIG_KV.get("dev:tv-old", { type: "json" });
  assert.ok(!("authorized" in dev) && !("cmd" in dev) && !("nick" in dev), "盒子紀錄不再帶管理員欄位");
  // 管理員在心跳之間改暱稱 → 下一次心跳（會寫 dev:）不會把暱稱蓋掉
  await call(env, "/admin/device", { method: "POST", body: { id: "tv-old", action: "rename", value: "阿嬤房" } });
  const d2 = await env.CONFIG_KV.get("dev:tv-old", { type: "json" });
  d2.lastWrite = new Date(Date.now() - 11 * 60000).toISOString();
  await env.CONFIG_KV.put("dev:tv-old", JSON.stringify(d2));
  const c2 = (await call(env, "/api/config?id=tv-old&m=Box&v=1.0.0.26&now=%E4%B8%AD%E8%A6%96")).json;
  assert.equal(c2.deviceNick, "阿嬤房");
  const p = await call(env, "/admin/partial?name=devices");
  assert.match(p.text, /阿嬤房/);
  assert.match(p.text, /中視/);
  assert.equal(env.CONFIG_KV.lists, 1, "裝置分頁只 list 一次");
});

await test("2.2：KV 故障時 /api/config 回 503（盒子沿用快取），不會回未授權把人鎖在外", async () => {
  const env = makeEnv({ config: { version: 1, subscriptionUrl: "http://src/x", requireActivation: true } });
  await call(env, "/api/config?id=tv-1");
  await call(env, "/admin/device", { method: "POST", body: { id: "tv-1", action: "authorize", value: "0" } });
  env.CONFIG_KV.failNext(1);
  let r = await call(env, "/api/config?id=tv-1");
  assert.equal(r.status, 503);
  assert.equal(r.headers.get("retry-after"), "60");
  assert.equal(r.json.ok, false);
  r = await call(env, "/api/config?id=tv-1");
  assert.equal(r.status, 200);
  assert.equal(r.json.authorized, true);
  // 伺服器內部錯誤對 fetch 呼叫回 JSON，不是純文字（管理頁局部刷新在 KV 全掛時）
  const brokenEnv = { CONFIG_KV: null, ADMIN_PASSWORD: PASS };
  const j = await call(brokenEnv, "/admin/partial?name=overview", { headers: { "X-Requested-With": "fetch" } });
  assert.equal(j.status, 500);
  assert.equal(j.json && j.json.ok, false);
  const t = await call(brokenEnv, "/admin");
  assert.equal(t.status, 500);
  assert.match(t.ct, /text\/plain/);
});

await test("2.2：撤銷授權連帶作廢啟動碼；autostart 管理員設定優先於盒子回報；cmd_all tune 驗證台號", async () => {
  const env = makeEnv({ config: { version: 1, subscriptionUrl: "http://src/x", requireActivation: true, codeDigits: 6 } });
  await call(env, "/api/config?id=tv-1&m=B&v=1");
  const g = await call(env, "/admin/codes", { method: "POST", body: { action: "gen_batch", count: "1", days: "0" } });
  const code = g.json.codes[0];
  assert.equal((await call(env, "/api/activate?id=tv-1&code=" + code)).json.ok, true);
  assert.equal((await call(env, "/api/config?id=tv-1")).json.authorized, true);
  let r = await call(env, "/admin/device", { method: "POST", body: { id: "tv-1", action: "deauthorize" } });
  assert.equal(r.json.ok, true);
  assert.match(r.json.message, /作廢/);
  assert.equal((await call(env, "/api/config?id=tv-1")).json.authorized, false);
  assert.equal((await call(env, "/api/activate?id=tv-1&code=" + code)).json.ok, false, "同一組碼不能再拿回授權");
  assert.equal((await env.CONFIG_KV.get("code:" + code, { type: "json" })).status, "revoked");
  // autostart：盒子回報 as=0，管理員沒設 → 跟盒子；之後管理員設開 → 以管理員為準；盒子之後又在設定頁改關 → 最後改的贏
  await call(env, "/api/config?id=tv-1&as=0");
  assert.equal((await call(env, "/api/config?id=tv-1")).json.autostart, false);
  await new Promise((r) => setTimeout(r, 5));
  await call(env, "/admin/device", { method: "POST", body: { id: "tv-1", action: "autostart", value: "on" } });
  assert.equal((await call(env, "/api/config?id=tv-1")).json.autostart, true, "管理員最後改 → 開");
  await new Promise((r) => setTimeout(r, 5));
  await call(env, "/api/config?id=tv-1&as=0");
  assert.equal((await call(env, "/api/config?id=tv-1")).json.autostart, false, "盒子之後在設定頁改關 → 關（最後改的贏）");
  r = await call(env, "/admin/device", { method: "POST", body: { action: "cmd_all", value: "tune", arg: "abc" } });
  assert.equal(r.json.ok, false);
  r = await call(env, "/admin/device", { method: "POST", body: { action: "cmd_all", value: "tune", arg: "7" } });
  assert.equal(r.json.ok, true);
  // 啟動碼位數下限 6
  await call(env, "/admin/save", { method: "POST", body: { _fields: "auth", requireActivation: "on", codeDigits: "4" } });
  assert.equal((await env.CONFIG_KV.get("config", { type: "json" })).codeDigits, 6);
});

await test("2.2：新裝置登記限速與 7 天壽命；HEAD 視同 GET；CSV 防公式注入；QR 只收真圖", async () => {
  const env = makeEnv({ config: { version: 1, subscriptionUrl: "http://src/x" } });
  for (let i = 0; i < 12; i++) await call(env, "/api/config?id=spam-" + i, { ip: "3.3.3.3" });
  const listed = await env.CONFIG_KV.list({ prefix: "dev:" });
  assert.equal(listed.keys.length, 10, "同 IP 每小時最多 10 台新裝置");
  assert.ok(env.CONFIG_KV.exp.has("dev:spam-1"), "未授權新裝置有 7 天壽命");
  await call(env, "/admin/device", { method: "POST", body: { id: "spam-1", action: "authorize", value: "0" } });
  assert.ok(!env.CONFIG_KV.exp.has("dev:spam-1"), "授權後改永久");
  const h = await call(env, "/api/health", { method: "HEAD" });
  assert.equal(h.status, 200);
  await call(env, "/api/config?id=tv-csv&m=%3DHYPERLINK(%22x%22)&v=1", { ip: "4.4.4.4" });
  const csv = await call(env, "/admin/export?what=devices");
  assert.ok(csv.text.includes(`"'=HYPERLINK`), "公式字元前置單引號");
  const fd = new FormData();
  fd.append("file", new Blob(["<svg onload=alert(1)></svg>"], { type: "image/svg+xml" }), "x.svg");
  const up = await call(env, "/admin/upload", { method: "POST", body: fd });
  assert.equal(up.json.ok, false, "SVG 不收");
  const fd2 = new FormData();
  fd2.append("file", new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0])], { type: "application/octet-stream" }), "photo.bin");
  const up2 = await call(env, "/admin/upload", { method: "POST", body: fd2 });
  assert.equal(up2.json.ok, true, "看檔頭不看 MIME：JPEG 收");
  const img = await call(env, "/asset/qr");
  assert.equal(img.ct, "image/jpeg");
  assert.match(img.headers.get("content-security-policy") || "", /sandbox/);
});

await test("2.2：公告 / 跑馬燈只改文字時留空維持原到期", async () => {
  const env = makeEnv();
  await call(env, "/admin/save", { method: "POST", body: { _fields: "notice", notice: "客服 0912", noticeHours: "24" } });
  const until1 = (await env.CONFIG_KV.get("config", { type: "json" })).noticeUntil;
  assert.ok(until1);
  await call(env, "/admin/save", { method: "POST", body: { _fields: "notice", notice: "客服 0912-345", noticeHours: "" } });
  assert.equal((await env.CONFIG_KV.get("config", { type: "json" })).noticeUntil, until1, "留空維持原到期");
  await call(env, "/admin/save", { method: "POST", body: { _fields: "notice", notice: "客服 0912-345", noticeHours: "0" } });
  assert.equal((await env.CONFIG_KV.get("config", { type: "json" })).noticeUntil, "", "填 0 = 常駐");
  await call(env, "/admin/save", { method: "POST", body: { _fields: "marquee", marquee: "維護", marqueeMinutes: "30" } });
  const m1 = (await env.CONFIG_KV.get("config", { type: "json" })).marqueeUntil;
  await call(env, "/admin/save", { method: "POST", body: { _fields: "marquee", marquee: "維護中", marqueeMinutes: "" } });
  assert.equal((await env.CONFIG_KV.get("config", { type: "json" })).marqueeUntil, m1);
  const p = await call(env, "/admin/partial?name=notice");
  assert.match(p.text, /維持原到期/);
});

/* ───────────────────────── 2.3：備援線路 / 家用備援 / ln / 看門狗新代碼 ───────────────────────── */

const lib = await import("../src/lib.js");
const monitor = await import("../src/monitor.js");
const MAIN = "http://1.2.3.4:5050/channel?type=m3u&token=MAINTOKEN0001";
const BACKUP = "http://5.6.7.8:5050/channel?type=m3u&token=BACKUPTOKEN99";
const HOME_KEY = "TestHomeKey_0123456789abcdefABCDEF";
const HP_BODY = { lanUrl: "http://192.168.31.100:5050", version: "2.3.0", channels: 118, healthy: true };

/** 家用代理登記（JSON 本文；key 選用）。注意：同一 IP 每分鐘最多 6 次，各測試用不同 IP */
function homeReg(env, body, opts) {
  opts = opts || {};
  const headers = { "Content-Type": "application/json" };
  if (opts.key) headers["X-Home-Key"] = opts.key;
  return call(env, "/api/home-proxy", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), headers, ip: opts.ip });
}

/** 在 ip 這個家放一台盒子（心跳一次）；authorize !== false 時再由管理員授權 */
async function homeBox(env, id, ip, authorize) {
  await call(env, `/api/config?id=${id}&m=Box&v=1.0.0.30`, { ip });
  if (authorize !== false) await call(env, "/admin/device", { method: "POST", body: { id, action: "authorize", value: "0" } });
}

/** 依主機回 status.json：函式回物件 = 看門狗 JSON、null = 404、數字 = 該 HTTP 狀態、"throw" = 連線失敗；Telegram 一併 mock */
function statusMock(tg, byHost, realFetch) {
  return async (url, init) => {
    const u = unIp(url);
    if (u.startsWith("https://api.telegram.org/bot")) {
      tg.push(JSON.parse(init.body).text);
      return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
    }
    const m = /^https?:\/\/([^/]+)\/status\.json/.exec(u);
    if (m) {
      const f = byHost[m[1]];
      const s = f ? f(u) : null;
      if (s === "throw") throw new TypeError("fetch failed");
      if (typeof s === "number") return new Response("err", { status: s });
      return s ? new Response(JSON.stringify(s), { headers: { "Content-Type": "application/json" } }) : new Response("nf", { status: 404 });
    }
    return realFetch(url, init);
  };
}

await test("2.4：/api/health 回報 build 2.4.1", async () => {
  const h = (await call(makeEnv(), "/api/health")).json;
  assert.equal(h.build, "2.4.1");
});

await test("2.3：備援直播源 — 驗證、儲存、下發條件、舊表單不清掉、操作紀錄與歷史遮罩 token、直播源分頁兩顆測試鈕", async () => {
  const env = makeEnv({ config: { version: 1, subscriptionUrl: MAIN } });
  let r = await call(env, "/admin/save", { method: "POST", body: { _fields: "source", subscriptionUrl: MAIN, backupSubscriptionUrl: "ftp://x" } });
  assert.equal(r.status, 400);
  assert.match(r.json.message, /備援訂閱網址格式不正確/);
  r = await call(env, "/admin/save", { method: "POST", body: { _fields: "source", subscriptionUrl: MAIN, backupSubscriptionUrl: MAIN } });
  assert.equal(r.json.ok, false, "跟主線路一樣要擋");
  r = await call(env, "/admin/save", { method: "POST", body: { _fields: "source", subscriptionUrl: MAIN, backupSubscriptionUrl: "http://b/" + "x".repeat(2000) } });
  assert.equal(r.json.ok, false);
  assert.match(r.json.message, /太長/);
  assert.equal((await env.CONFIG_KV.get("config", { type: "json" })).version, 1, "被擋的不存");
  r = await call(env, "/admin/save", { method: "POST", body: { _fields: "source", subscriptionUrl: MAIN, backupSubscriptionUrl: "  " + BACKUP + "  " } });
  assert.equal(r.json.ok, true, r.text);
  assert.ok(r.json.refresh.includes("home"));
  assert.equal((await env.CONFIG_KV.get("config", { type: "json" })).backupSubscriptionUrl, BACKUP, "前後空白去掉");
  let c = (await call(env, "/api/config?id=tv-1", { ip: "70.0.0.1" })).json;
  assert.equal(c.subscriptionUrl, MAIN);
  assert.equal(c.backupSubscriptionUrl, BACKUP);
  assert.equal(c.homeProxy, "");
  assert.equal((await call(env, "/api/config")).json.backupSubscriptionUrl, "", "沒帶 id 不給");
  await call(env, "/admin/device", { method: "POST", body: { id: "tv-1", action: "block" } });
  assert.equal((await call(env, "/api/config?id=tv-1", { ip: "70.0.0.1" })).json.backupSubscriptionUrl, "", "封鎖不給");
  await call(env, "/admin/save", { method: "POST", body: { _fields: "auth", requireActivation: "on", codeDigits: "8" } });
  c = (await call(env, "/api/config?id=tv-2", { ip: "70.0.0.2" })).json;
  assert.equal(c.authorized, false);
  assert.equal(c.backupSubscriptionUrl, "", "未授權不給");
  // 舊版管理頁的表單沒有備援欄位 → 維持原值
  r = await call(env, "/admin/save", { method: "POST", body: { _fields: "source", subscriptionUrl: MAIN + "2" } });
  assert.equal(r.json.ok, true);
  assert.equal((await env.CONFIG_KV.get("config", { type: "json" })).backupSubscriptionUrl, BACKUP);
  let audit = await env.CONFIG_KV.get("audit", { type: "json" });
  const setAudit = audit.find((a) => /；備援 /.test(a.what));
  assert.ok(setAudit, JSON.stringify(audit));
  assert.ok(!setAudit.what.includes("BACKUPTOKEN99"), "操作紀錄不可有完整 token");
  assert.match(setAudit.what, /token=BACK…EN99/);
  // 清空 = 停用備援
  r = await call(env, "/admin/save", { method: "POST", body: { _fields: "source", subscriptionUrl: MAIN, backupSubscriptionUrl: "" } });
  assert.equal(r.json.ok, true);
  assert.equal((await env.CONFIG_KV.get("config", { type: "json" })).backupSubscriptionUrl, "");
  audit = await env.CONFIG_KV.get("audit", { type: "json" });
  assert.match(audit[0].what, /備援已移除/);
  const s = await call(env, "/admin/partial?name=system");
  assert.match(s.text, /備援 http:\/\/5\.6\.7\.8:5050/, "版本歷史列出備援網址（遮罩）");
  assert.ok(!s.text.includes("BACKUPTOKEN99"));
  const src = await call(env, "/admin/partial?name=source");
  assert.match(src.text, /id="backupSubscriptionUrl"/);
  assert.match(src.text, /testSource\('backup'\)/);
  assert.match(src.text, /id="testResultBackup"/);
  assert.match(src.text, /同名頻道合併多線路/);
});

await test("2.3：匯出 / 匯入 / 還原 — 備援網址驗證；家用金鑰格式對才套用；還原舊版不換金鑰", async () => {
  const env = makeEnv({ config: { version: 1, subscriptionUrl: MAIN, backupSubscriptionUrl: BACKUP, homeProxyKey: HOME_KEY } });
  const ex = JSON.parse((await call(env, "/admin/export?what=config")).text);
  assert.equal(ex.backupSubscriptionUrl, BACKUP);
  const imp = (obj) => {
    const fd = new FormData();
    fd.append("action", "import_config");
    fd.append("file", new Blob([JSON.stringify(obj)], { type: "application/json" }), "cfg.json");
    return call(env, "/admin/upload", { method: "POST", body: fd });
  };
  let r = await imp({ ...ex, backupSubscriptionUrl: "javascript:alert(1)" });
  assert.equal(r.json.ok, false);
  assert.match(r.json.message, /匯入的備援訂閱網址格式不正確/);
  r = await imp({ ...ex, backupSubscriptionUrl: "http://c/9", homeProxyKey: "短", homeProxyRole: "weird" });
  assert.equal(r.json.ok, true, r.text);
  let cfg = await env.CONFIG_KV.get("config", { type: "json" });
  assert.equal(cfg.backupSubscriptionUrl, "http://c/9");
  assert.equal(cfg.homeProxyKey, HOME_KEY, "格式不對的金鑰不套用");
  assert.equal(cfg.homeProxyRole, "backup", "不認得的角色回預設");
  const newKey = lib.genHomeKey();
  r = await imp({ ...ex, homeProxyKey: newKey, homeProxyRole: "primary" });
  assert.equal(r.json.ok, true);
  cfg = await env.CONFIG_KV.get("config", { type: "json" });
  assert.equal(cfg.homeProxyKey, newKey, "搬家可沿用舊金鑰");
  assert.equal(cfg.homeProxyRole, "primary");
  r = await call(env, "/admin/system", { method: "POST", body: { action: "restore_config", idx: "1" } });
  assert.equal(r.json.ok, true, r.text);
  cfg = await env.CONFIG_KV.get("config", { type: "json" });
  assert.equal(cfg.backupSubscriptionUrl, BACKUP, "還原成 v1 的備援網址");
  assert.equal(cfg.homeProxyRole, "backup");
  assert.equal(cfg.homeProxyKey, newKey, "金鑰是憑證，還原不換");
});

await test("2.3：監控兩條線路 — 主壞備好較不緊急、備援也壞升級成一則緊急；恢復分開通知；備援自己壞是低優先；舊 mon:state 相容", async () => {
  const env = makeEnv({
    config: { version: 1, subscriptionUrl: MAIN, backupSubscriptionUrl: BACKUP, alertsEnabled: true, tgBotToken: TOK, tgChatId: "9", alertSourceMin: 10 },
    // 2.2 版寫的 mon:state（沒有 bsrc）
    "mon:state": { v: 1, lastTick: 1, lastWrite: 1, src: { state: "ok", since: 1, downSince: 0, alerted: false, ip: "1.1.1.1", reason: "", fails: 0, lastAction: "" }, dev: {}, hist: [], log: [] },
  });
  const realFetch = globalThis.fetch;
  const tg = [];
  let T = Date.parse("2026-09-10T04:00:00Z");
  let main = { healthy: true, consecutive_failures: 0, public_ip: "1.1.1.1" };
  let bk = { healthy: true, consecutive_failures: 0, public_ip: "2.2.2.2" };
  globalThis.fetch = statusMock(tg, {
    "1.2.3.4:5050": () => ({ ...main, checked_at_ms: T - 30000 }),
    "5.6.7.8:5050": () => (typeof bk === "object" ? { ...bk, checked_at_ms: T - 30000 } : bk),
  }, realFetch);
  try {
    let r = await monitor.runMonitorTick(env, T);
    assert.equal(r.state, "ok");
    assert.equal(r.bstate, "ok");
    assert.equal(r.st.bsrc.state, "ok", "舊資料補上備援線路狀態機");
    main = { healthy: false, consecutive_failures: 2, reason: "vpn", public_ip: "1.1.1.1", last_action: "restart_4gtv_reconnect" };
    T += 5 * 60000; await monitor.runMonitorTick(env, T);
    T += 5 * 60000; await monitor.runMonitorTick(env, T);
    T += 5 * 60000; r = await monitor.runMonitorTick(env, T);
    assert.equal(tg.length, 1, JSON.stringify(tg));
    assert.equal(r.events[0].kind, "src_down_bk");
    assert.match(tg[0], /主線路異常/);
    assert.match(tg[0], /較不緊急/);
    assert.match(tg[0], /盒子會自動改用備援線路/);
    assert.match(tg[0], /VPN 重連，清快取重啟/);
    bk = { healthy: false, consecutive_failures: 3, reason: "auth", public_ip: "2.2.2.2" };
    T += 5 * 60000; await monitor.runMonitorTick(env, T);
    assert.equal(tg.length, 1, "備援剛壞不吵");
    T += 5 * 60000; await monitor.runMonitorTick(env, T);
    T += 5 * 60000; r = await monitor.runMonitorTick(env, T);
    assert.equal(tg.length, 2, JSON.stringify(tg));
    assert.equal(r.events[0].kind, "both_down");
    assert.match(tg[1], /主線路與備援線路都異常/);
    assert.match(tg[1], /緊急/);
    assert.match(tg[1], /NordVPN 帳密錯誤/);
    T += 5 * 60000; await monitor.runMonitorTick(env, T);
    assert.equal(tg.length, 2, "持續都壞不重複");
    main = { healthy: true, consecutive_failures: 0, public_ip: "1.1.1.1" };
    T += 5 * 60000; await monitor.runMonitorTick(env, T);
    assert.equal(tg.length, 3, "主線路恢復一則；備援已在緊急通知裡講過，不另發異常");
    assert.match(tg[2], /直播源已恢復/);
    bk = { healthy: true, consecutive_failures: 0, public_ip: "2.2.2.2" };
    T += 5 * 60000; await monitor.runMonitorTick(env, T);
    assert.equal(tg.length, 4);
    assert.match(tg[3], /備援線路已恢復/);
    bk = 500;
    T += 5 * 60000; await monitor.runMonitorTick(env, T);
    T += 10 * 60000; r = await monitor.runMonitorTick(env, T);
    assert.equal(r.bstate, "stale", "5xx = 連不上主機");
    assert.equal(tg.length, 5, JSON.stringify(tg));
    assert.equal(r.events[0].kind, "bsrc_down");
    assert.match(tg[4], /備援線路異常/);
    assert.match(tg[4], /不影響觀看/);
    assert.match(tg[4], /連不上主機（HTTP 500）/);
    const a = await call(env, "/admin/partial?name=alerts");
    assert.match(a.text, /主備線路都異常/);
    assert.match(a.text, /主線路異常（有備援）/);
    const cfg = await env.CONFIG_KV.get("config", { type: "json" });
    await env.CONFIG_KV.put("config", JSON.stringify({ ...cfg, backupSubscriptionUrl: "" }));
    T += 5 * 60000; r = await monitor.runMonitorTick(env, T);
    assert.equal(r.bstate, "off");
    assert.equal(r.st.bsrc.state, "off", "拿掉備援線路 → 狀態歸零");
    assert.equal(r.st.bsrc.alerted, false);
  } finally {
    globalThis.fetch = realFetch;
  }
});

await test("2.3：監控 — 兩條同時壞只發一則緊急；看門狗主機連不上算「沒回報」（不再當第三方源默不作聲）", async () => {
  const env = makeEnv({ config: { version: 1, subscriptionUrl: MAIN, backupSubscriptionUrl: BACKUP, alertsEnabled: true, tgBotToken: TOK, tgChatId: "9", alertSourceMin: 10 } });
  const realFetch = globalThis.fetch;
  const tg = [];
  let T = Date.parse("2026-09-11T04:00:00Z");
  globalThis.fetch = statusMock(tg, {
    "1.2.3.4:5050": () => "throw",
    "5.6.7.8:5050": () => ({ healthy: false, consecutive_failures: 4, reason: "web_key", public_ip: "2.2.2.2", checked_at_ms: T - 30000 }),
  }, realFetch);
  try {
    let r = await monitor.runMonitorTick(env, T);
    assert.equal(r.state, "stale", "連不上主機 = 沒回報");
    assert.equal(r.bstate, "bad");
    T += 5 * 60000; await monitor.runMonitorTick(env, T);
    T += 5 * 60000; r = await monitor.runMonitorTick(env, T);
    assert.equal(tg.length, 1, JSON.stringify(tg));
    assert.equal(r.events.length, 1);
    assert.equal(r.events[0].kind, "both_down");
    assert.match(tg[0], /連不上主機（連線失敗）/);
    assert.match(tg[0], /keystream/);
    T += 5 * 60000; await monitor.runMonitorTick(env, T);
    assert.equal(tg.length, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
  // 沒設備援、VPS 整台連不上 → 以前被當成「第三方源」不通知，現在會發「沒回報」
  const env2 = makeEnv({ config: { version: 1, subscriptionUrl: MAIN, alertsEnabled: true, tgBotToken: TOK, tgChatId: "9", alertSourceMin: 10 } });
  const tg2 = [];
  globalThis.fetch = statusMock(tg2, { "1.2.3.4:5050": () => 502 }, realFetch);
  try {
    T = Date.parse("2026-09-11T08:00:00Z");
    await monitor.runMonitorTick(env2, T);
    T += 10 * 60000; await monitor.runMonitorTick(env2, T);
    assert.equal(tg2.length, 1, JSON.stringify(tg2));
    assert.match(tg2[0], /沒回報/);
    assert.match(tg2[0], /連不上主機：HTTP 502/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

await test("2.3：監控 — 主線路壞、沒設備援但家用備援在線 → 較不緊急，並說明其他地點仍受影響", async () => {
  const env = makeEnv({ config: { version: 1, subscriptionUrl: MAIN, alertsEnabled: true, tgBotToken: TOK, tgChatId: "9", alertSourceMin: 10 } });
  const realFetch = globalThis.fetch;
  const tg = [];
  let T = Date.parse("2026-09-12T04:00:00Z");
  await env.CONFIG_KV.put("homeproxy", JSON.stringify({ lanUrl: "http://192.168.31.100:5050", publicIp: "61.9.9.9", version: "2.3.0", channels: 118, healthy: true, lastSeen: new Date(T).toISOString(), via: "box", boxId: "tv-h" }));
  globalThis.fetch = statusMock(tg, { "1.2.3.4:5050": () => ({ healthy: false, consecutive_failures: 3, reason: "upstream", checked_at_ms: T - 30000 }) }, realFetch);
  try {
    await monitor.runMonitorTick(env, T);
    T += 10 * 60000;
    const r = await monitor.runMonitorTick(env, T);
    assert.equal(tg.length, 1, JSON.stringify(tg));
    assert.equal(r.events[0].kind, "src_down_bk");
    assert.match(tg[0], /家用備援在線/);
    assert.match(tg[0], /其他地點的盒子仍會受影響/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

await test("2.3：看門狗新處置代碼與原因白話；status.json 的 self_heal → 「代理自動修復 N 次」", async () => {
  assert.equal(lib.actionText("restart_4gtv_reconnect"), "VPN 重連，清快取重啟");
  assert.equal(lib.actionText("renew_nord_credentials"), "Nord 憑證失效，已自動換新");
  for (const k of ["auth", "web_key", "vpn", "stale", "api_blocked", "nginx", "upstream"]) {
    assert.ok(monitor.REASON_TEXT[k], "缺原因 " + k);
    assert.equal(monitor.reasonText(k), monitor.REASON_TEXT[k]);
  }
  assert.match(monitor.selfHealText({ self_heal: { forced_reresolves: 3, session_resets: 2 } }), /^代理自動修復 5 次/);
  assert.equal(monitor.selfHealText({ healthy: true }), "");
  assert.equal(monitor.selfHealText({ self_heal: { other: 1 } }), "");
  const env = makeEnv({ config: { version: 1, subscriptionUrl: MAIN } });
  const realFetch = globalThis.fetch;
  let withHeal = true;
  globalThis.fetch = statusMock([], {
    "1.2.3.4:5050": () => ({ healthy: true, consecutive_failures: 0, public_ip: "1.1.1.1", checked_at_ms: Date.now() - 60000, last_action: "renew_nord_credentials", ...(withHeal ? { self_heal: { forced_reresolves: 3, session_resets: 2 } } : {}) }),
  }, realFetch);
  try {
    let o = await call(env, "/admin/partial?name=overview");
    assert.match(o.text, /代理自動修復 5 次/);
    assert.match(o.text, /Nord 憑證失效，已自動換新/);
    withHeal = false;
    o = await call(env, "/admin/partial?name=overview");
    assert.ok(!o.text.includes("代理自動修復"), "沒有 self_heal 就不顯示");
  } finally {
    globalThis.fetch = realFetch;
  }
});

await test("2.3：心跳 ln（目前線路）— 存進 dev:、切換才寫且有節流；裝置卡 / 總覽 / 測試來源顯示", async () => {
  const env = makeEnv({ config: { version: 1, subscriptionUrl: MAIN } });
  const kv = env.CONFIG_KV;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes("/status.json")) return new Response("nf", { status: 404 });
    if (u.startsWith("http://bk.test/")) return new Response("#EXTM3U\n#EXTINF:-1 group-title=\"新聞\",民視\nhttp://x/1.m3u8\n");
    return realFetch(url, init);
  };
  try {
    const q = "/api/config?id=tv-ln&m=Box&v=1.0.0.30&now=%E6%B0%91%E8%A6%96";
    await call(env, q + "&ln=0", { ip: "70.1.1.1" });
    assert.equal((await kv.get("dev:tv-ln", { type: "json" })).ln, 0);
    let w = kv.writes;
    await call(env, q + "&ln=0", { ip: "70.1.1.1" });
    assert.equal(kv.writes, w, "沒換線路不寫");
    await call(env, q + "&ln=1", { ip: "70.1.1.1" });
    assert.equal(kv.writes, w + 1, "切到備援立刻寫");
    let dev = await kv.get("dev:tv-ln", { type: "json" });
    assert.equal(dev.ln, 1);
    assert.ok(dev.lnAt);
    w = kv.writes;
    await call(env, q + "&ln=0", { ip: "70.1.1.1" });
    await call(env, q + "&ln=1", { ip: "70.1.1.1" });
    await call(env, q + "&ln=0", { ip: "70.1.1.1" });
    assert.equal(kv.writes, w, "10 分鐘內來回切照 3 分鐘節流，不會每次都寫");
    dev = await kv.get("dev:tv-ln", { type: "json" });
    dev.lastWrite = new Date(Date.now() - 4 * 60000).toISOString();
    await kv.put("dev:tv-ln", JSON.stringify(dev));
    w = kv.writes;
    await call(env, q + "&ln=0", { ip: "70.1.1.1" });
    assert.equal(kv.writes, w + 1, "距上次寫入超過 3 分鐘的切換會寫");
    assert.equal((await kv.get("dev:tv-ln", { type: "json" })).ln, 0);
    await call(env, "/api/config?id=tv-bk&m=Box&v=1.0.0.30&now=%E4%B8%AD%E8%A6%96&ln=1", { ip: "70.1.1.2" });
    assert.equal((await kv.get("dev:tv-bk", { type: "json" })).ln, 1);
    const p = await call(env, "/admin/partial?name=devices");
    assert.match(p.text, /備援線路中/);
    assert.match(p.text, /data-backup="1"/);
    assert.match(p.text, /<span class="fv ok">主線路<\/span>/);
    assert.match(p.text, /走備援線路（1）/);
    const o = await call(env, "/admin/partial?name=overview");
    assert.match(o.text, /class="ph bk"/);
    assert.match(o.text, /1 台盒子還在走備援線路/);
    const t = await call(env, "/admin/test", { method: "POST", body: { subscriptionUrl: "http://bk.test/list.m3u" } });
    assert.equal(t.json.ok, true, t.text);
    assert.equal(t.json.channelCount, 1);
    assert.equal(t.json.boxes.onBackup, 1, "測試來源附上目前走備援的盒子數");
  } finally {
    globalThis.fetch = realFetch;
  }
});

await test("2.3：家用代理登記（帶金鑰）— 錯金鑰 401 並計入防暴力、錯太多次 429；沒產生金鑰 401；lanUrl 只收私有 IPv4", async () => {
  const good = {
    "http://192.168.31.100:5050": "http://192.168.31.100:5050",
    "http://10.0.0.5": "http://10.0.0.5",
    "http://172.16.0.1:8080/": "http://172.16.0.1:8080",
    "http://172.31.255.254:5050": "http://172.31.255.254:5050",
    " http://192.168.001.002:5050 ": "http://192.168.1.2:5050",
  };
  for (const [u, want] of Object.entries(good)) assert.equal(lib.parseLanUrl(u), want, u);
  for (const u of ["http://8.8.8.8:5050", "http://172.32.0.1", "http://172.15.0.1", "http://169.254.1.1", "http://127.0.0.1:5050", "https://192.168.1.2:5050",
    "http://nas.local:5050", "http://192.168.1.2:5050/playlist.m3u", "http://192.168.1.256", "http://192.168.1.2:0", "http://192.168.1.2:70000", "http://user@192.168.1.2", "", null, 123]) {
    assert.equal(lib.parseLanUrl(u), "", "應拒絕 " + u);
  }
  const env = makeEnv({ config: { version: 1, subscriptionUrl: MAIN, homeProxyKey: HOME_KEY } });
  const kv = env.CONFIG_KV;
  let w = kv.writes;
  let r = await homeReg(env, HP_BODY, { key: "wrong-key-wrong-key-wrong", ip: "80.0.0.1" });
  assert.equal(r.status, 401);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.reason, "bad_key");
  assert.equal(kv.writes, w + 1, "錯金鑰計入限速（rl:hpkey）");
  assert.equal(await kv.get("rl:hpkey:80.0.0.1"), "1");
  assert.equal(await kv.get("homeproxy"), null);
  await kv.put("rl:hpkey:80.0.0.2", "20");
  r = await homeReg(env, HP_BODY, { key: "wrong-key-wrong-key-wrong", ip: "80.0.0.2" });
  assert.equal(r.status, 429);
  assert.equal(r.json.reason, "key_locked");
  assert.equal(r.headers.get("retry-after"), "600");
  assert.equal(await kv.get("rl:adm:80.0.0.2"), null, "跟管理密碼限速分開計數");
  r = await homeReg(env, HP_BODY, { key: HOME_KEY, ip: "80.0.0.3" });
  assert.equal(r.status, 200, r.text);
  assert.ok(Date.parse(r.json.lastSeen) > 0);
  assert.deepEqual({ ...r.json, lastSeen: "" }, { ok: true, stored: true, via: "key", role: "backup", publicIp: "80.0.0.3", playlist: "http://192.168.31.100:5050/playlist.m3u", lastSeen: "" });
  const rec = await kv.get("homeproxy", { type: "json" });
  assert.equal(rec.lanUrl, "http://192.168.31.100:5050");
  assert.equal(rec.publicIp, "80.0.0.3");
  assert.equal(rec.version, "2.3.0");
  assert.equal(rec.channels, 118);
  assert.equal(rec.healthy, true);
  assert.equal(rec.via, "key");
  r = await homeReg(env, "not json", { key: HOME_KEY, ip: "80.0.0.3" });
  assert.equal(r.status, 400);
  assert.equal(r.json.reason, "bad_body");
  for (const lanUrl of ["http://8.8.8.8:5050", "https://192.168.1.2:5050", "http://nas.local:5050"]) {
    r = await homeReg(env, { ...HP_BODY, lanUrl }, { key: HOME_KEY, ip: "80.0.0.4" });
    assert.equal(r.status, 400, lanUrl);
    assert.equal(r.json.reason, "bad_lan_url");
  }
  assert.equal((await kv.get("homeproxy", { type: "json" })).lanUrl, "http://192.168.31.100:5050", "被拒的不會蓋掉紀錄");
  // 管理中心沒有金鑰、請求卻帶了 → 401（沒東西可猜，不寫 KV）
  const env2 = makeEnv({ config: { version: 1, subscriptionUrl: MAIN } });
  const w2 = env2.CONFIG_KV.writes;
  r = await homeReg(env2, HP_BODY, { key: HOME_KEY, ip: "80.0.0.5" });
  assert.equal(r.status, 401);
  assert.equal(r.json.reason, "no_key_configured");
  assert.equal(env2.CONFIG_KV.writes, w2);
});

await test("2.3：家用代理登記（免金鑰）— 同 IP 有已授權盒子 → 200；沒有 → 403；未授權 / 封鎖 / 到期 / 超過 24 小時不算；403 不寫 KV", async () => {
  let env = makeEnv({ config: { version: 1, subscriptionUrl: MAIN } });
  let w = env.CONFIG_KV.writes;
  let r = await homeReg(env, HP_BODY, { ip: "81.0.0.1" });
  assert.equal(r.status, 403);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.reason, "no_home_box");
  assert.equal(r.json.publicIp, "81.0.0.1");
  assert.match(r.json.error, /24 小時內沒有已授權的盒子/);
  assert.equal(env.CONFIG_KV.writes, w, "403 不寫 KV");

  env = makeEnv({ config: { version: 1, subscriptionUrl: MAIN } });
  await homeBox(env, "tv-h1", "81.0.0.2");
  r = await homeReg(env, HP_BODY, { ip: "81.0.0.2" });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.via, "box");
  assert.equal(r.json.stored, true);
  const rec = await env.CONFIG_KV.get("homeproxy", { type: "json" });
  assert.equal(rec.publicIp, "81.0.0.2");
  assert.equal(rec.via, "box");
  assert.equal(rec.boxId, "tv-h1");
  const lists = env.CONFIG_KV.lists;
  r = await homeReg(env, { ...HP_BODY, channels: 117 }, { ip: "81.0.0.2" });
  assert.equal(r.status, 200);
  assert.equal(env.CONFIG_KV.lists, lists, "平常用上次擔保的盒子驗證，不列舉裝置");
  await call(env, "/admin/device", { method: "POST", body: { id: "tv-h1", action: "block" } });
  w = env.CONFIG_KV.writes;
  r = await homeReg(env, HP_BODY, { ip: "81.0.0.2" });
  assert.equal(r.status, 403, "盒子被封鎖就不算數（立即生效）");
  assert.equal(r.json.reason, "no_home_box");
  assert.equal(env.CONFIG_KV.writes, w);
  r = await homeReg(env, HP_BODY, { ip: "81.0.0.99" });
  assert.equal(r.status, 403, "外人（別的公網 IP）登記不了");

  env = makeEnv({ config: { version: 1, subscriptionUrl: MAIN } });
  await homeBox(env, "tv-h2", "81.0.0.3", false);
  r = await homeReg(env, HP_BODY, { ip: "81.0.0.3" });
  assert.equal(r.status, 403, "只心跳、沒授權的盒子不能擔保（授權機制關著也一樣）");

  env = makeEnv({ config: { version: 1, subscriptionUrl: MAIN } });
  await homeBox(env, "tv-h3", "81.0.0.4");
  const adm = await env.CONFIG_KV.get("devadm:tv-h3", { type: "json" });
  await env.CONFIG_KV.put("devadm:tv-h3", JSON.stringify({ ...adm, expireAt: new Date(Date.now() - 60000).toISOString() }));
  r = await homeReg(env, HP_BODY, { ip: "81.0.0.4" });
  assert.equal(r.status, 403, "授權到期的盒子不能擔保");

  env = makeEnv({ config: { version: 1, subscriptionUrl: MAIN } });
  await homeBox(env, "tv-h4", "81.0.0.5");
  const d4 = await env.CONFIG_KV.get("dev:tv-h4", { type: "json" });
  await env.CONFIG_KV.put("dev:tv-h4", JSON.stringify({ ...d4, lastSeen: new Date(Date.now() - 25 * 3600000).toISOString() }));
  r = await homeReg(env, HP_BODY, { ip: "81.0.0.5" });
  assert.equal(r.status, 403, "超過 24 小時沒心跳不算");
});

await test("2.3：家用代理登記（免金鑰）— 監控整理已授權盒子 IP（不必 list）；另一個家正在用 → 403、帶金鑰可接手；那邊沒動靜後自動接手", async () => {
  const env = makeEnv({ config: { version: 1, subscriptionUrl: "http://src/x", homeProxyKey: HOME_KEY } });
  const realFetch = globalThis.fetch;
  globalThis.fetch = tgMock([], null, realFetch);
  try {
    await homeBox(env, "tv-a", "82.0.0.1");
    await homeBox(env, "tv-b", "82.0.0.2");
    await homeBox(env, "tv-c", "82.0.0.3", false);
    await monitor.runMonitorTick(env, Date.now());
    const st = await env.CONFIG_KV.get("mon:state", { type: "json" });
    assert.deepEqual(st.homeIps, [["82.0.0.1", "tv-a"], ["82.0.0.2", "tv-b"]], "只收已授權盒子");
    const lists = env.CONFIG_KV.lists;
    let r = await homeReg(env, HP_BODY, { ip: "82.0.0.1" });
    assert.equal(r.status, 200, r.text);
    assert.equal(env.CONFIG_KV.lists, lists, "有監控整理的清單就不 list");
    r = await homeReg(env, { ...HP_BODY, lanUrl: "http://192.168.1.50:5050" }, { ip: "82.0.0.2" });
    assert.equal(r.status, 403);
    assert.equal(r.json.reason, "other_home_active");
    assert.equal((await env.CONFIG_KV.get("homeproxy", { type: "json" })).publicIp, "82.0.0.1", "沒被蓋掉");
    r = await homeReg(env, { ...HP_BODY, lanUrl: "http://192.168.1.50:5050" }, { ip: "82.0.0.2", key: HOME_KEY });
    assert.equal(r.status, 200, "帶金鑰 = 管理員明確要換");
    assert.equal((await env.CONFIG_KV.get("homeproxy", { type: "json" })).publicIp, "82.0.0.2");
    r = await homeReg(env, HP_BODY, { ip: "82.0.0.1" });
    assert.equal(r.json.reason, "other_home_active", "新家的盒子還在線 → 舊家搶不回來");
    const db = await env.CONFIG_KV.get("dev:tv-b", { type: "json" });
    await env.CONFIG_KV.put("dev:tv-b", JSON.stringify({ ...db, lastSeen: new Date(Date.now() - 20 * 60000).toISOString() }));
    r = await homeReg(env, HP_BODY, { ip: "82.0.0.1" });
    assert.equal(r.status, 200, r.text);
    assert.equal((await env.CONFIG_KV.get("homeproxy", { type: "json" })).publicIp, "82.0.0.1", "那邊沒動靜 → 自動接手");
  } finally {
    globalThis.fetch = realFetch;
  }
});

await test("2.3：家用代理登記 — 內容沒變 30 分鐘內不寫 KV；同一 IP 每分鐘超過 6 次 → 429 且不碰 KV", async () => {
  const env = makeEnv({ config: { version: 1, subscriptionUrl: MAIN, homeProxyKey: HOME_KEY } });
  const kv = env.CONFIG_KV;
  let r = await homeReg(env, HP_BODY, { key: HOME_KEY, ip: "83.0.0.1" });
  assert.equal(r.json.stored, true);
  let w = kv.writes;
  r = await homeReg(env, HP_BODY, { key: HOME_KEY, ip: "83.0.0.1" });
  assert.equal(r.status, 200);
  assert.equal(r.json.stored, false);
  assert.equal(kv.writes, w, "內容沒變不寫");
  r = await homeReg(env, { ...HP_BODY, channels: 90 }, { key: HOME_KEY, ip: "83.0.0.1" });
  assert.equal(r.json.stored, true, "頻道數變了就寫");
  assert.equal(kv.writes, w + 1);
  const rec = await kv.get("homeproxy", { type: "json" });
  await kv.put("homeproxy", JSON.stringify({ ...rec, lastSeen: new Date(Date.now() - 31 * 60000).toISOString() }));
  r = await homeReg(env, { ...HP_BODY, channels: 90 }, { key: HOME_KEY, ip: "83.0.0.1" });
  assert.equal(r.json.stored, true, "超過 30 分鐘照寫（更新最後回報時間）");
  let last = null;
  for (let i = 0; i < 6; i++) {
    last = await homeReg(env, HP_BODY, { key: HOME_KEY, ip: "83.0.0.2" });
    assert.equal(last.status, 200, "第 " + (i + 1) + " 次");
  }
  w = kv.writes;
  const reads = kv.reads;
  last = await homeReg(env, HP_BODY, { key: HOME_KEY, ip: "83.0.0.2" });
  assert.equal(last.status, 429);
  assert.equal(last.json.reason, "rate_limited");
  assert.equal(last.headers.get("retry-after"), "60");
  assert.equal(kv.writes, w, "被擋的請求不寫 KV");
  assert.equal(kv.reads, reads, "也不讀 KV");
  assert.equal((await homeReg(env, HP_BODY, { key: HOME_KEY, ip: "83.0.0.3" })).status, 200, "別的 IP 不受影響");
});

await test("2.3：/api/config 下發家用備援 — 只給同一個家（IPv4 相同 / IPv6 同 /64）、手動備援優先、角色優先時主備對調、異常或超過 2 小時不下發", async () => {
  const env = makeEnv({ config: { version: 1, subscriptionUrl: MAIN } });
  const kv = env.CONFIG_KV;
  const HOME_PL = "http://192.168.31.100:5050/playlist.m3u";
  const putHp = (o) => kv.put("homeproxy", JSON.stringify({ lanUrl: "http://192.168.31.100:5050", publicIp: "84.0.0.1", version: "2.3.0", channels: 118, healthy: true, lastSeen: new Date().toISOString(), via: "box", boxId: "tv-x", ...(o || {}) }));
  const cfgOf = async (id, ip) => (await call(env, "/api/config?id=" + id, { ip })).json;
  await putHp();
  let c = await cfgOf("tv-home", "84.0.0.1");
  assert.equal(c.subscriptionUrl, MAIN);
  assert.equal(c.backupSubscriptionUrl, HOME_PL);
  assert.equal(c.homeProxy, "backup");
  c = await cfgOf("tv-away", "84.0.0.2");
  assert.equal(c.backupSubscriptionUrl, "", "別的地點拿不到區網網址");
  assert.equal(c.homeProxy, "");
  const cfg = await kv.get("config", { type: "json" });
  await kv.put("config", JSON.stringify({ ...cfg, backupSubscriptionUrl: BACKUP }));
  c = await cfgOf("tv-home", "84.0.0.1");
  assert.equal(c.backupSubscriptionUrl, BACKUP, "手動備援優先");
  assert.equal(c.homeProxy, "");
  let r = await call(env, "/admin/save", { method: "POST", body: { _fields: "home", homeProxyRole: "bogus" } });
  assert.equal(r.json.ok, false);
  r = await call(env, "/admin/save", { method: "POST", body: { _fields: "home", homeProxyRole: "primary" } });
  assert.equal(r.json.ok, true, r.text);
  assert.ok(r.json.refresh.includes("home"));
  assert.match((await kv.get("audit", { type: "json" }))[0].what, /家用備援角色/);
  c = await cfgOf("tv-home", "84.0.0.1");
  assert.equal(c.subscriptionUrl, HOME_PL, "優先：同一個家的盒子以家用清單為主");
  assert.equal(c.backupSubscriptionUrl, MAIN);
  assert.equal(c.homeProxy, "primary");
  c = await cfgOf("tv-away", "84.0.0.2");
  assert.equal(c.subscriptionUrl, MAIN);
  assert.equal(c.backupSubscriptionUrl, BACKUP);
  await putHp({ healthy: false });
  c = await cfgOf("tv-home", "84.0.0.1");
  assert.equal(c.subscriptionUrl, MAIN, "代理自報異常不下發");
  assert.equal(c.homeProxy, "");
  await putHp({ lastSeen: new Date(Date.now() - 3 * 3600000).toISOString() });
  assert.equal((await cfgOf("tv-home", "84.0.0.1")).homeProxy, "", "超過 2 小時沒登記不下發");
  await putHp({ publicIp: "2001:db8:1:2::1" });
  assert.equal((await cfgOf("tv-v6", "2001:db8:1:2:abcd::5")).homeProxy, "primary", "IPv6 同一個 /64");
  assert.equal((await cfgOf("tv-v6b", "2001:db8:1:3::5")).homeProxy, "");
  assert.equal(lib.sameHomeIp("::ffff:84.0.0.1", "84.0.0.1"), true);
  assert.equal(lib.sameHomeIp("84.0.0.1", "2001:db8::1"), false);
  await call(env, "/admin/device", { method: "POST", body: { id: "tv-v6", action: "block" } });
  c = await cfgOf("tv-v6", "2001:db8:1:2:abcd::5");
  assert.equal(c.subscriptionUrl, "");
  assert.equal(c.backupSubscriptionUrl, "");
  assert.equal(c.homeProxy, "");
  for (const k of ["homeProxyKey", "homeProxyRole"]) assert.ok(!(k in c), "不該外流 " + k);
});

await test("2.3：家用備援金鑰 — 開卡片自動產生、只出現在管理頁、盒子端點不外流；重新產生要確認並記錄、舊金鑰立即失效", async () => {
  const env = makeEnv({ config: { version: 1, subscriptionUrl: MAIN } });
  const kv = env.CONFIG_KV;
  const realFetch = globalThis.fetch;
  globalThis.fetch = statusMock([], {}, realFetch);
  try {
    let p = await call(env, "/admin/partial?name=home");
    assert.equal(p.status, 200);
    let cfg = await kv.get("config", { type: "json" });
    const key1 = cfg.homeProxyKey;
    assert.equal(key1.length, 40);
    assert.ok(lib.isValidHomeKey(key1));
    assert.equal(cfg.version, 1, "自動產生金鑰不升版本（盒子不必重載）");
    assert.match((await kv.get("audit", { type: "json" }))[0].what, /自動產生家用備援金鑰/);
    assert.ok(p.text.includes(`value="${key1}"`), "金鑰放在密碼欄");
    assert.ok(!p.text.includes(`data-copy="${key1}"`), "複製提示不回顯金鑰");
    assert.match(p.text, /換新電腦執行安裝指令就會自動登記，不用改這裡/);
    assert.match(p.text, /尚未登記/);
    assert.match(p.text, /data-confirm="重新產生後舊金鑰立即失效/);
    await call(env, "/admin/partial?name=home");
    assert.equal((await kv.get("config", { type: "json" })).homeProxyKey, key1, "不會每次重產");
    const page = await call(env, "/admin");
    assert.match(page.text, /data-part="home"/);
    for (const path of ["/api/config", "/api/config?id=tv-1", "/api/update", "/api/health"]) {
      const t = (await call(env, path)).text;
      assert.ok(!t.includes(key1), path + " 外流金鑰");
      assert.ok(!t.includes("homeProxyKey"), path);
    }
    const r = await call(env, "/admin/system", { method: "POST", body: { action: "regen_home_key" } });
    assert.equal(r.json.ok, true, r.text);
    assert.ok(r.json.refresh.includes("home"));
    cfg = await kv.get("config", { type: "json" });
    assert.notEqual(cfg.homeProxyKey, key1);
    assert.ok(lib.isValidHomeKey(cfg.homeProxyKey));
    assert.equal(cfg.version, 1, "盒子看不到金鑰 → 不升版本，免得盒子以為設定變了");
    assert.equal(await kv.get("cfghist"), null, "也不進設定歷史");
    const audit = await kv.get("audit", { type: "json" });
    assert.match(audit[0].what, /重新產生家用備援金鑰/);
    assert.ok(!audit.some((a) => a.what.includes(key1) || a.what.includes(cfg.homeProxyKey)), "操作紀錄不含金鑰");
    assert.equal((await homeReg(env, HP_BODY, { key: key1, ip: "85.0.0.1" })).status, 401, "舊金鑰立即失效");
    assert.equal((await homeReg(env, HP_BODY, { key: cfg.homeProxyKey, ip: "85.0.0.1" })).status, 200);
    p = await call(env, "/admin/partial?name=home");
    assert.match(p.text, /badge good-b">在線/);
    assert.match(p.text, /192\.168\.31\.100:5050/);
    assert.match(p.text, /85\.0\.0\.1/);
    const s = await call(env, "/admin/partial?name=system");
    assert.match(s.text, /重新產生家用備援金鑰/, "操作紀錄只記事件");
    assert.ok(!s.text.includes(key1));
  } finally {
    globalThis.fetch = realFetch;
  }
});

await test("2.3：總覽 — 主 / 備援線路分開顯示與分級（主壞備好黃燈、兩條都壞紅燈、備援連不上黃燈）；家用備援一行", async () => {
  const env = makeEnv({ config: { version: 1, subscriptionUrl: MAIN, backupSubscriptionUrl: BACKUP } });
  const realFetch = globalThis.fetch;
  let main = { healthy: false, consecutive_failures: 3, reason: "api_blocked", public_ip: "1.1.1.1" };
  let bk = { healthy: true, consecutive_failures: 0, public_ip: "2.2.2.2" };
  globalThis.fetch = statusMock([], {
    "1.2.3.4:5050": () => ({ ...main, checked_at_ms: Date.now() - 60000 }),
    "5.6.7.8:5050": () => (typeof bk === "object" ? { ...bk, checked_at_ms: Date.now() - 60000 } : bk),
  }, realFetch);
  try {
    let o = await call(env, "/admin/partial?name=overview");
    assert.match(o.text, /head-card yellow/);
    assert.match(o.text, /主線路異常（4gtv 封鎖/);
    assert.match(o.text, /盒子已自動改用備援線路/);
    assert.match(o.text, /直播源伺服器（主線路） <b>異常<\/b>/);
    assert.match(o.text, /備援線路 <b>正常<\/b>/);
    assert.match(o.text, /備援訂閱網址/);
    assert.ok(!o.text.includes("BACKUPTOKEN99"), "總覽只顯示遮罩後的備援網址");
    bk = { healthy: false, consecutive_failures: 2, reason: "vpn", public_ip: "2.2.2.2" };
    o = await call(env, "/admin/partial?name=overview");
    assert.match(o.text, /head-card red/);
    assert.match(o.text, /主線路與備援線路都異常/);
    main = { healthy: true, consecutive_failures: 0, public_ip: "1.1.1.1" };
    bk = "throw";
    o = await call(env, "/admin/partial?name=overview");
    assert.match(o.text, /head-card yellow/);
    assert.match(o.text, /備援線路異常（連不上主機）/);
    assert.match(o.text, /備援線路 <b>連不上<\/b>/);
    const T = Date.now();
    const hp = { lanUrl: "http://192.168.31.100:5050", publicIp: "86.0.0.1", version: "2.3.0", channels: 118, healthy: true, lastSeen: new Date(T).toISOString(), via: "box", boxId: "tv-h" };
    await env.CONFIG_KV.put("homeproxy", JSON.stringify(hp));
    o = await call(env, "/admin/partial?name=overview");
    assert.match(o.text, /家用備援在線（118 台頻道/);
    assert.match(o.text, /目前用手動備援、不下發/);
    await env.CONFIG_KV.put("homeproxy", JSON.stringify({ ...hp, lastSeen: new Date(T - 2 * 3600000).toISOString() }));
    o = await call(env, "/admin/partial?name=overview");
    assert.match(o.text, /家用備援離線（最後紀錄 2 小時前）/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

await test("2.3：總覽 / 裝置 — 沒設備援、主線路壞：家用備援顧得到全部線上盒子 → 黃燈，有盒子在別處 → 紅燈；裝置卡標出家用代理線路", async () => {
  const env = makeEnv({ config: { version: 1, subscriptionUrl: MAIN } });
  const realFetch = globalThis.fetch;
  globalThis.fetch = statusMock([], { "1.2.3.4:5050": () => ({ healthy: false, consecutive_failures: 3, reason: "stale", public_ip: "1.1.1.1", checked_at_ms: Date.now() - 60000 }) }, realFetch);
  try {
    await env.CONFIG_KV.put("homeproxy", JSON.stringify({ lanUrl: "http://192.168.31.100:5050", publicIp: "87.0.0.1", version: "2.3.0", channels: 118, healthy: true, lastSeen: new Date().toISOString(), via: "box", boxId: "tv-h" }));
    await call(env, "/api/config?id=tv-h&m=Box&v=1.0.0.30&ln=1", { ip: "87.0.0.1" });
    let o = await call(env, "/admin/partial?name=overview");
    assert.match(o.text, /head-card yellow/);
    assert.match(o.text, /同一個家的盒子有家用備援撐著/);
    assert.match(o.text, /家用備援在線（118 台頻道，同一個家 1 台盒子線上）/);
    assert.match(o.text, /1 台走備援線路/);
    await call(env, "/api/config?id=tv-away&m=Box&v=1.0.0.30", { ip: "87.0.0.9" });
    o = await call(env, "/admin/partial?name=overview");
    assert.match(o.text, /head-card red/);
    assert.match(o.text, /家用備援只顧得到同一個家的 1 台，其他 1 台受影響/);
    const d = await call(env, "/admin/partial?name=devices");
    assert.match(d.text, /備援線路（家用代理）/);
    assert.match(d.text, /未回報（舊版 App）/);
  } finally {
    globalThis.fetch = realFetch;
  }
});


/* ---------------------------------------------------------------
 *  2.4：雲端實測（測活）——Worker 不能直連 IP、照盒子的走法真的播一台
 * --------------------------------------------------------------- */

const SEG = new Uint8Array(70000).fill(0x47);
/**
 * 模擬整條播放鏈：清單 → 頻道 m3u8 → 切片。opts：
 *   seg: 切片 HTTP 狀態（預設 200）；m3u8: 頻道 m3u8 HTTP 狀態（預設 200）；variant: m3u8 是多畫質主清單
 *   status: status.json 內容（物件 / null = 404）；seen: 收集實際連過的網址（原樣，不還原）
 */
function chainMock(tg, opts, realFetch) {
  opts = opts || {};
  return async (url, init) => {
    const raw = String(url);
    if (opts.seen) opts.seen.push(raw);
    const u = unIp(raw);
    if (u.startsWith("https://api.telegram.org/bot")) {
      tg.push(JSON.parse(init.body).text);
      return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
    }
    if (/^http:\/\/\d+\.\d+\.\d+\.\d+(:\d+)?\//.test(raw)) return new Response("error code: 1003", { status: 403 });   // Cloudflare：不准直連 IP
    if (u.includes("/status.json")) {
      const s = typeof opts.status === "function" ? opts.status() : opts.status;
      return s ? new Response(JSON.stringify(s), { headers: { "Content-Type": "application/json" } }) : new Response("nf", { status: 404 });
    }
    if (u.includes("/channel?type=m3u")) {
      return new Response('#EXTM3U x-tvg-url="http://1.2.3.4:5050/epg.xml.gz"\n#EXTINF:-1 tvg-id="4gtv-4gtv040" group-title="新聞",中視\nhttp://1.2.3.4:5050/?id=4gtv-4gtv040&token=T\n#EXTINF:-1 tvg-id="4gtv-4gtv003" group-title="綜合",民視第一台\nhttp://1.2.3.4:5050/?id=4gtv-4gtv003&token=T\n');
    }
    if (u.includes("/?id=4gtv-4gtv003")) {
      const st = typeof opts.m3u8 === "function" ? opts.m3u8() : opts.m3u8 || 200;
      if (st !== 200) return new Response("Failed to get final m3u8 content", { status: st });
      if (opts.variant) return new Response("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2000000\nhttp://1.2.3.4:5050/sub.m3u8?token=T\n");
      return new Response("#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\nhttp://1.2.3.4:5050/ts/a1.ts\n#EXTINF:10,\nhttp://1.2.3.4:5050/ts/a2.ts\n");
    }
    if (u.includes("/sub.m3u8")) return new Response("#EXTM3U\n#EXTINF:10,\n/ts/v1.ts\n");
    if (u.includes("/ts/")) {
      const st = typeof opts.seg === "function" ? opts.seg() : opts.seg || 200;
      return st === 200 ? new Response(SEG) : new Response("upstream ts error", { status: st });
    }
    if (u.includes("192.168.")) throw new TypeError("private network not reachable");
    return realFetch(url, init);
  };
}

await test("2.4：probe — IP 網址改 sslip.io / nip.io、區網與網域不動；挑台優先民視第一台", async () => {
  const pr = await import("../src/probe.js");
  assert.equal(pr.workerFetchUrl("http://161.33.196.222:5050/channel?type=m3u&token=x"), "http://161-33-196-222.sslip.io:5050/channel?type=m3u&token=x");
  assert.equal(pr.workerFetchUrl("http://161.33.196.222:5050/a", true), "http://161.33.196.222.nip.io:5050/a");
  assert.equal(pr.workerFetchUrl("https://tv.example.com/a"), "https://tv.example.com/a");
  assert.equal(pr.workerFetchUrl("http://192.168.31.73:9010/playlist.m3u"), "http://192.168.31.73:9010/playlist.m3u");
  for (const u of ["http://192.168.1.2:9010/x", "http://10.0.0.5/x", "http://172.20.0.1/x", "http://127.0.0.1:9010/x", "http://nas.local/x"]) assert.equal(pr.isLanUrl(u), true, u);
  for (const u of ["http://161.33.196.222:5050/x", "https://tv.example.com/x", "http://172.32.0.1/x", "nope"]) assert.equal(pr.isLanUrl(u), false, u);
  const ch = pr.pickProbeChannel("#EXTM3U\n#EXTINF:-1,中視\nhttp://h/1\n#EXTINF:-1,民視第一台\n/rel?id=3\n", "http://h:5050/channel?type=m3u");
  assert.deepEqual(ch, { name: "民視第一台", url: "http://h:5050/rel?id=3", total: 2 });
  assert.equal(pr.pickProbeChannel("#EXTM3U\n#EXTINF:-1,Only\nhttp://h/1\n", "http://h/").name, "Only");
  assert.equal(pr.pickProbeChannel("#EXTM3U\n", "http://h/"), null);
});

await test("2.4：/admin/test 抓清單之外真的播一台（IP 改連 sslip.io）；切片壞了 → 清單正常但播不出來", async () => {
  const env = makeEnv({ config: { version: 1, subscriptionUrl: MAIN } });
  const realFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = chainMock([], { seen }, realFetch);
  try {
    let r = await call(env, "/admin/test", { method: "POST", body: { subscriptionUrl: MAIN } });
    assert.equal(r.json.ok, true, r.text);
    assert.equal(r.json.httpStatus, 200);
    assert.equal(r.json.channelCount, 2);
    assert.equal(r.json.channel, "民視第一台");
    assert.equal(r.json.stream.ok, true, JSON.stringify(r.json.stream));
    assert.equal(r.json.stream.ts, true);
    assert.ok(r.json.stream.bytes >= 16384);
    assert.ok(seen.length >= 3 && seen.every((u) => !/^http:\/\/\d+\.\d+\.\d+\.\d+[:/]/.test(u)), "全部改連網域，不直連 IP：" + seen.join(" "));
    assert.ok(seen.some((u) => u.includes("1-2-3-4.sslip.io:5050/ts/a2.ts")), "抓最新一片切片");
    // 切片 502
    globalThis.fetch = chainMock([], { seg: 502 }, realFetch);
    r = await call(env, "/admin/test", { method: "POST", body: { subscriptionUrl: MAIN } });
    assert.equal(r.json.httpOk, true);
    assert.equal(r.json.stream.ok, false);
    assert.equal(r.json.stream.step, "segment");
    assert.match(r.json.stream.error, /切片回 HTTP 502/);
    // 頻道 m3u8 500
    globalThis.fetch = chainMock([], { m3u8: 500 }, realFetch);
    r = await call(env, "/admin/test", { method: "POST", body: { subscriptionUrl: MAIN } });
    assert.equal(r.json.stream.ok, false);
    assert.match(r.json.stream.error, /頻道播放清單回 HTTP 500/);
    // 多畫質主清單 → 抓子清單、相對路徑切片
    globalThis.fetch = chainMock([], { variant: true }, realFetch);
    r = await call(env, "/admin/test", { method: "POST", body: { subscriptionUrl: MAIN } });
    assert.equal(r.json.stream.ok, true, JSON.stringify(r.json.stream));
  } finally {
    globalThis.fetch = realFetch;
  }
});

await test("2.4：probe — 頻道網址轉址後，相對切片網址以轉址後的清單網址為基準（跟播放器一樣）", async () => {
  const pr = await import("../src/probe.js");
  const realFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    seen.push(u);
    if (u.includes("/flip/ch.m3u8")) {
      const r = new Response(["#EXTM3U", "#EXTINF:10,", "/ts/x.ts", ""].join("\n"));
      Object.defineProperty(r, "url", { value: "http://real.example:5050/?id=ch&token=T" });
      return r;
    }
    if (u === "http://real.example:5050/ts/x.ts") return new Response(SEG);
    return new Response("nf", { status: 404 });
  };
  try {
    const r = await pr.probeStream("http://fake.example:8823/flip/ch.m3u8");
    assert.equal(r.ok, true, JSON.stringify(r) + " " + seen.join(" "));
    assert.ok(seen.includes("http://real.example:5050/ts/x.ts"));
  } finally {
    globalThis.fetch = realFetch;
  }
});

await test("2.4：/admin/test 區網網址 / 備援欄空白 → 回家用代理自己的播放實測（雲端連不到區網）", async () => {
  const env = makeEnv({ config: { version: 1, subscriptionUrl: MAIN } });
  let r = await call(env, "/admin/test", { method: "POST", body: { subscriptionUrl: "", which: "home" } });
  assert.equal(r.json.ok, true);
  assert.equal(r.json.lan, true);
  assert.equal(r.json.home, null);
  await env.CONFIG_KV.put("homeproxy", JSON.stringify({ lanUrl: "http://192.168.31.73:9010", publicIp: "88.0.0.1", version: "2.4.0", channels: 118, healthy: true, lastSeen: new Date().toISOString(), via: "box", boxId: "tv-h", probe: { at: Date.now(), ok: true, channel: "民視第一台", m3u8Ms: 900, segMs: 1200, bytes: 65536, error: "" } }));
  r = await call(env, "/admin/test", { method: "POST", body: { subscriptionUrl: "http://192.168.31.73:9010/playlist.m3u" } });
  assert.equal(r.json.lan, true);
  assert.equal(r.json.home.state, "online");
  assert.equal(r.json.home.probe.ok, true);
  assert.equal(r.json.home.probe.channel, "民視第一台");
  r = await call(env, "/admin/test", { method: "POST", body: { subscriptionUrl: "ftp://x" } });
  assert.equal(r.status, 400);
});

await test("2.4：監控 — 看門狗自報正常但雲端實測連續 2 次播不出來 → 異常＋Telegram；恢復後通知；status.json 改連網域", async () => {
  let T = Date.parse("2026-11-03T12:00:00Z");
  const env = makeEnv({ config: { version: 1, subscriptionUrl: MAIN, alertsEnabled: true, tgBotToken: TOK, tgChatId: "99", alertSourceMin: 10, alertQuiet: "" } }, { STREAM_PROBE: "on" });
  const { runMonitorTick } = await import("../src/monitor.js");
  const realFetch = globalThis.fetch;
  const tg = [];
  const seen = [];
  let seg = 200;
  globalThis.fetch = chainMock(tg, { seen, seg: () => seg, status: () => ({ healthy: true, consecutive_failures: 0, public_ip: "187.15.1.1", checked_at_ms: T - 60000 }) }, realFetch);
  try {
    let r = await runMonitorTick(env, T);
    assert.equal(r.state, "ok");
    assert.equal(r.st.src.probe.ok, true);
    assert.equal(r.st.src.probe.channel, "民視第一台");
    assert.ok(seen.some((u) => u.startsWith("http://1-2-3-4.sslip.io:5050/status.json")), "status.json 改連網域");
    seg = 502;
    T += 5 * 60000; r = await runMonitorTick(env, T);
    assert.equal(r.state, "ok", "失敗一次不算");
    assert.equal(r.st.src.probeFails, 1);
    T += 5 * 60000; r = await runMonitorTick(env, T);
    assert.equal(r.state, "bad");
    assert.equal(r.st.src.reason, "probe");
    T += 5 * 60000; r = await runMonitorTick(env, T);
    T += 5 * 60000; r = await runMonitorTick(env, T);
    assert.equal(tg.length, 1, tg.join("\n---\n"));
    assert.match(tg[0], /直播源播不出來/);
    assert.match(tg[0], /切片回 HTTP 502/);
    assert.match(tg[0], /看門狗自報正常/);
    // 總覽也要講真話：紅燈＋雲端實測原因
    const o = await call(env, "/admin/partial?name=overview");
    assert.match(o.text, /head-card red/);
    assert.match(o.text, /雲端實測播不出來/);
    seg = 200;
    T += 5 * 60000; r = await runMonitorTick(env, T);
    assert.equal(r.state, "ok");
    assert.equal(tg.length, 2);
    assert.match(tg[1], /直播源已恢復/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

await test("2.4：監控 — 沒有看門狗的源（status.json 404）靠雲端實測也有監控；看門狗沒回報但播得出來 → 正常＋黃燈提醒", async () => {
  let T = Date.now();
  const env = makeEnv({ config: { version: 1, subscriptionUrl: MAIN } }, { STREAM_PROBE: "on" });
  const { runMonitorTick } = await import("../src/monitor.js");
  const realFetch = globalThis.fetch;
  let status = null;
  globalThis.fetch = chainMock([], { status: () => status }, realFetch);
  try {
    let r = await runMonitorTick(env, T);
    assert.equal(r.state, "ok", "第三方源：實測播得出來就是正常");
    let o = await call(env, "/admin/partial?name=overview");
    assert.match(o.text, /雲端實測：民視第一台 播放正常/);
    status = { healthy: true, consecutive_failures: 0, checked_at_ms: T - 3 * 3600000 };
    T += 5 * 60000; r = await runMonitorTick(env, T);
    assert.equal(r.state, "ok");
    o = await call(env, "/admin/partial?name=overview");
    assert.match(o.text, /出事時不會自動修復/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

await test("2.4：家用代理回報播放實測 — 存下精簡結果、失敗立刻記、直播源分頁顯示", async () => {
  const env = makeEnv({ config: { version: 1, subscriptionUrl: MAIN, homeProxyKey: "K".repeat(40) } });
  const post = async (body) => {
    const req = new Request(ORIGIN + "/api/home-proxy", { method: "POST", headers: { "Content-Type": "application/json", "X-Home-Key": "K".repeat(40), "cf-connecting-ip": "89.0.0.1" }, body: JSON.stringify(body) });
    const res = await worker.fetch(req, env, {});
    return { status: res.status, json: await res.json() };
  };
  let r = await post({ ...HP_BODY, probe: { ok: true, channel: "民視第一台", m3u8Ms: 800, segMs: 1100, bytes: 65536, error: "", junk: "x" } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  let rec = await env.CONFIG_KV.get("homeproxy", { type: "json" });
  assert.equal(rec.probe.ok, true);
  assert.equal(rec.probe.channel, "民視第一台");
  assert.ok(!("junk" in rec.probe));
  // 同樣成功、秒數不同 → 不重寫（省 KV）；失敗 → 立刻寫
  r = await post({ ...HP_BODY, probe: { ok: true, channel: "民視第一台", m3u8Ms: 900, segMs: 1300, bytes: 65536 } });
  assert.equal(r.json.stored, false);
  r = await post({ ...HP_BODY, healthy: false, probe: { ok: false, channel: "民視第一台", error: "切片回 HTTP 502" } });
  assert.equal(r.json.stored, true);
  rec = await env.CONFIG_KV.get("homeproxy", { type: "json" });
  assert.equal(rec.healthy, false);
  assert.equal(rec.probe.error, "切片回 HTTP 502");
  const page = await call(env, "/admin/partial?name=home");
  assert.match(page.text, /家用代理自己實測播不出來（切片回 HTTP 502）/);
  assert.match(page.text, /播放實測（代理每 5 分鐘自己播一台/);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const [n, e] of failures) console.log("FAIL:", n, "\n", e && e.stack);
  process.exit(1);
}

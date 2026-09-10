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
  return { CONFIG_KV: new MockKV(seed), ADMIN_PASSWORD: PASS, ...(opts || {}) };
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
    if (String(url) === "http://1.2.3.4:5050/status.json?token=x") {
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
    const u = String(url);
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

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const [n, e] of failures) console.log("FAIL:", n, "\n", e && e.stack);
  process.exit(1);
}

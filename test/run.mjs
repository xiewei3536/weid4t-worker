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
  assert.equal(w1, 1, "新裝置寫一次");
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
  const dev = await env.CONFIG_KV.get("dev:tv-1", { type: "json" });
  assert.equal(dev.lastAck.id, cmdId);
  assert.equal(dev.lastAck.type, "tune");
  // 過期指令不下發
  dev.cmd = { id: "old", type: "reload", arg: "", at: new Date(Date.now() - 7 * 3600000).toISOString() };
  await env.CONFIG_KV.put("dev:tv-1", JSON.stringify(dev));
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

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const [n, e] of failures) console.log("FAIL:", n, "\n", e && e.stack);
  process.exit(1);
}

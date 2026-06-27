/**
 * 偉電視（WeiTV）直播源同步控制平面 — Cloudflare Worker
 * ----------------------------------------------------------------
 * 用途：
 *   1. 提供安卓電視盒 App 開機/定時輪詢的設定端點（GET /api/config）。
 *   2. 提供管理員用手機瀏覽器登入的管理頁（GET /admin），可遠端更新「訂閱網址」、
 *      公告、輪詢間隔、強制刷新旗標。
 *   3. 提供「測試來源」功能，讓管理員存檔前先確認新 token 的清單網址有效。
 *
 * 設計重點：
 *   - 不依賴任何框架/npm 套件，只用原生 fetch handler。
 *   - 設定資料存在 KV（binding 名稱：CONFIG_KV，key：config）。
 *   - 管理頁用 HTTP Basic Auth 比對 secret（env.ADMIN_PASSWORD），密碼不寫死。
 *   - 影片串流不經過本 Worker（盒子直連），故流量極小，可跑在免費額度內。
 */

// KV 中儲存設定用的 key 名稱
const CONFIG_KEY = "config";

// 預設設定：第一次讀取時若 KV 還沒有資料，就回傳這份並寫入 KV。
// subscriptionUrl 預設「留空」（公開範本不含任何 token）。
// 部署完成後，到 /admin 登入並貼上你的直播源網址即可。
const DEFAULT_CONFIG = {
  version: 1,
  subscriptionUrl: "",
  pollIntervalMinutes: 180,
  forceRefresh: false,
  notice: "",
  updatedAt: "2026-06-26T00:00:00Z",
};

// CORS 標頭：App 端（或網頁端）跨網域讀取設定時需要。
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export default {
  /**
   * Worker 進入點：依路徑分派到各個處理函式。
   */
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;

    try {
      // 統一處理 CORS preflight
      if (method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      }

      // ── App 端：讀取設定 ──────────────────────────────
      if (pathname === "/api/config" && method === "GET") {
        return await handleGetConfig(request, env);
      }

      // ── 管理頁：顯示 HTML 介面（需驗證）────────────────
      if (pathname === "/admin" && method === "GET") {
        return await handleAdminPage(request, env);
      }

      // ── 管理頁：存檔（需驗證）──────────────────────────
      if (pathname === "/admin/save" && method === "POST") {
        return await handleAdminSave(request, env);
      }

      // ── 管理頁：測試來源（需驗證）──────────────────────
      if (pathname === "/admin/test" && method === "POST") {
        return await handleAdminTest(request, env);
      }

      // ── 管理頁：裝置管理動作（需驗證）──────────────────
      if (pathname === "/admin/device" && method === "POST") {
        return await handleAdminDevice(request, env);
      }

      // 首頁簡單導引
      if (pathname === "/" && method === "GET") {
        return new Response(
          "WeiTV 控制平面運作中。App 設定端點：/api/config，管理頁：/admin",
          { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" } }
        );
      }

      return new Response("Not Found", { status: 404 });
    } catch (err) {
      // 全域錯誤處理：避免把堆疊細節外洩，只回傳簡短訊息。
      console.error("Unhandled error:", err && err.stack ? err.stack : err);
      return new Response("Internal Server Error", {
        status: 500,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }
  },
};

/* ================================================================
 *  設定讀寫工具
 * ================================================================ */

/**
 * 從 KV 讀取設定；若不存在則寫入並回傳預設值。
 * 回傳一個保證欄位齊全的設定物件。
 */
async function loadConfig(env) {
  let stored = null;
  try {
    stored = await env.CONFIG_KV.get(CONFIG_KEY, { type: "json" });
  } catch (err) {
    console.error("KV 讀取失敗:", err);
    // KV 讀取失敗時退回預設值（讓盒子至少有可用設定），但不寫入。
    return { ...DEFAULT_CONFIG };
  }

  if (!stored) {
    // 第一次：寫入預設值。寫入失敗也不致命，照樣回傳預設值。
    try {
      await env.CONFIG_KV.put(CONFIG_KEY, JSON.stringify(DEFAULT_CONFIG));
    } catch (err) {
      console.error("KV 初始化寫入失敗:", err);
    }
    return { ...DEFAULT_CONFIG };
  }

  // 合併預設值，確保舊資料缺欄位時也能補齊。
  return { ...DEFAULT_CONFIG, ...stored };
}

/**
 * 把設定寫回 KV。
 */
async function saveConfig(env, config) {
  await env.CONFIG_KV.put(CONFIG_KEY, JSON.stringify(config));
}

/* ================================================================
 *  App 端端點
 * ================================================================ */

/**
 * GET /api/config — 回傳目前設定給盒子。
 * 注意：forceRefresh 採「不自動清除」策略——讀取後維持原值，
 * 由管理員在管理頁手動切回 false。這樣簡單可靠，不會因為多台盒子
 * 輪詢時序問題導致只有第一台讀到 true。
 */
async function handleGetConfig(request, env) {
  const config = await loadConfig(env);

  // 更新裝置註冊表，並取得該裝置狀態（封鎖/傳話）。
  // 整段以 try/catch 包住，任何失敗都不可影響正常回應。
  let dev = null;
  try {
    dev = await touchDevice(request, env);
  } catch (err) {
    console.error("裝置註冊表更新失敗:", err);
  }

  // 在原本欄位外，附加該裝置的封鎖與傳話狀態。
  const blocked = !!(dev && dev.blocked);
  const payload = {
    ...config,
    blocked,
    message: (dev && dev.msg) || "",
    messageLevel: (dev && dev.msgLevel) || "info",
  };
  // 封鎖時雙重保險：訂閱網址清空，盒子拿不到來源。
  if (blocked) {
    payload.subscriptionUrl = "";
  }

  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...CORS_HEADERS,
    },
  });
}

/* ================================================================
 *  裝置註冊表（每台一個 KV key，前綴 dev:）
 * ================================================================ */

// 裝置 KV key 前綴
const DEVICE_PREFIX = "dev:";
// 列舉裝置時的上限
const DEVICE_LIST_MAX = 200;

/**
 * 依 query 的 id 讀取/新建裝置，更新 lastSeen/count/ip/m/v 後寫回。
 * 回傳更新後的裝置物件；若沒有 id 則回傳 null（不寫入）。
 * 呼叫端已用 try/catch 包住；本函式內任何錯誤都不應外洩影響回應。
 */
async function touchDevice(request, env) {
  const url = new URL(request.url);
  const id = (url.searchParams.get("id") || "").trim();
  if (!id) return null; // 沒帶 id，不記錄。

  const now = new Date().toISOString();
  const key = DEVICE_PREFIX + id;

  let dev = null;
  try {
    dev = await env.CONFIG_KV.get(key, { type: "json" });
  } catch (_) {
    dev = null;
  }

  if (!dev || typeof dev !== "object") {
    // 新建一筆裝置紀錄。
    dev = {
      id,
      nick: "",
      m: "",
      v: "",
      ip: "",
      firstSeen: now,
      lastSeen: now,
      count: 0,
      blocked: false,
      msg: "",
      msgLevel: "info",
    };
  }

  // 更新動態欄位，保留 nick/blocked/msg/msgLevel/firstSeen。
  dev.id = id;
  dev.lastSeen = now;
  dev.count = (typeof dev.count === "number" ? dev.count : 0) + 1;
  dev.ip = request.headers.get("cf-connecting-ip") || "";
  dev.m = url.searchParams.get("m") || "";
  dev.v = url.searchParams.get("v") || "";

  await env.CONFIG_KV.put(key, JSON.stringify(dev));
  return dev;
}

/**
 * 列出所有裝置（前綴 dev:），逐一讀取組成清單，依 lastSeen 由新到舊排序。
 * 上限約 DEVICE_LIST_MAX 筆。讀取失敗回傳空陣列。
 */
async function loadDevices(env) {
  let keys = [];
  try {
    const listed = await env.CONFIG_KV.list({ prefix: DEVICE_PREFIX });
    keys = (listed && Array.isArray(listed.keys) ? listed.keys : []).slice(
      0,
      DEVICE_LIST_MAX
    );
  } catch (err) {
    console.error("裝置列舉失敗:", err);
    return [];
  }

  const devices = [];
  for (const k of keys) {
    try {
      const dev = await env.CONFIG_KV.get(k.name, { type: "json" });
      if (dev && typeof dev === "object") devices.push(dev);
    } catch (_) {
      // 單筆讀取失敗就略過。
    }
  }

  devices.sort((a, b) => {
    const ta = Date.parse(a && a.lastSeen) || 0;
    const tb = Date.parse(b && b.lastSeen) || 0;
    return tb - ta;
  });
  return devices;
}

/* ================================================================
 *  驗證（HTTP Basic Auth）
 * ================================================================ */

/**
 * ADMIN_PASSWORD 尚未設定時顯示的「完成設定」說明頁(深色,步驟清楚)。
 */
function setupPasswordHtml() {
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>偉電視 · 完成最後一步</title>
<style>
:root{--bg0:#07090E;--bg1:#0C1119;--surface:#141A28;--stroke:#273043;--accent:#2DD4BF;--gold:#FBBF24;--text:#EEF2F7;--dim:#97A2B4}
*{box-sizing:border-box}body{margin:0;font-family:-apple-system,"PingFang TC","Microsoft JhengHei",system-ui,sans-serif;background:linear-gradient(180deg,var(--bg1),var(--bg0));color:var(--text);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
.card{width:100%;max-width:580px;background:var(--surface);border:1px solid var(--stroke);border-radius:18px;padding:30px;box-shadow:0 20px 50px rgba(0,0,0,.4)}
h1{font-size:22px;margin:0 0 6px}.sub{color:var(--dim);font-size:14px;margin-bottom:22px;line-height:1.7}
.dot{display:inline-block;width:11px;height:11px;border-radius:50%;background:var(--gold);box-shadow:0 0 12px var(--gold);margin-right:9px;vertical-align:middle}
ol{padding:0;margin:0;list-style:none;counter-reset:s}
li{counter-increment:s;position:relative;padding:13px 0 13px 46px;border-bottom:1px solid #1b2231;line-height:1.7}
li:last-child{border-bottom:0}
li::before{content:counter(s);position:absolute;left:0;top:11px;width:29px;height:29px;border-radius:9px;background:var(--accent);color:#052A26;font-weight:700;font-size:15px;display:flex;align-items:center;justify-content:center}
code{background:#0e1422;border:1px solid var(--stroke);border-radius:6px;padding:2px 8px;color:var(--accent);font-size:13px}
.k{color:var(--gold);font-weight:700}
.foot{margin-top:20px;color:var(--dim);font-size:13px;line-height:1.8}
</style></head><body>
<div class="card">
<h1><span class="dot"></span>還差最後一步:設定管理密碼</h1>
<div class="sub">Worker 已經部署成功、資料庫也建好了 ✅<br>只要設一組管理密碼,就能登入這個管理頁。</div>
<ol>
<li>到 Cloudflare 後台 → 左側 <span class="k">Workers &amp; Pages</span> → 點開這個 Worker(<code>weid4t-worker</code>)</li>
<li>上方分頁切到 <span class="k">Settings</span> → 找到 <span class="k">Variables and Secrets</span>(變數與密鑰)</li>
<li>按 <span class="k">+ Add</span>;Type 選 <span class="k">Secret</span>(加密,不是 Text)</li>
<li>Variable name 填 <code>ADMIN_PASSWORD</code>,Value 填你想要的密碼</li>
<li>按 <span class="k">Deploy</span> 儲存,等十幾秒,再 <span class="k">重新整理本頁</span></li>
</ol>
<div class="foot">完成後本頁會跳出帳密框:<b>帳號隨便填</b>、<b>密碼 = 你剛設的那組</b>。<br>
進階(CLI):<code>npx wrangler secret put ADMIN_PASSWORD</code></div>
</div></body></html>`;
}

/**
 * 驗證 Basic Auth。
 * 規則：使用者名稱不限（建議填 admin），密碼必須等於 env.ADMIN_PASSWORD。
 * 通過回傳 null；未通過回傳一個 401 Response（含 WWW-Authenticate）。
 */
function checkAuth(request, env) {
  const expected = env.ADMIN_PASSWORD;

  // 沒設定密碼 secret：顯示「如何設定」的說明頁(深色,步驟清楚)。
  if (!expected) {
    return new Response(setupPasswordHtml(), {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  const header = request.headers.get("Authorization") || "";
  if (header.startsWith("Basic ")) {
    try {
      const decoded = atob(header.slice(6)); // "username:password"
      const idx = decoded.indexOf(":");
      const password = idx >= 0 ? decoded.slice(idx + 1) : "";
      if (timingSafeEqual(password, expected)) {
        return null; // 通過
      }
    } catch (_) {
      // 解碼失敗 → 視為未授權，往下走。
    }
  }

  // 未授權：要求瀏覽器跳出帳密輸入框。
  return new Response("需要授權（請輸入管理密碼）", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="WeiTV Admin", charset="UTF-8"',
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}

/**
 * 等長度安全比對，降低 timing attack 風險。
 */
function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

/* ================================================================
 *  管理頁端點
 * ================================================================ */

/**
 * GET /admin — 回傳手機友善的管理 HTML。
 */
async function handleAdminPage(request, env) {
  const unauthorized = checkAuth(request, env);
  if (unauthorized) return unauthorized;

  const config = await loadConfig(env);
  const devices = await loadDevices(env);
  const html = renderAdminHtml(config, devices);
  return new Response(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

/**
 * POST /admin/save — 寫入設定、version +1、更新 updatedAt。
 * 接受 application/x-www-form-urlencoded（管理頁表單送出）。
 */
async function handleAdminSave(request, env) {
  const unauthorized = checkAuth(request, env);
  if (unauthorized) return unauthorized;

  const current = await loadConfig(env);

  let form;
  try {
    form = await request.formData();
  } catch (err) {
    return new Response("表單解析失敗", {
      status: 400,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  // 取值與基本清理
  const subscriptionUrl = (form.get("subscriptionUrl") || "").toString().trim();
  const notice = (form.get("notice") || "").toString();
  let pollIntervalMinutes = parseInt(
    (form.get("pollIntervalMinutes") || "").toString(),
    10
  );
  // forceRefresh：表單用 checkbox，有勾才會送出 "on"
  const forceRefresh = form.get("forceRefresh") === "on";

  // 驗證
  if (!subscriptionUrl || !/^https?:\/\//i.test(subscriptionUrl)) {
    return renderResultPage(
      false,
      "訂閱網址格式不正確（必須以 http(s):// 開頭）。",
      current
    );
  }
  if (!Number.isFinite(pollIntervalMinutes) || pollIntervalMinutes < 1) {
    // 給個合理下限，避免盒子過度頻繁輪詢。
    pollIntervalMinutes = current.pollIntervalMinutes || 180;
  }

  const updated = {
    ...current,
    version: (current.version || 0) + 1,
    subscriptionUrl,
    notice,
    pollIntervalMinutes,
    forceRefresh,
    updatedAt: new Date().toISOString(),
  };

  try {
    await saveConfig(env, updated);
  } catch (err) {
    console.error("KV 寫入失敗:", err);
    return renderResultPage(false, "KV 寫入失敗，請稍後再試。", current);
  }

  return renderResultPage(
    true,
    `已儲存（版本 v${updated.version}）。盒子下次輪詢就會更新。`,
    updated
  );
}

/**
 * POST /admin/test — 後端去 fetch 指定的 subscriptionUrl，
 * 回報 HTTP 狀態與解析到的頻道數（數 #EXTINF 行數）。
 * 回傳 JSON，由管理頁前端 fetch 後顯示。
 */
async function handleAdminTest(request, env) {
  const unauthorized = checkAuth(request, env);
  if (unauthorized) return unauthorized;

  let targetUrl = "";
  try {
    const form = await request.formData();
    targetUrl = (form.get("subscriptionUrl") || "").toString().trim();
  } catch (_) {
    // 忽略，往下檢查
  }

  if (!targetUrl || !/^https?:\/\//i.test(targetUrl)) {
    return jsonResponse({ ok: false, error: "網址格式不正確" }, 400);
  }

  try {
    // 設 10 秒逾時，避免卡住。
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    const resp = await fetch(targetUrl, {
      method: "GET",
      headers: { "User-Agent": "WeiTV-Admin-Test/1.0" },
      signal: controller.signal,
    });
    clearTimeout(timer);

    const text = await resp.text();
    // 數 #EXTINF 行數（每行一個頻道）
    const channelCount = (text.match(/#EXTINF/gi) || []).length;

    return jsonResponse({
      ok: true,
      httpStatus: resp.status,
      httpOk: resp.ok,
      channelCount,
      bytes: text.length,
      looksLikeM3u: /#EXTM3U/i.test(text),
    });
  } catch (err) {
    const msg =
      err && err.name === "AbortError"
        ? "連線逾時（10 秒）"
        : "連線失敗：" + (err && err.message ? err.message : "未知錯誤");
    return jsonResponse({ ok: false, error: msg }, 200);
  }
}

/* ================================================================
 *  裝置管理動作端點
 * ================================================================ */

/**
 * POST /admin/device — 對單一裝置執行管理動作（需 Basic Auth）。
 * 接受 application/x-www-form-urlencoded：id、action、value、level。
 * 動作：block / unblock / message / clearmsg / rename / delete。
 * 完成後回傳成功頁（沿用 renderResultPage 風格）。
 */
async function handleAdminDevice(request, env) {
  const unauthorized = checkAuth(request, env);
  if (unauthorized) return unauthorized;

  let form;
  try {
    form = await request.formData();
  } catch (err) {
    return renderResultPage(false, "表單解析失敗。", { version: "-", updatedAt: "-" });
  }

  const id = (form.get("id") || "").toString().trim();
  const action = (form.get("action") || "").toString().trim();
  const value = (form.get("value") || "").toString();
  const level = (form.get("level") || "").toString().trim();

  if (!id || !action) {
    return renderResultPage(false, "缺少裝置 id 或動作。", { version: "-", updatedAt: "-" });
  }

  const key = DEVICE_PREFIX + id;

  // 刪除動作不需先讀取既有資料。
  if (action === "delete") {
    try {
      await env.CONFIG_KV.delete(key);
    } catch (err) {
      console.error("裝置刪除失敗:", err);
      return renderResultPage(false, "刪除失敗，請稍後再試。", { version: "-", updatedAt: "-" });
    }
    return renderResultPage(true, `已刪除裝置 ${id}。`, { version: "-", updatedAt: new Date().toISOString() });
  }

  // 其餘動作：讀取現有裝置，套用變更後寫回。
  let dev = null;
  try {
    dev = await env.CONFIG_KV.get(key, { type: "json" });
  } catch (_) {
    dev = null;
  }
  if (!dev || typeof dev !== "object") {
    return renderResultPage(false, `找不到裝置 ${id}（可能已下線或被刪除）。`, { version: "-", updatedAt: "-" });
  }

  let summary = "";
  switch (action) {
    case "block":
      dev.blocked = true;
      summary = `已封鎖裝置 ${id}。`;
      break;
    case "unblock":
      dev.blocked = false;
      summary = `已解除封鎖裝置 ${id}。`;
      break;
    case "message":
      dev.msg = value;
      dev.msgLevel = level === "warn" ? "warn" : "info";
      summary = `已對裝置 ${id} 傳話。`;
      break;
    case "clearmsg":
      dev.msg = "";
      dev.msgLevel = "info";
      summary = `已清除裝置 ${id} 的訊息。`;
      break;
    case "rename":
      dev.nick = value;
      summary = `已更新裝置 ${id} 暱稱。`;
      break;
    default:
      return renderResultPage(false, `未知動作：${action}。`, { version: "-", updatedAt: "-" });
  }

  try {
    await env.CONFIG_KV.put(key, JSON.stringify(dev));
  } catch (err) {
    console.error("裝置寫入失敗:", err);
    return renderResultPage(false, "寫入失敗，請稍後再試。", { version: "-", updatedAt: "-" });
  }

  return renderResultPage(true, summary, { version: "-", updatedAt: new Date().toISOString() });
}

/* ================================================================
 *  HTML / 回應產生器
 * ================================================================ */

function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

/**
 * 簡易 HTML escape，避免設定值內容破壞頁面或注入。
 */
function escapeHtml(str) {
  return String(str == null ? "" : str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * 把 ISO 時間轉成「相對時間」（如「3 分鐘前」）。解析失敗回傳空字串。
 */
function relativeTime(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const diff = Date.now() - d.getTime();
  if (diff < 0) return "剛剛";
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return "剛剛";
  const min = Math.floor(sec / 60);
  if (min < 60) return min + " 分鐘前";
  const hr = Math.floor(min / 60);
  if (hr < 24) return hr + " 小時前";
  const day = Math.floor(hr / 24);
  if (day < 30) return day + " 天前";
  const mon = Math.floor(day / 30);
  if (mon < 12) return mon + " 個月前";
  return Math.floor(mon / 12) + " 年前";
}

/**
 * 把 ISO 時間轉成台灣（GMT+8）絕對時間，格式 YYYY/MM/DD HH:mm。
 * 解析失敗回傳原字串。
 */
function formatTaipeiFull(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso == null ? "" : iso);
  const t = new Date(d.getTime() + 8 * 60 * 60 * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  return (
    t.getUTCFullYear() +
    "/" +
    pad(t.getUTCMonth() + 1) +
    "/" +
    pad(t.getUTCDate()) +
    " " +
    pad(t.getUTCHours()) +
    ":" +
    pad(t.getUTCMinutes())
  );
}

/**
 * 產生「裝置管理」區塊 HTML（沿用既有深色卡片樣式）。
 * 每台一張卡片，附封鎖/解封、傳話、改暱稱、刪除操作。
 */
function renderDevicesSection(devices) {
  const list = Array.isArray(devices) ? devices : [];
  let body;
  if (list.length === 0) {
    body = `<div class="log-empty">尚無裝置上線</div>`;
  } else {
    body = list.map((d) => renderDeviceCard(d)).join("");
  }
  return `<div class="card">
    <div class="card-title">📺 裝置管理 · 共 ${list.length} 台</div>
    ${body}
  </div>`;
}

/**
 * 產生單一裝置卡片 HTML。所有使用者字串皆 escapeHtml 跳脫。
 */
function renderDeviceCard(d) {
  const id = String(d && d.id != null ? d.id : "");
  const nick = String(d && d.nick ? d.nick : "");
  const title = nick || id || "（未命名）";
  const blocked = !!(d && d.blocked);
  const msg = String(d && d.msg ? d.msg : "");
  const msgLevel = d && d.msgLevel === "warn" ? "warn" : "info";
  const idAttr = escapeHtml(id);

  const statusBadge = blocked
    ? `<span class="badge dev-blocked">已封鎖</span>`
    : `<span class="badge dev-active">使用中</span>`;

  // 封鎖/解封：依目前狀態顯示其一。
  const blockForm = blocked
    ? `<form class="dev-form" method="POST" action="/admin/device">
        <input type="hidden" name="id" value="${idAttr}">
        <input type="hidden" name="action" value="unblock">
        <button type="submit" class="btn-mini btn-ok">解除封鎖</button>
      </form>`
    : `<form class="dev-form" method="POST" action="/admin/device">
        <input type="hidden" name="id" value="${idAttr}">
        <input type="hidden" name="action" value="block">
        <button type="submit" class="btn-mini btn-danger">封鎖</button>
      </form>`;

  const currentMsg = msg
    ? `<div class="dev-curmsg ${msgLevel === "warn" ? "lv-warn" : "lv-info"}">目前訊息（${
        msgLevel === "warn" ? "警告" : "一般"
      }）：${escapeHtml(msg)}</div>`
    : "";

  return `<div class="dev-card">
    <div class="dev-head">
      <div class="dev-name">${escapeHtml(title)}</div>
      ${statusBadge}
    </div>
    <div class="dev-meta">
      <span class="dev-id mono">${idAttr}</span>
      <span>機型：${escapeHtml(d && d.m ? d.m : "-")}</span>
      <span>版本：${escapeHtml(d && d.v ? d.v : "-")}</span>
    </div>
    <div class="dev-meta">
      <span title="${escapeHtml(formatTaipeiFull(d && d.lastSeen))}">最後上線：${escapeHtml(
    relativeTime(d && d.lastSeen) || "-"
  )}（${escapeHtml(formatTaipeiFull(d && d.lastSeen))}）</span>
      <span>累計：${escapeHtml(d && d.count != null ? d.count : 0)} 次</span>
      <span class="mono">IP：${escapeHtml(d && d.ip ? d.ip : "-")}</span>
    </div>
    ${currentMsg}
    <div class="dev-actions">
      ${blockForm}

      <form class="dev-form dev-msg-form" method="POST" action="/admin/device">
        <input type="hidden" name="id" value="${idAttr}">
        <input type="hidden" name="action" value="message">
        <input type="text" name="value" class="dev-input" placeholder="傳話內容…" value="${escapeHtml(
          msg
        )}">
        <select name="level" class="dev-select">
          <option value="info"${msgLevel === "info" ? " selected" : ""}>一般</option>
          <option value="warn"${msgLevel === "warn" ? " selected" : ""}>警告</option>
        </select>
        <button type="submit" class="btn-mini btn-ok">送出</button>
      </form>

      <form class="dev-form" method="POST" action="/admin/device">
        <input type="hidden" name="id" value="${idAttr}">
        <input type="hidden" name="action" value="clearmsg">
        <button type="submit" class="btn-mini">清除訊息</button>
      </form>

      <form class="dev-form dev-rename-form" method="POST" action="/admin/device">
        <input type="hidden" name="id" value="${idAttr}">
        <input type="hidden" name="action" value="rename">
        <input type="text" name="value" class="dev-input" placeholder="暱稱…" value="${escapeHtml(
          nick
        )}">
        <button type="submit" class="btn-mini">改暱稱</button>
      </form>

      <form class="dev-form" method="POST" action="/admin/device" onsubmit="return confirm('確定刪除這台裝置紀錄？');">
        <input type="hidden" name="id" value="${idAttr}">
        <input type="hidden" name="action" value="delete">
        <button type="submit" class="btn-mini btn-danger">刪除</button>
      </form>
    </div>
  </div>`;
}

/**
 * 產生管理頁主畫面 HTML（深色、大按鈕、RWD）。
 */
function renderAdminHtml(config, devices) {
  return `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>偉電視 · 管理中心</title>
<style>
  :root {
    color-scheme: dark;
    --bg-0: #07090E;
    --bg-1: #0C1119;
    --surface: #141A28;
    --surface-2: #0F1420;
    --border: #273043;
    --accent: #2DD4BF;
    --accent-deep: #0EA5A0;
    --gold: #FBBF24;
    --danger: #FF4D5E;
    --text: #EEF2F7;
    --text-dim: #97A2B4;
  }
  * { box-sizing: border-box; }
  html, body { min-height: 100%; }
  body {
    margin: 0;
    background:
      radial-gradient(1200px 600px at 50% -10%, rgba(45,212,191,0.07), transparent 60%),
      linear-gradient(165deg, #07090E 0%, #0C1119 100%);
    background-attachment: fixed;
    color: var(--text);
    font-family: -apple-system, "PingFang TC", "Microsoft JhengHei", system-ui, sans-serif;
    padding: 22px 16px 48px;
    line-height: 1.55;
    -webkit-font-smoothing: antialiased;
  }
  .wrap { max-width: 640px; margin: 0 auto; }

  /* 品牌標題 */
  .brand { display: flex; align-items: center; gap: 11px; margin: 6px 2px 4px; }
  .brand .dot {
    width: 11px; height: 11px; border-radius: 50%;
    background: var(--accent);
    box-shadow: 0 0 0 4px rgba(45,212,191,0.16), 0 0 14px rgba(45,212,191,0.6);
  }
  h1 {
    font-size: 21px; font-weight: 700; letter-spacing: 0.3px;
    margin: 0; color: var(--text);
  }
  .accent-line {
    height: 3px; width: 64px; margin: 11px 2px 8px;
    border-radius: 3px;
    background: linear-gradient(90deg, var(--accent), var(--accent-deep) 70%, transparent);
  }
  .sub { color: var(--text-dim); font-size: 13.5px; margin: 0 2px 22px; }

  /* 卡片 */
  .card {
    background: linear-gradient(180deg, var(--surface) 0%, var(--surface-2) 130%);
    border: 1px solid var(--border);
    border-radius: 16px;
    padding: 20px;
    margin-bottom: 16px;
    box-shadow: 0 10px 30px -18px rgba(0,0,0,0.85), inset 0 1px 0 rgba(255,255,255,0.02);
  }
  .card-title {
    font-size: 12px; font-weight: 700; letter-spacing: 1.4px;
    text-transform: uppercase; color: var(--accent);
    margin: 0 0 14px; display: flex; align-items: center; gap: 8px;
  }

  /* 狀態資訊列 */
  .info-grid { display: flex; flex-wrap: wrap; gap: 10px; }
  .chip {
    flex: 1 1 160px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 12px 14px;
  }
  .chip .k { font-size: 11.5px; color: var(--text-dim); letter-spacing: 0.4px; margin-bottom: 4px; }
  .chip .v { font-size: 16px; font-weight: 700; color: var(--text); word-break: break-all; }
  .chip .v.mono { font-size: 13px; font-weight: 500; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .badge {
    display: inline-flex; align-items: center; gap: 6px;
    font-size: 13px; font-weight: 700; padding: 4px 10px; border-radius: 999px;
  }
  .badge.on { color: var(--gold); background: rgba(251,191,36,0.12); border: 1px solid rgba(251,191,36,0.35); }
  .badge.off { color: var(--text-dim); background: rgba(151,162,180,0.10); border: 1px solid var(--border); }

  /* 表單 */
  label { display: block; font-size: 13.5px; color: var(--text); font-weight: 600; margin: 18px 0 7px; }
  label:first-of-type { margin-top: 4px; }
  label .hint { display: block; font-weight: 400; font-size: 12px; color: var(--text-dim); margin-top: 2px; }
  input[type="text"], input[type="number"], textarea {
    width: 100%;
    padding: 14px 15px;
    font-size: 16px; /* 16px 以上避免 iOS 自動放大 */
    border-radius: 13px;
    border: 1px solid var(--border);
    background: var(--surface-2);
    color: var(--text);
    transition: border-color .15s, box-shadow .15s;
    font-family: inherit;
  }
  textarea { min-height: 76px; resize: vertical; line-height: 1.5; }
  input:focus, textarea:focus {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 3px rgba(45,212,191,0.18);
  }
  input::placeholder, textarea::placeholder { color: #5A647A; }

  /* checkbox 列 */
  .switch-row {
    display: flex; align-items: center; gap: 13px; margin-top: 18px;
    background: var(--surface-2); border: 1px solid var(--border);
    border-radius: 13px; padding: 14px 15px;
  }
  .switch-row input[type="checkbox"] {
    width: 24px; height: 24px; flex: none;
    accent-color: var(--accent); cursor: pointer;
  }
  .switch-row label { margin: 0; font-weight: 500; font-size: 14px; }

  /* 按鈕 */
  .btn {
    display: flex; align-items: center; justify-content: center; gap: 8px;
    width: 100%;
    padding: 16px;
    font-size: 16px;
    font-weight: 700;
    border: 1px solid transparent;
    border-radius: 13px;
    margin-top: 16px;
    cursor: pointer;
    font-family: inherit;
    transition: transform .08s, filter .15s, background .15s;
  }
  .btn:active { transform: translateY(1px); }
  .btn-primary {
    background: linear-gradient(135deg, var(--accent), var(--accent-deep));
    color: #04201E;
    box-shadow: 0 8px 22px -10px rgba(45,212,191,0.6);
  }
  .btn-primary:hover { filter: brightness(1.05); }
  .btn-secondary {
    background: transparent; color: var(--text);
    border: 1px solid var(--border);
  }
  .btn-secondary:hover { border-color: var(--accent); color: var(--accent); }

  /* 測試結果狀態卡 */
  #testResult { margin-top: 14px; display: none; }
  .result-card {
    border-radius: 14px; padding: 16px;
    border: 1px solid var(--border);
    background: var(--surface-2);
  }
  .result-head { display: flex; align-items: center; gap: 12px; }
  .result-icon {
    width: 38px; height: 38px; flex: none; border-radius: 11px;
    display: flex; align-items: center; justify-content: center;
    font-size: 20px; font-weight: 800;
  }
  .result-card.ok { border-color: rgba(45,212,191,0.4); background: rgba(45,212,191,0.07); }
  .result-card.ok .result-icon { background: rgba(45,212,191,0.16); color: var(--accent); }
  .result-card.bad { border-color: rgba(255,77,94,0.4); background: rgba(255,77,94,0.07); }
  .result-card.bad .result-icon { background: rgba(255,77,94,0.16); color: var(--danger); }
  .result-card.pending { color: var(--text-dim); }
  .result-title { font-size: 15px; font-weight: 700; }
  .result-sub { font-size: 12.5px; color: var(--text-dim); margin-top: 1px; }
  .result-stats { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
  .stat {
    flex: 1 1 90px; background: rgba(0,0,0,0.25);
    border: 1px solid var(--border); border-radius: 10px; padding: 9px 11px;
  }
  .stat .sk { font-size: 11px; color: var(--text-dim); }
  .stat .sv { font-size: 16px; font-weight: 700; color: var(--text); margin-top: 2px; }

  code {
    background: var(--surface-2); border: 1px solid var(--border);
    padding: 2px 8px; border-radius: 7px; word-break: break-all;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px;
    color: var(--accent);
  }

  /* 裝置管理 */
  .log-empty {
    color: var(--text-dim); font-size: 14px; padding: 10px 2px;
  }
  .badge.dev-active { color: var(--accent); background: rgba(45,212,191,0.12); border: 1px solid rgba(45,212,191,0.35); }
  .badge.dev-blocked { color: var(--danger); background: rgba(255,77,94,0.12); border: 1px solid rgba(255,77,94,0.4); }
  .dev-card {
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: 14px 15px;
    margin-bottom: 12px;
  }
  .dev-card:last-child { margin-bottom: 0; }
  .dev-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
  .dev-name { font-size: 16px; font-weight: 700; color: var(--text); word-break: break-all; }
  .dev-meta {
    display: flex; flex-wrap: wrap; gap: 4px 14px;
    color: var(--text-dim); font-size: 12.5px; margin-top: 8px;
  }
  .dev-id { color: var(--accent); }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .dev-curmsg {
    margin-top: 10px; padding: 9px 11px; border-radius: 9px; font-size: 13px;
    border: 1px solid var(--border); word-break: break-word;
  }
  .dev-curmsg.lv-info { color: var(--accent); background: rgba(45,212,191,0.08); border-color: rgba(45,212,191,0.3); }
  .dev-curmsg.lv-warn { color: var(--gold); background: rgba(251,191,36,0.10); border-color: rgba(251,191,36,0.35); }
  .dev-actions { margin-top: 12px; display: flex; flex-direction: column; gap: 8px; }
  .dev-form { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin: 0; }
  .dev-input {
    flex: 1 1 120px; min-width: 0;
    padding: 9px 11px; font-size: 15px; border-radius: 10px;
    border: 1px solid var(--border); background: var(--bg-1); color: var(--text);
    font-family: inherit;
  }
  .dev-input:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px rgba(45,212,191,0.16); }
  .dev-select {
    padding: 9px 10px; font-size: 14px; border-radius: 10px;
    border: 1px solid var(--border); background: var(--bg-1); color: var(--text);
    font-family: inherit;
  }
  .btn-mini {
    padding: 9px 14px; font-size: 14px; font-weight: 700;
    border-radius: 10px; border: 1px solid var(--border);
    background: var(--surface); color: var(--text);
    cursor: pointer; font-family: inherit; white-space: nowrap;
    transition: filter .15s, border-color .15s;
  }
  .btn-mini:active { transform: translateY(1px); }
  .btn-mini.btn-ok { background: linear-gradient(135deg, var(--accent), var(--accent-deep)); color: #04201E; border-color: transparent; }
  .btn-mini.btn-danger { color: var(--danger); border-color: rgba(255,77,94,0.4); background: rgba(255,77,94,0.07); }
  .btn-mini:hover { filter: brightness(1.06); }
  @media (max-width: 480px) {
    .dev-input { flex-basis: 100%; }
  }
  .footnote { text-align: center; color: var(--text-dim); font-size: 12.5px; margin-top: 24px; }
</style>
</head>
<body>
<div class="wrap">
  <div class="brand">
    <span class="dot"></span>
    <h1>偉電視 · 管理中心</h1>
  </div>
  <div class="accent-line"></div>
  <div class="sub">遠端同步直播源訂閱網址。存檔後盒子下次輪詢自動更新。</div>

  <div class="card">
    <div class="card-title">目前設定</div>
    <div class="info-grid">
      <div class="chip">
        <div class="k">版本</div>
        <div class="v">v${escapeHtml(config.version)}</div>
      </div>
      <div class="chip">
        <div class="k">強制刷新旗標</div>
        <div class="v">
          <span class="badge ${config.forceRefresh ? "on" : "off"}">${
            config.forceRefresh ? "開啟中" : "關閉"
          }</span>
        </div>
      </div>
      <div class="chip" style="flex-basis:100%;">
        <div class="k">最後更新</div>
        <div class="v mono">${escapeHtml(config.updatedAt)}</div>
      </div>
      <div class="chip" style="flex-basis:100%;">
        <div class="k">目前訂閱網址</div>
        <div class="v mono">${escapeHtml(config.subscriptionUrl)}</div>
      </div>
    </div>
  </div>

  <form class="card" method="POST" action="/admin/save">
    <div class="card-title">編輯設定</div>

    <label for="subscriptionUrl">訂閱網址
      <span class="hint">含 token 的 m3u8 清單網址</span>
    </label>
    <textarea id="subscriptionUrl" name="subscriptionUrl">${escapeHtml(
      config.subscriptionUrl
    )}</textarea>

    <button type="button" class="btn btn-secondary" onclick="testSource()">測試來源</button>
    <div id="testResult"></div>

    <label for="pollIntervalMinutes">盒子輪詢間隔（分鐘）</label>
    <input type="number" id="pollIntervalMinutes" name="pollIntervalMinutes" min="1"
      value="${escapeHtml(config.pollIntervalMinutes)}">

    <label for="notice">公告
      <span class="hint">可留空，盒子會顯示</span>
    </label>
    <textarea id="notice" name="notice">${escapeHtml(config.notice)}</textarea>

    <div class="switch-row">
      <input type="checkbox" id="forceRefresh" name="forceRefresh" ${
        config.forceRefresh ? "checked" : ""
      }>
      <label for="forceRefresh">強制刷新（讓盒子下次輪詢立即重載來源）</label>
    </div>

    <button type="submit" class="btn btn-primary">儲存設定</button>
  </form>

  ${renderDevicesSection(devices)}

  <div class="footnote">App 設定端點 <code>/api/config</code></div>
</div>

<script>
async function testSource() {
  var el = document.getElementById('testResult');
  var url = document.getElementById('subscriptionUrl').value.trim();
  el.style.display = 'block';
  el.innerHTML = '<div class="result-card pending"><div class="result-head">' +
    '<div class="result-icon" style="background:rgba(151,162,180,0.12);color:#97A2B4;">…</div>' +
    '<div><div class="result-title">測試中</div>' +
    '<div class="result-sub">正在連線並解析來源</div></div></div></div>';
  try {
    var fd = new FormData();
    fd.append('subscriptionUrl', url);
    var r = await fetch('/admin/test', { method: 'POST', body: fd });
    var data = await r.json();
    if (data.ok) {
      var good = data.httpOk && data.channelCount > 0;
      var cls = good ? 'ok' : 'bad';
      var icon = good ? '\\u2713' : '\\u2715';
      var title = good ? '來源正常' : '雲端測試未通過';
      var subtxt = good ? '可以儲存使用' : '雲端連不到(不代表盒子連不到,見下方說明)';
      var hint = good ? '' :
        '<div style="margin-top:12px;padding:11px 13px;border-radius:10px;background:rgba(251,191,36,0.10);border:1px solid rgba(251,191,36,0.35);color:#FBBF24;font-size:13px;line-height:1.7;">' +
        '\\u26A0 此測試是從 Cloudflare 雲端 IP 去打來源。若你的源只允許台灣/家用 IP(很常見),雲端會被擋(例如 403);但電視盒是從你家網路<b>直接連源</b>,通常仍可正常使用 \\u2014 可直接按「儲存設定」。' +
        '</div>';
      el.innerHTML =
        '<div class="result-card ' + cls + '">' +
          '<div class="result-head">' +
            '<div class="result-icon">' + icon + '</div>' +
            '<div><div class="result-title">' + title + '</div>' +
            '<div class="result-sub">' + subtxt + '</div></div>' +
          '</div>' +
          '<div class="result-stats">' +
            '<div class="stat"><div class="sk">HTTP 狀態</div><div class="sv">' + data.httpStatus + '</div></div>' +
            '<div class="stat"><div class="sk">M3U 格式</div><div class="sv">' + (data.looksLikeM3u ? '是' : '否') + '</div></div>' +
            '<div class="stat"><div class="sk">頻道數</div><div class="sv">' + data.channelCount + '</div></div>' +
            '<div class="stat"><div class="sk">回應大小</div><div class="sv">' + data.bytes + ' B</div></div>' +
          '</div>' + hint +
        '</div>';
    } else {
      el.innerHTML =
        '<div class="result-card bad"><div class="result-head">' +
          '<div class="result-icon">\\u2715</div>' +
          '<div><div class="result-title">測試失敗</div>' +
          '<div class="result-sub">' + (data.error || '未知錯誤') + '</div></div>' +
        '</div></div>';
    }
  } catch (e) {
    el.innerHTML =
      '<div class="result-card bad"><div class="result-head">' +
        '<div class="result-icon">\\u2715</div>' +
        '<div><div class="result-title">測試請求失敗</div>' +
        '<div class="result-sub">' + e.message + '</div></div>' +
      '</div></div>';
  }
}
</script>
</body>
</html>`;
}

/**
 * 產生存檔結果頁（成功/失敗），並提供回管理頁連結。
 */
function renderResultPage(success, message, config) {
  const accent = success ? "#2DD4BF" : "#FF4D5E";
  const iconBg = success ? "rgba(45,212,191,0.16)" : "rgba(255,77,94,0.16)";
  const cardBg = success ? "rgba(45,212,191,0.07)" : "rgba(255,77,94,0.07)";
  const cardBorder = success ? "rgba(45,212,191,0.4)" : "rgba(255,77,94,0.4)";
  const icon = success ? "✓" : "✕";
  const heading = success ? "儲存成功" : "操作失敗";
  const html = `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>偉電視 · ${success ? "儲存成功" : "操作失敗"}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background:
      radial-gradient(1200px 600px at 50% -10%, rgba(45,212,191,0.07), transparent 60%),
      linear-gradient(165deg, #07090E 0%, #0C1119 100%);
    background-attachment: fixed;
    color: #EEF2F7;
    font-family: -apple-system, "PingFang TC", "Microsoft JhengHei", system-ui, sans-serif;
    padding: 40px 16px; line-height: 1.6;
    -webkit-font-smoothing: antialiased;
  }
  .wrap { max-width: 640px; margin: 0 auto; }
  .card {
    background: linear-gradient(180deg, #141A28 0%, #0F1420 130%);
    border: 1px solid ${cardBorder};
    border-radius: 16px; padding: 22px;
    box-shadow: 0 10px 30px -18px rgba(0,0,0,0.85);
  }
  .head { display: flex; align-items: center; gap: 14px; }
  .icon {
    width: 46px; height: 46px; flex: none; border-radius: 13px;
    display: flex; align-items: center; justify-content: center;
    font-size: 24px; font-weight: 800;
    background: ${iconBg}; color: ${accent};
  }
  .title { font-size: 18px; font-weight: 700; }
  .msg {
    margin-top: 16px; padding: 14px 15px; border-radius: 12px;
    background: ${cardBg}; border: 1px solid ${cardBorder};
    color: #EEF2F7; font-size: 15px;
  }
  .meta {
    color: #97A2B4; font-size: 13px; margin-top: 16px;
    display: flex; flex-wrap: wrap; gap: 6px 18px;
  }
  .meta b { color: #EEF2F7; font-weight: 600; }
  a.btn {
    display: flex; align-items: center; justify-content: center;
    text-decoration: none; margin-top: 22px;
    background: linear-gradient(135deg, #2DD4BF, #0EA5A0); color: #04201E;
    padding: 16px; border-radius: 13px; font-size: 16px; font-weight: 700;
    box-shadow: 0 8px 22px -10px rgba(45,212,191,0.6);
  }
</style>
</head>
<body>
<div class="wrap">
  <div class="card">
    <div class="head">
      <div class="icon">${icon}</div>
      <div class="title">${heading}</div>
    </div>
    <div class="msg">${escapeHtml(message)}</div>
    <div class="meta">
      <span>版本 <b>v${escapeHtml(config.version)}</b></span>
      <span>更新時間 <b>${escapeHtml(config.updatedAt)}</b></span>
    </div>
    <a class="btn" href="/admin">返回管理中心</a>
  </div>
</div>
</body>
</html>`;
  return new Response(html, {
    status: success ? 200 : 400,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

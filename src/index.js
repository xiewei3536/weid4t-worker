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
  autostart: true,
  notice: "",
  // 公告自動消失時間(ISO 字串,空=常駐不消失)
  noticeUntil: "",
  // 臨時跑馬燈(滾動通知)文字 + 自動消失時間(空=不顯示)
  marquee: "",
  marqueeUntil: "",
  // 聯絡資訊:說明文字 + QR 圖版本戳(0=尚未上傳)
  contactText: "",
  contactQrVer: 0,
  // ── 授權機制 ──────────────────────────────────────────────
  // requireActivation：總開關。開啟後,未授權/到期裝置拿不到 subscriptionUrl,
  // App 會要求輸入啟動碼。預設關閉,不影響既有盒子運作。
  requireActivation: false,
  // 啟動畫面(App 開啟即顯示,亦用於啟動碼輸入頁)
  activationTitle: "歡迎使用偉電視",
  activationText: "請輸入啟動碼以開通本機。\n如需協助,請聯絡您的服務人員。",
  // 啟動碼位數(方便遙控器輸入,預設 8 位數字)
  codeDigits: 8,
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

      // ── App 端：啟動碼激活 ────────────────────────────
      if (pathname === "/api/activate" && method === "GET") {
        return await handleActivate(request, env);
      }

      // ── App OTA：查詢最新版本（公開，不需 Basic Auth）──
      if (pathname === "/api/update" && method === "GET") {
        return await handleUpdateInfo(request, env);
      }

      // ── App OTA：下載最新 APK（公開，串流代理）────────
      if (pathname === "/dl/latest.apk" && method === "GET") {
        return await handleDownloadApk(request, env);
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

      // ── 管理頁：啟動碼管理動作（需驗證）────────────────
      if (pathname === "/admin/codes" && method === "POST") {
        return await handleAdminCodes(request, env);
      }

      // ── 管理頁：上傳/移除聯絡 QR（需驗證）──────────────
      if (pathname === "/admin/upload" && method === "POST") {
        return await handleAdminUpload(request, env);
      }

      // ── 公開：聯絡 QR 圖（App 下載顯示）────────────────
      if (pathname === "/asset/qr" && method === "GET") {
        return await handleAssetQr(request, env);
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
  // 開機自啟改為每台為準：該裝置有設過布林就用它，否則回全域 config.autostart（預設 true）。
  const autostart =
    dev && typeof dev.autostart === "boolean" ? dev.autostart : config.autostart;

  // 授權狀態：requireActivation 關閉時一律視為已授權；開啟時看裝置 authorized + 是否到期。
  const auth = computeAuth(dev, config);

  const payload = {
    ...config,
    autostart,
    blocked,
    message: (dev && dev.msg) || "",
    messageLevel: (dev && dev.msgLevel) || "info",
    authorized: auth.authorized,
    expireAt: auth.expireAt,
  };
  // 封鎖、或（需授權但未授權/到期）→ 不下發來源，雙重保險。
  if (blocked || !auth.authorized) {
    payload.subscriptionUrl = "";
  }
  // 公告 / 跑馬燈到期過濾（過期就不下發）
  const nowMs = Date.now();
  if (config.noticeUntil && (Date.parse(config.noticeUntil) || 0) <= nowMs) {
    payload.notice = "";
  }
  if (!config.marqueeUntil || (Date.parse(config.marqueeUntil) || 0) <= nowMs) {
    payload.marquee = "";
  }
  // 聯絡 QR 網址（有上傳才給，附版本戳供更新快取）
  payload.contactQrUrl =
    config.contactQrVer > 0
      ? new URL("/asset/qr?v=" + config.contactQrVer, request.url).toString()
      : "";

  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...CORS_HEADERS,
    },
  });
}

/**
 * 計算裝置授權狀態。
 * requireActivation 關閉 → 一律授權（回傳裝置既有 expireAt 供顯示）。
 * 開啟 → 需 dev.authorized 為真且未過期（expireAt 空 = 永久）。
 * 回傳 { authorized:boolean, expireAt:string }。
 */
function computeAuth(dev, config) {
  const expireAt = (dev && dev.expireAt) || "";
  if (!config.requireActivation) {
    return { authorized: true, expireAt };
  }
  if (!dev || dev.authorized !== true) {
    return { authorized: false, expireAt };
  }
  if (expireAt) {
    const t = Date.parse(expireAt);
    if (Number.isFinite(t) && t <= Date.now()) {
      return { authorized: false, expireAt }; // 已到期
    }
  }
  return { authorized: true, expireAt };
}

/* ================================================================
 *  App OTA 自動更新（私有 repo Releases 代理）
 * ================================================================ */

// 私有 APK repo
const OTA_REPO = "xiewei3536/weid4t-app";
// 最新 release 結果在 KV 的快取 key
const OTA_CACHE_KEY = "update_cache";
// 快取有效時間（毫秒）：15 分鐘
const OTA_CACHE_TTL_MS = 15 * 60 * 1000;
// 打 GitHub API 共用 User-Agent
const OTA_USER_AGENT = "weitv-worker";

/**
 * 取得最新 release 的精簡資訊（含 KV 快取，15 分鐘）。
 * 回傳物件：{ version, name, notes, size, assetId, fetchedAt }；
 * token 未設或 GitHub 失敗時回傳 null（呼叫端自行決定降級行為）。
 */
async function getLatestRelease(env) {
  // 1) 先讀 KV 快取，未過期就直接用。
  try {
    const cached = await env.CONFIG_KV.get(OTA_CACHE_KEY, { type: "json" });
    if (
      cached &&
      typeof cached.fetchedAt === "number" &&
      Date.now() - cached.fetchedAt < OTA_CACHE_TTL_MS
    ) {
      return cached;
    }
  } catch (_) {
    // 快取讀取失敗就當沒有，往下打 API。
  }

  // 2) 沒有 token 無法存取私有 repo。
  if (!env.GITHUB_TOKEN) return null;

  // 3) 打 GitHub API 取 latest release。
  let release;
  try {
    const resp = await fetch(
      `https://api.github.com/repos/${OTA_REPO}/releases/latest`,
      {
        headers: {
          Authorization: `Bearer ${env.GITHUB_TOKEN}`,
          "User-Agent": OTA_USER_AGENT,
          Accept: "application/vnd.github+json",
        },
      }
    );
    if (!resp.ok) return null;
    release = await resp.json();
  } catch (err) {
    console.error("OTA 取 release 失敗:", err);
    return null;
  }

  if (!release || typeof release !== "object") return null;

  // 解析欄位
  const tag = (release.tag_name || "").toString();
  const m = tag.match(/(\d+)$/);
  const version = m ? parseInt(m[1], 10) : 0;
  const notes = (release.body || "").toString();

  // 找出 .apk 資產的 size 與 id。
  let size = 0;
  let assetId = 0;
  const assets = Array.isArray(release.assets) ? release.assets : [];
  for (const a of assets) {
    if (a && typeof a.name === "string" && /\.apk$/i.test(a.name)) {
      size = typeof a.size === "number" ? a.size : 0;
      assetId = typeof a.id === "number" ? a.id : 0;
      break;
    }
  }

  const result = {
    version,
    name: tag,
    notes,
    size,
    assetId,
    fetchedAt: Date.now(),
  };

  // 4) 寫回 KV 快取（失敗不致命）。
  try {
    await env.CONFIG_KV.put(OTA_CACHE_KEY, JSON.stringify(result));
  } catch (err) {
    console.error("OTA 快取寫入失敗:", err);
  }

  return result;
}

/**
 * GET /api/update — 公開查詢最新 App 版本。
 * 回 JSON：{ version, name, notes, url, size }。
 * token 未設或 GitHub 失敗時回「無更新」的零值，避免 App 報錯。
 */
async function handleUpdateInfo(request, env) {
  const rel = await getLatestRelease(env);

  let payload;
  if (!rel) {
    payload = { version: 0, name: "", notes: "", url: "", size: 0 };
  } else {
    payload = {
      version: rel.version,
      name: rel.name,
      notes: rel.notes,
      url: new URL("/dl/latest.apk", request.url).toString(),
      size: rel.size,
    };
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

/**
 * GET /dl/latest.apk — 公開串流代理最新 APK 資產。
 * 透過 release asset API（Accept: application/octet-stream）讓 GitHub 302 到
 * 實際檔案，再把 body 串流回盒子；token 未設或找不到資產回 404。
 */
async function handleDownloadApk(request, env) {
  if (!env.GITHUB_TOKEN) {
    return new Response("更新服務尚未設定", {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  const rel = await getLatestRelease(env);
  if (!rel || !rel.assetId) {
    return new Response("找不到可下載的 APK", {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  let resp;
  try {
    resp = await fetch(
      `https://api.github.com/repos/${OTA_REPO}/releases/assets/${rel.assetId}`,
      {
        headers: {
          Authorization: `Bearer ${env.GITHUB_TOKEN}`,
          "User-Agent": OTA_USER_AGENT,
          Accept: "application/octet-stream",
        },
      }
    );
  } catch (err) {
    console.error("OTA 下載資產失敗:", err);
    return new Response("下載失敗", {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  if (!resp.ok || !resp.body) {
    return new Response("下載失敗", {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  return new Response(resp.body, {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.android.package-archive",
      "Content-Disposition": 'attachment; filename="WeiTV.apk"',
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

  // 盒子實測來源健康：只有帶 ok 參數時才更新這三個欄位。
  if (url.searchParams.has("ok")) {
    dev.lastOk = url.searchParams.get("ok") === "1";
    dev.lastCount = parseInt(url.searchParams.get("ch"), 10) || 0;
    dev.lastResultAt = now;
  }

  // 開機自啟回報：只有帶 as 參數時才更新（一般輪詢不帶 as，避免覆蓋管理頁設定）。
  // as=1 → 開、as=0 → 關，存成布林記在該裝置上。
  if (url.searchParams.has("as")) {
    dev.autostart = url.searchParams.get("as") === "1";
  }

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
 *  啟動碼授權（每碼一個 KV key，前綴 code:）
 * ================================================================ */

const CODE_PREFIX = "code:";
const CODE_LIST_MAX = 500;

/**
 * 產生隨機數字啟動碼（digits 位，限 4~12）。首位避免 0，方便辨識位數。
 */
function genCodeString(digits) {
  const n = Math.max(4, Math.min(12, digits || 8));
  const arr = new Uint8Array(n);
  crypto.getRandomValues(arr);
  let s = "";
  for (let i = 0; i < n; i++) s += (arr[i] % 10).toString();
  if (s[0] === "0") s = (1 + (arr[0] % 9)).toString() + s.slice(1);
  return s;
}

/**
 * 標記某裝置為已授權，寫入到期日（expireAt 空 = 永久）。
 * 裝置不存在時建立一筆。回傳裝置物件。
 */
async function authorizeDevice(env, id, expireAt, codeUsed) {
  const key = DEVICE_PREFIX + id;
  let dev = null;
  try {
    dev = await env.CONFIG_KV.get(key, { type: "json" });
  } catch (_) {
    dev = null;
  }
  const now = new Date().toISOString();
  if (!dev || typeof dev !== "object") {
    dev = {
      id, nick: "", m: "", v: "", ip: "",
      firstSeen: now, lastSeen: now, count: 0,
      blocked: false, msg: "", msgLevel: "info",
    };
  }
  dev.authorized = true;
  dev.authedAt = now;
  dev.expireAt = expireAt || "";
  if (codeUsed) dev.codeUsed = codeUsed;
  await env.CONFIG_KV.put(key, JSON.stringify(dev));
  return dev;
}

/**
 * GET /api/activate?id=&code= — 盒子輸入啟動碼後呼叫。
 * 未使用碼：綁定本機、依 days 算到期、標記裝置授權。
 * 已使用碼：僅允許原綁定裝置（重裝情境）。回 JSON。
 */
async function handleActivate(request, env) {
  const url = new URL(request.url);
  const id = (url.searchParams.get("id") || "").trim();
  const code = (url.searchParams.get("code") || "").trim();
  if (!id || !code) {
    return jsonResponse({ ok: false, error: "缺少裝置或啟動碼" }, 400);
  }

  const codeKey = CODE_PREFIX + code;
  let rec = null;
  try {
    rec = await env.CONFIG_KV.get(codeKey, { type: "json" });
  } catch (_) {
    rec = null;
  }

  if (!rec || typeof rec !== "object" || rec.status === "revoked") {
    return jsonResponse({ ok: false, error: "啟動碼錯誤或已失效" }, 200);
  }
  if (rec.status === "used" && rec.device && rec.device !== id) {
    return jsonResponse({ ok: false, error: "此啟動碼已被其他裝置使用" }, 200);
  }

  const now = new Date();
  let expireAt = rec.expireAt || "";
  if (rec.status !== "used") {
    const days = typeof rec.days === "number" ? rec.days : 0;
    expireAt = days > 0 ? new Date(now.getTime() + days * 86400000).toISOString() : "";
    rec.status = "used";
    rec.device = id;
    rec.usedAt = now.toISOString();
    rec.expireAt = expireAt;
    try {
      await env.CONFIG_KV.put(codeKey, JSON.stringify(rec));
    } catch (_) {
      return jsonResponse({ ok: false, error: "啟動碼寫入失敗，請重試" }, 200);
    }
  }

  try {
    await authorizeDevice(env, id, expireAt, code);
  } catch (_) {
    return jsonResponse({ ok: false, error: "授權寫入失敗，請重試" }, 200);
  }

  return jsonResponse({ ok: true, expireAt, message: "啟動成功" }, 200);
}

/**
 * 列出所有啟動碼（前綴 code:），依建立時間新到舊排序，上限 CODE_LIST_MAX。
 */
async function loadCodes(env) {
  let keys = [];
  try {
    const listed = await env.CONFIG_KV.list({ prefix: CODE_PREFIX });
    keys = (listed && Array.isArray(listed.keys) ? listed.keys : []).slice(0, CODE_LIST_MAX);
  } catch (err) {
    console.error("啟動碼列舉失敗:", err);
    return [];
  }
  const codes = [];
  for (const k of keys) {
    try {
      const c = await env.CONFIG_KV.get(k.name, { type: "json" });
      if (c && typeof c === "object") codes.push(c);
    } catch (_) {}
  }
  codes.sort(
    (a, b) => (Date.parse(b && b.createdAt) || 0) - (Date.parse(a && a.createdAt) || 0)
  );
  return codes;
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
  const codes = await loadCodes(env);
  const html = renderAdminHtml(config, devices, codes);
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

  // 分頁各自儲存：_fields 指明這次表單涵蓋哪一組欄位，只更新那組，其餘保留。
  const fields = (form.get("_fields") || "all").toString();
  const updated = {
    ...current,
    version: (current.version || 0) + 1,
    updatedAt: new Date().toISOString(),
  };

  if (fields === "all" || fields === "source") {
    const subscriptionUrl = (form.get("subscriptionUrl") || "").toString().trim();
    if (!subscriptionUrl || !/^https?:\/\//i.test(subscriptionUrl)) {
      return renderResultPage(false, "訂閱網址格式不正確（必須以 http(s):// 開頭）。", current);
    }
    updated.subscriptionUrl = subscriptionUrl;
  }

  if (fields === "all" || fields === "notice") {
    updated.notice = (form.get("notice") || "").toString();
    let nh = parseFloat((form.get("noticeHours") || "0").toString());
    if (!Number.isFinite(nh) || nh < 0) nh = 0;
    updated.noticeUntil = nh > 0 ? new Date(Date.now() + nh * 3600000).toISOString() : "";
  }

  if (fields === "all" || fields === "marquee") {
    updated.marquee = (form.get("marquee") || "").toString();
    let mm = parseFloat((form.get("marqueeMinutes") || "0").toString());
    if (!Number.isFinite(mm) || mm < 0) mm = 0;
    updated.marqueeUntil =
      mm > 0 && updated.marquee ? new Date(Date.now() + mm * 60000).toISOString() : "";
  }

  if (fields === "all" || fields === "contact") {
    updated.contactText = (form.get("contactText") || "").toString();
  }

  if (fields === "all" || fields === "system") {
    let poll = parseInt((form.get("pollIntervalMinutes") || "").toString(), 10);
    if (!Number.isFinite(poll) || poll < 1) poll = current.pollIntervalMinutes || 180;
    updated.pollIntervalMinutes = poll;
    updated.forceRefresh = form.get("forceRefresh") === "on";
    updated.autostart = form.get("autostart") === "on";
  }

  if (fields === "all" || fields === "auth") {
    updated.requireActivation = form.get("requireActivation") === "on";
    updated.activationTitle = (form.get("activationTitle") || "").toString();
    updated.activationText = (form.get("activationText") || "").toString();
    let cd = parseInt((form.get("codeDigits") || "").toString(), 10);
    if (!Number.isFinite(cd)) cd = current.codeDigits || 8;
    updated.codeDigits = Math.max(4, Math.min(12, cd));
  }

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

  // 盒子實測健康彙整（雲端被擋時也有真實判斷依據）。
  const boxes = await summarizeBoxes(env);

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
      boxes,
    });
  } catch (err) {
    const msg =
      err && err.name === "AbortError"
        ? "連線逾時（10 秒）"
        : "連線失敗：" + (err && err.message ? err.message : "未知錯誤");
    return jsonResponse({ ok: false, error: msg, boxes }, 200);
  }
}

/**
 * 用 loadDevices 彙整盒子實測來源健康。
 * 回傳：reported（有回報數）、ok（成功數）、maxCount（ok 裝置最大頻道數）、
 * recentAt（最新 lastResultAt ISO，沒有為 ""）、recentRel（recentAt 的相對時間）。
 */
async function summarizeBoxes(env) {
  let devices = [];
  try {
    devices = await loadDevices(env);
  } catch (_) {
    devices = [];
  }

  let reported = 0;
  let ok = 0;
  let maxCount = 0;
  let recentMs = 0;
  let recentAt = "";

  for (const d of devices) {
    if (!d || !d.lastResultAt) continue;
    reported++;
    const ms = Date.parse(d.lastResultAt) || 0;
    if (ms > recentMs) {
      recentMs = ms;
      recentAt = d.lastResultAt;
    }
    if (d.lastOk === true) {
      ok++;
      const c = typeof d.lastCount === "number" ? d.lastCount : 0;
      if (c > maxCount) maxCount = c;
    }
  }

  return {
    reported,
    ok,
    maxCount,
    recentAt,
    recentRel: recentAt ? relativeTime(recentAt) : "",
  };
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

  // 一鍵全部：不針對單一 id，故先於 id 檢查處理。
  if (action === "autostart_all") {
    const on = value === "on";
    let devices = [];
    try {
      devices = await loadDevices(env);
    } catch (err) {
      console.error("裝置列舉失敗:", err);
      return renderResultPage(false, "列舉裝置失敗，請稍後再試。", { version: "-", updatedAt: "-" });
    }
    let n = 0;
    for (const dev of devices) {
      if (!dev || typeof dev !== "object" || !dev.id) continue;
      dev.autostart = on;
      try {
        await env.CONFIG_KV.put(DEVICE_PREFIX + dev.id, JSON.stringify(dev));
        n++;
      } catch (err) {
        console.error("裝置寫入失敗:", err);
      }
    }
    return renderResultPage(
      true,
      `已將 ${n} 台裝置的開機自啟設為「${on ? "開" : "關"}」。`,
      { version: "-", updatedAt: new Date().toISOString() }
    );
  }

  // 一鍵授權所有現有裝置（啟用授權機制時，避免既有盒子被鎖在外）。
  if (action === "authorize_all") {
    let days = parseInt(value, 10);
    if (!Number.isFinite(days) || days < 0) days = 0;
    const expireAt = days > 0 ? new Date(Date.now() + days * 86400000).toISOString() : "";
    let devices = [];
    try {
      devices = await loadDevices(env);
    } catch (_) {
      return renderResultPage(false, "列舉裝置失敗，請稍後再試。", { version: "-", updatedAt: "-" });
    }
    let n = 0;
    for (const dev of devices) {
      if (!dev || !dev.id) continue;
      try {
        await authorizeDevice(env, dev.id, expireAt, "");
        n++;
      } catch (_) {}
    }
    return renderResultPage(
      true,
      `已授權 ${n} 台現有裝置（${days > 0 ? days + " 天" : "永久"}）。`,
      { version: "-", updatedAt: new Date().toISOString() }
    );
  }

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
    case "autostart":
      dev.autostart = value === "on";
      summary = `已將裝置 ${id} 的開機自啟設為「${dev.autostart ? "開" : "關"}」。`;
      break;
    case "authorize": {
      let days = parseInt(value, 10);
      if (!Number.isFinite(days) || days < 0) days = 0;
      dev.authorized = true;
      dev.authedAt = new Date().toISOString();
      dev.expireAt = days > 0 ? new Date(Date.now() + days * 86400000).toISOString() : "";
      summary = `已授權裝置 ${id}（${days > 0 ? days + " 天" : "永久"}）。`;
      break;
    }
    case "deauthorize":
      dev.authorized = false;
      dev.expireAt = "";
      summary = `已撤銷裝置 ${id} 的授權。`;
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

/**
 * POST /admin/codes — 啟動碼管理（需 Basic Auth）。
 * action：gen_single（產 1 組）/ gen_batch（產 count 組）/ revoke（撤銷）/ delete（刪除）。
 * 參數：days（有效天數，0=永久）、note（備註）、count（批量數）、code（指定碼）。
 */
async function handleAdminCodes(request, env) {
  const unauthorized = checkAuth(request, env);
  if (unauthorized) return unauthorized;

  let form;
  try {
    form = await request.formData();
  } catch (_) {
    return renderResultPage(false, "表單解析失敗。", { version: "-", updatedAt: "-" });
  }

  const action = (form.get("action") || "").toString().trim();
  const note = (form.get("note") || "").toString().trim();
  let days = parseInt((form.get("days") || "").toString(), 10);
  if (!Number.isFinite(days) || days < 0) days = 0;

  const nowIso = new Date().toISOString();

  // 產生啟動碼（單筆或批量）
  if (action === "gen_single" || action === "gen_batch") {
    const config = await loadConfig(env);
    const digits = config.codeDigits || 8;
    let count =
      action === "gen_batch" ? parseInt((form.get("count") || "").toString(), 10) : 1;
    if (!Number.isFinite(count) || count < 1) count = 1;
    count = Math.min(count, 200); // 單次上限，避免誤觸大量寫入

    const created = [];
    for (let i = 0; i < count; i++) {
      let code = "";
      for (let tries = 0; tries < 6; tries++) {
        const c = genCodeString(digits);
        let exists = null;
        try {
          exists = await env.CONFIG_KV.get(CODE_PREFIX + c);
        } catch (_) {}
        if (!exists) {
          code = c;
          break;
        }
      }
      if (!code) continue;
      const rec = {
        code,
        status: "unused",
        device: null,
        note,
        days,
        createdAt: nowIso,
        usedAt: "",
        expireAt: "",
      };
      try {
        await env.CONFIG_KV.put(CODE_PREFIX + code, JSON.stringify(rec));
        created.push(code);
      } catch (_) {}
    }
    return renderCodesResultPage(created, days, note);
  }

  // 以下動作需指定 code
  const code = (form.get("code") || "").toString().trim();
  if (!code) {
    return renderResultPage(false, "缺少啟動碼。", { version: "-", updatedAt: "-" });
  }
  const key = CODE_PREFIX + code;

  if (action === "delete") {
    try {
      await env.CONFIG_KV.delete(key);
    } catch (_) {
      return renderResultPage(false, "刪除失敗。", { version: "-", updatedAt: "-" });
    }
    return renderResultPage(true, `已刪除啟動碼 ${code}。`, { version: "-", updatedAt: nowIso });
  }

  if (action === "revoke") {
    let rec = null;
    try {
      rec = await env.CONFIG_KV.get(key, { type: "json" });
    } catch (_) {}
    if (!rec) {
      return renderResultPage(false, `找不到啟動碼 ${code}。`, { version: "-", updatedAt: "-" });
    }
    rec.status = "revoked";
    // 若已綁定裝置，一併撤銷該裝置授權。
    if (rec.device) {
      try {
        const dkey = DEVICE_PREFIX + rec.device;
        const dev = await env.CONFIG_KV.get(dkey, { type: "json" });
        if (dev) {
          dev.authorized = false;
          dev.expireAt = "";
          await env.CONFIG_KV.put(dkey, JSON.stringify(dev));
        }
      } catch (_) {}
    }
    try {
      await env.CONFIG_KV.put(key, JSON.stringify(rec));
    } catch (_) {
      return renderResultPage(false, "撤銷失敗。", { version: "-", updatedAt: "-" });
    }
    return renderResultPage(
      true,
      `已撤銷啟動碼 ${code}${rec.device ? "（並停用綁定裝置）" : ""}。`,
      { version: "-", updatedAt: nowIso }
    );
  }

  return renderResultPage(false, `未知動作：${action}。`, { version: "-", updatedAt: "-" });
}

/**
 * 產生「啟動碼已生成」結果頁，列出新碼並提供一鍵複製。
 */
function renderCodesResultPage(codes, days, note) {
  const list = Array.isArray(codes) ? codes : [];
  const term = days > 0 ? days + " 天" : "永久";
  const rows = list
    .map((c) => `<div class="cg-row"><span class="mono">${escapeHtml(c)}</span></div>`)
    .join("");
  const allText = list.join("\n");
  const html = `<!DOCTYPE html><html lang="zh-Hant"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>偉電視 · 啟動碼已產生</title>
<style>
  :root{color-scheme:dark}*{box-sizing:border-box}
  body{margin:0;background:radial-gradient(1200px 600px at 50% -10%,rgba(45,212,191,.07),transparent 60%),linear-gradient(165deg,#07090E,#0C1119);background-attachment:fixed;color:#EEF2F7;font-family:-apple-system,"PingFang TC","Microsoft JhengHei",system-ui,sans-serif;padding:40px 16px;line-height:1.6}
  .wrap{max-width:640px;margin:0 auto}
  .card{background:linear-gradient(180deg,#141A28,#0F1420 130%);border:1px solid rgba(45,212,191,.4);border-radius:16px;padding:22px;box-shadow:0 10px 30px -18px rgba(0,0,0,.85)}
  .head{display:flex;align-items:center;gap:14px}
  .icon{width:46px;height:46px;flex:none;border-radius:13px;display:flex;align-items:center;justify-content:center;font-size:24px;font-weight:800;background:rgba(45,212,191,.16);color:#2DD4BF}
  .title{font-size:18px;font-weight:700}
  .meta{color:#97A2B4;font-size:13px;margin-top:14px;display:flex;flex-wrap:wrap;gap:6px 18px}.meta b{color:#EEF2F7}
  .code-box{margin-top:16px;max-height:340px;overflow:auto;border:1px solid #273043;border-radius:12px;background:#0F1420;padding:6px}
  .cg-row{padding:9px 12px;border-bottom:1px solid #1b2231;font-size:19px;letter-spacing:2px}.cg-row:last-child{border-bottom:0}
  .mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:#2DD4BF;font-weight:700}
  .btn{display:flex;align-items:center;justify-content:center;text-decoration:none;margin-top:16px;background:linear-gradient(135deg,#2DD4BF,#0EA5A0);color:#04201E;padding:15px;border-radius:13px;font-size:16px;font-weight:700;border:none;width:100%;cursor:pointer;font-family:inherit}
  .btn2{background:transparent;color:#EEF2F7;border:1px solid #273043}
</style></head><body>
<div class="wrap"><div class="card">
  <div class="head"><div class="icon">✓</div><div class="title">已產生 ${list.length} 組啟動碼</div></div>
  <div class="meta"><span>有效期 <b>${term}</b></span>${note ? `<span>備註 <b>${escapeHtml(note)}</b></span>` : ""}</div>
  <div class="code-box">${rows || '<div class="cg-row">（沒有產生，請重試）</div>'}</div>
  <button class="btn" onclick="copyAll()">📋 複製全部</button>
  <a class="btn btn2" href="/admin">返回管理中心</a>
</div></div>
<textarea id="allcodes" style="position:absolute;left:-9999px;top:0">${escapeHtml(allText)}</textarea>
<script>function copyAll(){var t=document.getElementById('allcodes');t.focus();t.select();try{document.execCommand('copy');alert('已複製 ${list.length} 組啟動碼');}catch(e){alert('複製失敗，請手動選取');}}</script>
</body></html>`;
  return new Response(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

/**
 * POST /admin/upload — 上傳或移除聯絡 QR 圖（存 KV，需 Basic Auth）。
 * action=remove 移除；否則讀 file 欄位存成 asset:qr 並把 contactQrVer +1。
 */
async function handleAdminUpload(request, env) {
  const unauthorized = checkAuth(request, env);
  if (unauthorized) return unauthorized;

  let form;
  try {
    form = await request.formData();
  } catch (_) {
    return renderResultPage(false, "上傳解析失敗。", { version: "-", updatedAt: "-" });
  }

  const action = (form.get("action") || "").toString();
  const config = await loadConfig(env);

  if (action === "remove") {
    try {
      await env.CONFIG_KV.delete("asset:qr");
    } catch (_) {}
    config.version = (config.version || 0) + 1;
    config.contactQrVer = 0;
    config.updatedAt = new Date().toISOString();
    try {
      await saveConfig(env, config);
    } catch (_) {}
    return renderResultPage(true, "已移除聯絡 QR 圖。", config);
  }

  const file = form.get("file");
  if (!file || typeof file === "string" || typeof file.arrayBuffer !== "function") {
    return renderResultPage(false, "請選擇要上傳的圖檔。", { version: "-", updatedAt: "-" });
  }
  const ct = file.type || "image/png";
  if (!/^image\//.test(ct)) {
    return renderResultPage(false, "只接受圖片檔（PNG / JPG 等）。", { version: "-", updatedAt: "-" });
  }
  let buf;
  try {
    buf = await file.arrayBuffer();
  } catch (_) {
    return renderResultPage(false, "讀取圖檔失敗。", { version: "-", updatedAt: "-" });
  }
  if (buf.byteLength > 2 * 1024 * 1024) {
    return renderResultPage(false, "圖檔太大，請小於 2MB。", { version: "-", updatedAt: "-" });
  }
  try {
    await env.CONFIG_KV.put("asset:qr", buf, { metadata: { ct } });
  } catch (_) {
    return renderResultPage(false, "圖檔儲存失敗，請稍後再試。", { version: "-", updatedAt: "-" });
  }
  config.version = (config.version || 0) + 1;
  config.contactQrVer = (config.contactQrVer || 0) + 1;
  config.updatedAt = new Date().toISOString();
  try {
    await saveConfig(env, config);
  } catch (_) {}
  return renderResultPage(true, "已上傳聯絡 QR 圖，盒子下次輪詢就會看到。", config);
}

/**
 * GET /asset/qr — 公開回傳聯絡 QR 圖（從 KV）。沒有則 404。
 */
async function handleAssetQr(request, env) {
  let value = null;
  let metadata = null;
  try {
    const r = await env.CONFIG_KV.getWithMetadata("asset:qr", { type: "arrayBuffer" });
    value = r.value;
    metadata = r.metadata;
  } catch (_) {
    value = null;
  }
  if (!value) return new Response("Not Found", { status: 404 });
  const ct = (metadata && metadata.ct) || "image/png";
  return new Response(value, {
    status: 200,
    headers: {
      "Content-Type": ct,
      "Cache-Control": "public, max-age=86400",
      ...CORS_HEADERS,
    },
  });
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
 * 產生「啟動碼管理」區塊：生成表單 + 一鍵授權現有 + 啟動碼清單。
 */
function renderCodesSection(codes, config) {
  const list = Array.isArray(codes) ? codes : [];
  const now = Date.now();
  const rows = list.length
    ? list.map((c) => renderCodeRow(c, now)).join("")
    : `<div class="empty">尚無啟動碼，用上方表單產生。</div>`;
  const unused = list.filter((c) => c && c.status === "unused").length;
  const used = list.filter((c) => c && c.status === "used").length;
  return `
    <div class="block">
      <div class="block-head"><span class="block-title">產生啟動碼</span></div>
      <form method="POST" action="/admin/codes" class="gen-form">
        <input type="hidden" name="action" value="gen_batch">
        <div class="gen-grid">
          <div class="gen-field"><label>數量</label><input type="number" name="count" value="1" min="1" max="200"></div>
          <div class="gen-field"><label>有效天數（0＝永久）</label><input type="number" name="days" value="0" min="0"></div>
        </div>
        <input type="text" name="note" class="gen-input" placeholder="備註（選填）：經銷商 / 客戶名 / 檔期" style="margin-top:10px">
        <button class="btn btn-primary">＋ 產生啟動碼</button>
      </form>
      <form method="POST" action="/admin/device" class="gen-existing" onsubmit="return confirm('確定把目前所有現有裝置設為已授權（永久）？');">
        <input type="hidden" name="action" value="authorize_all">
        <input type="hidden" name="value" value="0">
        <button class="btn btn-secondary">🔓 一鍵授權所有現有裝置（永久）</button>
      </form>
    </div>

    <div class="block">
      <div class="block-head">
        <span class="block-title">啟動碼清單</span>
        <span class="count-pill">未用 ${unused} · 已用 ${used} · 共 ${list.length}</span>
      </div>
      <input type="text" class="search" id="codeSearch" placeholder="🔍 搜尋啟動碼 / 備註 / 綁定裝置" oninput="filterCodes()">
      <div class="filters">
        <button type="button" class="fchip active" data-f="all" onclick="setCodeFilter(this)">全部</button>
        <button type="button" class="fchip" data-f="unused" onclick="setCodeFilter(this)">未使用</button>
        <button type="button" class="fchip" data-f="used" onclick="setCodeFilter(this)">已啟用</button>
        <button type="button" class="fchip" data-f="expired" onclick="setCodeFilter(this)">已到期</button>
        <button type="button" class="fchip" data-f="revoked" onclick="setCodeFilter(this)">已撤銷</button>
      </div>
      <div class="code-list" id="codeList">${rows}</div>
    </div>`;
}

/**
 * 單一啟動碼列。狀態：未使用 / 已啟用 / 已到期 / 已撤銷。
 */
function renderCodeRow(c, now) {
  const code = String(c && c.code != null ? c.code : "");
  const status = c && c.status ? c.status : "unused";
  const note = String(c && c.note ? c.note : "");
  const device = String(c && c.device ? c.device : "");
  const expireAt = c && c.expireAt ? c.expireAt : "";
  const days = c && typeof c.days === "number" ? c.days : 0;
  const codeAttr = escapeHtml(code);

  let badge;
  if (status === "revoked") {
    badge = `<span class="badge dev-blocked">已撤銷</span>`;
  } else if (status === "used") {
    if (expireAt && (Date.parse(expireAt) || 0) <= now) {
      badge = `<span class="badge dev-blocked">已到期</span>`;
    } else {
      badge = `<span class="badge on">已啟用</span>`;
    }
  } else {
    badge = `<span class="badge dev-active">未使用</span>`;
  }

  const termText =
    status === "unused"
      ? days > 0
        ? days + " 天"
        : "永久"
      : expireAt
      ? "到期 " + formatTaipeiFull(expireAt)
      : "永久";

  const metaParts = [];
  if (device) metaParts.push("綁定 " + escapeHtml(device));
  metaParts.push(escapeHtml(termText));
  if (note) metaParts.push("📝 " + escapeHtml(note));

  const revokeBtn =
    status !== "revoked"
      ? `<form class="dev-form" method="POST" action="/admin/codes">
          <input type="hidden" name="code" value="${codeAttr}">
          <input type="hidden" name="action" value="revoke">
          <button type="submit" class="btn-mini btn-danger">撤銷</button>
        </form>`
      : "";
  const delBtn = `<form class="dev-form" method="POST" action="/admin/codes" onsubmit="return confirm('刪除此啟動碼？');">
      <input type="hidden" name="code" value="${codeAttr}">
      <input type="hidden" name="action" value="delete">
      <button type="submit" class="btn-mini">刪除</button>
    </form>`;

  const searchKey = (code + " " + note + " " + device).toLowerCase().replace(/"/g, "");
  const statusKey =
    status === "revoked"
      ? "revoked"
      : status === "used"
      ? expireAt && (Date.parse(expireAt) || 0) <= now
        ? "expired"
        : "used"
      : "unused";
  return `<div class="code-row" data-status="${statusKey}" data-search="${escapeHtml(searchKey)}">
    <div class="code-row-top">
      <span class="code-val mono">${codeAttr}</span>
      ${badge}
    </div>
    <div class="code-row-meta">${metaParts.join(" · ")}</div>
    <div class="code-row-actions">${revokeBtn}${delBtn}</div>
  </div>`;
}

/**
 * 產生「裝置管理」區塊 HTML（沿用既有深色卡片樣式）。
 * 每台一張卡片，附封鎖/解封、傳話、改暱稱、刪除操作。
 */
function renderDevicesSection(devices) {
  const list = Array.isArray(devices) ? devices : [];
  const body = list.length
    ? list.map((d) => renderDeviceCard(d)).join("")
    : `<div class="empty">尚無裝置上線（盒子裝好 App 開過後會出現）</div>`;
  return `
    <div class="block">
      <div class="block-head">
        <span class="block-title">裝置清單</span>
        <span class="count-pill">共 ${list.length} 台</span>
      </div>
      <input type="text" class="search" id="devSearch" placeholder="🔍 搜尋編號 / 暱稱 / 機型" oninput="filterDevs()">
      <div class="filters">
        <button type="button" class="fchip active" data-f="all" onclick="setDevFilter(this)">全部</button>
        <button type="button" class="fchip" data-f="online" onclick="setDevFilter(this)">在線</button>
        <button type="button" class="fchip" data-f="unauth" onclick="setDevFilter(this)">未授權</button>
        <button type="button" class="fchip" data-f="blocked" onclick="setDevFilter(this)">已封鎖</button>
      </div>
      <div class="bulk-row">
        <span class="bulk-label">批量開機自啟</span>
        <form class="row-form" method="POST" action="/admin/device"><input type="hidden" name="action" value="autostart_all"><input type="hidden" name="value" value="on"><button class="btn-mini btn-ok">全部開</button></form>
        <form class="row-form" method="POST" action="/admin/device"><input type="hidden" name="action" value="autostart_all"><input type="hidden" name="value" value="off"><button class="btn-mini">全部關</button></form>
      </div>
      <div class="dev-list" id="devList">${body}</div>
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
  const model = d && d.m ? d.m : "";
  const ver = d && d.v ? d.v : "";
  const now = Date.now();
  const online = !!(d && d.lastSeen && now - (Date.parse(d.lastSeen) || 0) < 86400000);

  const authed = !!(d && d.authorized);
  const dExpireAt = d && d.expireAt ? d.expireAt : "";
  const dExpired = authed && dExpireAt && (Date.parse(dExpireAt) || 0) <= now;
  const authActive = authed && !dExpired;
  const authText = !authed
    ? "未授權"
    : dExpired
    ? "已到期"
    : dExpireAt
    ? "至 " + formatTaipeiFull(dExpireAt)
    : "永久";

  const hasAutostart = d && typeof d.autostart === "boolean";
  const autostartOn = hasAutostart ? d.autostart : false;
  const autostartText = !hasAutostart ? "預設" : autostartOn ? "開" : "關";
  const autostartNext = hasAutostart && autostartOn ? "off" : "on";

  const badges =
    `<span class="sdot ${online ? "on" : "off"}" title="${online ? "24h 內在線" : "離線"}"></span>` +
    (authActive
      ? `<span class="badge ok-b">已授權</span>`
      : dExpired
      ? `<span class="badge warn-b">已到期</span>`
      : `<span class="badge mute-b">未授權</span>`) +
    (blocked ? `<span class="badge danger-b">已封鎖</span>` : "");

  let srcFact;
  if (d && d.lastResultAt) {
    srcFact = d.lastOk
      ? ["來源", "✓ " + (d.lastCount != null ? d.lastCount : 0) + " 台", "ok"]
      : ["來源", "✕ 失敗", "bad"];
  } else {
    srcFact = ["來源", "未回報", "mute"];
  }
  const facts = [
    ["授權", authText, authActive ? "ok" : dExpired ? "bad" : "mute"],
    srcFact,
    ["開機自啟", autostartText, hasAutostart ? (autostartOn ? "ok" : "mute") : "mute"],
    ["機型", model || "-", "mute"],
    ["版本", ver || "-", "mute"],
    ["最後上線", relativeTime(d && d.lastSeen) || "-", "mute"],
    ["累計", (d && d.count != null ? d.count : 0) + " 次", "mute"],
    ["IP", d && d.ip ? d.ip : "-", "mute"],
  ];
  const factsHtml = facts
    .map(
      (f) =>
        `<div class="fact"><span class="fk">${f[0]}</span><span class="fv ${f[2]}">${escapeHtml(
          f[1]
        )}</span></div>`
    )
    .join("");

  const currentMsg = msg
    ? `<div class="dev-curmsg ${
        msgLevel === "warn" ? "lv-warn" : "lv-info"
      }">💬 ${escapeHtml(msg)}</div>`
    : "";

  const blockForm = blocked
    ? devForm(idAttr, "unblock", "解除封鎖", "ok")
    : devForm(idAttr, "block", "封鎖", "danger");

  const primary = `
      <form class="row-form" method="POST" action="/admin/device">
        <input type="hidden" name="id" value="${idAttr}">
        <input type="hidden" name="action" value="authorize">
        <input type="number" name="value" class="mini-input mini-days" placeholder="天" value="0" min="0">
        <button class="btn-mini btn-ok" title="0=永久">授權</button>
      </form>
      ${authed ? devForm(idAttr, "deauthorize", "撤銷授權", "danger") : ""}
      ${blockForm}`;

  const more = `
      <form class="row-form wide" method="POST" action="/admin/device">
        <input type="hidden" name="id" value="${idAttr}">
        <input type="hidden" name="action" value="message">
        <input type="text" name="value" class="mini-input grow" placeholder="傳話內容…" value="${escapeHtml(
          msg
        )}">
        <select name="level" class="mini-select">
          <option value="info"${msgLevel === "info" ? " selected" : ""}>一般</option>
          <option value="warn"${msgLevel === "warn" ? " selected" : ""}>警告</option>
        </select>
        <button class="btn-mini btn-ok">傳話</button>
      </form>
      <div class="btn-row">
        ${devForm(idAttr, "clearmsg", "清除訊息", "")}
        <form class="row-form" method="POST" action="/admin/device">
          <input type="hidden" name="id" value="${idAttr}">
          <input type="hidden" name="action" value="autostart">
          <input type="hidden" name="value" value="${autostartNext}">
          <button class="btn-mini">開機自啟 ${autostartNext === "on" ? "開" : "關"}</button>
        </form>
      </div>
      <form class="row-form wide" method="POST" action="/admin/device">
        <input type="hidden" name="id" value="${idAttr}">
        <input type="hidden" name="action" value="rename">
        <input type="text" name="value" class="mini-input grow" placeholder="裝置暱稱…" value="${escapeHtml(
          nick
        )}">
        <button class="btn-mini">改暱稱</button>
      </form>
      <form class="row-form" method="POST" action="/admin/device" onsubmit="return confirm('確定刪除這台裝置紀錄？');">
        <input type="hidden" name="id" value="${idAttr}">
        <input type="hidden" name="action" value="delete">
        <button class="btn-mini btn-danger">刪除裝置紀錄</button>
      </form>`;

  const searchKey = (id + " " + nick + " " + model).toLowerCase().replace(/"/g, "");

  return `<div class="dev-card" data-search="${escapeHtml(searchKey)}" data-online="${
    online ? 1 : 0
  }" data-authed="${authActive ? 1 : 0}" data-blocked="${blocked ? 1 : 0}">
    <div class="dev-head">
      <div class="dev-title">
        <div class="dev-name">${escapeHtml(title)}</div>
        <div class="dev-id mono">${idAttr}</div>
      </div>
      <div class="dev-badges">${badges}</div>
    </div>
    <div class="facts">${factsHtml}</div>
    ${currentMsg}
    <div class="dev-primary">${primary}</div>
    <details class="dev-more">
      <summary>更多操作 ▾</summary>
      <div class="dev-more-body">${more}</div>
    </details>
  </div>`;
}

/** 產生一個只有隱藏欄位 + 單一按鈕的裝置操作小表單 */
function devForm(idAttr, action, label, kind) {
  const cls = kind === "ok" ? " btn-ok" : kind === "danger" ? " btn-danger" : "";
  return `<form class="row-form" method="POST" action="/admin/device">
        <input type="hidden" name="id" value="${idAttr}">
        <input type="hidden" name="action" value="${action}">
        <button class="btn-mini${cls}">${label}</button>
      </form>`;
}

/**
 * 產生管理頁主畫面 HTML（深色、大按鈕、RWD）。
 */
function renderAdminHtml(config, devices, codes) {
  const devList = Array.isArray(devices) ? devices : [];
  const codeList = Array.isArray(codes) ? codes : [];
  const now = Date.now();
  const DAY = 86400000;
  const devAuthed = (d) =>
    d && d.authorized === true && (!d.expireAt || (Date.parse(d.expireAt) || 0) > now);
  const stat = {
    total: devList.length,
    online: devList.filter(
      (d) => d && d.lastSeen && now - (Date.parse(d.lastSeen) || 0) < DAY
    ).length,
    authed: devList.filter(devAuthed).length,
  };
  stat.unauth = stat.total - stat.authed;
  const codeStat = {
    total: codeList.length,
    used: codeList.filter((c) => c && c.status === "used").length,
    unused: codeList.filter((c) => c && c.status === "unused").length,
  };
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
  .wrap { max-width: 720px; margin: 0 auto; }

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
  .dev-bulk {
    display: flex; flex-wrap: wrap; align-items: center; gap: 8px;
    padding: 11px 13px; margin-bottom: 14px;
    background: var(--surface-2); border: 1px solid var(--border); border-radius: 12px;
  }
  .dev-bulk-label { font-size: 13px; font-weight: 600; color: var(--text); margin-right: auto; }
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
  .dev-source { margin-top: 8px; font-size: 12.5px; font-weight: 600; }
  .dev-source.ok { color: var(--accent); }
  .dev-source.bad { color: var(--danger); }
  .dev-source.none { color: var(--text-dim); }
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

  /* 概覽儀表板 */
  .stat-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 9px; }
  .stat-box { background: var(--surface-2); border: 1px solid var(--border); border-radius: 12px; padding: 13px 10px; text-align: center; }
  .sb-num { font-size: 26px; font-weight: 800; color: var(--text); line-height: 1.1; }
  .sb-num.accent { color: var(--accent); }
  .sb-num.ok { color: #34D399; }
  .sb-num.warn { color: var(--gold); }
  .sb-label { font-size: 11.5px; color: var(--text-dim); margin-top: 4px; }
  .auth-banner { margin-top: 13px; padding: 11px 13px; border-radius: 11px; font-size: 13px; line-height: 1.6; border: 1px solid var(--border); }
  .auth-banner b { font-weight: 700; }
  .auth-banner.on { color: var(--accent); background: rgba(45,212,191,0.08); border-color: rgba(45,212,191,0.32); }
  .auth-banner.off { color: var(--text-dim); background: var(--surface-2); }

  /* 區段分隔 */
  .section-sep { margin: 24px 0 6px; padding-top: 16px; border-top: 1px dashed var(--border); font-size: 13px; font-weight: 700; color: var(--accent); letter-spacing: 0.5px; }

  /* 啟動碼生成表單 */
  .gen-form { background: var(--surface-2); border: 1px solid var(--border); border-radius: 13px; padding: 14px; margin-bottom: 12px; }
  .gen-grid { display: flex; gap: 10px; }
  .gen-field { flex: 1; }
  .gen-field label, .gen-label { display: block; font-size: 12.5px; color: var(--text-dim); font-weight: 600; margin: 0 0 6px; }
  .gen-label { margin-top: 12px; }
  .gen-field input, .gen-input { width: 100%; padding: 12px 13px; font-size: 16px; border-radius: 11px; border: 1px solid var(--border); background: var(--bg-1); color: var(--text); font-family: inherit; }
  .gen-field input:focus, .gen-input:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px rgba(45,212,191,0.16); }
  .gen-form .btn { margin-top: 14px; }
  .gen-existing { margin-bottom: 14px; }
  .gen-existing .btn { margin-top: 0; }

  /* 啟動碼清單 */
  .code-list { display: flex; flex-direction: column; gap: 8px; max-height: 460px; overflow-y: auto; }
  .code-row { background: var(--surface-2); border: 1px solid var(--border); border-radius: 12px; padding: 12px 13px; }
  .code-row-top { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
  .code-val { font-size: 20px; font-weight: 700; color: var(--accent); letter-spacing: 2px; word-break: break-all; }
  .code-row-meta { color: var(--text-dim); font-size: 12.5px; margin-top: 7px; word-break: break-all; }
  .code-row-actions { display: flex; gap: 8px; margin-top: 10px; }
  .dev-days { flex: 0 0 92px !important; min-width: 0; }

  /* ── 頂欄 + 分頁 ── */
  .topbar { display:flex; align-items:center; justify-content:space-between; gap:10px; margin:2px 2px 14px; }
  .ver-pill { font-size:12px; color:var(--text-dim); border:1px solid var(--border); border-radius:999px; padding:5px 11px; white-space:nowrap; }
  .tabs { display:flex; gap:6px; overflow-x:auto; padding-bottom:4px; margin-bottom:18px; }
  .tabs::-webkit-scrollbar { display:none; }
  .tab {
    flex:0 0 auto; display:inline-flex; align-items:center; gap:6px;
    padding:10px 15px; font-size:14px; font-weight:700; font-family:inherit;
    color:var(--text-dim); background:var(--surface-2); border:1px solid var(--border);
    border-radius:11px; cursor:pointer; white-space:nowrap; transition:all .15s;
  }
  .tab:hover { color:var(--text); }
  .tab.active { color:#04201E; background:linear-gradient(135deg,var(--accent),var(--accent-deep)); border-color:transparent; box-shadow:0 6px 16px -8px rgba(45,212,191,.6); }
  .tab .tdot { width:7px; height:7px; border-radius:50%; background:var(--gold); }

  .panel { display:none; }
  .panel.active { display:block; animation:fade .2s ease; }
  @keyframes fade { from{opacity:0; transform:translateY(4px);} to{opacity:1; transform:none;} }

  /* ── 區塊(分頁內的子卡) ── */
  .block { background:var(--surface); border:1px solid var(--border); border-radius:15px; padding:16px; margin-bottom:14px; box-shadow:0 10px 30px -20px rgba(0,0,0,.8); }
  .block-head { display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:13px; }
  .block-title { font-size:14px; font-weight:700; color:var(--text); }
  .count-pill { font-size:12px; color:var(--text-dim); background:var(--surface-2); border:1px solid var(--border); border-radius:999px; padding:4px 10px; white-space:nowrap; }

  /* ── 搜尋 + 篩選 ── */
  .search { width:100%; padding:12px 14px; font-size:16px; border-radius:11px; border:1px solid var(--border); background:var(--surface-2); color:var(--text); font-family:inherit; margin-bottom:10px; }
  .search:focus { outline:none; border-color:var(--accent); box-shadow:0 0 0 3px rgba(45,212,191,.16); }
  .filters { display:flex; flex-wrap:wrap; gap:7px; margin-bottom:14px; }
  .fchip { padding:7px 13px; font-size:13px; font-weight:600; font-family:inherit; color:var(--text-dim); background:var(--surface-2); border:1px solid var(--border); border-radius:999px; cursor:pointer; transition:all .12s; }
  .fchip:hover { color:var(--text); }
  .fchip.active { color:var(--accent); background:rgba(45,212,191,.10); border-color:rgba(45,212,191,.4); }

  .empty { color:var(--text-dim); font-size:14px; text-align:center; padding:26px 10px; }

  /* ── 裝置卡(精簡版) ── */
  .dev-list { display:flex; flex-direction:column; gap:11px; }
  .dev-card.hide, .code-row.hide { display:none; }
  .dev-head { display:flex; align-items:flex-start; justify-content:space-between; gap:10px; }
  .dev-title { min-width:0; }
  .dev-name { font-size:16px; font-weight:700; color:var(--text); word-break:break-all; }
  .dev-id { font-size:11.5px; color:var(--accent); margin-top:2px; word-break:break-all; }
  .dev-badges { display:flex; align-items:center; gap:6px; flex:0 0 auto; flex-wrap:wrap; justify-content:flex-end; }
  .sdot { width:9px; height:9px; border-radius:50%; }
  .sdot.on { background:#34D399; box-shadow:0 0 8px rgba(52,211,153,.7); }
  .sdot.off { background:#4A5568; }
  .ok-b { color:var(--accent); background:rgba(45,212,191,.12); border:1px solid rgba(45,212,191,.35); }
  .warn-b { color:var(--gold); background:rgba(251,191,36,.12); border:1px solid rgba(251,191,36,.35); }
  .mute-b { color:var(--text-dim); background:rgba(151,162,180,.10); border:1px solid var(--border); }
  .danger-b { color:var(--danger); background:rgba(255,77,94,.12); border:1px solid rgba(255,77,94,.4); }
  .facts { display:grid; grid-template-columns:repeat(2,1fr); gap:6px 12px; margin:12px 0 4px; }
  .fact { display:flex; justify-content:space-between; gap:8px; font-size:12.5px; border-bottom:1px dashed #1b2231; padding-bottom:5px; }
  .fk { color:var(--text-dim); flex:0 0 auto; }
  .fv { font-weight:600; text-align:right; word-break:break-all; }
  .fv.ok { color:var(--accent); } .fv.bad { color:var(--danger); } .fv.mute { color:var(--text); }
  .dev-primary { display:flex; flex-wrap:wrap; gap:8px; margin-top:12px; }
  .dev-more { margin-top:10px; }
  .dev-more summary { cursor:pointer; font-size:13px; color:var(--text-dim); list-style:none; padding:7px 0; user-select:none; }
  .dev-more summary::-webkit-details-marker { display:none; }
  .dev-more[open] summary { color:var(--accent); }
  .dev-more-body { display:flex; flex-direction:column; gap:8px; padding-top:6px; }
  .row-form { display:flex; gap:8px; align-items:center; margin:0; }
  .row-form.wide { width:100%; }
  .btn-row { display:flex; gap:8px; flex-wrap:wrap; }
  .mini-input { padding:9px 11px; font-size:15px; border-radius:9px; border:1px solid var(--border); background:var(--bg-1); color:var(--text); font-family:inherit; min-width:0; }
  .mini-input.grow { flex:1 1 auto; }
  .mini-days { width:64px; flex:0 0 64px; }
  .mini-select { padding:9px 8px; font-size:14px; border-radius:9px; border:1px solid var(--border); background:var(--bg-1); color:var(--text); font-family:inherit; }
  .bulk-row { display:flex; flex-wrap:wrap; align-items:center; gap:8px; padding:10px 12px; margin-bottom:13px; background:var(--surface-2); border:1px solid var(--border); border-radius:11px; }
  .bulk-label { font-size:13px; font-weight:600; margin-right:auto; }

  .hint-line { font-size:12.5px; color:var(--gold); background:rgba(251,191,36,.08); border:1px solid rgba(251,191,36,.25); border-radius:9px; padding:9px 11px; margin-top:10px; }
  .hint-line b { color:var(--gold); }
  .qr-preview { display:flex; justify-content:center; padding:12px; background:#fff; border-radius:12px; margin-bottom:6px; }
  .qr-preview img { max-width:200px; max-height:200px; width:auto; height:auto; display:block; }
  .file-input { width:100%; padding:11px; font-size:14px; border-radius:11px; border:1px dashed var(--border); background:var(--surface-2); color:var(--text-dim); font-family:inherit; margin-bottom:4px; }

  .footnote { text-align: center; color: var(--text-dim); font-size: 12.5px; margin-top: 24px; }
</style>
</head>
<body>
<div class="wrap">
  <header class="topbar">
    <div class="brand"><span class="dot"></span><h1>偉電視 · 管理中心</h1></div>
    <div class="ver-pill">設定 v${escapeHtml(config.version)}</div>
  </header>

  <nav class="tabs">
    <button type="button" class="tab active" data-tab="overview" onclick="showTab('overview',this)">📊 總覽</button>
    <button type="button" class="tab" data-tab="source" onclick="showTab('source',this)">📡 直播源</button>
    <button type="button" class="tab" data-tab="auth" onclick="showTab('auth',this)">🎟️ 授權</button>
    <button type="button" class="tab" data-tab="devices" onclick="showTab('devices',this)">📺 裝置${
      stat.unauth > 0 ? ' <span class="tdot"></span>' : ""
    }</button>
    <button type="button" class="tab" data-tab="notice" onclick="showTab('notice',this)">📣 通知</button>
    <button type="button" class="tab" data-tab="system" onclick="showTab('system',this)">⚙️ 系統</button>
  </nav>

  <section class="panel active" data-panel="overview">
    <div class="block">
      <div class="block-head"><span class="block-title">📊 營運概覽</span></div>
      <div class="stat-grid">
        <div class="stat-box"><div class="sb-num">${stat.total}</div><div class="sb-label">總裝置</div></div>
        <div class="stat-box"><div class="sb-num accent">${stat.online}</div><div class="sb-label">24h 在線</div></div>
        <div class="stat-box"><div class="sb-num ok">${stat.authed}</div><div class="sb-label">已授權</div></div>
        <div class="stat-box"><div class="sb-num ${stat.unauth > 0 ? "warn" : ""}">${stat.unauth}</div><div class="sb-label">未授權</div></div>
        <div class="stat-box"><div class="sb-num">${codeStat.unused}</div><div class="sb-label">未用碼</div></div>
        <div class="stat-box"><div class="sb-num">${codeStat.used}</div><div class="sb-label">已用碼</div></div>
      </div>
      <div class="auth-banner ${config.requireActivation ? "on" : "off"}">
        ${
          config.requireActivation
            ? "🔒 授權機制 <b>已啟用</b>：未授權或到期的盒子無法取得直播源。"
            : "🔓 授權機制 <b>未啟用</b>：目前所有盒子皆可觀看（到「授權」分頁開啟）。"
        }
      </div>
    </div>
    <div class="block">
      <div class="block-head"><span class="block-title">目前設定摘要</span></div>
      <div class="info-grid">
        <div class="chip"><div class="k">設定版本</div><div class="v">v${escapeHtml(config.version)}</div></div>
        <div class="chip"><div class="k">輪詢間隔</div><div class="v">${escapeHtml(config.pollIntervalMinutes)} 分</div></div>
        <div class="chip"><div class="k">開機自啟（全域）</div><div class="v"><span class="badge ${config.autostart ? "on" : "off"}">${config.autostart ? "開啟" : "關閉"}</span></div></div>
        <div class="chip" style="flex-basis:100%;"><div class="k">最後更新</div><div class="v mono">${escapeHtml(config.updatedAt)}</div></div>
        <div class="chip" style="flex-basis:100%;"><div class="k">目前訂閱網址</div><div class="v mono">${escapeHtml(config.subscriptionUrl) || "（尚未設定）"}</div></div>
      </div>
    </div>
  </section>

  <section class="panel" data-panel="source">
    <form class="block" method="POST" action="/admin/save">
      <input type="hidden" name="_fields" value="source">
      <div class="block-head"><span class="block-title">📡 直播源</span></div>
      <label for="subscriptionUrl">訂閱網址<span class="hint">含 token 的 m3u8 清單網址；App 不內建 token，一律由此下發</span></label>
      <textarea id="subscriptionUrl" name="subscriptionUrl">${escapeHtml(config.subscriptionUrl)}</textarea>
      <button type="button" class="btn btn-secondary" onclick="testSource()">測試來源</button>
      <div id="testResult"></div>
      <button type="submit" class="btn btn-primary">儲存直播源</button>
    </form>
  </section>

  <section class="panel" data-panel="auth">
    <form class="block" method="POST" action="/admin/save">
      <input type="hidden" name="_fields" value="auth">
      <div class="block-head"><span class="block-title">🔐 授權設定</span></div>
      <div class="switch-row">
        <input type="checkbox" id="requireActivation" name="requireActivation" ${config.requireActivation ? "checked" : ""}>
        <label for="requireActivation">啟用啟動碼授權（未授權／到期盒子無法觀看）</label>
      </div>
      <label for="activationTitle">啟動畫面標題<span class="hint">App 開啟與輸入啟動碼時顯示</span></label>
      <input type="text" id="activationTitle" name="activationTitle" value="${escapeHtml(config.activationTitle || "")}">
      <label for="activationText">啟動畫面說明文字<span class="hint">可換行；可放歡迎語、客服聯絡方式</span></label>
      <textarea id="activationText" name="activationText">${escapeHtml(config.activationText || "")}</textarea>
      <label for="codeDigits">啟動碼位數（4～12，方便遙控器輸入）</label>
      <input type="number" id="codeDigits" name="codeDigits" min="4" max="12" value="${escapeHtml(config.codeDigits || 8)}">
      <button type="submit" class="btn btn-primary">儲存授權設定</button>
    </form>
    ${renderCodesSection(codeList, config)}
  </section>

  <section class="panel" data-panel="devices">
    ${renderDevicesSection(devices)}
  </section>

  <section class="panel" data-panel="notice">
    <form class="block" method="POST" action="/admin/save">
      <input type="hidden" name="_fields" value="notice">
      <div class="block-head"><span class="block-title">📢 公告（固定膠囊）</span></div>
      <label for="notice">公告文字<span class="hint">顯示在盒子畫面；留空則不顯示</span></label>
      <textarea id="notice" name="notice">${escapeHtml(config.notice)}</textarea>
      <label for="noticeHours">自動消失時數<span class="hint">0＝常駐不消失；例如 24＝一天後自動撤下</span></label>
      <input type="number" id="noticeHours" name="noticeHours" min="0" step="0.5" value="0" placeholder="0">
      ${
        config.noticeUntil
          ? `<div class="hint-line">⏱ 目前公告將於 <b>${escapeHtml(
              formatTaipeiFull(config.noticeUntil)
            )}</b> 自動消失</div>`
          : ""
      }
      <button type="submit" class="btn btn-primary">儲存公告</button>
    </form>

    <form class="block" method="POST" action="/admin/save">
      <input type="hidden" name="_fields" value="marquee">
      <div class="block-head"><span class="block-title">🏃 臨時跑馬燈（滾動）</span></div>
      <label for="marquee">跑馬燈文字<span class="hint">在畫面頂部滾動；適合臨時通知</span></label>
      <textarea id="marquee" name="marquee">${escapeHtml(config.marquee || "")}</textarea>
      <label for="marqueeMinutes">顯示分鐘數<span class="hint">時間到自動消失；0＝不顯示／清除</span></label>
      <input type="number" id="marqueeMinutes" name="marqueeMinutes" min="0" value="0" placeholder="例如 30">
      ${
        config.marqueeUntil && (Date.parse(config.marqueeUntil) || 0) > Date.now()
          ? `<div class="hint-line">⏱ 跑馬燈將於 <b>${escapeHtml(
              formatTaipeiFull(config.marqueeUntil)
            )}</b> 自動消失</div>`
          : ""
      }
      <button type="submit" class="btn btn-primary">發送跑馬燈</button>
    </form>

    <div class="block">
      <div class="block-head"><span class="block-title">📷 聯絡我們 QR（顯示在 App）</span></div>
      ${
        config.contactQrVer > 0
          ? `<div class="qr-preview"><img src="/asset/qr?v=${config.contactQrVer}" alt="聯絡 QR"></div>`
          : `<div class="empty">尚未上傳 QR 圖</div>`
      }
      <form method="POST" action="/admin/save">
        <input type="hidden" name="_fields" value="contact">
        <label for="contactText">聯絡說明文字<span class="hint">顯示在 QR 旁，例如「掃碼加 LINE 客服」</span></label>
        <input type="text" id="contactText" name="contactText" value="${escapeHtml(
          config.contactText || ""
        )}">
        <button type="submit" class="btn btn-secondary">儲存聯絡文字</button>
      </form>
      <form method="POST" action="/admin/upload" enctype="multipart/form-data" style="margin-top:12px">
        <label>上傳 QR 圖檔<span class="hint">PNG / JPG，小於 2MB</span></label>
        <input type="file" name="file" accept="image/*" class="file-input">
        <button type="submit" class="btn btn-primary">上傳 QR</button>
      </form>
      ${
        config.contactQrVer > 0
          ? `<form method="POST" action="/admin/upload" onsubmit="return confirm('確定移除 QR 圖？');" style="margin-top:8px"><input type="hidden" name="action" value="remove"><button class="btn btn-secondary">移除 QR</button></form>`
          : ""
      }
    </div>
  </section>

  <section class="panel" data-panel="system">
    <form class="block" method="POST" action="/admin/save">
      <input type="hidden" name="_fields" value="system">
      <div class="block-head"><span class="block-title">⚙️ 系統設定</span></div>
      <label for="pollIntervalMinutes">盒子輪詢間隔（分鐘）</label>
      <input type="number" id="pollIntervalMinutes" name="pollIntervalMinutes" min="1" value="${escapeHtml(config.pollIntervalMinutes)}">
      <div class="switch-row">
        <input type="checkbox" id="forceRefresh" name="forceRefresh" ${config.forceRefresh ? "checked" : ""}>
        <label for="forceRefresh">強制刷新（盒子下次輪詢立即重載來源）</label>
      </div>
      <div class="switch-row">
        <input type="checkbox" id="autostart" name="autostart" ${config.autostart ? "checked" : ""}>
        <label for="autostart">開機自動啟動（全域預設；可在「裝置」分頁個別覆蓋）</label>
      </div>
      <button type="submit" class="btn btn-primary">儲存系統設定</button>
    </form>
    <div class="footnote">App 設定端點 <code>/api/config</code> · 啟動端點 <code>/api/activate</code></div>
  </section>
</div>

<script>
// 分頁切換（記住目前分頁，操作後返回不跳回第一頁）
function showTab(name, el) {
  document.querySelectorAll('.panel').forEach(function(p){ p.classList.toggle('active', p.dataset.panel === name); });
  document.querySelectorAll('.tab').forEach(function(t){ t.classList.remove('active'); });
  if (el) el.classList.add('active');
  try { localStorage.setItem('weitvTab', name); } catch(e){}
}
function restoreTab() {
  var name; try { name = localStorage.getItem('weitvTab'); } catch(e){}
  if (!name) return;
  var btn = document.querySelector('.tab[data-tab="'+name+'"]');
  if (btn) showTab(name, btn);
}
// 裝置搜尋 + 篩選
var devFilter = 'all';
function setDevFilter(el){ devFilter = el.dataset.f; el.parentNode.querySelectorAll('.fchip').forEach(function(c){c.classList.remove('active');}); el.classList.add('active'); filterDevs(); }
function filterDevs(){
  var box = document.getElementById('devSearch');
  var q = (box ? box.value : '').trim().toLowerCase();
  document.querySelectorAll('#devList .dev-card').forEach(function(card){
    var okText = !q || (card.dataset.search||'').indexOf(q) >= 0;
    var okFilter = devFilter === 'all'
      || (devFilter === 'online' && card.dataset.online === '1')
      || (devFilter === 'unauth' && card.dataset.authed === '0')
      || (devFilter === 'blocked' && card.dataset.blocked === '1');
    card.classList.toggle('hide', !(okText && okFilter));
  });
}
// 啟動碼搜尋 + 篩選
var codeFilter = 'all';
function setCodeFilter(el){ codeFilter = el.dataset.f; el.parentNode.querySelectorAll('.fchip').forEach(function(c){c.classList.remove('active');}); el.classList.add('active'); filterCodes(); }
function filterCodes(){
  var box = document.getElementById('codeSearch');
  var q = (box ? box.value : '').trim().toLowerCase();
  document.querySelectorAll('#codeList .code-row').forEach(function(row){
    var okText = !q || (row.dataset.search||'').indexOf(q) >= 0;
    var okFilter = codeFilter === 'all' || row.dataset.status === codeFilter;
    row.classList.toggle('hide', !(okText && okFilter));
  });
}
document.addEventListener('DOMContentLoaded', restoreTab);

function renderBoxesHtml(b) {
  if (!b) return '';
  var inner;
  if (b.ok > 0) {
    inner = '<div style="margin-top:12px;padding:11px 13px;border-radius:10px;background:rgba(45,212,191,0.10);border:1px solid rgba(45,212,191,0.35);color:#2DD4BF;font-size:13px;line-height:1.7;">' +
      '\\u2705 盒子實測：' + b.ok + ' 台盒子最近成功載入(最多 ' + b.maxCount + ' 台,' + (b.recentRel || '') + ')\\u2014 這是真實結果,可放心儲存。' +
      '</div>';
  } else if (b.reported > 0) {
    inner = '<div style="margin-top:12px;padding:11px 13px;border-radius:10px;background:rgba(255,77,94,0.08);border:1px solid rgba(255,77,94,0.35);color:#FF4D5E;font-size:13px;line-height:1.7;">' +
      '盒子有回報,但最近未成功載入來源。' +
      '</div>';
  } else {
    inner = '<div style="margin-top:12px;padding:11px 13px;border-radius:10px;background:rgba(151,162,180,0.08);border:1px solid #273043;color:#97A2B4;font-size:13px;line-height:1.7;">' +
      '尚無盒子回報實測(盒子裝好 App 開過後,這裡會顯示真實載入結果)。' +
      '</div>';
  }
  return inner;
}
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
    var boxesHtml = renderBoxesHtml(data.boxes);
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
        '</div>' + boxesHtml;
    } else {
      el.innerHTML =
        '<div class="result-card bad"><div class="result-head">' +
          '<div class="result-icon">\\u2715</div>' +
          '<div><div class="result-title">測試失敗</div>' +
          '<div class="result-sub">' + (data.error || '未知錯誤') + '</div></div>' +
        '</div></div>' + boxesHtml;
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

/**
 * 偉電視（WeiTV）控制平面 — 共用工具與設定模型
 * ----------------------------------------------------------------
 * 這裡放所有模組共用的常數、KV 設定讀寫、回應產生器與小工具。
 * 沒有任何外部依賴，只用 Workers 內建的 Web API。
 */

/* ────────────────────────── KV key 常數 ────────────────────────── */

export const CONFIG_KEY = "config";
export const DEVICE_PREFIX = "dev:";
export const CODE_PREFIX = "code:";
export const OTA_CACHE_KEY = "update_cache";
export const QR_ASSET_KEY = "asset:qr";
export const RATE_PREFIX = "rl:";

/** 列舉上限（KV list 單次最多 1000 筆） */
export const DEVICE_LIST_MAX = 1000;
export const CODE_LIST_MAX = 1000;

/** 裝置紀錄「無變化時」最短寫回間隔（節省 KV 寫入配額；心跳每 90 秒但不必每次寫） */
export const DEVICE_WRITE_MIN_MS = 10 * 60 * 1000;

/** 裝置在線判定：lastSeen 在此時間內視為「線上」（心跳 90 秒 + 寫入節流 10 分鐘） */
export const ONLINE_MS = 15 * 60 * 1000;
/** lastSeen 在此時間內視為「今日曾上線」 */
export const TODAY_MS = 24 * 60 * 60 * 1000;

/** 遠端指令未送達的保留時間（超過就作廢，避免隔天才突然切台） */
export const CMD_TTL_MS = 6 * 60 * 60 * 1000;

/** 啟動碼嘗試限速：同一 IP 每 10 分鐘最多幾次 */
export const ACTIVATE_RL_MAX = 30;
export const ACTIVATE_RL_TTL_SEC = 600;

/* ────────────────────────── 預設設定 ────────────────────────── */

/**
 * 第一次讀取時若 KV 還沒有資料，就回傳這份並寫入 KV。
 * subscriptionUrl 預設「留空」（公開範本不含任何 token）。
 * 舊資料缺欄位時以此補齊，所以新增欄位一律在這裡給預設值。
 */
export const DEFAULT_CONFIG = {
  version: 1,
  subscriptionUrl: "",
  pollIntervalMinutes: 180,
  forceRefresh: false,
  autostart: true,
  notice: "",
  noticeUntil: "",
  marquee: "",
  marqueeUntil: "",
  contactText: "",
  contactQrVer: 0,
  // ── 授權機制 ──
  requireActivation: false,
  activationTitle: "歡迎使用偉電視",
  activationText: "請輸入啟動碼以開通本機。\n如需協助,請聯絡您的服務人員。",
  codeDigits: 8,
  // ── 盒子畫面（全域預設；裝置可個別覆蓋字體） ──
  // fontScale：auto（電視自動放大）/ normal / large / xlarge
  fontScale: "auto",
  // 播放畫面右上角常駐時鐘
  showClock: false,
  // 是否允許盒子提示 OTA 更新（關閉可避免長輩看到更新視窗）
  otaEnabled: true,
  updatedAt: "2026-06-26T00:00:00Z",
};

/** 字體大小選項（值 → 顯示名稱） */
export const FONT_SCALE_OPTIONS = [
  ["auto", "自動（電視放大）"],
  ["normal", "標準"],
  ["large", "大"],
  ["xlarge", "特大"],
];

/** 遠端指令型別（值 → 顯示名稱） */
export const CMD_TYPES = {
  reload: "重新載入頻道",
  tune: "切換頻道",
  restart: "重新啟動 App",
  clearcache: "清除快取並重載",
};

export function isValidFontScale(v) {
  return FONT_SCALE_OPTIONS.some((o) => o[0] === v);
}

/* ────────────────────────── CORS ────────────────────────── */

export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
};

/* ────────────────────────── 設定讀寫 ────────────────────────── */

/**
 * 從 KV 讀取設定；若不存在則寫入並回傳預設值。
 * 回傳一個保證欄位齊全的設定物件（舊資料缺欄位會被預設值補齊）。
 */
export async function loadConfig(env) {
  let stored = null;
  try {
    stored = await env.CONFIG_KV.get(CONFIG_KEY, { type: "json" });
  } catch (err) {
    console.error("KV 讀取失敗:", err);
    return { ...DEFAULT_CONFIG };
  }
  if (!stored || typeof stored !== "object") {
    try {
      await env.CONFIG_KV.put(CONFIG_KEY, JSON.stringify(DEFAULT_CONFIG));
    } catch (err) {
      console.error("KV 初始化寫入失敗:", err);
    }
    return { ...DEFAULT_CONFIG };
  }
  const merged = { ...DEFAULT_CONFIG, ...stored };
  if (!isValidFontScale(merged.fontScale)) merged.fontScale = "auto";
  return merged;
}

export async function saveConfig(env, config) {
  await env.CONFIG_KV.put(CONFIG_KEY, JSON.stringify(config));
}

/* ────────────────────────── 回應產生器 ────────────────────────── */

export function jsonResponse(obj, status, extraHeaders) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...(extraHeaders || {}),
    },
  });
}

export function htmlResponse(html, status) {
  return new Response(html, {
    status: status || 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "same-origin",
    },
  });
}

export function textResponse(text, status) {
  return new Response(text, {
    status: status || 200,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}

/** 管理頁前端以 fetch 送出時會帶這個標頭；有帶就回 JSON，沒帶就回傳統結果頁 */
export function wantsJson(request) {
  const x = (request.headers.get("X-Requested-With") || "").toLowerCase();
  if (x === "fetch" || x === "xmlhttprequest") return true;
  const accept = request.headers.get("Accept") || "";
  return /^application\/json\b/i.test(accept.trim());
}

/* ────────────────────────── 小工具 ────────────────────────── */

export function nowIso() {
  return new Date().toISOString();
}

export function clientIp(request) {
  return request.headers.get("cf-connecting-ip") || "";
}

/** 簡易 HTML escape，避免設定值內容破壞頁面或注入 */
export function escapeHtml(str) {
  return String(str == null ? "" : str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 放進 <script> 內的 JSON：把 </script> 與 U+2028/2029 行分隔符跳脫 */
export function jsonForScript(obj) {
  return JSON.stringify(obj)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/** ISO 時間 → 相對時間（如「3 分鐘前」）。解析失敗回傳空字串 */
export function relativeTime(iso, nowMs) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const diff = (nowMs || Date.now()) - d.getTime();
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

/** ISO 時間 → 台灣（GMT+8）YYYY/MM/DD HH:mm；解析失敗回傳原字串 */
export function formatTaipeiFull(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso == null ? "" : iso);
  const t = new Date(d.getTime() + 8 * 60 * 60 * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  return (
    t.getUTCFullYear() + "/" + pad(t.getUTCMonth() + 1) + "/" + pad(t.getUTCDate()) +
    " " + pad(t.getUTCHours()) + ":" + pad(t.getUTCMinutes())
  );
}

/** 台灣短時間 HH:mm */
export function formatTaipeiTime(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const t = new Date(d.getTime() + 8 * 60 * 60 * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  return pad(t.getUTCHours()) + ":" + pad(t.getUTCMinutes());
}

export function parseIntOr(v, fallback) {
  const n = parseInt(String(v == null ? "" : v), 10);
  return Number.isFinite(n) ? n : fallback;
}

export function parseFloatOr(v, fallback) {
  const n = parseFloat(String(v == null ? "" : v));
  return Number.isFinite(n) ? n : fallback;
}

/** 等長度安全比對，降低 timing attack 風險 */
export function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}

/* ────────────────────────── 裝置狀態判定 ────────────────────────── */

/** 裝置在線狀態：online（線上）/ today（今日曾上線）/ offline */
export function onlineState(dev, nowMs) {
  const t = Date.parse(dev && dev.lastSeen) || 0;
  if (!t) return "offline";
  const diff = (nowMs || Date.now()) - t;
  if (diff < ONLINE_MS) return "online";
  if (diff < TODAY_MS) return "today";
  return "offline";
}

/**
 * 計算裝置授權狀態。
 * requireActivation 關閉 → 一律授權（回傳裝置既有 expireAt 供顯示）。
 * 開啟 → 需 dev.authorized 為真且未過期（expireAt 空 = 永久）。
 */
export function computeAuth(dev, config) {
  const expireAt = (dev && dev.expireAt) || "";
  if (!config.requireActivation) return { authorized: true, expireAt };
  if (!dev || dev.authorized !== true) return { authorized: false, expireAt };
  if (expireAt) {
    const t = Date.parse(expireAt);
    if (Number.isFinite(t) && t <= Date.now()) return { authorized: false, expireAt };
  }
  return { authorized: true, expireAt };
}

/** 裝置的有效字體設定：裝置覆蓋 → 全域 */
export function effectiveFontScale(dev, config) {
  const v = dev && typeof dev.fontScale === "string" ? dev.fontScale : "";
  if (v && isValidFontScale(v)) return v;
  return isValidFontScale(config.fontScale) ? config.fontScale : "auto";
}

/** 待送達且未過期的遠端指令（沒有就 null） */
export function pendingCmd(dev, nowMs) {
  const c = dev && dev.cmd;
  if (!c || typeof c !== "object" || !c.id || !c.type) return null;
  const t = Date.parse(c.at) || 0;
  if (t && (nowMs || Date.now()) - t > CMD_TTL_MS) return null;
  return { id: String(c.id), type: String(c.type), arg: c.arg == null ? "" : String(c.arg) };
}

/* ────────────────────────── 簡易限速（KV 計數 + TTL） ────────────────────────── */

/**
 * 回傳 true 表示「已超過上限」。計數存 KV，靠 expirationTtl 自然歸零。
 * KV 讀寫任一失敗都視為未超限（不因限速機制故障而擋住正常使用者）。
 */
export async function rateLimited(env, bucket, key, max, ttlSec) {
  if (!key) return false;
  const k = RATE_PREFIX + bucket + ":" + key;
  let n = 0;
  try {
    n = parseIntOr(await env.CONFIG_KV.get(k), 0);
  } catch (_) {
    return false;
  }
  if (n >= max) return true;
  try {
    await env.CONFIG_KV.put(k, String(n + 1), { expirationTtl: Math.max(60, ttlSec) });
  } catch (_) {}
  return false;
}

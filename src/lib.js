/**
 * 偉電視（WeiTV）控制平面 — 共用工具與設定模型
 * ----------------------------------------------------------------
 * 這裡放所有模組共用的常數、KV 設定讀寫、回應產生器與小工具。
 * 沒有任何外部依賴，只用 Workers 內建的 Web API。
 */

/* ────────────────────────── KV key 常數 ────────────────────────── */

export const CONFIG_KEY = "config";
export const DEVICE_PREFIX = "dev:";
/** 管理員擁有的裝置欄位另存一把 key(暱稱 / 封鎖 / 授權 / 指令 / 監控…),盒子心跳永不寫它 → 不會被心跳的讀改寫蓋掉 */
export const DEVADM_PREFIX = "devadm:";
export const CODE_PREFIX = "code:";
export const OTA_CACHE_KEY = "update_cache";
export const QR_ASSET_KEY = "asset:qr";
export const RATE_PREFIX = "rl:";
/** 監控 / 警示狀態（monitor.js） */
export const MON_KEY = "mon:state";
/** 管理操作紀錄（環狀，最多 AUDIT_MAX 筆） */
export const AUDIT_KEY = "audit";
export const AUDIT_MAX = 200;
/** 設定版本歷史（最多 CFG_HIST_MAX 份快照，供還原） */
export const CFG_HIST_KEY = "cfghist";
export const CFG_HIST_MAX = 12;
/** 家用備援代理的登記紀錄（POST /api/home-proxy 寫入） */
export const HOME_PROXY_KEY = "homeproxy";
/** 家用代理登記內容沒變時，最短寫回間隔（省 KV 寫入額度） */
export const HOME_WRITE_MIN_MS = 30 * 60 * 1000;
/** 家用代理「線上」判定：最後紀錄在此時間內（寫入節流 30 分 ＋ 15 分寬限；紀錄最多舊 30 分鐘） */
export const HOME_ONLINE_MS = 45 * 60 * 1000;
/** /api/config 只把這段時間內登記過的家用代理下發給盒子 */
export const HOME_FRESH_MS = 2 * 60 * 60 * 1000;
/** 家用代理免金鑰登記：同一個公網 IP 在這段時間內要有已授權盒子的心跳 */
export const HOME_BOX_WINDOW_MS = 24 * 60 * 60 * 1000;

/** 程式版本（/api/health 回傳，部署後用來確認新版已生效） */
export const BUILD = "2.4.0";

/** 管理密碼猜錯限速：同一 IP 每 10 分鐘最多幾次 */
export const ADMIN_RL_MAX = 20;
export const ADMIN_RL_TTL_SEC = 600;
/** 新裝置登記限速：同一 IP 每小時最多建立幾台（防亂數 id 灌爆 KV 寫入額度） */
export const NEWDEV_RL_MAX = 10;
export const NEWDEV_RL_TTL_SEC = 3600;
/** 未授權的新裝置紀錄保留天數（沒人核准就自動消失；一旦授權會改成永久） */
export const NEWDEV_TTL_SEC = 7 * 86400;

/** 裝置紀錄裡屬於管理員的欄位（存 devadm:<id>；舊資料若還在 dev:<id> 會自動搬過去） */
export const ADMIN_DEVICE_FIELDS = ["nick", "blocked", "msg", "msgLevel", "autostart", "autostartAt", "authorized", "authedAt", "expireAt", "codeUsed", "fontScale", "cmd", "lastAck", "watch", "group", "note"];

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
  // 備援線路（選填；空 = 不用）：主線路連續失敗時盒子自動改用，兩份清單同名頻道合併成多條線路
  backupSubscriptionUrl: "",
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
  // ── 警示（只給管理員；不會下發到盒子，見 ADMIN_ONLY_KEYS） ──
  alertsEnabled: false,
  tgBotToken: "",
  tgChatId: "",
  // 直播源異常持續幾分鐘才通知（看門狗自己 5～15 分內多半會修好，太短會吵）
  alertSourceMin: 10,
  // 「重點監控」的盒子離線幾分鐘才通知
  alertDeviceOfflineMin: 180,
  // 靜音時段（台灣時間，例如 "23-7"；空 = 不靜音）
  alertQuiet: "",
  // 盒子回報載入頻道失敗時通知
  alertBoxFail: true,
  // ── 家用備援代理（家裡電腦跑的代理，POST /api/home-proxy 自動登記；只給同一個家的盒子） ──
  // backup：當備援線路（預設）｜primary：同一個家的盒子以家用清單為主、原本的主網址改當備援
  homeProxyRole: "backup",
  // 家用代理登記金鑰（選用，免金鑰時靠同一個家的已授權盒子擔保；管理員專用、不下發；第一次開管理頁時自動產生）
  homeProxyKey: "",
  updatedAt: "2026-06-26T00:00:00Z",
};

/** 這些欄位只屬於管理員，/api/config 一律不下發（含 Telegram token、家用代理金鑰） */
export const ADMIN_ONLY_KEYS = ["alertsEnabled", "tgBotToken", "tgChatId", "alertSourceMin", "alertDeviceOfflineMin", "alertQuiet", "alertBoxFail", "homeProxyRole", "homeProxyKey"];

/** 去掉管理員專用欄位後的設定（給盒子看的版本） */
export function publicConfig(config) {
  const out = { ...config };
  for (const k of ADMIN_ONLY_KEYS) delete out[k];
  return out;
}

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
 * KV 讀取失敗會丟出 KvUnavailable —— 呼叫端（/api/config）回 503 讓盒子沿用快取，
 * 而不是回一份空設定把長輩鎖在外面。
 */
export class KvUnavailable extends Error {}

export async function loadConfig(env) {
  let stored = null;
  try {
    stored = await env.CONFIG_KV.get(CONFIG_KEY, { type: "json" });
  } catch (err) {
    console.error("KV 讀取失敗:", err);
    throw new KvUnavailable("KV 讀取失敗");
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

/* ────────────────────────── 設定版本歷史 ────────────────────────── */

/** 把「即將被覆蓋的」設定快照推進歷史（最新在前，最多 CFG_HIST_MAX 份）。失敗不影響主流程 */
export async function pushConfigHistory(env, prevConfig) {
  if (!prevConfig || typeof prevConfig !== "object") return;
  try {
    const list = await loadConfigHistory(env);
    if (list.length && list[0] && list[0].version === prevConfig.version && list[0].updatedAt === prevConfig.updatedAt) return;
    list.unshift({ ...prevConfig });
    await env.CONFIG_KV.put(CFG_HIST_KEY, JSON.stringify(list.slice(0, CFG_HIST_MAX)));
  } catch (err) {
    console.error("設定歷史寫入失敗:", err);
  }
}

export async function loadConfigHistory(env) {
  try {
    const v = await env.CONFIG_KV.get(CFG_HIST_KEY, { type: "json" });
    return Array.isArray(v) ? v.filter((x) => x && typeof x === "object") : [];
  } catch (_) {
    return [];
  }
}

/** 兩份設定的差異欄位名稱（給歷史列表顯示「改了什麼」） */
export function diffConfigKeys(a, b) {
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  const out = [];
  for (const k of keys) {
    if (k === "version" || k === "updatedAt") continue;
    if (JSON.stringify(a ? a[k] : undefined) !== JSON.stringify(b ? b[k] : undefined)) out.push(k);
  }
  return out;
}

/** 設定欄位的中文名稱（歷史 / 匯入顯示用） */
export const CONFIG_LABELS = {
  subscriptionUrl: "直播源", backupSubscriptionUrl: "備援直播源", pollIntervalMinutes: "重載間隔", forceRefresh: "強制刷新", autostart: "開機自啟",
  notice: "公告", noticeUntil: "公告到期", marquee: "跑馬燈", marqueeUntil: "跑馬燈到期", contactText: "聯絡文字", contactQrVer: "聯絡 QR",
  requireActivation: "授權機制", activationTitle: "啟動頁標題", activationText: "啟動頁說明", codeDigits: "啟動碼位數",
  fontScale: "全域字體", showClock: "時鐘", otaEnabled: "OTA 提示",
  alertsEnabled: "警示開關", tgBotToken: "Telegram Token", tgChatId: "Telegram Chat", alertSourceMin: "直播源異常門檻",
  alertDeviceOfflineMin: "盒子離線門檻", alertQuiet: "靜音時段", alertBoxFail: "載入失敗通知",
  homeProxyRole: "家用備援角色", homeProxyKey: "家用備援金鑰",
};
export function configLabel(k) {
  return CONFIG_LABELS[k] || k;
}

/* ────────────────────────── 管理操作紀錄 ────────────────────────── */

/** 記一筆管理操作（誰、何時、做了什麼）。失敗不影響主流程 */
export async function appendAudit(env, request, what) {
  try {
    const list = await loadAudit(env);
    list.unshift({ at: nowIso(), ip: clientIp(request), what: String(what || "").slice(0, 200) });
    await env.CONFIG_KV.put(AUDIT_KEY, JSON.stringify(list.slice(0, AUDIT_MAX)));
  } catch (err) {
    console.error("操作紀錄寫入失敗:", err);
  }
}

export async function loadAudit(env) {
  try {
    const v = await env.CONFIG_KV.get(AUDIT_KEY, { type: "json" });
    return Array.isArray(v) ? v.filter((x) => x && typeof x === "object") : [];
  } catch (_) {
    return [];
  }
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
      "X-Frame-Options": "DENY",
      "Content-Security-Policy": "frame-ancestors 'none'",
      "Referrer-Policy": "same-origin",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    },
  });
}

/** 把網址裡的 token 遮成「前 4 碼…後 4 碼」（畫面與紀錄用，避免整串 token 到處出現） */
export function maskToken(url) {
  return String(url == null ? "" : url).replace(/([?&]token=)([^&\s]+)/gi, (_, k, v) =>
    k + (v.length > 10 ? v.slice(0, 4) + "…" + v.slice(-4) : "…")
  );
}

/** CSV 儲存格：跳脫引號，並在開頭是 = + - @ 等公式字元時前置單引號（防試算表公式注入） */
export function csvCell(v) {
  let s = String(v == null ? "" : v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}

/** 看門狗處置代碼 → 白話 */
export const ACTION_TEXT = {
  none: "無",
  hop_api_blocked: "更換出口節點（API 被封）",
  restart_gluetun_hop: "更換出口節點",
  restart_gluetun_vpn: "重撥 VPN",
  restart_4gtv_stale: "清快取重啟（網址失效）",
  restart_4gtv: "清快取重啟",
  restart_4gtv_ipchange: "出口 IP 變動，清快取重啟",
  restart_4gtv_reconnect: "VPN 重連，清快取重啟",
  renew_nord_credentials: "Nord 憑證失效，已自動換新",
  restart_nginx: "重啟對外入口 nginx",
};
export function actionText(a) {
  if (!a || a === "none") return "";
  return ACTION_TEXT[a] || String(a);
}

/* ────────────────────────── 裝置紀錄：盒子欄位 + 管理員欄位 ────────────────────────── */

/** 從一份（舊版）裝置物件抽出管理員欄位 */
export function splitAdminFields(dev) {
  const adm = {};
  let found = false;
  for (const k of ADMIN_DEVICE_FIELDS) {
    if (dev && dev[k] !== undefined) { adm[k] = dev[k]; found = true; }
  }
  return found ? adm : null;
}

/** 去掉管理員欄位後的盒子紀錄（寫回 dev:<id> 時用，避免舊欄位一直留著） */
export function stripAdminFields(dev) {
  const out = { ...dev };
  for (const k of ADMIN_DEVICE_FIELDS) delete out[k];
  return out;
}

/**
 * 合併 盒子紀錄 + 管理員紀錄 成畫面 / API 用的完整裝置物件。
 * autostart：管理員設定（autostartAt）與盒子本機設定回報（asReportAt）「最後改的贏」；都沒有就交給全域。
 */
export function mergeDevice(dev, adm) {
  if (!dev && !adm) return null;
  const out = { ...(dev || {}), ...(adm || {}) };
  const admT = adm && typeof adm.autostart === "boolean" ? (Date.parse(adm.autostartAt) || 1) : 0;
  const devT = dev && typeof dev.asReport === "boolean" ? (Date.parse(dev.asReportAt) || 1) : 0;
  if (admT || devT) out.autostart = admT >= devT ? adm.autostart : dev.asReport;
  else delete out.autostart;
  if (!out.id) out.id = (dev && dev.id) || (adm && adm.id) || "";
  return out;
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

/** 裝置在線狀態：online（線上）/ today（最近 24 小時內上線過）/ offline */
export function onlineState(dev, nowMs) {
  const t = Date.parse(dev && dev.lastSeen) || 0;
  if (!t) return "offline";
  const diff = (nowMs || Date.now()) - t;
  if (diff < ONLINE_MS) return "online";
  if (diff < TODAY_MS) return "today";
  return "offline";
}

/** 在線狀態的白話（today 不再說「今日曾上線」，改講清楚多久前離線） */
export function onlineText(dev, nowMs) {
  const s = onlineState(dev, nowMs);
  if (s === "online") return "線上";
  const rel = relativeTime(dev && dev.lastSeen, nowMs);
  if (s === "today") return "剛離線" + (rel ? "（" + rel + "）" : "");
  return "離線" + (rel ? "（" + rel + "）" : "");
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

/* ────────────────────────── 家用備援代理 ────────────────────────── */

/** 產生家用代理金鑰：40 碼英數（拒絕取樣避免取模偏差） */
export function genHomeKey(len) {
  const n = len || 40;
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  while (s.length < n) {
    const arr = new Uint8Array(n * 2);
    crypto.getRandomValues(arr);
    for (const b of arr) {
      if (b >= 248) continue; // 248 = 62 × 4 → 0~247 均勻對應 62 個字
      s += chars[b % 62];
      if (s.length >= n) break;
    }
  }
  return s;
}

/** 金鑰格式（匯入時檢查用） */
export function isValidHomeKey(k) {
  return /^[A-Za-z0-9_-]{20,128}$/.test(String(k || ""));
}

/**
 * 家用代理回報的區網網址：只收 http:// ＋ 私有 IPv4（10/8、172.16/12、192.168/16）＋ 可選 port。
 * 網域、公網 IP、https、帶路徑一律不收（盒子要走區網直連，網址不能指到外面）。
 * 合格回傳正規化後的網址（去掉結尾斜線、八位元前導零），不合格回 ""。
 */
export function parseLanUrl(u) {
  const m = /^http:\/\/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?::(\d{1,5}))?\/?$/i.exec(String(u == null ? "" : u).trim());
  if (!m) return "";
  const o = m.slice(1, 5).map(Number);
  if (o.some((n) => n > 255)) return "";
  const priv = o[0] === 10 || (o[0] === 172 && o[1] >= 16 && o[1] <= 31) || (o[0] === 192 && o[1] === 168);
  if (!priv) return "";
  let port = "";
  if (m[5] != null) {
    const p = Number(m[5]);
    if (!(p >= 1 && p <= 65535)) return "";
    port = ":" + p;
  }
  return "http://" + o.join(".") + port;
}

/** IPv6 → 8 段補零的陣列；不是合法 IPv6 回 null */
function expandIpv6(ip) {
  const s = String(ip).split("%")[0].toLowerCase();
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0) return null;
  const groups = head.concat(new Array(fill).fill("0"), tail);
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => g.padStart(4, "0"));
}

/**
 * 兩個公網 IP 是不是同一個家：IPv4 完全相同（NAT 後同一個對外位址）；
 * IPv6 比 /64 前綴（同一個區網的每台裝置位址都不同、前綴相同）。一邊 IPv4 一邊 IPv6 無法判定 → false。
 */
export function sameHomeIp(a, b) {
  const v4 = (x) => {
    const s = String(x == null ? "" : x).trim().toLowerCase();
    const m = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
    return m ? m[1] : s;
  };
  const x = v4(a);
  const y = v4(b);
  if (!x || !y) return false;
  const x6 = x.includes(":");
  const y6 = y.includes(":");
  if (x6 !== y6) return false;
  if (!x6) return x === y;
  const ex = expandIpv6(x);
  const ey = expandIpv6(y);
  return !!ex && !!ey && ex.slice(0, 4).join(":") === ey.slice(0, 4).join(":");
}

/** 讀家用代理登記紀錄；沒有或 KV 讀取失敗回 null（備援功能不該讓主流程出錯） */
export async function loadHomeProxy(env) {
  try {
    const v = await env.CONFIG_KV.get(HOME_PROXY_KEY, { type: "json" });
    return v && typeof v === "object" && v.lanUrl ? v : null;
  } catch (_) {
    return null;
  }
}

/** 家用代理狀態：none（從沒登記）/ online（45 分鐘內有紀錄）/ offline */
export function homeProxyState(hp, nowMs) {
  const t = Date.parse(hp && hp.lastSeen) || 0;
  if (!t) return "none";
  return (nowMs || Date.now()) - t < HOME_ONLINE_MS ? "online" : "offline";
}

/** 這台盒子能用的家用清單網址：2 小時內登記過、代理自報健康、且與盒子同一個家；否則 "" */
export function homePlaylistUrl(hp, boxIp, nowMs) {
  if (!hp || !hp.lanUrl || !hp.publicIp || hp.healthy === false) return "";
  const seen = Date.parse(hp.lastSeen) || 0;
  if (!seen || (nowMs || Date.now()) - seen > HOME_FRESH_MS) return "";
  if (!sameHomeIp(boxIp, hp.publicIp)) return "";
  return String(hp.lanUrl).replace(/\/+$/, "") + "/playlist.m3u";
}

/** 這台盒子要不要讀家用代理紀錄（手動備援已填且角色不是 primary 時用不到，省一次 KV 讀取） */
export function needsHomeProxy(config) {
  return config.homeProxyRole === "primary" || !String(config.backupSubscriptionUrl || "").trim();
}

/**
 * 能替家用代理「擔保同一個家」的盒子：管理員授權過（authorized，未封鎖、未到期）、24 小時內有心跳、有公網 IP。
 * 只認明確授權——授權機制關閉時任何人都能用亂數 id 心跳一次「生出」一台盒子，不能拿來當擔保。
 */
export function homeBoxEligible(d, nowMs) {
  if (!d || !d.id || !d.ip || d.blocked || d.authorized !== true) return false;
  if (d.expireAt && (Date.parse(d.expireAt) || 0) <= (nowMs || Date.now())) return false;
  const seen = Date.parse(d.lastSeen) || 0;
  return seen > 0 && (nowMs || Date.now()) - seen <= HOME_BOX_WINDOW_MS;
}

/**
 * 某台盒子實際拿到的主 / 備援訂閱網址：
 *  - 手動填的 backupSubscriptionUrl 優先；沒填時，同一個家的盒子拿家用清單當備援
 *  - homeProxyRole = primary：同一個家的盒子以家用清單為主、原本的主網址改當備援
 * 回傳 { subscriptionUrl, backupSubscriptionUrl, homeProxy: "primary" | "backup" | "" }
 */
export function effectiveLines(config, hp, boxIp, nowMs) {
  const main = String(config.subscriptionUrl || "");
  const manual = String(config.backupSubscriptionUrl || "").trim();
  const home = homePlaylistUrl(hp, boxIp, nowMs);
  if (home && config.homeProxyRole === "primary") return { subscriptionUrl: home, backupSubscriptionUrl: main, homeProxy: "primary" };
  if (home && !manual) return { subscriptionUrl: main, backupSubscriptionUrl: home, homeProxy: "backup" };
  return { subscriptionUrl: main, backupSubscriptionUrl: manual, homeProxy: "" };
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

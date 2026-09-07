/**
 * 偉電視（WeiTV）控制平面 — App 端 API 與資料存取
 * ----------------------------------------------------------------
 *  GET /api/config    盒子輪詢設定（並登記裝置、回報狀態、接收遠端指令）
 *  GET /api/activate  啟動碼激活
 *  GET /api/update    OTA 版本查詢
 *  GET /dl/latest.apk OTA 下載（代理私有 GitHub Release）
 *  GET /api/time      對時（老盒子 NTP 不通時的備援）
 *  GET /api/health    健康檢查
 */

import {
  ACTIVATE_RL_MAX,
  ACTIVATE_RL_TTL_SEC,
  CODE_LIST_MAX,
  CODE_PREFIX,
  CORS_HEADERS,
  DEVICE_LIST_MAX,
  DEVICE_PREFIX,
  DEVICE_WRITE_MIN_MS,
  OTA_CACHE_KEY,
  clientIp,
  computeAuth,
  effectiveFontScale,
  jsonResponse,
  loadConfig,
  nowIso,
  parseIntOr,
  pendingCmd,
  rateLimited,
} from "./lib.js";

/* ================================================================
 *  GET /api/config
 * ================================================================ */

/**
 * 回傳目前設定給盒子。
 * forceRefresh 採「不自動清除」策略——讀取後維持原值，由管理員手動切回。
 * 回應欄位只增不減，舊版 App 讀不到的欄位會自動忽略。
 */
export async function handleGetConfig(request, env) {
  const config = await loadConfig(env);

  let dev = null;
  try {
    dev = await touchDevice(request, env);
  } catch (err) {
    console.error("裝置登記失敗:", err);
  }

  const nowMs = Date.now();
  const blocked = !!(dev && dev.blocked);
  const autostart = dev && typeof dev.autostart === "boolean" ? dev.autostart : config.autostart;
  const auth = computeAuth(dev, config);

  const payload = {
    ...config,
    autostart,
    blocked,
    message: (dev && dev.msg) || "",
    messageLevel: (dev && dev.msgLevel) || "info",
    authorized: auth.authorized,
    expireAt: auth.expireAt,
    // 盒子畫面設定（裝置覆蓋 → 全域）
    fontScale: effectiveFontScale(dev, config),
    showClock: !!config.showClock,
    otaEnabled: config.otaEnabled !== false,
    // 待送達的遠端指令（App 執行後以 ack=<id> 回報）
    cmd: dev ? pendingCmd(dev, nowMs) : null,
    // 伺服器時間：老盒子 NTP 不通時可拿來校時
    serverTime: new Date(nowMs).toISOString(),
    serverTimeMs: nowMs,
    deviceNick: (dev && dev.nick) || "",
  };

  if (blocked || !auth.authorized) payload.subscriptionUrl = "";

  if (config.noticeUntil && (Date.parse(config.noticeUntil) || 0) <= nowMs) payload.notice = "";
  if (!config.marqueeUntil || (Date.parse(config.marqueeUntil) || 0) <= nowMs) payload.marquee = "";

  payload.contactQrUrl =
    config.contactQrVer > 0
      ? new URL("/asset/qr?v=" + config.contactQrVer, request.url).toString()
      : "";

  return jsonResponse(payload, 200, CORS_HEADERS);
}

/* ================================================================
 *  裝置註冊表（每台一個 KV key，前綴 dev:）
 * ================================================================ */

/**
 * 依 query 的 id 讀取/新建裝置並更新狀態。
 *
 * KV 寫入節流：心跳每 90 秒一次，但沒有變化時最多每 10 分鐘寫回一次，
 * 只有「新裝置 / 帶回報參數(ok, as, ack) / 機型或版本變了 / 觀看頻道變了(≥3 分鐘)」才立即寫，
 * 大幅降低 KV 每日寫入量（免費額度每日 1000 次）。
 *
 * 支援的 query 參數（App 端）：
 *   id  裝置編號        m  機型        v  App 版本
 *   ok  1/0 來源載入結果  ch 解析到的頻道數
 *   as  1/0 開機自啟回報
 *   now 正在觀看的頻道名稱   fs 目前生效的字體等級
 *   ack 已執行的遠端指令 id
 */
export async function touchDevice(request, env) {
  const url = new URL(request.url);
  const q = url.searchParams;
  const id = (q.get("id") || "").trim();
  if (!id || id.length > 64) return null;

  const now = new Date();
  const iso = now.toISOString();
  const key = DEVICE_PREFIX + id;

  let dev = null;
  try {
    dev = await env.CONFIG_KV.get(key, { type: "json" });
  } catch (_) {
    dev = null;
  }

  let isNew = false;
  if (!dev || typeof dev !== "object") {
    isNew = true;
    dev = {
      id,
      nick: "",
      m: "",
      v: "",
      ip: "",
      firstSeen: iso,
      lastSeen: iso,
      count: 0,
      blocked: false,
      msg: "",
      msgLevel: "info",
    };
  }

  const prevWriteMs = Date.parse(dev.lastWrite || dev.lastSeen) || 0;
  const sinceWrite = now.getTime() - prevWriteMs;
  let mustWrite = isNew || sinceWrite >= DEVICE_WRITE_MIN_MS;

  const m = q.get("m") || "";
  const v = q.get("v") || "";
  if (m && m !== dev.m) { dev.m = m; mustWrite = true; }
  if (v && v !== dev.v) { dev.v = v; mustWrite = true; }
  dev.id = id;
  dev.lastSeen = iso;
  dev.ip = clientIp(request) || dev.ip || "";

  if (q.has("ok")) {
    dev.lastOk = q.get("ok") === "1";
    dev.lastCount = parseIntOr(q.get("ch"), 0);
    dev.lastResultAt = iso;
    mustWrite = true;
  }
  if (q.has("as")) {
    dev.autostart = q.get("as") === "1";
    mustWrite = true;
  }
  if (q.has("fs")) {
    const fs = (q.get("fs") || "").slice(0, 16);
    if (fs !== dev.fs) { dev.fs = fs; if (sinceWrite >= 3 * 60 * 1000) mustWrite = true; }
  }
  if (q.has("now")) {
    const nowCh = (q.get("now") || "").slice(0, 60);
    if (nowCh !== dev.now) {
      dev.now = nowCh;
      dev.nowAt = iso;
      if (sinceWrite >= 3 * 60 * 1000) mustWrite = true;
    }
  }
  if (q.has("ack")) {
    const ack = (q.get("ack") || "").trim();
    if (ack && dev.cmd && dev.cmd.id === ack) {
      dev.lastAck = { id: ack, type: dev.cmd.type, arg: dev.cmd.arg == null ? "" : dev.cmd.arg, at: iso };
      dev.cmd = null;
      mustWrite = true;
    }
  }

  if (mustWrite) {
    dev.count = (typeof dev.count === "number" ? dev.count : 0) + 1;
    dev.lastWrite = iso;
    await env.CONFIG_KV.put(key, JSON.stringify(dev));
  }
  return dev;
}

/** 依 KV keys 平行讀取（每批 40 筆），失敗的略過 */
async function getManyJson(env, names) {
  const out = [];
  for (let i = 0; i < names.length; i += 40) {
    const batch = names.slice(i, i + 40);
    const results = await Promise.all(
      batch.map((n) => env.CONFIG_KV.get(n, { type: "json" }).catch(() => null))
    );
    for (const r of results) if (r && typeof r === "object") out.push(r);
  }
  return out;
}

/** 列出所有裝置，依 lastSeen 由新到舊排序 */
export async function loadDevices(env) {
  let keys = [];
  try {
    const listed = await env.CONFIG_KV.list({ prefix: DEVICE_PREFIX, limit: DEVICE_LIST_MAX });
    keys = (listed && Array.isArray(listed.keys) ? listed.keys : []).map((k) => k.name);
  } catch (err) {
    console.error("裝置列舉失敗:", err);
    return [];
  }
  const devices = await getManyJson(env, keys);
  devices.sort((a, b) => (Date.parse(b && b.lastSeen) || 0) - (Date.parse(a && a.lastSeen) || 0));
  return devices;
}

/** 列出所有啟動碼，依建立時間新到舊 */
export async function loadCodes(env) {
  let keys = [];
  try {
    const listed = await env.CONFIG_KV.list({ prefix: CODE_PREFIX, limit: CODE_LIST_MAX });
    keys = (listed && Array.isArray(listed.keys) ? listed.keys : []).map((k) => k.name);
  } catch (err) {
    console.error("啟動碼列舉失敗:", err);
    return [];
  }
  const codes = await getManyJson(env, keys);
  codes.sort((a, b) => (Date.parse(b && b.createdAt) || 0) - (Date.parse(a && a.createdAt) || 0));
  return codes;
}

/* ================================================================
 *  啟動碼授權
 * ================================================================ */

/** 產生隨機數字啟動碼（digits 位，限 4~12）。首位避免 0 */
export function genCodeString(digits) {
  const n = Math.max(4, Math.min(12, digits || 8));
  const arr = new Uint8Array(n);
  crypto.getRandomValues(arr);
  let s = "";
  for (let i = 0; i < n; i++) s += (arr[i] % 10).toString();
  if (s[0] === "0") s = (1 + (arr[0] % 9)).toString() + s.slice(1);
  return s;
}

/** 標記某裝置為已授權，寫入到期日（expireAt 空 = 永久）。裝置不存在時建立一筆 */
export async function authorizeDevice(env, id, expireAt, codeUsed) {
  const key = DEVICE_PREFIX + id;
  let dev = null;
  try {
    dev = await env.CONFIG_KV.get(key, { type: "json" });
  } catch (_) {
    dev = null;
  }
  const now = nowIso();
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
  dev.lastWrite = now;
  await env.CONFIG_KV.put(key, JSON.stringify(dev));
  return dev;
}

/**
 * GET /api/activate?id=&code= — 盒子輸入啟動碼後呼叫。
 * 未使用碼：綁定本機、依 days 算到期、標記裝置授權。
 * 已使用碼：僅允許原綁定裝置（重裝情境）。
 * 同一 IP 每 10 分鐘最多 30 次嘗試，防暴力猜碼。
 */
export async function handleActivate(request, env) {
  const url = new URL(request.url);
  const id = (url.searchParams.get("id") || "").trim();
  const code = (url.searchParams.get("code") || "").trim();
  if (!id || !code) return jsonResponse({ ok: false, error: "缺少裝置或啟動碼" }, 400);
  if (!/^\d{4,12}$/.test(code)) return jsonResponse({ ok: false, error: "啟動碼格式不正確" }, 200);

  const ip = clientIp(request);
  if (await rateLimited(env, "act", ip, ACTIVATE_RL_MAX, ACTIVATE_RL_TTL_SEC)) {
    return jsonResponse({ ok: false, error: "嘗試次數過多，請 10 分鐘後再試" }, 429);
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

/* ================================================================
 *  App OTA 自動更新（私有 repo Releases 代理）
 * ================================================================ */

const OTA_REPO = "xiewei3536/weid4t-app";
const OTA_CACHE_TTL_MS = 15 * 60 * 1000;
const OTA_USER_AGENT = "weitv-worker";

/**
 * 取得最新 release 的精簡資訊（含 KV 快取 15 分鐘）。
 * 回傳 { version, name, notes, size, assetId, fetchedAt } 或 null。
 */
export async function getLatestRelease(env, force) {
  if (!force) {
    try {
      const cached = await env.CONFIG_KV.get(OTA_CACHE_KEY, { type: "json" });
      if (cached && typeof cached.fetchedAt === "number" && Date.now() - cached.fetchedAt < OTA_CACHE_TTL_MS) {
        return cached;
      }
    } catch (_) {}
  }
  if (!env.GITHUB_TOKEN) return null;

  let release;
  try {
    const resp = await fetch(`https://api.github.com/repos/${OTA_REPO}/releases/latest`, {
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        "User-Agent": OTA_USER_AGENT,
        Accept: "application/vnd.github+json",
      },
    });
    if (!resp.ok) return null;
    release = await resp.json();
  } catch (err) {
    console.error("OTA 取 release 失敗:", err);
    return null;
  }
  if (!release || typeof release !== "object") return null;

  const tag = (release.tag_name || "").toString();
  const m = tag.match(/(\d+)$/);
  const version = m ? parseInt(m[1], 10) : 0;
  const notes = (release.body || "").toString();
  let size = 0;
  let assetId = 0;
  let assetName = "";
  for (const a of Array.isArray(release.assets) ? release.assets : []) {
    if (a && typeof a.name === "string" && /\.apk$/i.test(a.name)) {
      size = typeof a.size === "number" ? a.size : 0;
      assetId = typeof a.id === "number" ? a.id : 0;
      assetName = a.name;
      break;
    }
  }
  const result = {
    version, name: tag, notes, size, assetId, assetName,
    publishedAt: release.published_at || "",
    fetchedAt: Date.now(),
  };
  try {
    await env.CONFIG_KV.put(OTA_CACHE_KEY, JSON.stringify(result));
  } catch (err) {
    console.error("OTA 快取寫入失敗:", err);
  }
  return result;
}

/**
 * GET /api/update — 公開查詢最新 App 版本。
 * 管理員關閉 OTA 時回零值，讓所有版本的 App 都不再提示。
 */
export async function handleUpdateInfo(request, env) {
  const config = await loadConfig(env);
  const rel = config.otaEnabled === false ? null : await getLatestRelease(env);
  const payload = !rel
    ? { version: 0, name: "", notes: "", url: "", size: 0 }
    : {
        version: rel.version,
        name: rel.name,
        notes: rel.notes,
        url: new URL("/dl/latest.apk", request.url).toString(),
        size: rel.size,
      };
  return jsonResponse(payload, 200, CORS_HEADERS);
}

/** GET /dl/latest.apk — 串流代理最新 APK 資產（帶 Content-Length 讓 App 能顯示進度） */
export async function handleDownloadApk(request, env) {
  if (!env.GITHUB_TOKEN) return textPlain("更新服務尚未設定", 404);
  const rel = await getLatestRelease(env);
  if (!rel || !rel.assetId) return textPlain("找不到可下載的 APK", 404);

  let resp;
  try {
    resp = await fetch(`https://api.github.com/repos/${OTA_REPO}/releases/assets/${rel.assetId}`, {
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        "User-Agent": OTA_USER_AGENT,
        Accept: "application/octet-stream",
      },
    });
  } catch (err) {
    console.error("OTA 下載資產失敗:", err);
    return textPlain("下載失敗", 404);
  }
  if (!resp.ok || !resp.body) return textPlain("下載失敗", 404);

  const headers = {
    "Content-Type": "application/vnd.android.package-archive",
    "Content-Disposition": 'attachment; filename="WeiTV.apk"',
    "Cache-Control": "no-store",
  };
  const len = resp.headers.get("content-length");
  if (len) headers["Content-Length"] = len;
  else if (rel.size) headers["Content-Length"] = String(rel.size);
  return new Response(resp.body, { status: 200, headers });
}

function textPlain(text, status) {
  return new Response(text, {
    status: status || 200,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

/* ================================================================
 *  對時 / 健康檢查
 * ================================================================ */

/** GET /api/time — 盒子 NTP 不通時的對時備援 */
export function handleTime() {
  const now = Date.now();
  return jsonResponse({ now, iso: new Date(now).toISOString() }, 200, CORS_HEADERS);
}

/** GET /api/health — 監控用 */
export async function handleHealth(env) {
  let kv = true;
  try {
    await env.CONFIG_KV.get("config");
  } catch (_) {
    kv = false;
  }
  return jsonResponse({ ok: kv, kv, time: nowIso() }, kv ? 200 : 503, CORS_HEADERS);
}

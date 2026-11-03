/**
 * 偉電視（WeiTV）控制平面 — App 端 API 與資料存取
 * ----------------------------------------------------------------
 *  GET /api/config    盒子輪詢設定（並登記裝置、回報狀態、接收遠端指令）
 *  GET /api/activate  啟動碼激活
 *  GET /api/update    OTA 版本查詢
 *  GET /dl/latest.apk OTA 下載（代理私有 GitHub Release）
 *  GET /api/time      對時（老盒子 NTP 不通時的備援）
 *  GET /api/health    健康檢查
 *  POST /api/home-proxy 家用備援代理自動登記（同一個家的已授權盒子擔保，或 X-Home-Key 金鑰）
 *
 * 裝置紀錄分兩把 key：
 *  dev:<id>     盒子自己回報的（上線 / 版本 / 正在看 / 播放健康…），只有心跳會寫
 *  devadm:<id>  管理員設的（暱稱 / 封鎖 / 授權 / 指令 / 重點監控…），只有管理員（與指令回條）會寫
 * 兩邊各寫各的，就不會發生「心跳把管理員剛按的指令蓋掉」的遺失更新。
 */

import {
  ACTIVATE_RL_MAX,
  ACTIVATE_RL_TTL_SEC,
  ADMIN_RL_MAX,
  ADMIN_RL_TTL_SEC,
  BUILD,
  CODE_LIST_MAX,
  CODE_PREFIX,
  CORS_HEADERS,
  DEVADM_PREFIX,
  DEVICE_LIST_MAX,
  DEVICE_PREFIX,
  DEVICE_WRITE_MIN_MS,
  HOME_BOX_WINDOW_MS,
  HOME_PROXY_KEY,
  HOME_WRITE_MIN_MS,
  KvUnavailable,
  MON_KEY,
  NEWDEV_RL_MAX,
  NEWDEV_RL_TTL_SEC,
  NEWDEV_TTL_SEC,
  ONLINE_MS,
  OTA_CACHE_KEY,
  clientIp,
  computeAuth,
  effectiveFontScale,
  effectiveLines,
  homeBoxEligible,
  homeProxyState,
  jsonResponse,
  loadConfig,
  loadHomeProxy,
  mergeDevice,
  needsHomeProxy,
  nowIso,
  parseIntOr,
  parseLanUrl,
  pendingCmd,
  publicConfig,
  rateLimited,
  sameHomeIp,
  splitAdminFields,
  stripAdminFields,
  timingSafeEqual,
} from "./lib.js";

/* ================================================================
 *  GET /api/config
 * ================================================================ */

/**
 * 回傳目前設定給盒子。
 * forceRefresh 採「不自動清除」策略——讀取後維持原值，由管理員手動切回。
 * 回應欄位只增不減，舊版 App 讀不到的欄位會自動忽略。
 * KV 讀不到時回 503（盒子會沿用本機快取），絕不回「未授權 / 空來源」把長輩鎖在外面。
 */
export async function handleGetConfig(request, env, ctx) {
  let config;
  try {
    config = await loadConfig(env);
  } catch (err) {
    return kvUnavailable();
  }

  let dev = null;
  try {
    dev = await touchDevice(request, env, ctx);
  } catch (err) {
    console.error("裝置登記失敗:", err);
    if (err instanceof KvUnavailable) return kvUnavailable();
    dev = null;
  }

  const nowMs = Date.now();
  const blocked = !!(dev && dev.blocked);
  const autostart = dev && typeof dev.autostart === "boolean" ? dev.autostart : config.autostart;
  const auth = computeAuth(dev, config);

  const payload = {
    ...publicConfig(config),
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

  // 被封鎖 / 未授權 / 沒帶裝置編號（不是我們的 App）→ 不給直播源網址（裡面有 token）；備援線路同一套規則
  if (blocked || !auth.authorized || !dev) {
    payload.subscriptionUrl = "";
    payload.backupSubscriptionUrl = "";
    payload.homeProxy = "";
  } else {
    // 主 / 備援線路：手動備援優先；同一個家的盒子可拿到家用代理（區網直連）當備援，或角色 primary 時當主線路
    const hp = needsHomeProxy(config) ? await loadHomeProxy(env) : null;
    const lines = effectiveLines(config, hp, clientIp(request), nowMs);
    payload.subscriptionUrl = lines.subscriptionUrl;
    payload.backupSubscriptionUrl = lines.backupSubscriptionUrl;
    payload.homeProxy = lines.homeProxy;
  }

  if (config.noticeUntil && (Date.parse(config.noticeUntil) || 0) <= nowMs) payload.notice = "";
  if (!config.marqueeUntil || (Date.parse(config.marqueeUntil) || 0) <= nowMs) payload.marquee = "";

  payload.contactQrUrl =
    config.contactQrVer > 0
      ? new URL("/asset/qr?v=" + config.contactQrVer, request.url).toString()
      : "";

  return jsonResponse(payload, 200, CORS_HEADERS);
}

function kvUnavailable() {
  return jsonResponse({ ok: false, error: "資料庫暫時無法使用，請稍後再試", retryAfter: 60 }, 503, {
    ...CORS_HEADERS,
    "Retry-After": "60",
  });
}

/* ================================================================
 *  裝置註冊表
 * ================================================================ */

/** 讀一台裝置的兩把 key 並合併；舊資料（管理員欄位還在 dev:）會就地搬到 devadm:（一次性） */
export async function loadDevice(env, id, opts) {
  const key = DEVICE_PREFIX + id;
  const akey = DEVADM_PREFIX + id;
  const [dev, admRaw] = await Promise.all([
    env.CONFIG_KV.get(key, { type: "json" }),
    env.CONFIG_KV.get(akey, { type: "json" }),
  ]);
  let adm = admRaw && typeof admRaw === "object" ? admRaw : null;
  let migrated = false;
  if (!adm && dev && typeof dev === "object") {
    const legacy = splitAdminFields(dev);
    if (legacy) {
      adm = { id, ...legacy };
      migrated = true;
      if (!(opts && opts.noMigrate)) {
        try {
          await env.CONFIG_KV.put(akey, JSON.stringify(adm));
        } catch (_) {}
      }
    }
  }
  return { dev: dev && typeof dev === "object" ? dev : null, adm, migrated };
}

/** 寫回管理員欄位（devadm:<id>）；沒有裝置紀錄時也允許（例如先授權再開機） */
export async function saveDeviceAdmin(env, id, adm) {
  const out = { ...(adm || {}), id };
  await env.CONFIG_KV.put(DEVADM_PREFIX + id, JSON.stringify(out));
  return out;
}

/**
 * 依 query 的 id 讀取/新建裝置並更新狀態（只寫 dev:<id>；指令回條時才會動 devadm 的 cmd）。
 *
 * KV 寫入節流：心跳每 90 秒一次，但沒有變化時最多每 10 分鐘寫回一次，
 * 只有「新裝置 / 回報值改變(ok, as) / ack / 機型或版本變了 / 觀看頻道變了(≥3 分鐘) / 播放健康明顯變化」才立即寫，
 * 大幅降低 KV 每日寫入量（免費額度每日 1000 次）。
 *
 * 支援的 query 參數（App 端）：
 *   id  裝置編號        m  機型        v  App 版本
 *   ok  1/0 來源載入結果  ch 解析到的頻道數
 *   as  1/0 開機自啟回報（盒子本機設定）
 *   now 正在觀看的頻道名稱   fs 目前生效的字體等級
 *   ack 已執行的遠端指令 id
 *   pe  近 10 分鐘播放重連次數  le 最近一次播放錯誤（短文字）  up App 已運行分鐘數
 *   ln  目前播放所用線路（0 = 主線路、1 = 備援線路）
 */
export async function touchDevice(request, env, ctx) {
  const url = new URL(request.url);
  const q = url.searchParams;
  const id = (q.get("id") || "").trim();
  if (!id || id.length > 64 || !/^[A-Za-z0-9_.:-]+$/.test(id)) return null;

  const now = new Date();
  const iso = now.toISOString();
  const key = DEVICE_PREFIX + id;

  let loaded;
  try {
    loaded = await loadDevice(env, id);
  } catch (err) {
    throw new KvUnavailable("KV 讀取失敗");
  }
  let dev = loaded.dev;
  const adm = loaded.adm;

  let isNew = false;
  if (!dev) {
    // 新裝置：同一 IP 每小時最多登記 NEWDEV_RL_MAX 台（防亂數 id 灌爆寫入額度）；沒授權的新紀錄 7 天後自動消失
    if (await rateLimited(env, "newdev", clientIp(request), NEWDEV_RL_MAX, NEWDEV_RL_TTL_SEC)) return null;
    isNew = true;
    dev = { id, m: "", v: "", ip: "", firstSeen: iso, lastSeen: iso, count: 0 };
  } else {
    dev = stripAdminFields(dev);
  }

  const prevWriteMs = Date.parse(dev.lastWrite || dev.lastSeen) || 0;
  const sinceWrite = now.getTime() - prevWriteMs;
  let mustWrite = isNew || sinceWrite >= DEVICE_WRITE_MIN_MS;

  const m = q.get("m") || "";
  const v = q.get("v") || "";
  if (m && m !== dev.m) { dev.m = m.slice(0, 60); mustWrite = true; }
  if (v && v !== dev.v) { dev.v = v.slice(0, 30); mustWrite = true; }
  dev.id = id;
  dev.lastSeen = iso;
  dev.ip = clientIp(request) || dev.ip || "";

  if (q.has("ok")) {
    const ok = q.get("ok") === "1";
    const cnt = parseIntOr(q.get("ch"), 0);
    // 結果沒變且剛寫過就不寫（App 每次重載清單才帶 ok；防它每輪都帶時把節流打穿）
    if (ok !== dev.lastOk || cnt !== dev.lastCount || sinceWrite >= DEVICE_WRITE_MIN_MS) mustWrite = true;
    dev.lastOk = ok;
    dev.lastCount = cnt;
    dev.lastResultAt = iso;
  }
  if (q.has("as")) {
    // 盒子本機的「開機自啟」被人在設定頁動了（App 只在切換時才帶 as）→ 記時間，與管理員設定比誰最後改（見 mergeDevice）
    dev.asReport = q.get("as") === "1";
    dev.asReportAt = iso;
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
  if (q.has("pe")) {
    // 播放健康：重連次數變了（尤其從 0 變多、或恢復到 0）就記下來，讓管理員遠端看得到「這台一直在重連」
    const pe = Math.max(0, Math.min(999, parseIntOr(q.get("pe"), 0)));
    const le = (q.get("le") || "").slice(0, 80);
    if (pe !== dev.pe || (pe > 0 && le && le !== dev.le)) {
      dev.pe = pe;
      dev.le = pe > 0 ? le : "";
      dev.peAt = iso;
      // 變成「不穩」(≥3)或從不穩恢復到 0 → 立刻寫,管理員看到的是即時狀態;其餘照 3 分鐘節流
      if (sinceWrite >= 3 * 60 * 1000 || (pe >= 3 && !(dev.pePrev >= 3)) || (pe === 0 && dev.pePrev >= 3)) mustWrite = true;
    }
    dev.pePrev = pe;
  }
  if (q.has("up")) {
    const up = parseIntOr(q.get("up"), -1);
    if (up >= 0) dev.up = up;
  }
  if (q.has("ln")) {
    // 目前播放用的線路（0 = 主線路、1 = 備援線路）：切換時記下時間。距上次切換超過 10 分鐘的那次切換立刻寫
    // （管理員馬上看得到「這台撐在備援上」）；10 分鐘內來回切照 3 分鐘節流，免得一台盒子反覆切線吃光寫入額度
    const ln = Math.max(0, Math.min(9, parseIntOr(q.get("ln"), 0)));
    if (ln !== dev.ln) {
      const prev = typeof dev.ln === "number" ? dev.ln : 0;
      const lastSwitchMs = Date.parse(dev.lnAt || "") || 0;
      dev.ln = ln;
      if (ln !== prev) {   // 真的換了線路（新版 App 第一次回報主線路不算，跟著下次寫入一起存）
        dev.lnAt = iso;
        if (sinceWrite >= 3 * 60 * 1000 || now.getTime() - lastSwitchMs >= 10 * 60 * 1000) mustWrite = true;
      }
    }
  }

  // 指令回條：清掉 devadm 的待送指令並記回條（這是心跳唯一會碰 devadm 的時機，且只在有 ack 時）
  if (q.has("ack") && adm) {
    const ack = (q.get("ack") || "").trim();
    if (ack && adm.cmd && adm.cmd.id === ack) {
      adm.lastAck = { id: ack, type: adm.cmd.type, arg: adm.cmd.arg == null ? "" : adm.cmd.arg, at: iso };
      adm.cmd = null;
      await saveDeviceAdmin(env, id, adm);
    }
  }

  if (mustWrite) {
    dev.count = (typeof dev.count === "number" ? dev.count : 0) + 1;
    dev.lastWrite = iso;
    const merged = mergeDevice(dev, adm);
    // 沒授權的新裝置先給 7 天壽命（沒人核准就自動清掉）；已授權或非新裝置永久保存
    const ttl = isNew && !(adm && adm.authorized === true) ? { expirationTtl: NEWDEV_TTL_SEC } : undefined;
    const put = env.CONFIG_KV.put(key, JSON.stringify(dev), ttl);
    if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(put.catch((e) => console.error("裝置寫入失敗:", e)));
    else await put;
    return merged;
  }
  return mergeDevice(dev, adm);
}

/** 依 KV keys 平行讀取（每批 40 筆），失敗的略過 */
async function getManyJson(env, names) {
  const out = new Map();
  for (let i = 0; i < names.length; i += 40) {
    const batch = names.slice(i, i + 40);
    const results = await Promise.all(
      batch.map((n) => env.CONFIG_KV.get(n, { type: "json" }).catch(() => null))
    );
    results.forEach((r, j) => { if (r && typeof r === "object") out.set(batch[j], r); });
  }
  return out;
}

/**
 * 列出所有裝置（盒子紀錄 + 管理員紀錄合併），依 lastSeen 由新到舊排序。
 * 只 list 一次 dev: 前綴（KV list 免費額度每日 1000 次，list 很貴）；devadm 用讀取補。
 * KV 失敗會丟出例外（呼叫端決定要顯示「讀取失敗」還是當空清單）。
 */
export async function loadDevices(env) {
  const listed = await env.CONFIG_KV.list({ prefix: DEVICE_PREFIX, limit: DEVICE_LIST_MAX });
  const keys = (listed && Array.isArray(listed.keys) ? listed.keys : []).map((k) => k.name);
  const ids = keys.map((k) => k.slice(DEVICE_PREFIX.length));
  const [devs, adms] = await Promise.all([
    getManyJson(env, keys),
    getManyJson(env, ids.map((id) => DEVADM_PREFIX + id)),
  ]);
  const devices = [];
  for (const id of ids) {
    const dev = devs.get(DEVICE_PREFIX + id);
    if (!dev) continue;
    let adm = adms.get(DEVADM_PREFIX + id) || null;
    if (!adm) adm = splitAdminFields(dev); // 舊資料尚未搬家：就地合併（下次心跳會搬）
    devices.push(mergeDevice(dev, adm));
  }
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
  const codes = [...(await getManyJson(env, keys)).values()];
  codes.sort((a, b) => (Date.parse(b && b.createdAt) || 0) - (Date.parse(a && a.createdAt) || 0));
  return codes;
}

/* ================================================================
 *  啟動碼授權
 * ================================================================ */

/** 產生隨機數字啟動碼（digits 位，限 6~12）。拒絕取樣避免取模偏差；首位避免 0 */
export function genCodeString(digits) {
  const n = Math.max(6, Math.min(12, digits || 8));
  let s = "";
  while (s.length < n) {
    const arr = new Uint8Array(n * 2);
    crypto.getRandomValues(arr);
    for (const b of arr) {
      if (b >= 250) continue; // 250~255 丟掉 → 0~9 均勻
      const d = (b % 10).toString();
      if (s.length === 0 && d === "0") continue;
      s += d;
      if (s.length >= n) break;
    }
  }
  return s;
}

/** 標記某裝置為已授權，寫入到期日（expireAt 空 = 永久）。裝置不存在時只建立管理員紀錄 */
export async function authorizeDevice(env, id, expireAt, codeUsed) {
  const { adm: existing, dev } = await loadDevice(env, id);
  const adm = { ...(existing || {}), id };
  const now = nowIso();
  adm.authorized = true;
  adm.authedAt = now;
  adm.expireAt = expireAt || "";
  if (codeUsed) adm.codeUsed = codeUsed;
  await saveDeviceAdmin(env, id, adm);
  // 新裝置紀錄若還帶著 7 天壽命，改成永久
  if (dev) {
    try {
      await env.CONFIG_KV.put(DEVICE_PREFIX + id, JSON.stringify(stripAdminFields(dev)));
    } catch (_) {}
  }
  return mergeDevice(dev, adm);
}

/**
 * GET /api/activate?id=&code= — 盒子輸入啟動碼後呼叫。
 * 未使用碼：綁定本機、依 days 算到期、標記裝置授權。
 * 已使用碼：僅允許原綁定裝置（重裝情境）；被撤銷過的碼一律拒絕。
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
    return jsonResponse({ ok: false, error: "資料庫暫時無法使用，請稍後再試" }, 503);
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
  } else if (expireAt && (Date.parse(expireAt) || 0) <= now.getTime()) {
    return jsonResponse({ ok: false, error: "此啟動碼的授權已到期，請向服務人員索取新碼" }, 200);
  }

  try {
    await authorizeDevice(env, id, expireAt, code);
  } catch (_) {
    return jsonResponse({ ok: false, error: "授權寫入失敗，請重試" }, 200);
  }
  return jsonResponse({ ok: true, expireAt, message: "啟動成功" }, 200);
}

/* ================================================================
 *  家用備援代理自動登記
 * ================================================================ */

/**
 * 同 IP 每分鐘最多 HOME_RL_MAX 次：計數放 Worker 記憶體（每次登記都寫 KV 計數會吃光每日寫入額度；
 * 多個執行個體之間是近似值，擋暴衝夠用）。金鑰錯的嘗試另外走 KV 限速（見 handleHomeProxy）。
 */
const HOME_RL = new Map();
const HOME_RL_MAX = 6;
const HOME_RL_WINDOW_MS = 60 * 1000;
function homeRateLimited(ip, nowMs) {
  const key = ip || "-";
  const recent = (HOME_RL.get(key) || []).filter((t) => nowMs - t < HOME_RL_WINDOW_MS);
  const limited = recent.length >= HOME_RL_MAX;
  if (!limited) recent.push(nowMs);
  HOME_RL.set(key, recent);
  if (HOME_RL.size > 500) {
    for (const [k, v] of HOME_RL) if (!v.length || nowMs - v[v.length - 1] >= HOME_RL_WINDOW_MS) HOME_RL.delete(k);
  }
  return limited;
}

/**
 * 免金鑰登記時的候選盒子：監控每 5 分鐘把「已授權盒子的公網 IP」整理進 mon:state.homeIps（[[ip, id], …]），
 * 這裡只讀那一把 key，不列舉裝置（KV list 每日額度很少，不能讓沒帶金鑰的請求每次都 list）。
 * 監控還沒產生這份資料時（剛部署）才退回列舉一次，每個執行個體每分鐘最多一次。
 */
const HOME_LIST_GUARD = new WeakMap();
async function homeBoxCandidates(env, memo, nowMs) {
  if (memo.cands) return memo.cands;
  let cands = null;
  try {
    const mon = await env.CONFIG_KV.get(MON_KEY, { type: "json" });
    if (mon && Array.isArray(mon.homeIps)) {
      cands = mon.homeIps.filter((e) => Array.isArray(e) && e[0] && e[1]).map((e) => ({ ip: String(e[0]), id: String(e[1]) }));
    }
  } catch (_) {}
  if (!cands) {
    cands = [];
    const kv = env.CONFIG_KV;
    if (kv && typeof kv === "object" && nowMs - (HOME_LIST_GUARD.get(kv) || 0) >= 60 * 1000) {
      HOME_LIST_GUARD.set(kv, nowMs);
      try {
        for (const d of await loadDevices(env)) if (homeBoxEligible(d, nowMs)) cands.push({ ip: String(d.ip), id: String(d.id) });
      } catch (_) {}
    }
  }
  memo.cands = cands;
  return cands;
}

/**
 * 找一台跟 ip 同一個家、已授權（未封鎖、未到期）、maxAgeMs 內有心跳的盒子；沒有回 null。
 * 候選盒子一律重讀最新紀錄再確認，管理員剛封鎖 / 撤銷授權立即生效。hintId（上次擔保的盒子）先試，平常只花 2 次讀取。
 */
async function findHomeBox(env, ip, hintId, nowMs, maxAgeMs, memo) {
  const tried = new Set();
  const check = async (id) => {
    if (!id || tried.has(id) || tried.size >= 8) return null;
    tried.add(id);
    try {
      const r = await loadDevice(env, id, { noMigrate: true });
      const d = mergeDevice(r.dev, r.adm);
      return d && homeBoxEligible(d, nowMs) && sameHomeIp(d.ip, ip) && nowMs - (Date.parse(d.lastSeen) || 0) <= maxAgeMs ? d : null;
    } catch (_) {
      return null;
    }
  };
  const hit = await check(hintId);
  if (hit) return hit;
  for (const c of await homeBoxCandidates(env, memo, nowMs)) {
    if (!sameHomeIp(c.ip, ip)) continue;
    const d = await check(c.id);
    if (d) return d;
  }
  return null;
}

/**
 * POST /api/home-proxy — 家裡電腦的家用備援代理定時回報（建議每 5 分鐘）。本文 JSON {lanUrl, version, channels, healthy}。
 * 身分驗證（二選一）：
 *   • 標頭 X-Home-Key（選用）：帶了就必須正確，錯的回 401 並計入防暴力限速
 *   • 沒帶金鑰：這個公網 IP（CF-Connecting-IP）24 小時內要有已授權（未封鎖、未到期）盒子的心跳 = 同一個家，否則 403。
 *     另一個家的代理正在使用中（45 分內有登記、那邊的盒子 15 分內有心跳）時也回 403，免得兩台輪流蓋掉對方；帶金鑰可強制接手
 * 記錄 {lanUrl, publicIp, version, channels, healthy, lastSeen, via, boxId} 到 KV「homeproxy」；
 * 內容沒變且上次紀錄未滿 30 分鐘就不寫 KV（照樣回 200，stored:false）。
 * 回應：200 {ok, stored, via, role, publicIp, playlist, lastSeen}｜400 內容不對｜401 金鑰錯｜403 不是同一個家 / 另一個家使用中
 *       ｜429 太頻繁 / 金鑰錯太多次｜503 KV 故障。錯誤一律 {ok:false, reason, error}（reason 給程式判斷，error 給人看）。
 */
export async function handleHomeProxy(request, env) {
  const nowMs = Date.now();
  const ip = clientIp(request);
  const fail = (status, reason, error, extra, headers) => jsonResponse({ ok: false, reason, error, ...(extra || {}) }, status, headers);
  if (homeRateLimited(ip, nowMs)) {
    return fail(429, "rate_limited", "回報太頻繁（同一 IP 每分鐘最多 6 次）", { retryAfter: 60 }, { "Retry-After": "60" });
  }
  let config;
  try {
    config = await loadConfig(env);
  } catch (_) {
    return kvUnavailable();
  }
  const sentKey = request.headers.get("X-Home-Key") || "";
  if (sentKey) {
    const expected = String(config.homeProxyKey || "");
    // 管理中心根本沒有金鑰：沒有東西可猜，不計入限速（省一次 KV 寫入）
    if (!expected) return fail(401, "no_key_configured", "管理中心還沒有家用備援金鑰：拿掉 X-Home-Key 改用免金鑰登記，或先到管理頁「直播源 → 家用備援」產生金鑰");
    if (!timingSafeEqual(sentKey, expected)) {
      // 金鑰錯：沿用管理密碼同一套限速（同 IP 每 10 分鐘 20 次），但計數另開一桶——
      // 家用代理和管理員常是同一個家用 IP，代理金鑰設錯時不該連帶把管理頁登入鎖住
      if (await rateLimited(env, "hpkey", ip, ADMIN_RL_MAX, ADMIN_RL_TTL_SEC)) {
        return fail(429, "key_locked", "金鑰錯誤次數過多，請 10 分鐘後再試", { retryAfter: 600 }, { "Retry-After": "600" });
      }
      return fail(401, "bad_key", "金鑰錯誤（管理頁重新產生過金鑰的話，舊金鑰已失效）");
    }
  }
  let body = null;
  try {
    const text = await request.text();
    if (text.length > 4000) throw new Error("too large");
    body = JSON.parse(text);
  } catch (_) {
    return fail(400, "bad_body", "本文必須是 JSON：{lanUrl, version, channels, healthy}");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return fail(400, "bad_body", "本文必須是 JSON 物件");
  }
  const lanUrl = parseLanUrl(body.lanUrl);
  if (!lanUrl) {
    return fail(400, "bad_lan_url", "lanUrl 必須是 http://私有 IPv4[:port]（10.x、172.16～31.x、192.168.x），不接受網域、公網 IP、https 或路徑");
  }
  let prev = null;
  try {
    prev = await env.CONFIG_KV.get(HOME_PROXY_KEY, { type: "json" });
  } catch (_) {
    return kvUnavailable();
  }
  if (prev && typeof prev !== "object") prev = null;

  let via = "key";
  let boxId = "";
  if (!sentKey) {
    const memo = {};
    const box = await findHomeBox(env, ip, prev && prev.boxId, nowMs, HOME_BOX_WINDOW_MS, memo);
    if (!box) {
      return fail(403, "no_home_box", `公網 IP ${ip} 24 小時內沒有已授權的盒子上線，無法免金鑰登記。請確認這台電腦跟電視盒接同一台路由器、盒子開過偉電視且已授權（未封鎖、未到期）；或改帶 X-Home-Key 金鑰登記`, { publicIp: ip });
    }
    if (prev && prev.publicIp && !sameHomeIp(prev.publicIp, ip) && homeProxyState(prev, nowMs) === "online" &&
        (await findHomeBox(env, prev.publicIp, prev.boxId, nowMs, ONLINE_MS, memo))) {
      return fail(403, "other_home_active", "另一個家的家用代理正在使用中（同時只能登記一台）。要改用這台請帶 X-Home-Key 金鑰登記；或等那台離線約 45 分鐘後，這台會自動接手", { publicIp: ip });
    }
    via = "box";
    boxId = String(box.id);
  }

  const rec = {
    lanUrl,
    publicIp: ip,
    version: String(body.version == null ? "" : body.version).slice(0, 30),
    channels: Math.max(0, Math.min(10000, parseIntOr(body.channels, 0))),
    healthy: body.healthy !== false && body.healthy !== "false",
    lastSeen: new Date(nowMs).toISOString(),
    via,
    boxId,
  };
  const same = !!prev && prev.lanUrl === rec.lanUrl && prev.publicIp === rec.publicIp && prev.version === rec.version &&
    prev.channels === rec.channels && prev.healthy === rec.healthy && (prev.via || "key") === rec.via && (prev.boxId || "") === rec.boxId;
  const recent = !!prev && nowMs - (Date.parse(prev.lastSeen) || 0) < HOME_WRITE_MIN_MS;
  let stored = false;
  if (!(same && recent)) {
    try {
      await env.CONFIG_KV.put(HOME_PROXY_KEY, JSON.stringify(rec));
      stored = true;
    } catch (_) {
      return kvUnavailable();
    }
  }
  return jsonResponse({
    ok: true,
    stored,
    via,
    role: config.homeProxyRole === "primary" ? "primary" : "backup",
    publicIp: ip,
    playlist: lanUrl + "/playlist.m3u",
    lastSeen: stored ? rec.lastSeen : prev.lastSeen,
  }, 200);
}

/* ================================================================
 *  App OTA 自動更新（私有 repo Releases 代理）
 * ================================================================ */

const OTA_REPO = "xiewei3536/weid4t-app";
const OTA_CACHE_TTL_MS = 15 * 60 * 1000;
const OTA_NEG_CACHE_TTL_MS = 5 * 60 * 1000;
const OTA_USER_AGENT = "weitv-worker";

/**
 * 取得最新 release 的精簡資訊（含 KV 快取 15 分鐘；查詢失敗也快取 5 分鐘，避免每個請求都去撞 GitHub）。
 * 版本碼 = tag 最後一段數字（約定：tag v1.0.0.26 ↔ versionCode 26）。
 * 回傳 { version, name, notes, size, assetId, fetchedAt } 或 null。
 */
export async function getLatestRelease(env, force) {
  if (!force) {
    try {
      const cached = await env.CONFIG_KV.get(OTA_CACHE_KEY, { type: "json" });
      if (cached && typeof cached.fetchedAt === "number") {
        const ttl = cached.failed ? OTA_NEG_CACHE_TTL_MS : OTA_CACHE_TTL_MS;
        if (Date.now() - cached.fetchedAt < ttl) return cached.failed ? null : cached;
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
    if (!resp.ok) throw new Error("GitHub HTTP " + resp.status);
    release = await resp.json();
  } catch (err) {
    console.error("OTA 取 release 失敗:", err);
    try {
      await env.CONFIG_KV.put(OTA_CACHE_KEY, JSON.stringify({ failed: true, fetchedAt: Date.now() }));
    } catch (_) {}
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
  let config;
  try {
    config = await loadConfig(env);
  } catch (_) {
    return kvUnavailable();
  }
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

/** GET /dl/latest.apk — 串流代理最新 APK 資產（帶 Content-Length 供進度；透傳 Range 可續傳） */
export async function handleDownloadApk(request, env) {
  if (!env.GITHUB_TOKEN) return textPlain("更新服務尚未設定", 404);
  const rel = await getLatestRelease(env);
  if (!rel || !rel.assetId) return textPlain("找不到可下載的 APK", 404);

  const upstreamHeaders = {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    "User-Agent": OTA_USER_AGENT,
    Accept: "application/octet-stream",
  };
  const range = request.headers.get("Range");
  if (range) upstreamHeaders.Range = range;
  let resp;
  try {
    resp = await fetch(`https://api.github.com/repos/${OTA_REPO}/releases/assets/${rel.assetId}`, { headers: upstreamHeaders });
  } catch (err) {
    console.error("OTA 下載資產失敗:", err);
    return textPlain("下載失敗", 502);
  }
  if (!resp.ok || !resp.body) return textPlain("下載失敗", resp.status === 416 ? 416 : 502);

  const headers = {
    "Content-Type": "application/vnd.android.package-archive",
    "Content-Disposition": `attachment; filename="WeiTV-${rel.name || "latest"}.apk"`,
    "Cache-Control": "no-store",
    "Accept-Ranges": "bytes",
  };
  for (const h of ["content-length", "content-range", "etag", "last-modified"]) {
    const v = resp.headers.get(h);
    if (v) headers[h.replace(/(^|-)([a-z])/g, (s) => s.toUpperCase())] = v;
  }
  if (!headers["Content-Length"] && !range && rel.size) headers["Content-Length"] = String(rel.size);
  return new Response(resp.body, { status: resp.status === 206 ? 206 : 200, headers });
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
  return jsonResponse({ ok: kv, kv, build: BUILD, time: nowIso() }, kv ? 200 : 503, CORS_HEADERS);
}

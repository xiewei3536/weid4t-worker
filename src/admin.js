/**
 * 偉電視（WeiTV）控制平面 — 管理頁後端（需 Basic Auth）
 * ----------------------------------------------------------------
 * 所有 POST 動作同時支援：
 *   • 管理頁前端 fetch（帶 X-Requested-With: fetch）→ 回 JSON，前端 toast + 局部刷新
 *   • 傳統表單送出（無 JS）→ 回結果頁
 */

import {
  ADMIN_RL_MAX,
  ADMIN_RL_TTL_SEC,
  CMD_TYPES,
  CODE_PREFIX,
  DEFAULT_CONFIG,
  DEVADM_PREFIX,
  DEVICE_PREFIX,
  ONLINE_MS,
  OTA_CACHE_KEY,
  QR_ASSET_KEY,
  appendAudit,
  clientIp,
  configLabel,
  csvCell,
  diffConfigKeys,
  escapeHtml,
  formatTaipeiFull,
  genHomeKey,
  htmlResponse,
  isValidFontScale,
  isValidHomeKey,
  jsonResponse,
  loadAudit,
  loadConfig,
  loadConfigHistory,
  loadHomeProxy,
  maskToken,
  nowIso,
  parseFloatOr,
  parseIntOr,
  pushConfigHistory,
  rateLimited,
  relativeTime,
  saveConfig,
  timingSafeEqual,
  wantsJson,
} from "./lib.js";
import { authorizeDevice, genCodeString, getLatestRelease, loadCodes, loadDevice, loadDevices, saveDeviceAdmin } from "./api.js";
import { fetchSourceStatus, isValidTgToken, loadMonState, runMonitorTick, saveMonState, sendTelegram } from "./monitor.js";
import { renderAdminHtml, renderCodesResultPage, renderPartial, renderResultPage, setupPasswordHtml } from "./ui.js";

/* ================================================================
 *  驗證與安全
 * ================================================================ */

/**
 * 驗證 Basic Auth。使用者名稱不限，密碼必須等於 env.ADMIN_PASSWORD。
 * 通過回傳 null；未通過回傳 401 Response（fetch 模式回 JSON，瀏覽器模式跳帳密框）。
 * 同一 IP 密碼連錯 ADMIN_RL_MAX 次 → 10 分鐘內回 429（防暴力猜密碼）。
 */
export async function checkAuth(request, env) {
  const expected = env.ADMIN_PASSWORD;
  if (!expected) return htmlResponse(setupPasswordHtml(), 200);

  const header = request.headers.get("Authorization") || "";
  let attempted = false;
  if (header.startsWith("Basic ")) {
    attempted = true;
    try {
      const decoded = atob(header.slice(6));
      const idx = decoded.indexOf(":");
      const password = idx >= 0 ? decoded.slice(idx + 1) : "";
      if (timingSafeEqual(password, expected)) return null;
    } catch (_) {}
  }
  if (attempted && (await rateLimited(env, "adm", clientIp(request), ADMIN_RL_MAX, ADMIN_RL_TTL_SEC))) {
    const msg = "密碼錯誤次數過多，請 10 分鐘後再試";
    if (wantsJson(request)) return jsonResponse({ ok: false, error: msg }, 429);
    return new Response(msg, { status: 429, headers: { "Content-Type": "text/plain; charset=utf-8", "Retry-After": "600" } });
  }
  if (wantsJson(request)) {
    return jsonResponse({ ok: false, error: "需要重新登入", relogin: true }, 401, {
      "WWW-Authenticate": 'Basic realm="WeiTV Admin", charset="UTF-8"',
    });
  }
  return new Response("需要授權（請輸入管理密碼）", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="WeiTV Admin", charset="UTF-8"',
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}

/**
 * CSRF 防護：瀏覽器會自動附帶 Basic Auth，所以要擋掉「從別的網站發出的 POST」。
 * 現代瀏覽器帶 Sec-Fetch-Site；有帶且不是 same-origin/none 就拒絕。
 * 另外若帶 Origin，必須與本站相同。舊瀏覽器兩者都沒帶則放行。
 */
export function csrfCheck(request) {
  const site = (request.headers.get("Sec-Fetch-Site") || "").toLowerCase();
  if (site && site !== "same-origin" && site !== "none") {
    return jsonResponse({ ok: false, error: "拒絕跨站請求" }, 403);
  }
  const origin = request.headers.get("Origin");
  if (origin) {
    try {
      if (new URL(origin).host !== new URL(request.url).host) {
        return jsonResponse({ ok: false, error: "拒絕跨站請求" }, 403);
      }
    } catch (_) {
      return jsonResponse({ ok: false, error: "拒絕跨站請求" }, 403);
    }
  }
  return null;
}

/** 通過驗證與 CSRF 後回傳 null，否則回傳要直接送出的 Response */
async function guard(request, env) {
  const unauthorized = await checkAuth(request, env);
  if (unauthorized) return unauthorized;
  if (request.method === "POST") {
    const bad = csrfCheck(request);
    if (bad) return bad;
  }
  return null;
}

/** 依請求型態回 JSON 或結果頁 */
function respond(request, ok, message, extra, config) {
  if (wantsJson(request)) {
    return jsonResponse({ ok, message, ...(extra || {}) }, ok ? 200 : 400);
  }
  return renderResultPage(ok, message, config || { version: "-", updatedAt: nowIso() });
}

async function readForm(request) {
  try {
    return await request.formData();
  } catch (_) {
    return null;
  }
}

const str = (form, k) => (form.get(k) == null ? "" : String(form.get(k))).trim();

/* ================================================================
 *  頁面與局部刷新
 * ================================================================ */

/**
 * 組出畫面需要的資料。parts 指定要哪些區塊（省 KV 讀取與對外請求）：
 *   page（整頁）= 全部；partial 名稱 → 只載該區塊會用到的東西。
 */
const NEED = {
  page: ["devices", "codes", "ota", "status", "bstatus", "mon", "audit", "hist", "home", "homekey"],
  overview: ["devices", "ota", "status", "bstatus", "mon", "home"],
  devices: ["devices", "ota", "home"],
  codes: ["codes"],
  source: [],
  home: ["home", "homekey"],
  auth: [],
  notice: [],
  system: ["ota", "audit", "hist"],
  alerts: ["devices", "mon", "status"],
};

async function buildContext(request, env, part) {
  const need = new Set(NEED[part] || NEED.page);
  const config = await loadConfig(env);
  // 「家用備援」卡片第一次出現時自動產生登記金鑰（只寫這一欄，不升版本、不進歷史）
  if (need.has("homekey") && !config.homeProxyKey) {
    config.homeProxyKey = genHomeKey();
    try {
      await saveConfig(env, config);
      await appendAudit(env, request, "自動產生家用備援金鑰");
    } catch (err) {
      console.error("家用備援金鑰寫入失敗:", err);
      config.homeProxyKey = "";   // 沒存成功就別顯示（卡片會改顯示「產生金鑰」按鈕）
    }
  }
  const hasBackup = !!String(config.backupSubscriptionUrl || "").trim();
  let devicesError = false;
  const [devices, codes, ota, sourceStatus, backupStatus, mon, audit, hist, homeProxy] = await Promise.all([
    need.has("devices")
      ? loadDevices(env).catch((err) => { console.error("裝置列舉失敗:", err); devicesError = true; return []; })
      : Promise.resolve([]),
    need.has("codes") ? loadCodes(env) : Promise.resolve([]),
    need.has("ota") ? getLatestRelease(env).catch(() => null) : Promise.resolve(null),
    need.has("status") ? fetchSourceStatus(config.subscriptionUrl) : Promise.resolve(null),
    need.has("bstatus") && hasBackup ? fetchSourceStatus(config.backupSubscriptionUrl) : Promise.resolve(null),
    need.has("mon") ? loadMonState(env) : Promise.resolve(null),
    need.has("audit") ? loadAudit(env) : Promise.resolve([]),
    need.has("hist") ? loadConfigHistory(env) : Promise.resolve([]),
    need.has("home") ? loadHomeProxy(env) : Promise.resolve(null),
  ]);
  return {
    config, devices, codes, ota, sourceStatus, backupStatus, mon, audit, hist, homeProxy, devicesError,
    origin: new URL(request.url).origin,
    hasGithubToken: !!env.GITHUB_TOKEN,
  };
}

/** GET /admin */
export async function handleAdminPage(request, env) {
  const blocked = await guard(request, env);
  if (blocked) return blocked;
  const ctx = await buildContext(request, env, "page");
  return htmlResponse(renderAdminHtml(ctx), 200);
}

/** GET /admin/partial?name=overview|devices|codes|source|home|system|notice|auth|alerts → HTML 片段 */
export async function handleAdminPartial(request, env) {
  const blocked = await guard(request, env);
  if (blocked) return blocked;
  const name = new URL(request.url).searchParams.get("name") || "";
  if (!(name in NEED) || name === "page") return jsonResponse({ ok: false, error: "未知區塊" }, 404);
  const ctx = await buildContext(request, env, name);
  const html = renderPartial(name, ctx);
  if (html == null) return jsonResponse({ ok: false, error: "未知區塊" }, 404);
  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Config-Version": String(ctx.config.version),
    },
  });
}

/* ================================================================
 *  POST /admin/save — 分頁各自儲存（_fields 指明欄位組）
 * ================================================================ */

export async function handleAdminSave(request, env) {
  const blocked = await guard(request, env);
  if (blocked) return blocked;

  const current = await loadConfig(env);
  const form = await readForm(request);
  if (!form) return respond(request, false, "表單解析失敗", null, current);

  const fields = str(form, "_fields") || "all";
  const updated = { ...current, version: (current.version || 0) + 1, updatedAt: nowIso() };
  const changes = [];

  if (fields === "all" || fields === "source") {
    const subscriptionUrl = str(form, "subscriptionUrl");
    if (!subscriptionUrl || !/^https?:\/\//i.test(subscriptionUrl)) {
      return respond(request, false, "訂閱網址格式不正確（必須以 http:// 或 https:// 開頭）", null, current);
    }
    if (subscriptionUrl.length > 2000) {
      return respond(request, false, "訂閱網址太長", null, current);
    }
    updated.subscriptionUrl = subscriptionUrl;
    changes.push("直播源");
    // 備援線路（選填）：表單沒帶這欄（舊版管理頁還開著 / 直接 POST）就維持原值，免得一存主線路就把備援清掉
    if (form.has("backupSubscriptionUrl")) {
      const backupSubscriptionUrl = str(form, "backupSubscriptionUrl");
      if (backupSubscriptionUrl && !/^https?:\/\//i.test(backupSubscriptionUrl)) {
        return respond(request, false, "備援訂閱網址格式不正確（必須以 http:// 或 https:// 開頭；不用備援請留空）", null, current);
      }
      if (backupSubscriptionUrl.length > 2000) {
        return respond(request, false, "備援訂閱網址太長", null, current);
      }
      if (backupSubscriptionUrl && backupSubscriptionUrl === subscriptionUrl) {
        return respond(request, false, "備援訂閱網址跟主訂閱網址一樣，請填另一條線路（不用備援請留空）", null, current);
      }
      updated.backupSubscriptionUrl = backupSubscriptionUrl;
      if (backupSubscriptionUrl !== (current.backupSubscriptionUrl || "")) changes.push("備援直播源");
    }
  }

  if (fields === "all" || fields === "notice") {
    updated.notice = String(form.get("notice") || "").slice(0, 500);
    const nhRaw = str(form, "noticeHours");
    if (!updated.notice) updated.noticeUntil = "";
    else if (nhRaw === "") updated.noticeUntil = current.noticeUntil || "";   // 留空 = 維持原到期（改錯字不會把限時公告變常駐）
    else {
      let nh = parseFloatOr(nhRaw, 0);
      if (nh < 0) nh = 0;
      updated.noticeUntil = nh > 0 ? new Date(Date.now() + nh * 3600000).toISOString() : "";
    }
    changes.push("公告");
  }

  if (fields === "all" || fields === "marquee") {
    updated.marquee = String(form.get("marquee") || "").replace(/\s+/g, " ").trim().slice(0, 300);
    const mmRaw = str(form, "marqueeMinutes");
    if (!updated.marquee) updated.marqueeUntil = "";
    else if (mmRaw === "" && current.marqueeUntil && (Date.parse(current.marqueeUntil) || 0) > Date.now()) updated.marqueeUntil = current.marqueeUntil;
    else {
      let mm = parseFloatOr(mmRaw, 30);
      if (mm < 0) mm = 0;
      updated.marqueeUntil = mm > 0 ? new Date(Date.now() + mm * 60000).toISOString() : "";
    }
    changes.push("跑馬燈");
  }

  if (fields === "all" || fields === "contact") {
    updated.contactText = String(form.get("contactText") || "").slice(0, 200);
    changes.push("聯絡文字");
  }

  if (fields === "all" || fields === "system") {
    let poll = parseIntOr(form.get("pollIntervalMinutes"), current.pollIntervalMinutes || 180);
    if (poll < 10) poll = 10;
    if (poll > 1440) poll = 1440;
    updated.pollIntervalMinutes = poll;
    updated.forceRefresh = form.get("forceRefresh") === "on";
    updated.autostart = form.get("autostart") === "on";
    updated.showClock = form.get("showClock") === "on";
    updated.otaEnabled = form.get("otaEnabled") === "on";
    const fs = str(form, "fontScale");
    updated.fontScale = isValidFontScale(fs) ? fs : "auto";
    changes.push("系統設定");
  }

  if (fields === "all" || fields === "auth") {
    updated.requireActivation = form.get("requireActivation") === "on";
    updated.activationTitle = String(form.get("activationTitle") || "").slice(0, 60);
    updated.activationText = String(form.get("activationText") || "").slice(0, 500);
    let cd = parseIntOr(form.get("codeDigits"), current.codeDigits || 8);
    updated.codeDigits = Math.max(6, Math.min(12, cd));   // 4～5 位太好猜（200 組未用碼時每猜 2%），最低 6 位
    changes.push("授權設定");
  }

  if (fields === "home") {
    const role = str(form, "homeProxyRole");
    if (role !== "backup" && role !== "primary") return respond(request, false, "家用備援角色只能是「備援」或「優先」", null, current);
    updated.homeProxyRole = role;
    changes.push("家用備援角色");
  }

  if (fields === "alerts") {
    updated.alertsEnabled = form.get("alertsEnabled") === "on";
    const tok = str(form, "tgBotToken");
    if (form.get("clearTg") === "on") {
      updated.tgBotToken = "";
    } else if (tok) {
      if (!isValidTgToken(tok)) return respond(request, false, "Telegram Bot Token 格式不正確（應像 123456789:AAxxxxxxxx…，從 @BotFather 取得）", null, current);
      updated.tgBotToken = tok;
    } // 留空 = 沿用既有 token（畫面不會回填 token）
    const chat = str(form, "tgChatId").slice(0, 40);
    if (chat && !/^-?\d{1,20}$/.test(chat)) return respond(request, false, "Chat ID 應為數字（群組會是負數，例如 -1001234567890）", null, current);
    updated.tgChatId = chat;
    updated.alertSourceMin = Math.max(5, Math.min(120, parseIntOr(form.get("alertSourceMin"), current.alertSourceMin || 10)));
    updated.alertDeviceOfflineMin = Math.max(30, Math.min(1440, parseIntOr(form.get("alertDeviceOfflineMin"), current.alertDeviceOfflineMin || 180)));
    const quiet = str(form, "alertQuiet");
    if (quiet && !/^\d{1,2}\s*-\s*\d{1,2}$/.test(quiet)) return respond(request, false, "靜音時段格式為「起-迄」小時，例如 23-7", null, current);
    updated.alertQuiet = quiet.replace(/\s+/g, "");
    updated.alertBoxFail = form.get("alertBoxFail") === "on";
    if (updated.alertsEnabled && (!updated.tgBotToken || !updated.tgChatId)) {
      return respond(request, false, "要開啟警示，Bot Token 與 Chat ID 都要填", null, current);
    }
    changes.push("警示設定");
  }

  try {
    await pushConfigHistory(env, current);
    await saveConfig(env, updated);
  } catch (err) {
    console.error("KV 寫入失敗:", err);
    return respond(request, false, "KV 寫入失敗，請稍後再試", null, current);
  }

  const what = changes.length ? changes.join("、") : "設定";
  let srcNote = "";
  if (fields === "source") {
    srcNote = "：" + maskToken(updated.subscriptionUrl).slice(0, 100);
    if ((updated.backupSubscriptionUrl || "") !== (current.backupSubscriptionUrl || "")) {
      srcNote += updated.backupSubscriptionUrl ? "；備援 " + maskToken(updated.backupSubscriptionUrl).slice(0, 80) : "；備援已移除";
    }
  }
  await appendAudit(env, request, `儲存${what}（v${updated.version}）${srcNote}`);
  return respond(
    request,
    true,
    `${what}已儲存（版本 v${updated.version}），盒子下次輪詢就會套用`,
    { version: updated.version, refresh: ["overview", fields === "source" || fields === "home" ? "home" : "", fields === "alerts" ? "alerts" : ""].filter(Boolean) },
    updated
  );
}

/* ================================================================
 *  POST /admin/test — 測試來源（回 JSON）
 * ================================================================ */

export async function handleAdminTest(request, env) {
  const blocked = await guard(request, env);
  if (blocked) return blocked;

  let targetUrl = "";
  const form = await readForm(request);
  if (form) targetUrl = str(form, "subscriptionUrl");
  if (!targetUrl || !/^https?:\/\//i.test(targetUrl)) {
    return jsonResponse({ ok: false, error: "網址格式不正確" }, 400);
  }

  const boxes = await summarizeBoxes(env);

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    const started = Date.now();
    const resp = await fetch(targetUrl, {
      method: "GET",
      headers: { "User-Agent": "WeiTV-Admin-Test/2.0" },
      signal: controller.signal,
    });
    clearTimeout(timer);
    const text = await resp.text();
    const ms = Date.now() - started;
    const preview = parsePlaylistPreview(text);
    return jsonResponse({
      ok: true,
      httpStatus: resp.status,
      httpOk: resp.ok,
      channelCount: preview.count,
      bytes: text.length,
      ms,
      looksLikeM3u: /#EXTM3U/i.test(text),
      epgUrl: preview.epgUrl,
      groups: preview.groups,
      sample: preview.sample,
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

/** 從 m3u 文字抓出頻道數、分類統計、前幾個頻道名與 EPG 網址 */
function parsePlaylistPreview(text) {
  const lines = String(text || "").split(/\r?\n/);
  const groups = {};
  const sample = [];
  let count = 0;
  let epgUrl = "";
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#EXTM3U")) {
      const m = line.match(/(?:x-tvg-url|url-tvg)="([^"]+)"/i);
      if (m) epgUrl = m[1];
      continue;
    }
    if (!line.startsWith("#EXTINF")) continue;
    count++;
    const g = (line.match(/group-title="([^"]*)"/i) || [])[1] || "其他";
    groups[g] = (groups[g] || 0) + 1;
    const comma = line.lastIndexOf(",");
    const name = comma >= 0 ? line.slice(comma + 1).trim() : "";
    if (name && sample.length < 12) sample.push(name);
  }
  const groupList = Object.keys(groups)
    .map((k) => ({ name: k, count: groups[k] }))
    .sort((a, b) => b.count - a.count);
  return { count, epgUrl, groups: groupList, sample };
}

/** 彙整盒子實測來源健康（雲端被擋時也有真實依據） */
async function summarizeBoxes(env) {
  let devices = [];
  try {
    devices = await loadDevices(env);
  } catch (_) {
    devices = [];
  }
  let reported = 0, ok = 0, maxCount = 0, recentMs = 0, recentAt = "", onBackup = 0;
  const nowMs = Date.now();
  for (const d of devices) {
    // 目前在線、且回報正走備援線路的盒子（ln=1）
    if (d && d.ln === 1 && nowMs - (Date.parse(d.lastSeen) || 0) < ONLINE_MS) onBackup++;
    if (!d || !d.lastResultAt) continue;
    reported++;
    const ms = Date.parse(d.lastResultAt) || 0;
    if (ms > recentMs) { recentMs = ms; recentAt = d.lastResultAt; }
    if (d.lastOk === true) {
      ok++;
      const c = typeof d.lastCount === "number" ? d.lastCount : 0;
      if (c > maxCount) maxCount = c;
    }
  }
  return { reported, ok, maxCount, recentAt, recentRel: recentAt ? relativeTime(recentAt) : "", onBackup };
}

/* ================================================================
 *  POST /admin/device — 裝置動作（只寫 devadm:<id>，心跳寫的 dev:<id> 不碰）
 * ================================================================ */

/** 讀某台的管理員紀錄（不存在時給空物件）；順便回傳合併後的顯示名 */
async function loadAdm(env, id) {
  const { dev, adm } = await loadDevice(env, id);
  if (!dev && !adm) return null;
  const a = { ...(adm || {}), id };
  const who = a.nick ? `${a.nick}（${id}）` : id;
  return { adm: a, who, dev };
}

export async function handleAdminDevice(request, env) {
  const blocked = await guard(request, env);
  if (blocked) return blocked;

  const form = await readForm(request);
  if (!form) return respond(request, false, "表單解析失敗");

  const id = str(form, "id");
  const action = str(form, "action");
  const value = String(form.get("value") == null ? "" : form.get("value"));
  const level = str(form, "level");
  const arg = str(form, "arg");
  const refresh = ["devices", "overview"];

  // ── 批量動作（不針對單一 id）──
  if (action === "autostart_all") {
    const on = value === "on";
    const devices = await loadDevices(env);
    let n = 0;
    for (const dev of devices) {
      if (!dev || !dev.id) continue;
      try {
        const r = await loadAdm(env, dev.id);
        if (!r) continue;
        r.adm.autostart = on;
        r.adm.autostartAt = nowIso();
        await saveDeviceAdmin(env, dev.id, r.adm);
        n++;
      } catch (_) {}
    }
    await appendAudit(env, request, `全部裝置開機自啟設為「${on ? "開" : "關"}」（${n} 台）`);
    return respond(request, true, `已將 ${n} 台裝置的開機自啟設為「${on ? "開" : "關"}」`, { refresh });
  }

  if (action === "authorize_all") {
    let days = parseIntOr(value, 0);
    if (days < 0) days = 0;
    const expireAt = days > 0 ? new Date(Date.now() + days * 86400000).toISOString() : "";
    const devices = await loadDevices(env);
    let n = 0;
    for (const dev of devices) {
      if (!dev || !dev.id) continue;
      try {
        await authorizeDevice(env, dev.id, expireAt, "");
        n++;
      } catch (_) {}
    }
    await appendAudit(env, request, `一鍵授權所有裝置（${n} 台，${days > 0 ? days + " 天" : "永久"}）`);
    return respond(request, true, `已授權 ${n} 台現有裝置（${days > 0 ? days + " 天" : "永久"}）`, { refresh });
  }

  if (action === "cmd_all") {
    const type = value;
    if (!CMD_TYPES[type]) return respond(request, false, "未知指令");
    if (type === "tune" && !/^\d{1,4}$/.test(arg)) return respond(request, false, "請輸入頻道號碼（數字）");
    const devices = await loadDevices(env);
    let n = 0;
    const cmd = { id: "c" + Date.now().toString(36), type, arg, at: nowIso() };
    for (const dev of devices) {
      if (!dev || !dev.id || dev.blocked) continue;
      try {
        const r = await loadAdm(env, dev.id);
        if (!r) continue;
        r.adm.cmd = { ...cmd };
        await saveDeviceAdmin(env, dev.id, r.adm);
        n++;
      } catch (_) {}
    }
    await appendAudit(env, request, `對全部裝置送出「${CMD_TYPES[type]}」（${n} 台）`);
    return respond(request, true, `已對 ${n} 台裝置送出「${CMD_TYPES[type]}」，各台下次心跳（約 90 秒內）執行`, { refresh });
  }

  if (action === "delete_stale") {
    // 刪除 30 天以上沒上線的裝置紀錄
    const devices = await loadDevices(env);
    const cutoff = Date.now() - 30 * 86400000;
    let n = 0;
    for (const dev of devices) {
      if (!dev || !dev.id) continue;
      if ((Date.parse(dev.lastSeen) || 0) < cutoff) {
        try {
          await env.CONFIG_KV.delete(DEVICE_PREFIX + dev.id);
          await env.CONFIG_KV.delete(DEVADM_PREFIX + dev.id);
          n++;
        } catch (_) {}
      }
    }
    await appendAudit(env, request, `清除 30 天未上線裝置（${n} 台）`);
    return respond(request, true, `已清除 ${n} 台超過 30 天未上線的裝置紀錄`, { refresh });
  }

  if (!id || !action) return respond(request, false, "缺少裝置 id 或動作");

  if (action === "delete") {
    try {
      await env.CONFIG_KV.delete(DEVICE_PREFIX + id);
      await env.CONFIG_KV.delete(DEVADM_PREFIX + id);
    } catch (err) {
      return respond(request, false, "刪除失敗，請稍後再試");
    }
    await appendAudit(env, request, `刪除裝置 ${id}`);
    return respond(request, true, `已刪除裝置 ${id}`, { refresh });
  }

  let r = null;
  try {
    r = await loadAdm(env, id);
  } catch (_) {}
  if (!r) {
    return respond(request, false, `找不到裝置 ${id}（可能已被刪除）`);
  }
  const adm = r.adm;
  const who = r.who;

  let summary = "";
  switch (action) {
    case "block":
      adm.blocked = true;
      summary = `已封鎖 ${who}，約 90 秒內停播`;
      break;
    case "unblock":
      adm.blocked = false;
      summary = `已解除封鎖 ${who}`;
      break;
    case "message":
      adm.msg = value.slice(0, 200);
      adm.msgLevel = level === "warn" ? "warn" : "info";
      summary = adm.msg ? `已對 ${who} 傳話` : `已清除 ${who} 的訊息`;
      break;
    case "clearmsg":
      adm.msg = "";
      adm.msgLevel = "info";
      summary = `已清除 ${who} 的訊息`;
      break;
    case "rename":
      adm.nick = value.trim().slice(0, 40);
      summary = adm.nick ? `已把 ${id} 命名為「${adm.nick}」` : `已清除 ${id} 的暱稱`;
      break;
    case "autostart":
      adm.autostart = value === "on";
      adm.autostartAt = nowIso();
      summary = `已將 ${who} 的開機自啟設為「${adm.autostart ? "開" : "關"}」`;
      break;
    case "authorize": {
      let days = parseIntOr(value, 0);
      if (days < 0) days = 0;
      adm.authorized = true;
      adm.authedAt = nowIso();
      adm.expireAt = days > 0 ? new Date(Date.now() + days * 86400000).toISOString() : "";
      summary = `已授權 ${who}（${days > 0 ? days + " 天" : "永久"}）`;
      break;
    }
    case "deauthorize":
      adm.authorized = false;
      adm.expireAt = "";
      // 綁定的啟動碼一併作廢，不然盒子重輸同一組碼就又回來了
      if (adm.codeUsed) {
        try {
          const ck = CODE_PREFIX + adm.codeUsed;
          const rec = await env.CONFIG_KV.get(ck, { type: "json" });
          if (rec && rec.status === "used" && rec.device === id) {
            rec.status = "revoked";
            await env.CONFIG_KV.put(ck, JSON.stringify(rec));
          }
        } catch (_) {}
      }
      summary = `已撤銷 ${who} 的授權${adm.codeUsed ? "（原啟動碼一併作廢）" : ""}`;
      break;
    case "fontscale": {
      const fs = value.trim();
      if (fs && !isValidFontScale(fs)) return respond(request, false, "字體等級不正確");
      adm.fontScale = fs; // 空字串 = 跟隨全域
      summary = fs ? `已將 ${who} 的字體設為「${fs}」` : `${who} 的字體改為跟隨全域設定`;
      break;
    }
    case "cmd": {
      const type = value.trim();
      if (!CMD_TYPES[type]) return respond(request, false, "未知指令");
      if (type === "tune" && !/^\d{1,4}$/.test(arg)) return respond(request, false, "請輸入頻道號碼（數字）");
      adm.cmd = { id: "c" + Date.now().toString(36), type, arg, at: nowIso() };
      summary = `已送出「${CMD_TYPES[type]}${type === "tune" ? " " + arg : ""}」給 ${who}，下次心跳（約 90 秒內）執行`;
      break;
    }
    case "clearcmd":
      adm.cmd = null;
      summary = `已取消 ${who} 的待送指令`;
      break;
    case "watch":
      adm.watch = value === "on";
      summary = adm.watch
        ? `已把 ${who} 設為重點監控：離線超過門檻會通知你（在「警示」分頁設定）`
        : `已取消 ${who} 的重點監控`;
      break;
    default:
      return respond(request, false, `未知動作：${action}`);
  }

  try {
    await saveDeviceAdmin(env, id, adm);
    // 授權後盒子紀錄改永久（未授權的新裝置原本只有 7 天壽命）
    if (action === "authorize" && r.dev) {
      const { stripAdminFields } = await import("./lib.js");
      await env.CONFIG_KV.put(DEVICE_PREFIX + id, JSON.stringify(stripAdminFields(r.dev)));
    }
  } catch (err) {
    return respond(request, false, "寫入失敗，請稍後再試");
  }
  await appendAudit(env, request, summary);
  return respond(request, true, summary, { refresh });
}

/* ================================================================
 *  POST /admin/codes — 啟動碼管理
 * ================================================================ */

export async function handleAdminCodes(request, env) {
  const blocked = await guard(request, env);
  if (blocked) return blocked;

  const form = await readForm(request);
  if (!form) return respond(request, false, "表單解析失敗");

  const action = str(form, "action");
  const note = str(form, "note").slice(0, 60);
  let days = parseIntOr(form.get("days"), 0);
  if (days < 0) days = 0;
  const iso = nowIso();
  const refresh = ["codes", "overview"];

  if (action === "gen_single" || action === "gen_batch") {
    const config = await loadConfig(env);
    const digits = config.codeDigits || 8;
    let count = action === "gen_batch" ? parseIntOr(form.get("count"), 1) : 1;
    count = Math.max(1, Math.min(count, 200));

    const created = [];
    for (let i = 0; i < count; i++) {
      let code = "";
      for (let tries = 0; tries < 6; tries++) {
        const c = genCodeString(digits);
        let exists = null;
        try {
          exists = await env.CONFIG_KV.get(CODE_PREFIX + c);
        } catch (_) {}
        if (!exists) { code = c; break; }
      }
      if (!code) continue;
      const rec = { code, status: "unused", device: null, note, days, createdAt: iso, usedAt: "", expireAt: "" };
      try {
        await env.CONFIG_KV.put(CODE_PREFIX + code, JSON.stringify(rec));
        created.push(code);
      } catch (_) {}
    }
    if (created.length) await appendAudit(env, request, `產生 ${created.length} 組啟動碼（${days > 0 ? days + " 天" : "永久"}${note ? "，" + note : ""}）`);
    if (wantsJson(request)) {
      return jsonResponse({
        ok: created.length > 0,
        message: created.length ? `已產生 ${created.length} 組啟動碼（${days > 0 ? days + " 天" : "永久"}）` : "產生失敗，請重試",
        codes: created,
        days,
        note,
        refresh,
      });
    }
    return renderCodesResultPage(created, days, note);
  }

  if (action === "delete_unused_all") {
    const codes = await loadCodes(env);
    let n = 0;
    for (const c of codes) {
      if (c && c.status === "unused" && c.code) {
        try {
          await env.CONFIG_KV.delete(CODE_PREFIX + c.code);
          n++;
        } catch (_) {}
      }
    }
    await appendAudit(env, request, `刪除 ${n} 組未使用啟動碼`);
    return respond(request, true, `已刪除 ${n} 組未使用的啟動碼`, { refresh });
  }

  const code = str(form, "code");
  if (!code) return respond(request, false, "缺少啟動碼");
  const key = CODE_PREFIX + code;

  if (action === "delete") {
    try {
      await env.CONFIG_KV.delete(key);
    } catch (_) {
      return respond(request, false, "刪除失敗");
    }
    await appendAudit(env, request, `刪除啟動碼 ${code}`);
    return respond(request, true, `已刪除啟動碼 ${code}`, { refresh });
  }

  if (action === "revoke") {
    let rec = null;
    try {
      rec = await env.CONFIG_KV.get(key, { type: "json" });
    } catch (_) {}
    if (!rec) return respond(request, false, `找不到啟動碼 ${code}`);
    rec.status = "revoked";
    if (rec.device) {
      try {
        const { adm } = await loadDevice(env, rec.device);
        if (adm) {
          adm.authorized = false;
          adm.expireAt = "";
          await saveDeviceAdmin(env, rec.device, adm);
        }
      } catch (_) {}
    }
    try {
      await env.CONFIG_KV.put(key, JSON.stringify(rec));
    } catch (_) {
      return respond(request, false, "撤銷失敗");
    }
    await appendAudit(env, request, `撤銷啟動碼 ${code}${rec.device ? "（停用裝置 " + rec.device + "）" : ""}`);
    return respond(request, true, `已撤銷啟動碼 ${code}${rec.device ? "（並停用綁定裝置）" : ""}`, {
      refresh: ["codes", "devices", "overview"],
    });
  }

  return respond(request, false, `未知動作：${action}`);
}

/* ================================================================
 *  POST /admin/upload — 聯絡 QR 圖
 * ================================================================ */

export async function handleAdminUpload(request, env) {
  const blocked = await guard(request, env);
  if (blocked) return blocked;

  const form = await readForm(request);
  if (!form) return respond(request, false, "上傳解析失敗");
  const action = str(form, "action");
  const config = await loadConfig(env);
  const refresh = ["notice", "overview"];

  if (action === "remove") {
    try {
      await env.CONFIG_KV.delete(QR_ASSET_KEY);
    } catch (_) {}
    config.version = (config.version || 0) + 1;
    config.contactQrVer = 0;
    config.updatedAt = nowIso();
    try {
      await saveConfig(env, config);
    } catch (_) {}
    await appendAudit(env, request, "移除聯絡 QR 圖");
    return respond(request, true, "已移除聯絡 QR 圖", { refresh, version: config.version }, config);
  }

  // 匯入設定 JSON（由「系統」分頁匯出的檔案）：只接受已知欄位，其餘忽略；舊設定會進版本歷史可還原
  if (action === "import_config") {
    const file = form.get("file");
    if (!file || typeof file === "string" || typeof file.text !== "function") return respond(request, false, "請選擇匯出的設定 JSON 檔", null, config);
    let obj = null;
    try {
      const text = await file.text();
      if (text.length > 200000) throw new Error("too large");
      obj = JSON.parse(text);
    } catch (_) {
      return respond(request, false, "檔案不是有效的設定 JSON", null, config);
    }
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return respond(request, false, "檔案內容不是設定物件", null, config);
    const imported = { ...config };
    const applied = [];
    for (const k of Object.keys(DEFAULT_CONFIG)) {
      if (k === "version" || k === "updatedAt" || k === "contactQrVer") continue;
      if (!(k in obj)) continue;
      const want = typeof DEFAULT_CONFIG[k];
      let v = obj[k];
      if (want === "boolean") v = v === true || v === "true" || v === "on";
      else if (want === "number") { v = parseIntOr(v, DEFAULT_CONFIG[k]); }
      else v = String(v == null ? "" : v);
      // 家用代理金鑰：格式對才換（搬家沿用舊金鑰，家用代理不必重設）；不對就維持目前的
      if (k === "homeProxyKey" && !isValidHomeKey(v)) continue;
      if (k === "homeProxyRole" && v !== "primary") v = "backup";
      if (k === "backupSubscriptionUrl") v = v.trim();
      if (JSON.stringify(v) !== JSON.stringify(config[k])) applied.push(configLabel(k));
      imported[k] = v;
    }
    if (imported.subscriptionUrl && !/^https?:\/\//i.test(imported.subscriptionUrl)) return respond(request, false, "匯入的訂閱網址格式不正確", null, config);
    if (imported.backupSubscriptionUrl && (!/^https?:\/\//i.test(imported.backupSubscriptionUrl) || imported.backupSubscriptionUrl.length > 2000)) {
      return respond(request, false, "匯入的備援訂閱網址格式不正確", null, config);
    }
    if (!isValidFontScale(imported.fontScale)) imported.fontScale = "auto";
    if (imported.tgBotToken && !isValidTgToken(imported.tgBotToken)) imported.tgBotToken = "";
    imported.version = (config.version || 0) + 1;
    imported.updatedAt = nowIso();
    try {
      await pushConfigHistory(env, config);
      await saveConfig(env, imported);
    } catch (_) {
      return respond(request, false, "KV 寫入失敗", null, config);
    }
    await appendAudit(env, request, `匯入設定（v${imported.version}，${applied.length ? "變更：" + applied.join("、") : "無變更"}）`);
    return respond(request, true, `已匯入設定（v${imported.version}）${applied.length ? "，變更：" + applied.join("、") : "，內容與目前相同"}`, {
      refresh: ["overview", "source", "home", "notice", "system", "auth", "alerts"], version: imported.version,
    }, imported);
  }

  const file = form.get("file");
  if (!file || typeof file === "string" || typeof file.arrayBuffer !== "function") {
    return respond(request, false, "請選擇要上傳的圖檔", null, config);
  }
  let buf;
  try {
    buf = await file.arrayBuffer();
  } catch (_) {
    return respond(request, false, "讀取圖檔失敗", null, config);
  }
  if (buf.byteLength > 2 * 1024 * 1024) return respond(request, false, "圖檔太大，請小於 2MB", null, config);
  // 只認檔頭（magic bytes），不信瀏覽器報的 MIME：SVG 之類可夾帶 script 的一律拒收
  const ct = sniffImageType(new Uint8Array(buf.slice(0, 16)));
  if (!ct) return respond(request, false, "只接受 PNG / JPG / GIF / WebP 圖片檔", null, config);
  try {
    await env.CONFIG_KV.put(QR_ASSET_KEY, buf, { metadata: { ct } });
  } catch (_) {
    return respond(request, false, "圖檔儲存失敗，請稍後再試", null, config);
  }
  config.version = (config.version || 0) + 1;
  config.contactQrVer = (config.contactQrVer || 0) + 1;
  config.updatedAt = nowIso();
  try {
    await saveConfig(env, config);
  } catch (_) {}
  await appendAudit(env, request, "上傳聯絡 QR 圖");
  return respond(request, true, "已上傳聯絡 QR 圖，盒子下次輪詢就會看到", { refresh, version: config.version }, config);
}

/** 由檔頭判斷圖片類型；不是 PNG / JPEG / GIF / WebP 回 null */
function sniffImageType(b) {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return "image/gif";
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  return null;
}

/* ================================================================
 *  POST /admin/system — 系統動作
 * ================================================================ */

export async function handleAdminSystem(request, env) {
  const blocked = await guard(request, env);
  if (blocked) return blocked;
  const form = await readForm(request);
  if (!form) return respond(request, false, "表單解析失敗");
  const action = str(form, "action");

  if (action === "ota_refresh") {
    try {
      await env.CONFIG_KV.delete(OTA_CACHE_KEY);
    } catch (_) {}
    const rel = env.GITHUB_TOKEN ? await getLatestRelease(env, true) : null;
    if (!env.GITHUB_TOKEN) return respond(request, false, "尚未設定 GITHUB_TOKEN，無法查詢 Release");
    if (!rel) return respond(request, false, "向 GitHub 查詢失敗（token 權限或網路）");
    return respond(request, true, `已重新讀取：最新版 ${rel.name}（${Math.round((rel.size || 0) / 1024 / 1024 * 10) / 10} MB）`, {
      refresh: ["system", "overview"],
    });
  }

  if (action === "clear_notice" || action === "clear_marquee") {
    const config = await loadConfig(env);
    if (action === "clear_notice") { config.notice = ""; config.noticeUntil = ""; }
    else { config.marquee = ""; config.marqueeUntil = ""; }
    config.version = (config.version || 0) + 1;
    config.updatedAt = nowIso();
    try {
      await saveConfig(env, config);
    } catch (_) {
      return respond(request, false, "KV 寫入失敗");
    }
    await appendAudit(env, request, action === "clear_notice" ? "撤下公告" : "停止跑馬燈");
    return respond(request, true, action === "clear_notice" ? "已撤下公告" : "已停止跑馬燈", {
      refresh: ["notice", "overview"], version: config.version,
    }, config);
  }

  if (action === "force_refresh_off") {
    const config = await loadConfig(env);
    config.forceRefresh = false;
    config.version = (config.version || 0) + 1;
    config.updatedAt = nowIso();
    try {
      await saveConfig(env, config);
    } catch (_) {
      return respond(request, false, "KV 寫入失敗");
    }
    await appendAudit(env, request, "關閉強制刷新旗標");
    return respond(request, true, "已關閉強制刷新旗標", { refresh: ["system", "overview"], version: config.version }, config);
  }

  // 還原某一份歷史設定（idx = 歷史列表索引，0 = 最近一份）
  if (action === "restore_config") {
    const current = await loadConfig(env);
    const hist = await loadConfigHistory(env);
    const idx = parseIntOr(form.get("idx"), -1);
    const snap = hist[idx];
    if (!snap) return respond(request, false, "找不到這份歷史設定（可能已被新的擠掉）", null, current);
    const restored = { ...DEFAULT_CONFIG, ...snap, version: (current.version || 0) + 1, updatedAt: nowIso() };
    // QR 圖本體沒有版本化，維持目前的；家用代理金鑰是憑證不是設定，還原舊版也不換（否則家用代理會突然登記失敗）
    restored.contactQrVer = current.contactQrVer;
    restored.homeProxyKey = current.homeProxyKey;
    const changed = diffConfigKeys(current, restored).map(configLabel);
    try {
      await pushConfigHistory(env, current);
      await saveConfig(env, restored);
    } catch (_) {
      return respond(request, false, "KV 寫入失敗", null, current);
    }
    await appendAudit(env, request, `還原設定 v${snap.version || "?"} → v${restored.version}（${changed.length ? changed.join("、") : "無變更"}）`);
    return respond(request, true, `已還原成 v${snap.version || "?"} 的內容（新版本 v${restored.version}）${changed.length ? "，變更：" + changed.join("、") : ""}`, {
      refresh: ["overview", "source", "home", "notice", "system", "auth", "alerts"], version: restored.version,
    }, restored);
  }

  if (action === "regen_home_key") {
    // 金鑰只有家用代理用、盒子看不到：只換這一欄，不升版本、不進歷史（免得盒子以為設定變了而重載）
    const current = await loadConfig(env);
    const updated = { ...current, homeProxyKey: genHomeKey() };
    try {
      await saveConfig(env, updated);
    } catch (_) {
      return respond(request, false, "KV 寫入失敗", null, current);
    }
    await appendAudit(env, request, current.homeProxyKey ? "重新產生家用備援金鑰（舊金鑰立即失效）" : "產生家用備援金鑰");
    return respond(request, true, current.homeProxyKey ? "已重新產生家用備援金鑰：帶舊金鑰登記的家用代理要換成新金鑰（免金鑰登記的不受影響）" : "已產生家用備援金鑰", {
      refresh: ["home"],
    }, updated);
  }

  if (action === "clear_audit") {
    try {
      await env.CONFIG_KV.delete("audit");
    } catch (_) {}
    await appendAudit(env, request, "清除操作紀錄");
    return respond(request, true, "已清除操作紀錄", { refresh: ["system"] });
  }

  return respond(request, false, `未知動作：${action}`);
}

/* ================================================================
 *  POST /admin/alerts — 警示：測試發送 / 立即檢查 / 清除警示紀錄
 * ================================================================ */

export async function handleAdminAlerts(request, env) {
  const blocked = await guard(request, env);
  if (blocked) return blocked;
  const form = await readForm(request);
  if (!form) return respond(request, false, "表單解析失敗");
  const action = str(form, "action");
  const config = await loadConfig(env);

  if (action === "test") {
    // 允許用表單裡剛填、尚未儲存的值測試
    const tok = str(form, "tgBotToken") || config.tgBotToken;
    const chat = str(form, "tgChatId") || config.tgChatId;
    const r = await sendTelegram({ tgBotToken: tok, tgChatId: chat },
      `✅ <b>偉電視管理中心</b> 測試訊息\n收到這則表示 Telegram 通知已接好。\n${formatTaipeiFull(nowIso())}`);
    if (!r.ok) return respond(request, false, `Telegram 發送失敗：${r.error}`);
    await appendAudit(env, request, "發送 Telegram 測試訊息");
    return respond(request, true, "測試訊息已送出，請看 Telegram");
  }

  if (action === "run") {
    const r = await runMonitorTick(env, Date.now(), { force: true });
    const T = { ok: "正常", bad: "異常", stale: "沒回報", none: "無看門狗資料", off: "未設定" };
    const stateTxt = (T[r.state] || r.state) + (r.bstate && r.bstate !== "off" ? "；備援線路 " + (T[r.bstate] || r.bstate) : "");
    await appendAudit(env, request, `手動執行監控（直播源 ${stateTxt}，${r.events.length} 則事件）`);
    return respond(request, true, `已檢查：直播源 ${stateTxt}${r.events.length ? "，產生 " + r.events.length + " 則通知" : "，沒有新事件"}`, { refresh: ["alerts", "overview"] });
  }

  if (action === "clear_log") {
    const st = await loadMonState(env);
    st.log = [];
    try {
      await saveMonState(env, st);
    } catch (_) {
      return respond(request, false, "KV 寫入失敗");
    }
    await appendAudit(env, request, "清除警示紀錄");
    return respond(request, true, "已清除警示紀錄", { refresh: ["alerts"] });
  }

  return respond(request, false, `未知動作：${action}`);
}

/* ================================================================
 *  GET /admin/export?what=codes|devices|config — CSV / JSON 匯出
 * ================================================================ */

export async function handleAdminExport(request, env) {
  const blocked = await guard(request, env);
  if (blocked) return blocked;
  const what = new URL(request.url).searchParams.get("what") || "codes";
  const stamp = new Date().toISOString().slice(0, 10);
  if (what === "config") {
    const config = await loadConfig(env);
    // 含直播源 token 與 Telegram token：檔名標 SECRET 提醒妥善保管
    return new Response(JSON.stringify(config, null, 2), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="weitv-config-SECRET-v${config.version}-${stamp}.json"`,
        "Cache-Control": "no-store",
      },
    });
  }
  const q = csvCell;
  let rows = [];
  let name = "";
  if (what === "devices") {
    const devices = await loadDevices(env);
    name = "weitv-devices";
    rows.push(["編號", "暱稱", "機型", "版本", "授權", "到期", "封鎖", "最後上線", "首次上線", "IP", "正在觀看"]);
    for (const d of devices) {
      rows.push([
        d.id, d.nick || "", d.m || "", d.v || "", d.authorized ? "是" : "否",
        d.expireAt ? formatTaipeiFull(d.expireAt) : (d.authorized ? "永久" : ""),
        d.blocked ? "是" : "否", formatTaipeiFull(d.lastSeen), formatTaipeiFull(d.firstSeen), d.ip || "", d.now || "",
      ]);
    }
  } else {
    const codes = await loadCodes(env);
    name = "weitv-codes";
    rows.push(["啟動碼", "狀態", "天數", "到期", "綁定裝置", "備註", "建立時間", "使用時間"]);
    for (const c of codes) {
      rows.push([
        c.code, c.status === "used" ? "已啟用" : c.status === "revoked" ? "已撤銷" : "未使用",
        c.days > 0 ? c.days : "永久", c.expireAt ? formatTaipeiFull(c.expireAt) : "", c.device || "", c.note || "",
        formatTaipeiFull(c.createdAt), c.usedAt ? formatTaipeiFull(c.usedAt) : "",
      ]);
    }
  }
  const csv = "﻿" + rows.map((r) => r.map(q).join(",")).join("\r\n") + "\r\n";
  return new Response(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${name}-${stamp}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}

// 供 ui.js 以外的模組需要時使用
export { escapeHtml };

/**
 * 偉電視（WeiTV）控制平面 — 管理頁後端（需 Basic Auth）
 * ----------------------------------------------------------------
 * 所有 POST 動作同時支援：
 *   • 管理頁前端 fetch（帶 X-Requested-With: fetch）→ 回 JSON，前端 toast + 局部刷新
 *   • 傳統表單送出（無 JS）→ 回結果頁
 */

import {
  CMD_TYPES,
  CODE_PREFIX,
  DEVICE_PREFIX,
  OTA_CACHE_KEY,
  QR_ASSET_KEY,
  escapeHtml,
  formatTaipeiFull,
  htmlResponse,
  isValidFontScale,
  jsonResponse,
  loadConfig,
  nowIso,
  parseFloatOr,
  parseIntOr,
  relativeTime,
  saveConfig,
  timingSafeEqual,
  wantsJson,
} from "./lib.js";
import { authorizeDevice, genCodeString, getLatestRelease, loadCodes, loadDevices } from "./api.js";
import { renderAdminHtml, renderCodesResultPage, renderPartial, renderResultPage, setupPasswordHtml } from "./ui.js";

/* ================================================================
 *  驗證與安全
 * ================================================================ */

/**
 * 驗證 Basic Auth。使用者名稱不限，密碼必須等於 env.ADMIN_PASSWORD。
 * 通過回傳 null；未通過回傳 401 Response（fetch 模式回 JSON，瀏覽器模式跳帳密框）。
 */
export function checkAuth(request, env) {
  const expected = env.ADMIN_PASSWORD;
  if (!expected) return htmlResponse(setupPasswordHtml(), 200);

  const header = request.headers.get("Authorization") || "";
  if (header.startsWith("Basic ")) {
    try {
      const decoded = atob(header.slice(6));
      const idx = decoded.indexOf(":");
      const password = idx >= 0 ? decoded.slice(idx + 1) : "";
      if (timingSafeEqual(password, expected)) return null;
    } catch (_) {}
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
function guard(request, env) {
  const unauthorized = checkAuth(request, env);
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

async function buildContext(request, env) {
  const [config, devices, codes] = await Promise.all([loadConfig(env), loadDevices(env), loadCodes(env)]);
  let ota = null;
  try {
    ota = await getLatestRelease(env);
  } catch (_) {
    ota = null;
  }
  return { config, devices, codes, ota, origin: new URL(request.url).origin, hasGithubToken: !!env.GITHUB_TOKEN };
}

/** GET /admin */
export async function handleAdminPage(request, env) {
  const blocked = guard(request, env);
  if (blocked) return blocked;
  const ctx = await buildContext(request, env);
  return htmlResponse(renderAdminHtml(ctx), 200);
}

/** GET /admin/partial?name=overview|devices|codes|source|system|notice|auth → HTML 片段 */
export async function handleAdminPartial(request, env) {
  const blocked = guard(request, env);
  if (blocked) return blocked;
  const name = new URL(request.url).searchParams.get("name") || "";
  const ctx = await buildContext(request, env);
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
  const blocked = guard(request, env);
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
  }

  if (fields === "all" || fields === "notice") {
    updated.notice = String(form.get("notice") || "").slice(0, 500);
    let nh = parseFloatOr(form.get("noticeHours"), 0);
    if (nh < 0) nh = 0;
    updated.noticeUntil = nh > 0 && updated.notice ? new Date(Date.now() + nh * 3600000).toISOString() : "";
    changes.push("公告");
  }

  if (fields === "all" || fields === "marquee") {
    updated.marquee = String(form.get("marquee") || "").replace(/\s+/g, " ").trim().slice(0, 300);
    let mm = parseFloatOr(form.get("marqueeMinutes"), 0);
    if (mm < 0) mm = 0;
    updated.marqueeUntil = mm > 0 && updated.marquee ? new Date(Date.now() + mm * 60000).toISOString() : "";
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
    updated.codeDigits = Math.max(4, Math.min(12, cd));
    changes.push("授權設定");
  }

  try {
    await saveConfig(env, updated);
  } catch (err) {
    console.error("KV 寫入失敗:", err);
    return respond(request, false, "KV 寫入失敗，請稍後再試", null, current);
  }

  const what = changes.length ? changes.join("、") : "設定";
  return respond(
    request,
    true,
    `${what}已儲存（版本 v${updated.version}），盒子下次輪詢就會套用`,
    { version: updated.version, refresh: ["overview", fields === "source" ? "source" : ""].filter(Boolean) },
    updated
  );
}

/* ================================================================
 *  POST /admin/test — 測試來源（回 JSON）
 * ================================================================ */

export async function handleAdminTest(request, env) {
  const blocked = guard(request, env);
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
  let reported = 0, ok = 0, maxCount = 0, recentMs = 0, recentAt = "";
  for (const d of devices) {
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
  return { reported, ok, maxCount, recentAt, recentRel: recentAt ? relativeTime(recentAt) : "" };
}

/* ================================================================
 *  POST /admin/device — 裝置動作
 * ================================================================ */

export async function handleAdminDevice(request, env) {
  const blocked = guard(request, env);
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
      dev.autostart = on;
      try {
        await env.CONFIG_KV.put(DEVICE_PREFIX + dev.id, JSON.stringify(dev));
        n++;
      } catch (_) {}
    }
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
    return respond(request, true, `已授權 ${n} 台現有裝置（${days > 0 ? days + " 天" : "永久"}）`, { refresh });
  }

  if (action === "cmd_all") {
    const type = value;
    if (!CMD_TYPES[type]) return respond(request, false, "未知指令");
    const devices = await loadDevices(env);
    let n = 0;
    const cmd = { id: "c" + Date.now().toString(36), type, arg, at: nowIso() };
    for (const dev of devices) {
      if (!dev || !dev.id || dev.blocked) continue;
      dev.cmd = { ...cmd };
      try {
        await env.CONFIG_KV.put(DEVICE_PREFIX + dev.id, JSON.stringify(dev));
        n++;
      } catch (_) {}
    }
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
          n++;
        } catch (_) {}
      }
    }
    return respond(request, true, `已清除 ${n} 台超過 30 天未上線的裝置紀錄`, { refresh });
  }

  if (!id || !action) return respond(request, false, "缺少裝置 id 或動作");
  const key = DEVICE_PREFIX + id;

  if (action === "delete") {
    try {
      await env.CONFIG_KV.delete(key);
    } catch (err) {
      return respond(request, false, "刪除失敗，請稍後再試");
    }
    return respond(request, true, `已刪除裝置 ${id}`, { refresh });
  }

  let dev = null;
  try {
    dev = await env.CONFIG_KV.get(key, { type: "json" });
  } catch (_) {}
  if (!dev || typeof dev !== "object") {
    return respond(request, false, `找不到裝置 ${id}（可能已被刪除）`);
  }

  let summary = "";
  const who = dev.nick ? `${dev.nick}（${id}）` : id;
  switch (action) {
    case "block":
      dev.blocked = true;
      summary = `已封鎖 ${who}，約 90 秒內停播`;
      break;
    case "unblock":
      dev.blocked = false;
      summary = `已解除封鎖 ${who}`;
      break;
    case "message":
      dev.msg = value.slice(0, 200);
      dev.msgLevel = level === "warn" ? "warn" : "info";
      summary = dev.msg ? `已對 ${who} 傳話` : `已清除 ${who} 的訊息`;
      break;
    case "clearmsg":
      dev.msg = "";
      dev.msgLevel = "info";
      summary = `已清除 ${who} 的訊息`;
      break;
    case "rename":
      dev.nick = value.trim().slice(0, 40);
      summary = dev.nick ? `已把 ${id} 命名為「${dev.nick}」` : `已清除 ${id} 的暱稱`;
      break;
    case "autostart":
      dev.autostart = value === "on";
      summary = `已將 ${who} 的開機自啟設為「${dev.autostart ? "開" : "關"}」`;
      break;
    case "authorize": {
      let days = parseIntOr(value, 0);
      if (days < 0) days = 0;
      dev.authorized = true;
      dev.authedAt = nowIso();
      dev.expireAt = days > 0 ? new Date(Date.now() + days * 86400000).toISOString() : "";
      summary = `已授權 ${who}（${days > 0 ? days + " 天" : "永久"}）`;
      break;
    }
    case "deauthorize":
      dev.authorized = false;
      dev.expireAt = "";
      summary = `已撤銷 ${who} 的授權`;
      break;
    case "fontscale": {
      const fs = value.trim();
      if (fs && !isValidFontScale(fs)) return respond(request, false, "字體等級不正確");
      dev.fontScale = fs; // 空字串 = 跟隨全域
      summary = fs ? `已將 ${who} 的字體設為「${fs}」` : `${who} 的字體改為跟隨全域設定`;
      break;
    }
    case "cmd": {
      const type = value.trim();
      if (!CMD_TYPES[type]) return respond(request, false, "未知指令");
      if (type === "tune" && !/^\d{1,4}$/.test(arg)) return respond(request, false, "請輸入頻道號碼（數字）");
      dev.cmd = { id: "c" + Date.now().toString(36), type, arg, at: nowIso() };
      summary = `已送出「${CMD_TYPES[type]}${type === "tune" ? " " + arg : ""}」給 ${who}，下次心跳（約 90 秒內）執行`;
      break;
    }
    case "clearcmd":
      dev.cmd = null;
      summary = `已取消 ${who} 的待送指令`;
      break;
    default:
      return respond(request, false, `未知動作：${action}`);
  }

  try {
    await env.CONFIG_KV.put(key, JSON.stringify(dev));
  } catch (err) {
    return respond(request, false, "寫入失敗，請稍後再試");
  }
  return respond(request, true, summary, { refresh });
}

/* ================================================================
 *  POST /admin/codes — 啟動碼管理
 * ================================================================ */

export async function handleAdminCodes(request, env) {
  const blocked = guard(request, env);
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
      return respond(request, false, "撤銷失敗");
    }
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
  const blocked = guard(request, env);
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
    return respond(request, true, "已移除聯絡 QR 圖", { refresh, version: config.version }, config);
  }

  const file = form.get("file");
  if (!file || typeof file === "string" || typeof file.arrayBuffer !== "function") {
    return respond(request, false, "請選擇要上傳的圖檔", null, config);
  }
  const ct = file.type || "image/png";
  if (!/^image\//.test(ct)) return respond(request, false, "只接受圖片檔（PNG / JPG 等）", null, config);
  let buf;
  try {
    buf = await file.arrayBuffer();
  } catch (_) {
    return respond(request, false, "讀取圖檔失敗", null, config);
  }
  if (buf.byteLength > 2 * 1024 * 1024) return respond(request, false, "圖檔太大，請小於 2MB", null, config);
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
  return respond(request, true, "已上傳聯絡 QR 圖，盒子下次輪詢就會看到", { refresh, version: config.version }, config);
}

/* ================================================================
 *  POST /admin/system — 系統動作
 * ================================================================ */

export async function handleAdminSystem(request, env) {
  const blocked = guard(request, env);
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
    return respond(request, true, "已關閉強制刷新旗標", { refresh: ["system", "overview"], version: config.version }, config);
  }

  return respond(request, false, `未知動作：${action}`);
}

/* ================================================================
 *  GET /admin/export?what=codes|devices — CSV 匯出
 * ================================================================ */

export async function handleAdminExport(request, env) {
  const blocked = guard(request, env);
  if (blocked) return blocked;
  const what = new URL(request.url).searchParams.get("what") || "codes";
  const q = (v) => '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"';
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
  const stamp = new Date().toISOString().slice(0, 10);
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

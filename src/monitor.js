/**
 * 偉電視（WeiTV）控制平面 — 監控與警示
 * ----------------------------------------------------------------
 * Cron Trigger 每 5 分鐘執行 runMonitorTick()：
 *   1. 讀直播源伺服器的看門狗 status.json（VPS 每 5 分鐘輸出）→ 正常 / 異常 / 沒回報 / 無資料
 *   2. 記 24 小時健康歷史（15 分鐘一格），總覽畫成色條與可用率
 *   3. 狀態轉變達門檻 → Telegram 通知管理員：直播源異常與恢復、重點盒子離線與回來、盒子載入頻道失敗
 * 所有狀態存 KV 一把 key（mon:state）；沒變化時最多每 15 分鐘寫一次，免費方案也夠用。
 */

import {
  MON_KEY,
  ONLINE_MS,
  actionText,
  formatTaipeiFull,
  loadConfig,
  parseIntOr,
  relativeTime,
} from "./lib.js";
import { loadDevices } from "./api.js";

export const HIST_STEP_MS = 15 * 60 * 1000;
export const HIST_KEEP_MS = 24 * 60 * 60 * 1000;
/** 看門狗超過這麼久沒更新 status.json 就視為「沒回報」 */
export const STALE_MS = 20 * 60 * 1000;
const PERSIST_MS = 15 * 60 * 1000;
const LOG_MAX = 40;

export const REASON_TEXT = {
  vpn: "VPN 出口斷線",
  api_blocked: "4gtv 封鎖了目前出口 IP（API 回 400 或官網 403）",
  web_key: "4gtv 更換了官網播放器金鑰，需更新 keystream.bin（換節點無效）",
  stale: "快取的播放網址失效",
  upstream: "上游 4gtv 不通",
  auth: "NordVPN 帳密錯誤或到期（AUTH_FAILED）",
  nginx: "直播源主機的對外入口（nginx）沒回應",
};
export function reasonText(r) {
  return REASON_TEXT[r] || (r ? String(r) : "上游 4gtv 不通");
}

/**
 * 直播源伺服器的看門狗狀態（VPS 上 watchdog.sh 每 5 分鐘輸出 /status.json，需 token）。
 * 用訂閱網址同源 + 訂閱網址裡的 token 去讀；沒有（第三方源）就回 null 不顯示。3 秒逾時。
 */
export async function fetchSourceStatus(subscriptionUrl) {
  const sub = String(subscriptionUrl || "").trim();
  const m = /^(https?:\/\/[^/]+)/i.exec(sub);
  if (!m) return null;
  let token = "";
  try {
    token = new URL(sub).searchParams.get("token") || "";
  } catch (_) {}
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const resp = await fetch(m[1] + "/status.json" + (token ? "?token=" + encodeURIComponent(token) : ""), {
      signal: controller.signal,
      headers: { "User-Agent": "WeiTV-Admin/2.1", Accept: "application/json" },
      cf: { cacheTtl: 0 },
    });
    clearTimeout(timer);
    if (!resp.ok) return null;
    const j = await resp.json();
    if (!j || typeof j !== "object" || typeof j.healthy !== "boolean") return null;
    // 用來源伺服器回應的 Date 標頭算「多久沒更新」，VPS 與 Worker 時鐘差幾分鐘也不會誤判成沒回報
    const d = Date.parse(resp.headers.get("Date") || "");
    if (Number.isFinite(d) && d > 0) j._serverNowMs = d;
    return j;
  } catch (_) {
    return null;
  }
}

/** 看門狗狀態 → ok（正常）/ bad（異常）/ stale（沒回報）/ none（沒有 status.json，例如第三方源） */
export function sourceState(ss, nowMs) {
  if (!ss) return "none";
  const ref = ss._serverNowMs && Math.abs(ss._serverNowMs - nowMs) < 6 * 3600000 ? ss._serverNowMs : nowMs;
  const age = ss.checked_at_ms ? ref - ss.checked_at_ms : NaN;
  if (!Number.isFinite(age) || age > STALE_MS) return "stale";
  return ss.healthy ? "ok" : "bad";
}
export const STATE_CODE = { ok: 1, bad: 0, stale: 2, none: 3 };
export const CODE_STATE = { 1: "ok", 0: "bad", 2: "stale", 3: "none" };

export function defaultMonState() {
  return {
    v: 1,
    lastTick: 0,
    lastWrite: 0,
    src: { state: "none", since: 0, downSince: 0, alerted: false, ip: "", reason: "", fails: 0, lastAction: "" },
    dev: {},
    hist: [],
    log: [],
  };
}

export async function loadMonState(env) {
  try {
    const s = await env.CONFIG_KV.get(MON_KEY, { type: "json" });
    if (s && typeof s === "object") {
      const d = defaultMonState();
      return {
        ...d,
        ...s,
        src: { ...d.src, ...(s.src || {}) },
        dev: s.dev && typeof s.dev === "object" ? s.dev : {},
        hist: Array.isArray(s.hist) ? s.hist : [],
        log: Array.isArray(s.log) ? s.log : [],
      };
    }
  } catch (_) {}
  return defaultMonState();
}

export async function saveMonState(env, st) {
  await env.CONFIG_KV.put(MON_KEY, JSON.stringify(st));
}

/** 靜音時段 "23-7"（台灣時間、整點；可跨午夜）。格式不對 → 不靜音 */
export function inQuietHours(quiet, nowMs) {
  const m = /^\s*(\d{1,2})\s*-\s*(\d{1,2})\s*$/.exec(String(quiet || ""));
  if (!m) return false;
  const a = parseInt(m[1], 10);
  const b = parseInt(m[2], 10);
  if (!(a >= 0 && a <= 24 && b >= 0 && b <= 24) || a === b) return false;
  const h = new Date((nowMs || Date.now()) + 8 * 3600000).getUTCHours();
  return a < b ? h >= a && h < b : h >= a || h < b;
}

export function isValidTgToken(t) {
  return /^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(String(t || ""));
}

export function telegramReady(config) {
  return !!(config && config.alertsEnabled && isValidTgToken(config.tgBotToken) && String(config.tgChatId || "").trim());
}

/** 送一則 Telegram 訊息（HTML）。回 { ok, error } */
export async function sendTelegram(config, text) {
  if (!isValidTgToken(config && config.tgBotToken)) return { ok: false, error: "Bot Token 格式不正確（應為 123456789:AAxxxx…）" };
  const chatId = String((config && config.tgChatId) || "").trim();
  if (!chatId) return { ok: false, error: "尚未填 Chat ID" };
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const resp = await fetch("https://api.telegram.org/bot" + config.tgBotToken + "/sendMessage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true }),
    });
    clearTimeout(timer);
    let j = null;
    try {
      j = await resp.json();
    } catch (_) {}
    if (resp.ok && j && j.ok) return { ok: true };
    return { ok: false, error: (j && j.description) || "HTTP " + resp.status };
  } catch (err) {
    return { ok: false, error: err && err.name === "AbortError" ? "連線 Telegram 逾時" : String((err && err.message) || err) };
  }
}

/** 直播源目前狀態的一句話（總覽 / 警示用） */
export function describeSource(ss, state, nowMs) {
  if (state === "none") return "沒有看門狗資料（第三方源或尚未設定）";
  const when = ss && ss.checked_at_ms ? relativeTime(new Date(ss.checked_at_ms).toISOString(), nowMs) : "-";
  if (state === "stale") return `看門狗 ${when === "-" ? "沒有回報" : when + "後就沒再回報"}`;
  if (state === "bad") return `異常：${reasonText(ss.reason)}（連續 ${ss.consecutive_failures || 0} 次，${when}）`;
  return `正常（${when}實測）`;
}

/**
 * 監控主流程。nowMs 可注入（測試用）。opts.force 一律寫回 KV。
 * 回傳 { state, events, st }。
 */
export async function runMonitorTick(env, nowMs, opts) {
  nowMs = nowMs || Date.now();
  opts = opts || {};
  const config = await loadConfig(env);
  const st = await loadMonState(env);
  const ss = await fetchSourceStatus(config.subscriptionUrl);
  const state = sourceState(ss, nowMs);
  const events = [];
  let changed = false;

  // ── 直播源 ──
  const src = st.src;
  if (state !== src.state) {
    src.state = state;
    src.since = nowMs;
    changed = true;
  }
  if (ss) {
    if (ss.public_ip && ss.public_ip !== src.ip) { src.ip = ss.public_ip; changed = true; }
    src.reason = ss.reason || "";
    src.fails = ss.consecutive_failures || 0;
    src.lastAction = ss.last_action || "";
  }
  const down = state === "bad" || state === "stale";
  const thresholdMs = Math.max(5, parseIntOr(config.alertSourceMin, 10)) * 60000;
  if (down) {
    if (!src.downSince) { src.downSince = nowMs; changed = true; }
    // 排程有秒級抖動，門檻放 1 分鐘容忍
    if (!src.alerted && nowMs - src.downSince >= thresholdMs - 60000) {
      src.alerted = true;
      changed = true;
      const mins = Math.max(1, Math.round((nowMs - src.downSince) / 60000));
      if (state === "stale") {
        events.push({
          kind: "src_stale",
          text: `⚠️ <b>直播源伺服器沒回報</b>\n看門狗已 ${mins} 分鐘沒更新狀態，VPS 可能離線、關機或排程停了。\n請確認 VPS 是否開著（盒子若還能播，是舊快取撐著）。`,
        });
      } else {
        events.push({
          kind: "src_down",
          text: `🔴 <b>直播源異常</b>（已 ${mins} 分鐘）\n原因：${reasonText(src.reason)}\n連續失敗 ${src.fails} 次${src.ip ? " · 出口 IP " + src.ip : ""}\n看門狗會自動清快取 / 更換出口節點${actionText(src.lastAction) ? "（最近處置：" + actionText(src.lastAction) + "）" : ""}。30 分鐘內沒恢復請登入 VPS 執行 4gtv doctor。`,
        });
      }
    }
  } else if (src.downSince) {
    const mins = Math.max(1, Math.round((nowMs - src.downSince) / 60000));
    if (src.alerted) {
      events.push({ kind: "src_up", text: `🟢 <b>直播源已恢復</b>\n中斷約 ${mins} 分鐘${src.ip ? " · 出口 IP " + src.ip : ""}${actionText(src.lastAction) ? " · 處置：" + actionText(src.lastAction) : ""}` });
    }
    src.downSince = 0;
    src.alerted = false;
    changed = true;
  }

  // ── 盒子 ──
  let devices = [];
  try {
    devices = await loadDevices(env);
  } catch (err) {
    console.error("監控讀取裝置失敗:", err);
    devices = [];
  }
  st.devError = devices.length === 0 && false;
  const offMs = Math.max(30, parseIntOr(config.alertDeviceOfflineMin, 180)) * 60000;
  const ids = new Set();
  for (const d of devices) {
    if (!d || !d.id) continue;
    ids.add(d.id);
    const ds = st.dev[d.id] || (st.dev[d.id] = {});
    const name = d.nick ? `${d.nick}（${d.id}）` : d.id;
    const seen = Date.parse(d.lastSeen) || 0;
    const offFor = nowMs - seen;
    if (d.watch === true) {
      if (offFor >= offMs && !ds.offAlerted) {
        ds.offAlerted = true;
        changed = true;
        events.push({ kind: "dev_off", text: `⚫ <b>重點盒子離線</b> ${name}\n已 ${Math.round(offFor / 60000)} 分鐘沒有心跳（可能斷電、斷網或被關機）。\n上次上線 ${formatTaipeiFull(d.lastSeen)}${d.now ? "，當時在看 " + d.now : ""}` });
      } else if (offFor < ONLINE_MS && ds.offAlerted) {
        ds.offAlerted = false;
        changed = true;
        events.push({ kind: "dev_on", text: `🟢 <b>盒子回來了</b> ${name}${d.now ? "\n正在看 " + d.now : ""}` });
      }
    } else if (ds.offAlerted) {
      ds.offAlerted = false;
      changed = true;
    }
    if (config.alertBoxFail !== false && d.lastResultAt && d.lastOk === false) {
      const at = Date.parse(d.lastResultAt) || 0;
      if (nowMs - at <= 15 * 60000 && (!ds.failAlertAt || nowMs - ds.failAlertAt >= 3600000)) {
        ds.failAlertAt = nowMs;
        changed = true;
        events.push({ kind: "dev_fail", text: `⚠️ <b>盒子載入頻道失敗</b> ${name}\n${relativeTime(d.lastResultAt, nowMs)}回報抓不到清單（改用快取播放）。${state === "bad" || state === "stale" ? "直播源目前也異常，多半是同一件事。" : "直播源看起來正常，可能是該盒子的網路。"}` });
      }
    }
  }
  for (const k of Object.keys(st.dev)) {
    if (!ids.has(k)) { delete st.dev[k]; changed = true; }
  }

  // ── 歷史 ──
  const code = STATE_CODE[state];
  const last = st.hist.length ? st.hist[st.hist.length - 1] : null;
  if (!last || nowMs - last[0] >= HIST_STEP_MS - 60000 || last[1] !== code) {
    st.hist.push([nowMs, code]);
    changed = true;
  }
  st.hist = st.hist.filter((h) => Array.isArray(h) && nowMs - h[0] <= HIST_KEEP_MS + HIST_STEP_MS).slice(-400);

  // ── 通知 ──
  const quiet = inQuietHours(config.alertQuiet, nowMs);
  const ready = telegramReady(config);
  for (const ev of events) {
    let status = "no-telegram";
    if (ready) {
      if (quiet) status = "muted";
      else {
        const r = await sendTelegram(config, ev.text);
        status = r.ok ? "sent" : "failed: " + r.error;
      }
    }
    st.log.unshift({ at: new Date(nowMs).toISOString(), kind: ev.kind, text: ev.text.replace(/<[^>]+>/g, ""), status });
  }
  st.log = st.log.slice(0, LOG_MAX);
  st.lastTick = nowMs;
  st.lastState = state;

  if (changed || events.length || opts.force || nowMs - (st.lastWrite || 0) >= PERSIST_MS - 60000) {
    st.lastWrite = nowMs;
    try {
      await saveMonState(env, st);
    } catch (err) {
      console.error("監控狀態寫入失敗:", err);
    }
  }
  return { state, events, st, ss };
}

/**
 * 24 小時可用率（依歷史片段時間加權；只算有資料的時段）。回 null 表示沒資料。
 */
export function uptime24h(st, nowMs) {
  const hist = (st && Array.isArray(st.hist) ? st.hist : []).filter((h) => Array.isArray(h)).sort((a, b) => a[0] - b[0]);
  if (!hist.length) return null;
  const start = nowMs - HIST_KEEP_MS;
  let ok = 0;
  let total = 0;
  for (let i = 0; i < hist.length; i++) {
    const t0 = Math.max(hist[i][0], start);
    const t1 = Math.min(i + 1 < hist.length ? hist[i + 1][0] : nowMs, nowMs);
    if (t1 <= t0) continue;
    const code = hist[i][1];
    if (code === 3) continue; // 無資料不計
    total += t1 - t0;
    if (code === 1) ok += t1 - t0;
  }
  if (total <= 0) return null;
  return Math.round((ok / total) * 1000) / 10;
}

/** 把歷史攤成 96 格（每 15 分鐘一格，舊→新），每格 = 該時段開始時的狀態 */
export function historySlots(st, nowMs, slots) {
  slots = slots || 96;
  const hist = (st && Array.isArray(st.hist) ? st.hist : []).filter((h) => Array.isArray(h)).sort((a, b) => a[0] - b[0]);
  const out = [];
  const step = HIST_KEEP_MS / slots;
  const start = nowMs - HIST_KEEP_MS;
  let j = 0;
  let cur = null;
  for (let i = 0; i < slots; i++) {
    const t = start + i * step;
    while (j < hist.length && hist[j][0] <= t + step / 2) {
      cur = hist[j][1];
      j++;
    }
    out.push({ t, state: cur == null ? "none" : CODE_STATE[cur] || "none" });
  }
  return out;
}

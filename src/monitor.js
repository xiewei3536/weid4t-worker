/**
 * 偉電視（WeiTV）控制平面 — 監控與警示
 * ----------------------------------------------------------------
 * Cron Trigger 每 5 分鐘執行 runMonitorTick()：
 *   1. 讀直播源伺服器的看門狗 status.json（VPS 每 5 分鐘輸出）→ 正常 / 異常 / 沒回報 / 無資料；
 *      有設備援線路時兩條都讀，各自一套狀態機
 *   2. 記 24 小時健康歷史（15 分鐘一格，主線路），總覽畫成色條與可用率
 *   3. 狀態轉變達門檻 → Telegram 通知管理員：直播源異常與恢復（主線路壞但備援正常 → 較不緊急；兩條都壞 → 緊急）、
 *      重點盒子離線與回來、盒子載入頻道失敗、盒子播放常卡（App 1.0.0.29+ 回報）
 * 所有狀態存 KV 一把 key（mon:state）；沒變化時最多每 15 分鐘寫一次，免費方案也夠用。
 * 順便整理「已授權盒子的公網 IP」（mon:state.homeIps），給家用代理免金鑰登記判斷同一個家用。
 */

import {
  MON_KEY,
  ONLINE_MS,
  actionText,
  formatTaipeiFull,
  homeBoxEligible,
  homeProxyState,
  loadConfig,
  loadHomeProxy,
  needsHomeProxy,
  parseIntOr,
  relativeTime,
  smoothness,
  speedText,
} from "./lib.js";
import { loadDevices } from "./api.js";
import { probeLine, probeSummary, probeText, workerFetch } from "./probe.js";

export const HIST_STEP_MS = 15 * 60 * 1000;
export const HIST_KEEP_MS = 24 * 60 * 60 * 1000;
/** 看門狗超過這麼久沒更新 status.json 就視為「沒回報」 */
export const STALE_MS = 20 * 60 * 1000;
const PERSIST_MS = 15 * 60 * 1000;
/** 雲端實測連續失敗這麼多次（每 5 分鐘一次）才算這條線異常，偶發一次不算 */
export const PROBE_FAILS_BAD = 2;
const LOG_MAX = 40;

export const REASON_TEXT = {
  vpn: "VPN 出口斷線",
  api_blocked: "4gtv 封鎖了目前出口 IP（API 回 400 或官網 403）",
  web_key: "4gtv 更換了官網播放器金鑰，需更新 keystream.bin（換節點無效）",
  stale: "快取的播放網址失效",
  upstream: "上游 4gtv 不通",
  auth: "NordVPN 帳密錯誤或到期（AUTH_FAILED）",
  nginx: "直播源主機的對外入口（nginx）沒回應",
  probe: "雲端實測播不出來",
};
export function reasonText(r) {
  return REASON_TEXT[r] || (r ? String(r) : "上游 4gtv 不通");
}

/**
 * 直播源伺服器的看門狗狀態（VPS 上 watchdog.sh 每 5 分鐘輸出 /status.json，需 token）。
 * 用訂閱網址同源 + 訂閱網址裡的 token 去讀，5 秒逾時。網址是 IP 時改連 sslip.io 對應網域（Worker 不能直連 IP，見 probe.js）。
 *   - 404 / 其他 4xx / 不是看門狗格式 → null（第三方源沒有看門狗，不顯示）
 *   - 連不上 / 逾時 / 5xx → { _unreachable: 原因 }（主機掛了也要算「沒回報」，不能被當成第三方源而默不作聲）
 */
export async function fetchSourceStatus(subscriptionUrl) {
  const sub = String(subscriptionUrl || "").trim();
  const m = /^(https?:\/\/[^/]+)/i.exec(sub);
  if (!m) return null;
  let token = "";
  try {
    token = new URL(sub).searchParams.get("token") || "";
  } catch (_) {}
  let resp;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    resp = await workerFetch(m[1] + "/status.json" + (token ? "?token=" + encodeURIComponent(token) : ""), {
      signal: controller.signal,
      headers: { "User-Agent": "WeiTV-Admin/2.5", Accept: "application/json" },
    });
  } catch (err) {
    return { _unreachable: err && err.name === "AbortError" ? "逾時" : "連線失敗" };
  } finally {
    clearTimeout(timer);
  }
  if (!resp.ok) return resp.status >= 500 ? { _unreachable: "HTTP " + resp.status } : null;
  let j = null;
  try {
    j = await resp.json();
  } catch (_) {
    return null;
  }
  if (!j || typeof j !== "object" || typeof j.healthy !== "boolean") return null;
  // 用來源伺服器回應的 Date 標頭算「多久沒更新」，VPS 與 Worker 時鐘差幾分鐘也不會誤判成沒回報
  const d = Date.parse(resp.headers.get("Date") || "");
  if (Number.isFinite(d) && d > 0) j._serverNowMs = d;
  return j;
}

/** 看門狗狀態 → ok（正常）/ bad（異常）/ stale（沒回報或連不上）/ none（沒有 status.json，例如第三方源） */
export function sourceState(ss, nowMs) {
  if (!ss) return "none";
  if (ss._unreachable) return "stale";
  const ref = ss._serverNowMs && Math.abs(ss._serverNowMs - nowMs) < 6 * 3600000 ? ss._serverNowMs : nowMs;
  const age = ss.checked_at_ms ? ref - ss.checked_at_ms : NaN;
  if (!Number.isFinite(age) || age > STALE_MS) return "stale";
  return ss.healthy ? "ok" : "bad";
}
export const STATE_CODE = { ok: 1, bad: 0, stale: 2, none: 3 };
export const CODE_STATE = { 1: "ok", 0: "bad", 2: "stale", 3: "none" };

/** 備援線路狀態：沒設定 → off；有設定 → 同 sourceState，再併入雲端實測（line = 監控狀態 mon.bsrc） */
export function backupState(config, bss, nowMs, line) {
  return String((config && config.backupSubscriptionUrl) || "").trim() ? combineState(sourceState(bss, nowMs), line, nowMs) : "off";
}

/** 監控狀態裡 20 分鐘內的雲端實測結果（監控停了就不拿舊結果出來講） */
export function freshProbe(line, nowMs) {
  const p = line && line.probe;
  return p && typeof p === "object" && nowMs - (p.at || 0) <= STALE_MS ? p : null;
}

/**
 * 看門狗自報 + 雲端實測 → 這條線的狀態（監控、總覽共用；line = 監控狀態 mon.src / mon.bsrc）。
 *  - 看門狗說異常 → bad（看門狗的原因比較準）
 *  - 雲端實測連續 PROBE_FAILS_BAD 次播不出來 → bad：看門狗說正常、沒回報、或根本沒有看門狗（第三方源）都算
 *  - 看門狗沒回報 / 沒有看門狗，但雲端實測播得出來 → ok（第三方源也有監控了；看門狗停了另外提醒）
 */
export function combineState(wdState, line, nowMs) {
  if (wdState === "bad") return "bad";
  const p = freshProbe(line, nowMs || Date.now());
  if (!p || p.lan) return wdState;
  if (!p.ok && (line.probeFails || 0) >= PROBE_FAILS_BAD) return "bad";
  if (p.ok && (wdState === "stale" || wdState === "none")) return "ok";
  return wdState;
}

/** 異常原因的一句話：看門狗的原因，或雲端實測失敗的細節 */
export function lineReason(line, ss) {
  if (line && line.reason === "probe") return `${REASON_TEXT.probe}（${(line.probe && line.probe.error) || "原因不明"}）`;
  return reasonText((line && line.reason) || (ss && ss.reason));
}

/** 記下這次雲端實測；回傳是否有需要寫回的變化（成敗翻轉、連續失敗次數變了） */
function recordProbe(line, pr) {
  if (!pr) return false;
  const s = probeSummary(pr);
  const before = line.probe && typeof line.probe === "object" ? line.probe.ok : null;
  const fails = s.ok || s.lan ? 0 : (line.probeFails || 0) + 1;
  const changed = before !== s.ok || fails !== (line.probeFails || 0);
  line.probe = s;
  line.probeFails = fails;
  return changed;
}

const isDown = (s) => s === "bad" || s === "stale";

/** 一條線路目前狀況的短句（警示用） */
function lineBrief(state, ss, line) {
  if (state === "bad") return lineReason(line, ss);
  if (state === "stale") return ss && ss._unreachable ? `連不上主機（${ss._unreachable}）` : "看門狗沒回報";
  if (state === "ok") return "正常";
  return "沒有看門狗資料";
}

/** 代理自上次重啟以來的自動修復次數（status.json 的 self_heal；沒有就回空字串） */
export function selfHealText(ss) {
  const sh = ss && ss.self_heal;
  if (!sh || typeof sh !== "object") return "";
  const a = typeof sh.forced_reresolves === "number" && sh.forced_reresolves >= 0 ? sh.forced_reresolves : null;
  const b = typeof sh.session_resets === "number" && sh.session_resets >= 0 ? sh.session_resets : null;
  if (a == null && b == null) return "";
  // 代理 2.4.1：官網（Cloudflare）對全新連線出驗證頁、代理靠原本的連線照常解析 → 提醒這段時間別重啟直播源
  const fresh = typeof sh.fresh_session_blocked === "number" && sh.fresh_session_blocked > 0 && !sh.web_blocked;
  return `代理自動修復 ${(a || 0) + (b || 0)} 次（重抓失效網址 ${a || 0}、重設連線 ${b || 0}）`
    + (fresh ? "；官網曾擋下新連線，這段時間別重啟直播源" : "");
}

function defaultLineState(state) {
  return { state, since: 0, downSince: 0, alerted: false, ip: "", reason: "", fails: 0, lastAction: "", probe: null, probeFails: 0 };
}

export function defaultMonState() {
  return {
    v: 1,
    lastTick: 0,
    lastWrite: 0,
    src: defaultLineState("none"),
    // 備援線路（2.3 新增；舊資料沒有這欄會補預設值）
    bsrc: defaultLineState("off"),
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
        bsrc: { ...d.bsrc, ...(s.bsrc || {}) },
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

/** 直播源目前狀態的一句話（總覽 / 警示用；line = 監控狀態，帶雲端實測） */
export function describeSource(ss, state, nowMs, line) {
  const p = freshProbe(line, nowMs);
  const cloud = p && !p.lan ? "；雲端實測" + (p.ok ? "：" : "") + probeText(p) : "";
  if (state === "none") return "沒有看門狗資料（第三方源或尚未設定）" + cloud;
  if (state === "stale" && ss && ss._unreachable) return `連不上主機（${ss._unreachable}）` + cloud;
  const when = ss && ss.checked_at_ms ? relativeTime(new Date(ss.checked_at_ms).toISOString(), nowMs) : "-";
  if (state === "stale") return `看門狗 ${when === "-" ? "沒有回報" : when + "後就沒再回報"}` + cloud;
  if (state === "bad" && line && line.reason === "probe") return `異常：${lineReason(line, ss)}（看門狗自報${ss && ss.healthy ? "正常" : "沒資料"}）`;
  if (state === "bad") return `異常：${reasonText(ss && ss.reason)}（連續 ${(ss && ss.consecutive_failures) || 0} 次，${when}）` + cloud;
  if (!ss || ss._unreachable || !ss.checked_at_ms) return "正常" + cloud;
  return `正常（看門狗 ${when}實測）` + cloud;
}

/** 更新一條線路狀態機的欄位（狀態轉換、出口 IP、原因…）；回傳是否有需要寫回的變化。wdState = 看門狗自己的狀態 */
function trackLine(line, state, ss, nowMs, wdState) {
  let changed = false;
  if (state !== line.state) {
    line.state = state;
    line.since = nowMs;
    changed = true;
  }
  if (ss && !ss._unreachable) {
    if (ss.public_ip && ss.public_ip !== line.ip) { line.ip = ss.public_ip; changed = true; }
    line.reason = ss.reason || "";
    line.fails = ss.consecutive_failures || 0;
    line.lastAction = ss.last_action || "";
  }
  // 看門狗沒說壞、是雲端實測判定的 → 原因記成 probe（細節在 line.probe.error）
  if (state === "bad" && wdState !== "bad") line.reason = "probe";
  return changed;
}

/**
 * 監控主流程。nowMs 可注入（測試用）。opts.force 一律寫回 KV。
 * 回傳 { state, bstate, events, st, ss, bss, hp }（bstate：備援線路狀態，沒設定為 off；hp：家用代理登記紀錄）。
 */
export async function runMonitorTick(env, nowMs, opts) {
  nowMs = nowMs || Date.now();
  opts = opts || {};
  const config = await loadConfig(env);
  const st = await loadMonState(env);
  const hasBackup = !!String(config.backupSubscriptionUrl || "").trim();
  // 雲端實測（照盒子的走法真的播一台）；env.STREAM_PROBE = "off" 可關（測試用）
  const probeOn = env.STREAM_PROBE !== "off";
  const noProbe = Promise.resolve(null);
  const [ss, bss, hp, pr, bpr] = await Promise.all([
    fetchSourceStatus(config.subscriptionUrl),
    hasBackup ? fetchSourceStatus(config.backupSubscriptionUrl) : Promise.resolve(null),
    loadHomeProxy(env),
    probeOn && config.subscriptionUrl ? probeLine(config.subscriptionUrl, nowMs).catch(() => null) : noProbe,
    probeOn && hasBackup ? probeLine(config.backupSubscriptionUrl, nowMs).catch(() => null) : noProbe,
  ]);
  let changed = false;
  if (recordProbe(st.src, pr)) changed = true;
  if (hasBackup && recordProbe(st.bsrc, bpr)) changed = true;
  const wdState = sourceState(ss, nowMs);
  const bwdState = hasBackup ? sourceState(bss, nowMs) : "off";
  const state = combineState(wdState, st.src, nowMs);
  const bstate = hasBackup ? combineState(bwdState, st.bsrc, nowMs) : "off";
  // 家用備援在線、自報健康、且真的會下發給盒子（見 lib.effectiveLines）→ 主線路壞了同一個家的盒子還有得看
  const homeUsable = !!hp && hp.healthy !== false && homeProxyState(hp, nowMs) === "online" && needsHomeProxy(config);
  const homePrimary = config.homeProxyRole === "primary";
  const events = [];
  const thresholdMs = Math.max(5, parseIntOr(config.alertSourceMin, 10)) * 60000;
  // 排程有秒級抖動，門檻放 1 分鐘容忍
  const overThreshold = (line) => nowMs - line.downSince >= thresholdMs - 60000;
  const minsSince = (t) => Math.max(1, Math.round((nowMs - t) / 60000));

  const src = st.src;
  if (trackLine(src, state, ss, nowMs, wdState)) changed = true;
  if (hasBackup) {
    if (trackLine(st.bsrc, bstate, bss, nowMs, bwdState)) changed = true;
  } else if (st.bsrc.state !== "off" || st.bsrc.downSince || st.bsrc.alerted) {
    st.bsrc = defaultLineState("off");   // 備援線路拿掉了 → 狀態歸零
    changed = true;
  }
  const bsrc = st.bsrc;
  const bothDownEvent = () => ({
    kind: "both_down",
    text: `🔴 <b>主線路與備援線路都異常</b>（緊急）\n主線路：${lineBrief(state, ss, src)}${src.ip ? " · 出口 IP " + src.ip : ""}\n備援線路：${lineBrief(bstate, bss, bsrc)}${bsrc.ip ? " · 出口 IP " + bsrc.ip : ""}\n盒子可能沒有畫面，請盡快登入 VPS 執行 4gtv doctor。`,
  });
  const backupHint = hasBackup ? "\n已設備援線路（沒有看門狗資料），盒子會自動嘗試改用它。" : "";

  // ── 直播源（主線路）──
  if (isDown(state)) {
    if (!src.downSince) { src.downSince = nowMs; changed = true; }
    if (!src.alerted && overThreshold(src)) {
      src.alerted = true;
      changed = true;
      const mins = minsSince(src.downSince);
      if (isDown(bstate)) {
        // 兩條都壞：一則緊急通知，備援線路也算通知過（不再另發）
        events.push(bothDownEvent());
        if (!bsrc.downSince) bsrc.downSince = nowMs;
        bsrc.alerted = true;
      } else if (bstate === "ok") {
        events.push({
          kind: "src_down_bk",
          text: `🟡 <b>主線路異常</b>（已 ${mins} 分鐘，較不緊急）\n原因：${lineBrief(state, ss, src)}\n備援線路正常 → 盒子會自動改用備援線路，暫時不影響觀看。\n看門狗會自動處理主線路${actionText(src.lastAction) ? "（最近處置：" + actionText(src.lastAction) + "）" : ""}；30 分鐘內沒恢復再登入 VPS 查看。`,
        });
      } else if (homeUsable) {
        events.push({
          kind: "src_down_bk",
          text: `🟡 <b>主線路異常</b>（已 ${mins} 分鐘，較不緊急）\n原因：${lineBrief(state, ss, src)}\n家用備援在線 → ${homePrimary ? "同一個家的盒子本來就以家用代理為主線路，不受影響" : "同一個家的盒子會自動改用家用代理（區網直連），不影響觀看"}；其他地點的盒子仍會受影響。\n看門狗會自動處理主線路${actionText(src.lastAction) ? "（最近處置：" + actionText(src.lastAction) + "）" : ""}；30 分鐘內沒恢復再登入 VPS 查看。`,
        });
      } else if (state === "stale") {
        events.push({
          kind: "src_stale",
          text: `⚠️ <b>直播源伺服器沒回報</b>\n看門狗已 ${mins} 分鐘沒更新狀態${ss && ss._unreachable ? "（連不上主機：" + ss._unreachable + "）" : ""}，VPS 可能離線、關機或排程停了。\n請確認 VPS 是否開著（盒子若還能播，是舊快取撐著）。${backupHint}`,
        });
      } else if (src.reason === "probe") {
        events.push({
          kind: "src_down",
          text: `🔴 <b>直播源播不出來</b>（已 ${mins} 分鐘）\n${lineReason(src, ss)}\nVPS 看門狗自報${wdState === "ok" ? "正常（它看不出來，不會自動處理）" : "沒資料"}：多半是對外入口（nginx、5050 埠、防火牆）或主機網路出問題。請登入 VPS 執行 4gtv doctor。${backupHint}`,
        });
      } else {
        events.push({
          kind: "src_down",
          text: `🔴 <b>直播源異常</b>（已 ${mins} 分鐘）\n原因：${reasonText(src.reason)}\n連續失敗 ${src.fails} 次${src.ip ? " · 出口 IP " + src.ip : ""}\n看門狗會自動清快取 / 更換出口節點${actionText(src.lastAction) ? "（最近處置：" + actionText(src.lastAction) + "）" : ""}。30 分鐘內沒恢復請登入 VPS 執行 4gtv doctor。${backupHint}`,
        });
      }
    }
  } else if (src.downSince) {
    if (src.alerted) {
      events.push({ kind: "src_up", text: `🟢 <b>直播源已恢復</b>\n中斷約 ${minsSince(src.downSince)} 分鐘${src.ip ? " · 出口 IP " + src.ip : ""}${actionText(src.lastAction) ? " · 處置：" + actionText(src.lastAction) : ""}` });
    }
    src.downSince = 0;
    src.alerted = false;
    changed = true;
  }

  // ── 備援線路（有設定才看）──
  if (hasBackup) {
    if (isDown(bstate)) {
      if (!bsrc.downSince) { bsrc.downSince = nowMs; changed = true; }
      if (!bsrc.alerted && overThreshold(bsrc)) {
        bsrc.alerted = true;
        changed = true;
        if (isDown(state)) {
          // 主線路早就壞了（當時發的是「較不緊急」或還沒到門檻）→ 現在備援也壞 → 升級成緊急，主線路不再另發
          events.push(bothDownEvent());
          if (!src.downSince) src.downSince = nowMs;
          src.alerted = true;
        } else {
          events.push({
            kind: "bsrc_down",
            text: `🟡 <b>備援線路異常</b>（已 ${minsSince(bsrc.downSince)} 分鐘，不影響觀看）\n原因：${lineBrief(bstate, bss, bsrc)}${bsrc.ip ? " · 出口 IP " + bsrc.ip : ""}\n主線路正常，盒子不受影響；但主線路再出問題時就沒有備援可切，有空再處理。`,
          });
        }
      }
    } else if (bsrc.downSince) {
      if (bsrc.alerted) {
        events.push({ kind: "bsrc_up", text: `🟢 <b>備援線路已恢復</b>\n中斷約 ${minsSince(bsrc.downSince)} 分鐘${bsrc.ip ? " · 出口 IP " + bsrc.ip : ""}` });
      }
      bsrc.downSince = 0;
      bsrc.alerted = false;
      changed = true;
    }
  }

  // ── 盒子 ──
  let devices = [];
  let devOk = true;
  try {
    devices = await loadDevices(env);
  } catch (err) {
    console.error("監控讀取裝置失敗:", err);
    devices = [];
    devOk = false;
  }
  st.devError = devices.length === 0 && false;
  // 已授權盒子的公網 IP（家用代理免金鑰登記靠它判斷「同一個家」，不必每次登記都列舉裝置）；組合變了才算變化
  if (devOk) {
    const homeIps = devices.filter((d) => homeBoxEligible(d, nowMs)).map((d) => [String(d.ip), String(d.id)])
      .sort((a, b) => (a[0] + a[1] < b[0] + b[1] ? -1 : 1)).slice(0, 300);
    if (JSON.stringify(homeIps) !== JSON.stringify(st.homeIps)) { st.homeIps = homeIps; changed = true; }
  }
  const offMs = Math.max(30, parseIntOr(config.alertDeviceOfflineMin, 180)) * 60000;
  const ids = new Set();
  const stalling = [];   // 這一輪線上、而且回報「常卡」的盒子
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
    // 播放卡頓（App 1.0.0.29+ 心跳回報）：記連續幾輪都常卡
    const sm = offFor < ONLINE_MS ? smoothness(d, nowMs) : null;
    if (sm && sm.level === "bad") {
      ds.stallTicks = (ds.stallTicks || 0) + 1;
      changed = true;
      stalling.push({ d, ds, name, sm });
    } else if (ds.stallTicks) {
      ds.stallTicks = 0;
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
  // 連續兩輪（約 10 分鐘）都常卡才通知，每台每小時最多一則；一閃而過的不吵
  if (config.alertStall !== false) {
    for (const it of stalling) {
      if (it.ds.stallTicks < 2 || (it.ds.stallAlertAt && nowMs - it.ds.stallAlertAt < 3600000)) continue;
      it.ds.stallAlertAt = nowMs;
      const others = stalling.length - 1;
      const d = it.d;
      const hint = isDown(state)
        ? "直播源目前也異常，多半是同一件事。"
        : others > 0
        ? `同時還有 ${others} 台盒子也在卡 → 多半是直播源主機或線路，請看管理中心總覽的「播放品質」。`
        : typeof d.bw === "number" && d.bw > 0 && d.bw < 4000
        ? `這台的下載速度只有 ${speedText(d.bw)}（看一台約需 2.5 Mbps）→ 多半是那個家的網路或 Wi-Fi 訊號。`
        : "其他盒子沒有回報卡頓 → 多半是那個家的網路或 Wi-Fi；持續發生再請對方重開分享器、盒子離分享器近一點。";
      events.push({
        kind: "dev_stall",
        text: `📶 <b>盒子播放卡頓</b> ${it.name}\n${it.sm.text}${d.now ? "\n正在看 " + d.now + (d.ln === 1 ? "（備援線路）" : "") : ""}\n${hint}`,
      });
    }
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
  return { state, bstate, events, st, ss, bss, hp };
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

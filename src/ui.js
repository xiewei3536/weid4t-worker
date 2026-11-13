/**
 * 偉電視（WeiTV）控制平面 — 管理頁 HTML 產生器
 * ----------------------------------------------------------------
 * renderAdminHtml(ctx)      整頁
 * renderPartial(name, ctx)  單一區塊（前端局部刷新用）
 * ctx = { config, devices, codes, ota, sourceStatus, backupStatus, mon, audit, hist, homeProxy, origin, hasGithubToken }
 */

import {
  CMD_TYPES,
  FONT_SCALE_OPTIONS,
  HOME_FRESH_MS,
  actionText,
  configLabel,
  diffConfigKeys,
  escapeHtml as esc,
  effectiveFontScale,
  effectiveLines,
  formatTaipeiFull,
  formatTaipeiTime,
  homeProxyState,
  maskToken,
  needsHomeProxy,
  onlineState,
  pendingCmd,
  relativeTime,
  sameHomeIp,
  smoothDetail,
  smoothness,
} from "./lib.js";
import { backupState, combineState, describeSource, freshProbe, historySlots, isValidTgToken, lineReason, reasonText, selfHealText, sourceState, telegramReady, uptime24h } from "./monitor.js";
import { probeText } from "./probe.js";
import { ADMIN_CSS, ADMIN_JS } from "./ui_assets.js";

const DAY = 86400000;

/** 盒子播放健康：近 15 分鐘內回報重連 ≥3 次視為「不穩」 */
function playHealth(d, nowMs) {
  const pe = d && typeof d.pe === "number" ? d.pe : 0;
  const at = d && d.peAt ? Date.parse(d.peAt) || 0 : 0;
  const fresh = at && nowMs - at < 15 * 60000;
  if (!d || !("pe" in d)) return { level: "unknown", text: "未回報" };
  if (pe >= 3 && fresh) return { level: "bad", text: `不穩：近 10 分鐘重連 ${pe} 次${d.le ? "（" + d.le + "）" : ""}` };
  if (pe > 0 && fresh) return { level: "warn", text: `重連 ${pe} 次${d.le ? "（" + d.le + "）" : ""}` };
  return { level: "ok", text: "正常" };
}

function fontLabel(v) {
  const o = FONT_SCALE_OPTIONS.find((x) => x[0] === v);
  return o ? o[1] : v || "自動";
}

/** 短版字體名稱（裝置卡欄位用） */
function fontShort(v) {
  return { auto: "自動", normal: "標準", large: "大", xlarge: "特大" }[v] || v || "自動";
}

/** 版本字串「1.0.0.27」→ 27（比對 OTA 用） */
function verNum(v) {
  const m = String(v || "").match(/(\d+)\s*$/);
  return m ? parseInt(m[1], 10) : 0;
}

function devAuthed(d, nowMs) {
  return !!(d && d.authorized === true && (!d.expireAt || (Date.parse(d.expireAt) || 0) > nowMs));
}

/* ================================================================
 *  尚未設定密碼的說明頁
 * ================================================================ */

export function setupPasswordHtml() {
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>偉電視 · 完成最後一步</title>
<style>
:root{--bg0:#060810;--bg1:#0B1018;--surface:#121826;--stroke:#232C3D;--accent:#2DD4BF;--gold:#FBBF24;--text:#EEF2F7;--dim:#98A3B6}
*{box-sizing:border-box}body{margin:0;font-family:-apple-system,"PingFang TC","Noto Sans TC","Microsoft JhengHei",system-ui,sans-serif;background:radial-gradient(900px 500px at 20% -10%,rgba(45,212,191,.12),transparent 60%),linear-gradient(180deg,var(--bg1),var(--bg0));color:var(--text);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
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
<h1><span class="dot"></span>還差最後一步：設定管理密碼</h1>
<div class="sub">Worker 已經部署成功、資料庫也建好了 ✅<br>只要設一組管理密碼，就能登入這個管理頁。</div>
<ol>
<li>到 Cloudflare 後台 → 左側 <span class="k">Workers &amp; Pages</span> → 點開這個 Worker（<code>weid4t-worker</code>）</li>
<li>上方分頁切到 <span class="k">Settings</span> → 找到 <span class="k">Variables and Secrets</span></li>
<li>按 <span class="k">+ Add</span>；Type 選 <span class="k">Secret</span>（加密，不是 Text）</li>
<li>Variable name 填 <code>ADMIN_PASSWORD</code>，Value 填你想要的密碼</li>
<li>按 <span class="k">Deploy</span> 儲存，等十幾秒，再 <span class="k">重新整理本頁</span></li>
</ol>
<div class="foot">完成後本頁會跳出帳密框：<b>帳號隨便填</b>、<b>密碼 = 你剛設的那組</b>。<br>進階（CLI）：<code>npx wrangler secret put ADMIN_PASSWORD</code></div>
</div></body></html>`;
}

/* ================================================================
 *  整頁
 * ================================================================ */

export function renderAdminHtml(ctx) {
  const { config, devices, codes, mon } = ctx;
  const nowMs = Date.now();
  const devList = Array.isArray(devices) ? devices : [];
  const unauth = devList.filter((d) => !devAuthed(d, nowMs)).length;
  const online = devList.filter((d) => onlineState(d, nowMs) === "online").length;
  const unusedCodes = (codes || []).filter((c) => c && c.status === "unused").length;
  const recentAlerts = mon && Array.isArray(mon.log) ? mon.log.filter((l) => l && nowMs - (Date.parse(l.at) || 0) < DAY).length : 0;

  const tab = (name, label, extra) =>
    `<button type="button" class="tab" data-tab="${name}" onclick="showTab('${name}')">${label}${extra || ""}</button>`;

  return `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<meta name="robots" content="noindex,nofollow">
<meta name="theme-color" content="#0B1018">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" href="/asset/icon.svg" type="image/svg+xml">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="偉電視">
<title>偉電視 · 管理中心</title>
<style>${ADMIN_CSS}</style>
</head>
<body>
<header class="topbar"><div class="wrap">
  <div class="brand"><div class="logo">偉</div><h1>偉電視 <span class="tag">管理中心</span></h1></div>
  <div class="top-right">
    <span class="pill clock" id="clock"></span>
    <span class="pill" id="verPill">設定 <b>v${esc(config.version)}</b></span>
    <button type="button" class="iconbtn" id="btnRefresh" title="重新整理資料" onclick="refreshAll()">⟳</button>
  </div>
</div></header>

<div class="wrap">
  <div class="tabs-wrap"><nav class="tabs">
    ${tab("overview", "📊 總覽")}
    ${tab("devices", "📺 裝置", ` <span class="cnt">${online}/${devList.length}</span>${config.requireActivation && unauth > 0 ? '<span class="tdot"></span>' : ""}`)}
    ${tab("source", "📡 直播源")}
    ${tab("auth", "🎟️ 授權", unusedCodes ? ` <span class="cnt">${unusedCodes}</span>` : "")}
    ${tab("notice", "📣 通知")}
    ${tab("alerts", "🔔 警示", recentAlerts ? ` <span class="cnt">${recentAlerts}</span>` : "")}
    ${tab("system", "⚙️ 系統")}
  </nav></div>

  <section class="panel active" data-panel="overview"><div data-part="overview">${renderOverview(ctx)}</div></section>
  <section class="panel" data-panel="devices"><div data-part="devices">${renderDevicesSection(ctx)}</div></section>
  <section class="panel" data-panel="source"><div data-part="source">${renderSourcePanel(ctx)}</div><div data-part="home">${renderHomeProxyCard(ctx)}</div></section>
  <section class="panel" data-panel="auth"><div data-part="auth">${renderAuthSettings(ctx)}</div><div data-part="codes">${renderCodesSection(ctx)}</div></section>
  <section class="panel" data-panel="notice"><div data-part="notice">${renderNoticePanel(ctx)}</div></section>
  <section class="panel" data-panel="alerts"><div data-part="alerts">${renderAlertsPanel(ctx)}</div></section>
  <section class="panel" data-panel="system"><div data-part="system">${renderSystemPanel(ctx)}</div></section>

  <div class="footnote">App 端點 <code>/api/config</code> · <code>/api/activate</code> · <code>/api/update</code> · <code>/api/time</code><br>所有操作即時生效；盒子每 90 秒心跳一次、每 ${esc(config.pollIntervalMinutes)} 分鐘重載頻道；監控每 5 分鐘檢查直播源。</div>
</div>

<div id="toast"></div>
<div class="modal-bg" id="modalBg"></div>
<script>${ADMIN_JS}</script>
</body>
</html>`;
}

/** 前端局部刷新：回傳單一區塊的 HTML；未知名稱回 null */
export function renderPartial(name, ctx) {
  switch (name) {
    case "overview": return renderOverview(ctx);
    case "devices": return renderDevicesSection(ctx);
    case "codes": return renderCodesSection(ctx);
    case "source": return renderSourcePanel(ctx);
    case "home": return renderHomeProxyCard(ctx);
    case "auth": return renderAuthSettings(ctx);
    case "notice": return renderNoticePanel(ctx);
    case "alerts": return renderAlertsPanel(ctx);
    case "system": return renderSystemPanel(ctx);
    default: return null;
  }
}

/* ================================================================
 *  總覽
 * ================================================================ */

/** 一眼狀態：綜合直播源（主 / 備援線路、家用備援）、盒子、設定，算出 綠 / 黃 / 紅 與一句話 */
function renderHeadline(ctx, stat, nowMs) {
  const { config, devices, mon } = ctx;
  const devList = Array.isArray(devices) ? devices : [];
  const ss = ctx.sourceStatus;
  // 看門狗自報 + 監控每 5 分鐘的雲端實測（真的播一台）合起來判斷
  const wd = sourceState(ss, nowMs);
  const state = combineState(wd, mon && mon.src, nowMs);
  const bss = ctx.backupStatus;
  const bstate = backupState(config, bss, nowMs, mon && mon.bsrc);
  const hasBackup = bstate !== "off";
  const hp = ctx.homeProxy;
  const hpState = homeProxyState(hp, nowMs);
  // 家用備援真的派得上用場：在線、自報健康、而且會下發（手動備援沒蓋過它）
  const homeUsable = !!hp && hp.healthy !== false && hpState === "online" && needsHomeProxy(config);
  const onlineDevs = devList.filter((d) => onlineState(d, nowMs) === "online");
  const homeBoxes = hp && hp.publicIp ? onlineDevs.filter((d) => sameHomeIp(d.ip, hp.publicIp)).length : 0;
  const onBackup = onlineDevs.filter((d) => d.ln === 1).length;
  const down = (s) => s === "bad" || s === "stale";
  const issues = [];
  if (down(state)) {
    const why = state === "bad"
      ? wd === "bad" ? reasonText(ss.reason) : lineReason({ reason: "probe", probe: freshProbe(mon && mon.src, nowMs) })
      : ss && ss._unreachable ? `連不上主機（${ss._unreachable}）` : "看門狗沒回報，VPS 可能離線";
    const away = onlineDevs.length - homeBoxes;
    if (down(bstate)) issues.push(["red", `主線路與備援線路都異常（主線路：${why}），盒子可能沒有畫面`]);
    else if (bstate === "ok") issues.push(["yellow", `主線路異常（${why}）→ 盒子已自動改用備援線路`]);
    else if (homeUsable && away <= 0) issues.push(["yellow", `主線路異常（${why}）→ 同一個家的盒子有家用備援撐著`]);
    else if (homeUsable) issues.push(["red", `主線路異常（${why}）；家用備援只顧得到同一個家的 ${homeBoxes} 台，其他 ${away} 台受影響`]);
    else if (state === "bad") issues.push(["red", `直播源異常：${why}，看門狗處理中${bstate === "none" ? "（備援線路沒有監測資料，盒子會自動嘗試改用）" : ""}`]);
    else issues.push(["red", (ss && ss._unreachable ? `連不上直播源主機（${ss._unreachable}），VPS 可能離線` : "直播源伺服器的看門狗沒回報，VPS 可能離線") + (bstate === "none" ? "（盒子會自動嘗試備援線路）" : "")]);
  } else if (down(bstate)) {
    issues.push(["yellow", `備援線路異常（${bstate === "bad" ? lineReason(mon && mon.bsrc, bss) : bss && bss._unreachable ? "連不上主機" : "看門狗沒回報"}），主線路正常、不影響觀看`]);
  }
  // 雲端實測播得出來、但看門狗讀不到 / 沒回報：現在能看，可是出事時沒人自動修
  if (wd === "stale" && state === "ok") issues.push(["yellow", `直播源看門狗${ss && ss._unreachable ? "狀態讀不到（" + ss._unreachable + "）" : "沒回報"}（雲端實測仍播得出來）：出事時不會自動修復，請查 VPS 的排程`]);
  if (onBackup && !down(state)) issues.push(["yellow", `${onBackup} 台盒子還在走備援線路`]);
  const failing = devList.filter((d) => onlineState(d, nowMs) === "online" && d.lastOk === false && nowMs - (Date.parse(d.lastResultAt) || 0) < 3600000).length;
  if (failing) issues.push(["red", `${failing} 台線上盒子最近載入頻道失敗`]);
  const unstable = devList.filter((d) => onlineState(d, nowMs) === "online" && playHealth(d, nowMs).level === "bad").length;
  if (unstable) issues.push(["yellow", `${unstable} 台盒子播放不穩（一直重連）`]);
  // 盒子自己回報的卡頓（App 1.0.0.29+）：一台多半是那個家的網路；兩台以上同時卡多半是直播源或線路
  const stalling = onlineDevs.filter((d) => smoothness(d, nowMs).level === "bad").length;
  if (stalling >= 2) issues.push(["red", `${stalling} 台盒子同時播放卡頓，多半是直播源主機或線路`]);
  else if (stalling) issues.push(["yellow", "1 台盒子播放卡頓（近 10 分鐘常卡）"]);
  const relay = ss && !ss._unreachable && ss.relay && typeof ss.relay === "object" ? ss.relay : null;
  if (relay && relay.delivery !== "proxy" && relay.direct_ok === false && !down(state)) {
    issues.push(["yellow", "切片直連 CDN 失效，暫時改由主機代抓（比較慢）"]);
  }
  if (!config.subscriptionUrl) issues.push(["red", "尚未設定訂閱網址，盒子沒有頻道"]);
  if (config.requireActivation && stat.unauth > 0) issues.push(["yellow", `${stat.unauth} 台盒子未授權`]);
  if (config.forceRefresh) issues.push(["yellow", "強制刷新旗標開著"]);
  if (stat.oldver > 0) issues.push(["yellow", `${stat.oldver} 台仍是舊版 App`]);
  const watchedOff = devList.filter((d) => d.watch === true && onlineState(d, nowMs) === "offline").length;
  if (watchedOff) issues.push(["yellow", `${watchedOff} 台重點監控的盒子離線`]);
  const level = issues.some((i) => i[0] === "red") ? "red" : issues.length ? "yellow" : "green";
  const title = level === "green" ? "一切正常" : level === "yellow" ? "需要留意" : "有問題要處理";

  const parts = [];
  parts.push(`${stat.online} 台線上` + (stat.total ? `（共 ${stat.total} 台）` : ""));
  if (state !== "none") parts.push((hasBackup ? "主線路" : "直播源") + describeSource(ss, state, nowMs, mon && mon.src));
  if (hasBackup) parts.push("備援線路" + describeSource(bss, bstate, nowMs, mon && mon.bsrc));
  if (onBackup && down(state)) parts.push(`${onBackup} 台走備援線路`);
  if (hp) parts.push(homeProxyLine(hp, hpState, homeBoxes, config, nowMs));
  if (ss && ss.epg_updated) parts.push("節目表 " + esc(String(ss.epg_updated).slice(5, 16)) + " 更新");
  const up = mon ? uptime24h(mon, nowMs) : null;
  if (up != null) parts.push(`24 小時可用率 ${up}%`);
  if (!telegramReady(config)) parts.push("Telegram 警示未設定");

  return `<div class="head-card ${level}">
      <div class="lamp"></div>
      <div class="head-body">
        <div class="head-title">${title}</div>
        <div class="head-sub">${parts.map((p) => esc(p)).join(" · ")}</div>
        ${issues.length ? `<div class="head-issues">${issues.map((i) => `<span class="issue ${i[0]}">${esc(i[1])}</span>`).join("")}</div>` : ""}
      </div>
    </div>`;
}

/** 總覽一句話裡的家用備援狀態 */
function homeProxyLine(hp, hpState, homeBoxes, config, nowMs) {
  if (hpState !== "online") return `家用備援離線（最後紀錄 ${relativeTime(hp.lastSeen, nowMs) || "-"}）`;
  const extra = [];
  extra.push(`${hp.channels != null ? hp.channels : "?"} 台頻道`);
  if (homeBoxes) extra.push(`同一個家 ${homeBoxes} 台盒子線上`);
  if (hp.healthy === false) extra.push("但代理自報異常、暫不下發");
  else if (!needsHomeProxy(config)) extra.push("目前用手動備援、不下發");
  else if (config.homeProxyRole === "primary") extra.push("家裡的盒子優先走它");
  return `家用備援在線（${extra.join("，")}）`;
}

/** 雲端實測的一行（橫幅尾巴）：每 5 分鐘從 Cloudflare 照盒子的走法真的播一台 */
function probeLineHtml(p, nowMs) {
  if (!p || p.lan) return "";
  const when = relativeTime(new Date(p.at).toISOString(), nowMs);
  return `<br>${p.ok ? "☁️" : "❌"} 雲端實測（${esc(when || "剛剛")}）：${esc(probeText(p))}`;
}

/** 一條線路的看門狗狀態橫幅（主線路 / 備援線路共用）；line = 監控狀態（帶雲端實測） */
function sourceBanner(ss, label, nowMs, isBackup, line) {
  const p = freshProbe(line, nowMs);
  const probeHtml = probeLineHtml(p, nowMs);
  if (!ss) {
    // 沒有看門狗（第三方源，或 status.json 讀不到）：只靠雲端實測
    if (!p || p.lan) return "";
    const bad = !p.ok && (line.probeFails || 0) >= 2;
    return `<div class="banner ${p.ok ? "off" : "warn"}"><span class="bi">${p.ok ? "🟢" : bad ? (isBackup ? "🟡" : "🔴") : "⚠️"}</span><div>${label} <b>${p.ok ? "播得出來" : bad ? "播不出來" : "實測失敗一次"}</b>（沒有看門狗資料，靠雲端實測）。${probeHtml}</div></div>`;
  }
  if (ss._unreachable) {
    if (p && p.ok) {
      return `<div class="banner warn"><span class="bi">⚠️</span><div>${label}的看門狗狀態 <b>讀不到</b>（${esc(ss._unreachable)}），但雲端實測還播得出來：出事時不會自動修復，請查 VPS。${probeHtml}</div></div>`;
    }
    return `<div class="banner warn"><span class="bi">⚠️</span><div>${label} <b>連不上</b>（${esc(ss._unreachable)}），VPS 可能離線、關機或網路斷了。${isBackup ? "主線路正常時不影響觀看。" : ""}${probeHtml}</div></div>`;
  }
  const ageMs = ss.checked_at_ms ? nowMs - ss.checked_at_ms : NaN;
  const stale = !Number.isFinite(ageMs) || ageMs > 20 * 60 * 1000;
  const when = ss.checked_at_ms ? relativeTime(new Date(ss.checked_at_ms).toISOString(), nowMs) : "-";
  const ipTxt = ss.public_ip ? `出口 IP ${esc(ss.public_ip)}` : "出口 IP 未知";
  const epgTxt = ss.epg_updated ? `節目表更新於 ${esc(String(ss.epg_updated).slice(5, 16))}` : "";
  const actTxt = ss.last_action && ss.last_action !== "none"
    ? `最近自動處置：${esc(actionText(ss.last_action))}${ss.last_action_at ? "（" + esc(relativeTime(ss.last_action_at, nowMs)) + "）" : ""}`
    : "";
  const heal = selfHealText(ss);
  if (stale) {
    return `<div class="banner warn"><span class="bi">⚠️</span><div>${label}的看門狗 <b>${when === "-" ? "沒有回報" : when + "後就沒再回報"}</b>，VPS 可能離線或排程停了。${probeHtml}</div></div>`;
  }
  if (ss.healthy && p && !p.ok && (line.probeFails || 0) >= 2) {
    return `<div class="banner warn"><span class="bi">${isBackup ? "🟡" : "🔴"}</span><div>${label} <b>播不出來</b>：看門狗自報正常（${when}），但從雲端照盒子的走法實測連續失敗——多半是對外入口（nginx、埠、防火牆）或主機網路，看門狗看不出來也不會自動處理，請登入 VPS 執行 4gtv doctor。${probeHtml}</div></div>`;
  }
  if (ss.healthy) {
    return `<div class="banner off"><span class="bi">🟢</span><div>${label} <b>正常</b>（看門狗實測熱門台切片與冷門台 API 解析，${when}）。${ipTxt}。${epgTxt}${actTxt ? " " + actTxt : ""}${heal ? `<br>🛠️ ${esc(heal)}` : ""}${probeHtml}</div></div>`;
  }
  return `<div class="banner warn"><span class="bi">${isBackup ? "🟡" : "🔴"}</span><div>${label} <b>異常</b>：連續 <b>${esc(ss.consecutive_failures)}</b> 次實測失敗（${esc(reasonText(ss.reason))}，${when}，${ipTxt}）。看門狗會自動清快取、重啟與更換出口節點${actTxt ? "；" + actTxt : ""}。${isBackup ? "主線路正常時不影響觀看，有空再處理。" : "若 30 分鐘內未恢復請通知維護人員。"}${heal ? `<br>🛠️ ${esc(heal)}` : ""}${probeHtml}</div></div>`;
}

/** 24 小時健康色條（96 格 × 15 分鐘） */
export function renderHistoryStrip(mon, nowMs) {
  if (!mon || !Array.isArray(mon.hist) || !mon.hist.length) {
    return `<div class="empty" style="padding:14px">監控啟動後（Cron 每 5 分鐘）這裡會畫出 24 小時的直播源健康色條</div>`;
  }
  const slots = historySlots(mon, nowMs, 96);
  const bars = slots.map((s) => `<i class="${s.state}" title="${esc(formatTaipeiTime(new Date(s.t).toISOString()))} ${s.state === "ok" ? "正常" : s.state === "bad" ? "異常" : s.state === "stale" ? "沒回報" : "無資料"}"></i>`).join("");
  const up = uptime24h(mon, nowMs);
  const t0 = formatTaipeiTime(new Date(nowMs - DAY).toISOString());
  const t1 = formatTaipeiTime(new Date(nowMs).toISOString());
  return `<div class="hist">${bars}</div>
    <div class="hist-axis"><span>${esc(t0)}（昨天）</span><span>${esc(t1)} 現在</span></div>
    <div class="hist-legend"><span><i class="ok"></i>正常</span><span><i class="bad"></i>異常</span><span><i class="stale"></i>看門狗沒回報</span><span><i class="none"></i>無資料</span>${up != null ? `<span style="margin-left:auto;color:var(--text)">24 小時可用率 <b>${up}%</b></span>` : ""}</div>`;
}

const ALERT_KIND = {
  src_down: "直播源異常", src_stale: "看門狗沒回報", src_up: "直播源恢復",
  src_down_bk: "主線路異常（有備援）", both_down: "主備線路都異常", bsrc_down: "備援線路異常", bsrc_up: "備援線路恢復",
  dev_off: "盒子離線", dev_on: "盒子回來", dev_fail: "盒子載入失敗", dev_stall: "盒子播放卡頓",
};
function renderAlertRows(log, nowMs, limit) {
  const rows = (Array.isArray(log) ? log : []).slice(0, limit || 8);
  if (!rows.length) return `<div class="empty">尚無警示事件（這是好事）</div>`;
  return `<div class="alog">${rows.map((l) => {
    const st = String(l.status || "");
    const stTxt = st === "sent" ? "已發 Telegram" : st === "muted" ? "靜音時段未發" : st === "no-telegram" ? "未設定 Telegram" : st.startsWith("failed") ? "發送失敗：" + st.slice(8) : st;
    return `<div class="alog-row k-${esc(l.kind)}"><div class="am"><span>${esc(ALERT_KIND[l.kind] || l.kind)} · ${esc(formatTaipeiFull(l.at))}（${esc(relativeTime(l.at, nowMs))}）</span><span>${esc(stTxt)}</span></div>${esc(l.text)}</div>`;
  }).join("")}</div>`;
}

/**
 * 播放品質（總覽第二塊）：看得順不順，一眼看完。
 *   - 盒子自己回報的卡頓、換台速度（App 1.0.0.29+ 心跳）
 *   - 直播源主機最近 24 小時的播放紀錄、切片走哪條路（代理 2.4+，看門狗 status.json 的 quality / relay）
 * 兩邊都沒有資料（舊版 App + 舊版代理，或第三方源）就不顯示。
 */
export function renderQualityBlock(ctx, nowMs) {
  const devList = Array.isArray(ctx.devices) ? ctx.devices : [];
  const ss = ctx.sourceStatus && !ctx.sourceStatus._unreachable ? ctx.sourceStatus : null;
  const q = ss && ss.quality && typeof ss.quality === "object" ? ss.quality : null;
  const relay = ss && ss.relay && typeof ss.relay === "object" ? ss.relay : null;
  const online = devList.filter((d) => onlineState(d, nowMs) === "online");
  const reporting = online.filter((d) => typeof d.rb === "number");
  if (!q && !relay && !reporting.length) return "";

  const secs = (ms) => (Math.round(ms / 100) / 10) + " 秒";
  const tile = (val, label, tone, sub) =>
    `<div class="q-tile"><div class="q-lab">${esc(label)}</div><div class="q-val ${tone}">${esc(val)}</div><div class="q-sub">${esc(sub || "")}</div></div>`;
  const tiles = [];

  // 1) 盒子現在順不順
  if (reporting.length) {
    const bad = reporting.filter((d) => smoothness(d, nowMs).level === "bad").length;
    const warn = reporting.filter((d) => smoothness(d, nowMs).level === "warn").length;
    tiles.push(tile(bad ? `${bad} 台常卡` : warn ? `${warn} 台偶爾卡` : "都很順", "盒子現在", bad ? "bad" : warn ? "warn" : "ok",
      `${reporting.length} 台線上盒子回報` + (online.length > reporting.length ? `（另 ${online.length - reporting.length} 台是舊版 App）` : "")));
  } else {
    tiles.push(tile("—", "盒子現在", "mute", online.length ? "線上盒子都是舊版 App，更新後才會回報" : "目前沒有盒子在線"));
  }

  // 2) 最近 24 小時（主機紀錄：有人看的每一分鐘有沒有漏片、抓不到切片）
  if (q && q.minutes_watched > 0) {
    const bad = q.bad_minutes || 0;
    const pct = Math.round((1 - bad / q.minutes_watched) * 1000) / 10;
    tiles.push(tile(pct + "%", "24 小時順暢", pct >= 99 ? "ok" : pct >= 95 ? "warn" : "bad",
      `看了 ${fmtUptime(q.minutes_watched)}，${bad ? bad + " 分鐘有狀況" : "全程正常"}`));
  } else if (q) {
    tiles.push(tile("—", "24 小時順暢", "mute", "這 24 小時沒有人收看"));
  }

  // 3) 換台速度：盒子回報的中位數；沒有就用主機自己實測的開播時間
  const zts = reporting.map((d) => d.zt).filter((v) => typeof v === "number" && v > 0).sort((a, b) => a - b);
  const pm = ss && ss.probe_ms && typeof ss.probe_ms === "object" ? ss.probe_ms : null;
  if (zts.length) {
    const mid = zts[Math.floor(zts.length / 2)];
    tiles.push(tile(secs(mid), "換台速度", mid <= 2500 ? "ok" : mid <= 5000 ? "warn" : "bad", "按下去到出畫面（盒子回報）"));
  } else if (pm && pm.segment > 0) {
    const total = (pm.m3u8 || 0) + pm.segment;
    tiles.push(tile(secs(total), "開播實測", total <= 2500 ? "ok" : total <= 5000 ? "warn" : "bad", `主機自測：清單 ${secs(pm.m3u8 || 0)}＋切片 ${secs(pm.segment)}`));
  }

  // 4) 影片（切片）走哪條路
  if (relay) {
    if (relay.delivery === "proxy") tiles.push(tile("主機代抓", "影片線路", "mute", "設定為一律經主機轉送"));
    else if (relay.direct_ok === false) tiles.push(tile("主機代抓", "影片線路", "warn", "直連 CDN 失效，暫時經主機轉送（較慢）"));
    else tiles.push(tile("直連 CDN", "影片線路", "ok", relay.fallback_clients ? `盒子直接向 CDN 下載（${relay.fallback_clients} 個位址暫時代抓）` : "盒子直接向 CDN 下載，不繞主機"));
  }

  const paused = ss && Array.isArray(ss.channels_paused) ? ss.channels_paused.filter((c) => c && c.name) : [];
  const pausedNote = paused.length
    ? `<div class="q-note">⏸ 暫停播出 ${paused.length} 台：${esc(paused.slice(0, 6).map((c) => c.name).join("、"))}${paused.length > 6 ? " 等" : ""}（4gtv 官網下架或改成會員限定；恢復後自動放回原台號）</div>`
    : "";
  const watching = relay && Array.isArray(relay.watching) && relay.watching.length ? `正在播 ${relay.watching.slice(0, 3).join("、")}${relay.watching.length > 3 ? " 等" : ""}` : "";
  const ver = ss && ss.proxy_version ? "代理 " + ss.proxy_version : "";
  const pill = [watching, ver].filter(Boolean).join(" · ");

  return `
    <div class="block">
      <div class="block-head"><span class="block-title"><span class="ic">📶</span>播放品質</span>${pill ? `<span class="count-pill">${esc(pill)}</span>` : ""}</div>
      <div class="q-grid">${tiles.join("")}</div>
      ${pausedNote}
    </div>`;
}

export function renderOverview(ctx) {
  const { config, devices, codes, ota, mon } = ctx;
  const nowMs = Date.now();
  const devList = Array.isArray(devices) ? devices : [];
  const codeList = Array.isArray(codes) ? codes : [];

  const stat = { total: devList.length, online: 0, today: 0, authed: 0, unauth: 0, blocked: 0, oldver: 0 };
  const verCount = {};
  const latestVer = ota && ota.version ? ota.version : 0;
  for (const d of devList) {
    const s = onlineState(d, nowMs);
    if (s === "online") stat.online++;
    if (s !== "offline") stat.today++;
    if (devAuthed(d, nowMs)) stat.authed++; else stat.unauth++;
    if (d.blocked) stat.blocked++;
    const v = d.v || "未知";
    verCount[v] = (verCount[v] || 0) + 1;
    if (latestVer && verNum(d.v) && verNum(d.v) < latestVer) stat.oldver++;
  }
  const unusedCodes = codeList.filter((c) => c && c.status === "unused").length;
  const usedCodes = codeList.filter((c) => c && c.status === "used").length;

  // 正在觀看（線上且有回報）
  const nowRows = devList
    .filter((d) => d.now && onlineState(d, nowMs) === "online")
    .slice(0, 12)
    .map((d) => {
      const ph = playHealth(d, nowMs);
      const phTxt = ph.level === "bad" ? `<span class="ph bad" title="${esc(ph.text)}">⚠ 重連 ${d.pe} 次</span>` : ph.level === "warn" ? `<span class="ph warn">重連 ${d.pe} 次</span>` : "";
      const lnTxt = d.ln === 1 ? `<span class="ph bk" title="主線路連續失敗，盒子自動改用備援線路">備援線路</span>` : "";
      const sm = smoothness(d, nowMs);
      const smTip = [sm.text].concat(smoothDetail(d)).join(" · ");
      const smTxt = sm.level === "unknown" ? "" : `<span class="ph ${sm.level === "bad" ? "bad" : sm.level === "warn" ? "warn" : "ok"}" title="${esc(smTip)}">${esc(sm.short)}</span>`;
      return `<div class="now-row"><span class="sdot online"></span><span class="nm">${esc(d.nick || d.id)}</span><span class="ch">${esc(d.now)}</span>${lnTxt}${smTxt}${phTxt}<span class="tm">${esc(relativeTime(d.nowAt || d.lastSeen, nowMs))}</span></div>`;
    })
    .join("");

  // 版本分布
  const verEntries = Object.keys(verCount).map((k) => [k, verCount[k]]).sort((a, b) => b[1] - a[1]);
  const maxV = verEntries.length ? verEntries[0][1] : 1;
  const verBars = verEntries
    .slice(0, 8)
    .map(([v, n]) => {
      const old = latestVer && verNum(v) && verNum(v) < latestVer;
      return `<div class="ver-bar ${old ? "old" : ""}"><span class="mono" style="color:${old ? "var(--gold)" : "var(--text)"}">${esc(v)}${old ? " ↑" : ""}</span><span class="vb"><i style="width:${Math.max(4, Math.round((n / maxV) * 100))}%"></i></span><span class="vn">${n} 台</span></div>`;
    })
    .join("");

  // 播放不穩 = 線上、而且一直重連或常卡
  const rough = devList.filter((d) => onlineState(d, nowMs) === "online" && (playHealth(d, nowMs).level === "bad" || smoothness(d, nowMs).level === "bad")).length;

  const banners = [];
  // 直播源伺服器看門狗（VPS 每 5 分鐘實測頻道解析與切片）；有備援線路時兩條各一條橫幅
  const ss = ctx.sourceStatus;
  const bss = ctx.backupStatus;
  const hasBackup = !!String(config.backupSubscriptionUrl || "").trim();
  const mainBanner = sourceBanner(ss, hasBackup ? "直播源伺服器（主線路）" : "直播源伺服器", nowMs, false, mon && mon.src);
  if (mainBanner) banners.push(mainBanner);
  if (hasBackup) {
    const bkBanner = sourceBanner(bss, "備援線路", nowMs, true, mon && mon.bsrc);
    banners.push(bkBanner ||
      `<div class="banner off"><span class="bi">🛟</span><div>備援線路 <b>已設定</b>（沒有看門狗資料${freshProbe(mon && mon.bsrc, nowMs) && freshProbe(mon && mon.bsrc, nowMs).lan ? "，是區網網址、雲端無法實測" : "，雲端實測還沒跑"}）。主線路連續失敗時盒子會自動改用它。</div></div>`);
  }
  banners.push(
    config.requireActivation
      ? `<div class="banner on"><span class="bi">🔒</span><div>授權機制 <b>已啟用</b>：未授權或到期的盒子拿不到直播源。${stat.unauth > 0 ? `目前有 <b>${stat.unauth}</b> 台未授權。` : "所有裝置皆已授權。"}</div></div>`
      : `<div class="banner off"><span class="bi">🔓</span><div>授權機制 <b>未啟用</b>：所有盒子皆可觀看（到「授權」分頁可開啟）。</div></div>`
  );
  if (!config.subscriptionUrl) {
    banners.push(`<div class="banner warn"><span class="bi">⚠️</span><div>尚未設定 <b>訂閱網址</b>，盒子沒有頻道可播。請到「直播源」分頁貼上網址。</div></div>`);
  }
  if (config.forceRefresh) {
    banners.push(`<div class="banner warn"><span class="bi">🔁</span><div style="flex:1">「強制刷新」旗標目前 <b>開著</b>，盒子每次輪詢都會重載清單。確認都更新後建議關閉。</div><form method="POST" action="/admin/system" style="margin:0"><input type="hidden" name="action" value="force_refresh_off"><button class="btn-mini btn-gold">立即關閉</button></form></div>`);
  }
  if (latestVer) {
    banners.push(
      stat.oldver > 0
        ? `<div class="banner info"><span class="bi">⬆️</span><div>最新 App <b>${esc(ota.name)}</b>；有 <b>${stat.oldver}</b> 台盒子仍是舊版，開機或回到播放畫面時會收到更新提示${config.otaEnabled === false ? "（<b>OTA 目前已停用</b>）" : ""}。</div></div>`
        : `<div class="banner off"><span class="bi">✅</span><div>最新 App <b>${esc(ota.name)}</b>，所有回報的盒子都是最新版。</div></div>`
    );
  } else if (!ctx.hasGithubToken) {
    banners.push(`<div class="banner off"><span class="bi">📦</span><div>OTA 尚未設定 <code>GITHUB_TOKEN</code>，盒子不會自動收到新版（見「系統」分頁）。</div></div>`);
  }
  if (config.marquee && config.marqueeUntil && (Date.parse(config.marqueeUntil) || 0) > nowMs) {
    banners.push(`<div class="banner info"><span class="bi">🏃</span><div>跑馬燈進行中：「${esc(config.marquee)}」，至 ${esc(formatTaipeiFull(config.marqueeUntil))}。</div></div>`);
  }
  if (config.notice && (!config.noticeUntil || (Date.parse(config.noticeUntil) || 0) > nowMs)) {
    banners.push(`<div class="banner info"><span class="bi">📢</span><div>公告顯示中：「${esc(config.notice)}」${config.noticeUntil ? `，至 ${esc(formatTaipeiFull(config.noticeUntil))}` : "（常駐）"}。</div></div>`);
  }

  return `
    ${renderHeadline(ctx, stat, nowMs)}
    ${renderQualityBlock(ctx, nowMs)}
    <div class="block">
      <div class="block-head"><span class="block-title"><span class="ic">📊</span>營運概覽</span><span class="count-pill">更新於 ${esc(formatTaipeiFull(new Date().toISOString()))}</span></div>
      <div class="stat-grid">
        <div class="stat-box"><div class="sb-num">${stat.total}</div><div class="sb-label">總裝置</div></div>
        <div class="stat-box"><div class="sb-num ok">${stat.online}</div><div class="sb-label">線上</div></div>
        <div class="stat-box"><div class="sb-num accent">${stat.today}</div><div class="sb-label">今日上線</div></div>
        <div class="stat-box"><div class="sb-num ${config.requireActivation ? "ok" : "mute"}">${stat.authed}</div><div class="sb-label">已授權</div></div>
        <div class="stat-box"><div class="sb-num ${stat.unauth > 0 && config.requireActivation ? "warn" : "mute"}">${stat.unauth}</div><div class="sb-label">未授權</div></div>
        <div class="stat-box"><div class="sb-num ${rough ? "warn" : "mute"}">${rough}</div><div class="sb-label">播放不穩</div></div>
      </div>
      ${banners.join("")}
    </div>

    <div class="grid2">
      <div class="block">
        <div class="block-head"><span class="block-title"><span class="ic">📺</span>正在觀看</span><span class="count-pill">線上 ${stat.online} 台</span></div>
        ${nowRows ? `<div class="now-list">${nowRows}</div>` : `<div class="empty">目前沒有線上盒子回報觀看中的頻道<br><small>盒子更新到新版 App 後會回報</small></div>`}
      </div>
      <div class="block">
        <div class="block-head"><span class="block-title"><span class="ic">🧩</span>App 版本分布</span>${latestVer ? `<span class="count-pill">最新 ${esc(ota.name)}</span>` : ""}</div>
        ${verBars ? `<div class="ver-bars">${verBars}</div>` : `<div class="empty">尚無裝置回報版本</div>`}
      </div>
    </div>

    <div class="block">
      <div class="block-head"><span class="block-title"><span class="ic">🩺</span>直播源 24 小時健康</span><span class="count-pill">${mon && mon.lastTick ? "監控最近寫入 " + esc(relativeTime(new Date(mon.lastTick).toISOString(), nowMs)) : "監控尚未執行"}</span></div>
      ${renderHistoryStrip(mon, nowMs)}
    </div>

    <div class="block">
      <div class="block-head"><span class="block-title"><span class="ic">🔔</span>最近警示</span><button type="button" class="btn-mini" onclick="showTab('alerts')">警示設定 ›</button></div>
      ${renderAlertRows(mon && mon.log, nowMs, 5)}
    </div>

    <div class="block">
      <div class="block-head"><span class="block-title"><span class="ic">⚡</span>快速操作</span></div>
      <div class="quick">
        <button type="button" onclick="showTab('source')">📡 換直播源</button>
        <button type="button" onclick="showTab('auth')">🎟️ 產生啟動碼</button>
        <button type="button" onclick="showTab('notice')">🏃 發跑馬燈</button>
        <button type="button" onclick="showTab('devices')">📺 管理裝置</button>
      </div>
    </div>

    <div class="block">
      <div class="block-head"><span class="block-title"><span class="ic">🗂️</span>目前設定摘要</span></div>
      <div class="kv">
        <div class="item"><div class="k">設定版本</div><div class="v">v${esc(config.version)}</div></div>
        <div class="item"><div class="k">輪詢間隔</div><div class="v">${esc(config.pollIntervalMinutes)} 分鐘</div></div>
        <div class="item"><div class="k">全域字體</div><div class="v">${esc(fontLabel(config.fontScale))}</div></div>
        <div class="item"><div class="k">右上角時鐘</div><div class="v"><span class="badge ${config.showClock ? "on" : "off"}">${config.showClock ? "顯示" : "關閉"}</span></div></div>
        <div class="item"><div class="k">開機自啟（全域）</div><div class="v"><span class="badge ${config.autostart ? "on" : "off"}">${config.autostart ? "開啟" : "關閉"}</span></div></div>
        <div class="item"><div class="k">OTA 更新提示</div><div class="v"><span class="badge ${config.otaEnabled !== false ? "on" : "off"}">${config.otaEnabled !== false ? "允許" : "停用"}</span></div></div>
        <div class="item"><div class="k">Telegram 警示</div><div class="v"><span class="badge ${telegramReady(config) ? "on" : "off"}">${telegramReady(config) ? "已啟用" : "未設定"}</span></div></div>
        <div class="item"><div class="k">最後更新</div><div class="v mono">${esc(formatTaipeiFull(config.updatedAt))}</div></div>
        <div class="item full"><div class="k">目前訂閱網址</div><div class="v mono" title="token 已遮罩；完整網址在「直播源」分頁">${config.subscriptionUrl ? esc(maskToken(config.subscriptionUrl)) : "（尚未設定）"}</div></div>
        <div class="item full"><div class="k">備援訂閱網址</div><div class="v mono" title="token 已遮罩；完整網址在「直播源」分頁">${hasBackup ? esc(maskToken(config.backupSubscriptionUrl)) : "（未設定）"}</div></div>
      </div>
      ${ctx.devicesError ? `<div class="inline-note" style="color:var(--danger)">⚠ 裝置清單讀取失敗（資料庫暫時無法使用，或今日免費額度用完），數字可能不完整，稍後再試。</div>` : ""}
      ${stat.blocked ? `<div class="inline-note">已封鎖裝置 ${stat.blocked} 台</div>` : ""}
    </div>`;
}

/* ================================================================
 *  直播源
 * ================================================================ */

export function renderSourcePanel(ctx) {
  const { config } = ctx;
  return `
    <form class="block" method="POST" action="/admin/save">
      <input type="hidden" name="_fields" value="source">
      <div class="block-head"><span class="block-title"><span class="ic">📡</span>直播源</span></div>
      <div class="block-sub">含 token 的 m3u 清單網址。App 不內建任何 token，一律由這裡下發；換 token 只要改這裡，盒子下次輪詢（最長 ${esc(config.pollIntervalMinutes)} 分鐘）或按「重載頻道」遠端指令就會更新。</div>
      <label for="subscriptionUrl">訂閱網址（主線路）<span class="hint">例如 http://你的IP:5050/channel?type=m3u&amp;token=…（HTTP 連接埠對老盒子最穩）</span></label>
      <textarea id="subscriptionUrl" name="subscriptionUrl" spellcheck="false">${esc(config.subscriptionUrl)}</textarea>
      <label for="backupSubscriptionUrl">備援訂閱網址（選填）<span class="hint">主線路連續失敗時盒子自動改用，同名頻道合併多線路。不用請留空（留空時，跟家用備援同一個家的盒子會自動拿家用代理當備援，見下方）。</span></label>
      <textarea id="backupSubscriptionUrl" name="backupSubscriptionUrl" spellcheck="false" placeholder="例如另一台主機的 http://…/channel?type=m3u&amp;token=…（不用請留空）">${esc(config.backupSubscriptionUrl || "")}</textarea>
      <div class="btn-row">
        <button type="button" class="btn btn-secondary" onclick="testSource()">🔍 測試主線路</button>
        <button type="button" class="btn btn-secondary" onclick="testSource('backup')">🔍 測試備援</button>
        <button type="submit" class="btn btn-primary">💾 儲存直播源</button>
      </div>
      <div id="testResult"></div>
      <div id="testResultBackup"></div>
    </form>
    <div class="block">
      <div class="block-head"><span class="block-title"><span class="ic">🛰️</span>全部盒子立即重載</span></div>
      <div class="block-sub">換完直播源不想等輪詢？送出「重新載入頻道」給所有線上盒子，約 90 秒內生效（也可在「裝置」分頁對單台操作）。</div>
      <form method="POST" action="/admin/device" data-confirm="確定要讓所有盒子重新載入頻道？播放會短暫中斷約 2 秒。">
        <input type="hidden" name="action" value="cmd_all"><input type="hidden" name="value" value="reload">
        <button class="btn btn-secondary">🔁 所有盒子重新載入頻道</button>
      </form>
    </div>`;
}

/**
 * 家用備援卡片（直播源分頁）：家裡電腦的代理自動登記的狀態、角色、進階金鑰。
 * 金鑰只出現在這張卡的密碼欄（管理員專用頁面），複製時提示訊息不回顯金鑰內容。
 */
export function renderHomeProxyCard(ctx) {
  const { config, origin } = ctx;
  const hp = ctx.homeProxy;
  const nowMs = Date.now();
  const st = homeProxyState(hp, nowMs);
  const role = config.homeProxyRole === "primary" ? "primary" : "backup";
  const manual = !!String(config.backupSubscriptionUrl || "").trim();
  const key = String(config.homeProxyKey || "");
  const badge = st === "online"
    ? hp.healthy === false ? `<span class="badge warn-b">在線・自報異常</span>` : `<span class="badge good-b">在線</span>`
    : st === "offline" ? `<span class="badge danger-b">離線</span>` : `<span class="badge off">尚未登記</span>`;

  const notes = [];
  const hpProbe = hp && hp.probe && typeof hp.probe === "object" ? hp.probe : null;
  if (hp && hp.healthy === false) notes.push(["warn", `家用代理自己實測播不出來${hpProbe && hpProbe.error ? "（" + hpProbe.error + "）" : "（或抓不到頻道）"} → 暫時不下發給盒子，恢復後自動繼續。`]);
  if (hp && !hpProbe && st === "online") notes.push(["mute", "這台家用代理版本較舊，只回報頻道數、沒有回報播放實測；在家裡電腦重跑一次安裝指令就會升級。"]);
  if (hp && nowMs - (Date.parse(hp.lastSeen) || 0) > HOME_FRESH_MS) notes.push(["warn", "超過 2 小時沒有登記 → 暫時不下發給盒子（電腦關機、睡眠或代理沒在跑）。"]);
  if (manual && role === "backup") notes.push(["mute", "上面已手動填「備援訂閱網址」→ 盒子用手動那條，家用代理只顯示狀態、不下發。想讓家裡的盒子用家用代理，就清空手動備援，或把角色改成「優先」。"]);

  const info = hp
    ? `<div class="kv">
        <div class="item"><div class="k">區網網址</div><div class="v mono">${esc(hp.lanUrl)}</div></div>
        <div class="item"><div class="k">家裡的公網 IP</div><div class="v mono">${esc(hp.publicIp || "-")}</div></div>
        <div class="item"><div class="k">代理版本</div><div class="v">${esc(hp.version || "-")}</div></div>
        <div class="item"><div class="k">頻道數</div><div class="v">${esc(hp.channels != null ? hp.channels : "-")} 台</div></div>
        <div class="item full"><div class="k">播放實測（代理每 5 分鐘自己播一台；雲端連不到區網，只能靠它回報）</div><div class="v">${hpProbe ? (hpProbe.ok ? "✅ " : "❌ ") + esc(probeText(hpProbe)) : "—（舊版代理沒有回報）"}</div></div>
        <div class="item"><div class="k">最後回報</div><div class="v">${esc(relativeTime(hp.lastSeen, nowMs) || "-")}<span class="sub-v">${esc(formatTaipeiFull(hp.lastSeen))}（沒變化時每 30 分鐘記一次）</span></div></div>
        <div class="item"><div class="k">登記方式</div><div class="v">${hp.via === "box" ? "免金鑰" + (hp.boxId ? `<span class="sub-v">同一個家的已授權盒子 ${esc(hp.boxId)} 擔保</span>` : "") : "金鑰"}</div></div>
      </div>`
    : `<div class="empty">還沒有家用代理登記過。在家裡的 Windows 電腦執行安裝指令，裝好幾分鐘內就會出現在這裡。</div>`;

  return `
    <div class="block">
      <div class="block-head"><span class="block-title"><span class="ic">🏠</span>家用備援（家裡電腦）</span>${badge}</div>
      <div class="block-sub">家裡電腦跑的代理會自動登記，只下發給跟它同一個家（同一個公網 IP）的盒子，走區網直連；45 分鐘內有紀錄算在線。<b>換新電腦執行安裝指令就會自動登記，不用改這裡。</b></div>
      ${info}
      ${notes.map((n) => `<div class="note-box ${n[0]}">${esc(n[1])}</div>`).join("")}
      <form method="POST" action="/admin/save">
        <input type="hidden" name="_fields" value="home">
        <label>家用備援的角色<span class="hint">只影響跟家用代理同一個家的盒子；其他地點的盒子照舊</span></label>
        <div class="radio-row">
          <label class="radio"><input type="radio" name="homeProxyRole" value="backup"${role === "backup" ? " checked" : ""}><span><b>備援</b>（預設）：雲端主線路壞了才改用家用代理</span></label>
          <label class="radio"><input type="radio" name="homeProxyRole" value="primary"${role === "primary" ? " checked" : ""}><span><b>優先</b>：家裡的盒子優先走家用代理（區網直連），雲端主線路改當備援</span></label>
        </div>
        <button type="submit" class="btn btn-secondary">💾 儲存角色</button>
      </form>
      <details class="howto">
        <summary>進階：登記金鑰（選用）</summary>
        <div class="inline-note">平常不用金鑰：同一個家 24 小時內有已授權（未封鎖、未到期）的盒子上線，家用代理就能自動登記。盒子還沒授權、或要讓另一個地方的電腦強制接手時，才在安裝時帶這把金鑰（標頭 <code>X-Home-Key</code>）。登記端點 <code>POST ${esc(origin)}/api/home-proxy</code></div>
        ${key
          ? `<input type="password" id="homeKey" value="${esc(key)}" readonly autocomplete="off" spellcheck="false" class="mono" style="margin-top:10px">
        <div class="btn-row" style="gap:8px;margin-top:8px">
          <button type="button" class="btn-mini" onclick="toggleHomeKey(this)">👁 顯示</button>
          <button type="button" class="btn-mini btn-info" onclick="copyHomeKey()">📋 複製金鑰</button>
          <form class="row-form" method="POST" action="/admin/system" data-confirm="重新產生後舊金鑰立即失效：帶舊金鑰登記的家用代理要改用新金鑰（免金鑰登記的不受影響）。確定？"><input type="hidden" name="action" value="regen_home_key"><button class="btn-mini btn-danger">🔄 重新產生</button></form>
        </div>`
          : `<form method="POST" action="/admin/system" style="margin-top:10px"><input type="hidden" name="action" value="regen_home_key"><button class="btn-mini btn-info">🔑 產生金鑰</button></form>`}
      </details>
    </div>`;
}

/* ================================================================
 *  授權設定 + 啟動碼
 * ================================================================ */

export function renderAuthSettings(ctx) {
  const { config } = ctx;
  return `
    <form class="block" method="POST" action="/admin/save">
      <input type="hidden" name="_fields" value="auth">
      <div class="block-head"><span class="block-title"><span class="ic">🔐</span>授權設定</span></div>
      <div class="switch-row" onclick="var c=this.querySelector('input');if(event.target!==c)c.checked=!c.checked;">
        <input type="checkbox" id="requireActivation" name="requireActivation" ${config.requireActivation ? "checked" : ""}>
        <label for="requireActivation">啟用啟動碼授權<span class="hint">開啟後未授權／到期的盒子無法觀看。開啟前請先「一鍵授權所有現有裝置」，否則現有盒子會被鎖在外。</span></label>
      </div>
      <label for="activationTitle">啟動畫面標題<span class="hint">App 開啟與輸入啟動碼時顯示</span></label>
      <input type="text" id="activationTitle" name="activationTitle" maxlength="60" value="${esc(config.activationTitle || "")}">
      <label for="activationText">啟動畫面說明文字<span class="hint">可換行；可放歡迎語、客服聯絡方式</span></label>
      <textarea id="activationText" name="activationText" maxlength="500">${esc(config.activationText || "")}</textarea>
      <label for="codeDigits">啟動碼位數（4～12）<span class="hint">位數越少越好輸入；6～8 位兼顧安全與方便。伺服器已有同 IP 每 10 分鐘 30 次的猜碼限制。</span></label>
      <input type="number" id="codeDigits" name="codeDigits" min="4" max="12" value="${esc(config.codeDigits || 8)}">
      <button type="submit" class="btn btn-primary">💾 儲存授權設定</button>
    </form>`;
}

export function renderCodesSection(ctx) {
  const { codes } = ctx;
  const list = Array.isArray(codes) ? codes : [];
  const now = Date.now();
  const rows = list.length
    ? list.map((c) => renderCodeRow(c, now)).join("")
    : `<div class="empty">尚無啟動碼，用上方表單產生。</div>`;
  const unused = list.filter((c) => c && c.status === "unused").length;
  const used = list.filter((c) => c && c.status === "used").length;
  return `
    <div class="block">
      <div class="block-head"><span class="block-title"><span class="ic">🎟️</span>產生啟動碼</span></div>
      <form method="POST" action="/admin/codes" class="gen-form">
        <input type="hidden" name="action" value="gen_batch">
        <div class="gen-grid">
          <div class="gen-field"><label>數量</label><input type="number" name="count" value="1" min="1" max="200"></div>
          <div class="gen-field"><label>有效天數（0＝永久）</label><input type="number" name="days" value="0" min="0"></div>
        </div>
        <input type="text" name="note" class="gen-input" maxlength="60" placeholder="備註（選填）：經銷商 / 客戶名 / 檔期" style="margin-top:10px">
        <button class="btn btn-primary">＋ 產生啟動碼</button>
      </form>
      <div class="btn-row">
        <form method="POST" action="/admin/device" data-confirm="確定把目前所有現有裝置設為已授權（永久）？" style="flex:1 1 auto">
          <input type="hidden" name="action" value="authorize_all"><input type="hidden" name="value" value="0">
          <button class="btn btn-secondary">🔓 一鍵授權所有現有裝置（永久）</button>
        </form>
        <a class="btn btn-secondary" href="/admin/export?what=codes" style="flex:0 1 auto;text-decoration:none">⬇️ 匯出 CSV</a>
      </div>
    </div>

    <div class="block">
      <div class="block-head">
        <span class="block-title"><span class="ic">📋</span>啟動碼清單</span>
        <span class="count-pill">未用 ${unused} · 已用 ${used} · 共 ${list.length}</span>
      </div>
      <input type="text" class="search" id="codeSearch" placeholder="🔍 搜尋啟動碼 / 備註 / 綁定裝置" oninput="filterCodes()">
      <div class="filters" id="codeFilters">
        <button type="button" class="fchip active" data-f="all" onclick="setCodeFilter(this)">全部</button>
        <button type="button" class="fchip" data-f="unused" onclick="setCodeFilter(this)">未使用</button>
        <button type="button" class="fchip" data-f="used" onclick="setCodeFilter(this)">已啟用</button>
        <button type="button" class="fchip" data-f="expired" onclick="setCodeFilter(this)">已到期</button>
        <button type="button" class="fchip" data-f="revoked" onclick="setCodeFilter(this)">已撤銷</button>
      </div>
      <div class="code-list" id="codeList">${rows}</div>
      ${unused > 0 ? `<form method="POST" action="/admin/codes" data-confirm="確定刪除全部 ${unused} 組未使用的啟動碼？" style="margin-top:12px"><input type="hidden" name="action" value="delete_unused_all"><button class="btn btn-danger" style="margin-top:0">🗑️ 刪除全部未使用的啟動碼</button></form>` : ""}
    </div>`;
}

export function renderCodeRow(c, now) {
  const code = String(c && c.code != null ? c.code : "");
  const status = c && c.status ? c.status : "unused";
  const note = String(c && c.note ? c.note : "");
  const device = String(c && c.device ? c.device : "");
  const expireAt = c && c.expireAt ? c.expireAt : "";
  const days = c && typeof c.days === "number" ? c.days : 0;
  const codeAttr = esc(code);
  const expired = status === "used" && expireAt && (Date.parse(expireAt) || 0) <= now;

  let badge;
  if (status === "revoked") badge = `<span class="badge danger-b">已撤銷</span>`;
  else if (status === "used") badge = expired ? `<span class="badge danger-b">已到期</span>` : `<span class="badge on">已啟用</span>`;
  else badge = `<span class="badge ok-b">未使用</span>`;

  const termText = status === "unused" ? (days > 0 ? days + " 天" : "永久") : expireAt ? "到期 " + formatTaipeiFull(expireAt) : "永久";
  const metaParts = [];
  if (device) metaParts.push("綁定 " + esc(device));
  metaParts.push(esc(termText));
  if (c && c.createdAt) metaParts.push("建立 " + esc(formatTaipeiFull(c.createdAt)));
  if (note) metaParts.push("📝 " + esc(note));

  const revokeBtn = status !== "revoked"
    ? `<form class="row-form" method="POST" action="/admin/codes" data-confirm="撤銷啟動碼 ${codeAttr}？${device ? "綁定的裝置也會被停用。" : ""}"><input type="hidden" name="code" value="${codeAttr}"><input type="hidden" name="action" value="revoke"><button type="submit" class="btn-mini btn-danger">撤銷</button></form>`
    : "";
  const delBtn = `<form class="row-form" method="POST" action="/admin/codes" data-confirm="刪除啟動碼 ${codeAttr}？"><input type="hidden" name="code" value="${codeAttr}"><input type="hidden" name="action" value="delete"><button type="submit" class="btn-mini">刪除</button></form>`;
  const copyBtn = status === "unused" ? `<button type="button" class="btn-mini btn-info" data-copy="${codeAttr}">📋 複製</button>` : "";

  const searchKey = (code + " " + note + " " + device).toLowerCase().replace(/"/g, "");
  const statusKey = status === "revoked" ? "revoked" : status === "used" ? (expired ? "expired" : "used") : "unused";
  return `<div class="code-row" data-status="${statusKey}" data-search="${esc(searchKey)}">
    <div class="code-row-top"><span class="code-val" data-copy="${codeAttr}" title="點一下複製">${codeAttr}</span>${badge}</div>
    <div class="code-row-meta">${metaParts.join(" · ")}</div>
    <div class="code-row-actions">${copyBtn}${revokeBtn}${delBtn}</div>
  </div>`;
}

/* ================================================================
 *  裝置
 * ================================================================ */

export function renderDevicesSection(ctx) {
  const { devices, config, ota } = ctx;
  const list = Array.isArray(devices) ? devices : [];
  const nowMs = Date.now();
  const latestVer = ota && ota.version ? ota.version : 0;
  const online = list.filter((d) => onlineState(d, nowMs) === "online").length;
  const onBackup = list.filter((d) => d.ln === 1 && onlineState(d, nowMs) === "online").length;
  const stallCount = list.filter((d) => onlineState(d, nowMs) === "online" && smoothness(d, nowMs).level !== "ok" && smoothness(d, nowMs).level !== "unknown").length;
  const body = list.length
    ? list.map((d) => renderDeviceCard(d, config, latestVer, nowMs, ctx.homeProxy)).join("")
    : ctx.devicesError
    ? `<div class="empty" style="color:var(--danger)">裝置清單讀取失敗（資料庫暫時無法使用，或今日免費額度用完）。這不代表盒子有問題，稍後再按「重新整理」。</div>`
    : `<div class="empty">尚無裝置上線（盒子裝好 App 開過後會出現）</div>`;
  const stale = list.filter((d) => nowMs - (Date.parse(d.lastSeen) || 0) > 30 * DAY).length;
  const cmdOpts = Object.keys(CMD_TYPES).filter((k) => k !== "tune").map((k) => `<option value="${k}">${CMD_TYPES[k]}</option>`).join("");
  return `
    <div class="block">
      <div class="block-head">
        <span class="block-title"><span class="ic">📺</span>裝置清單</span>
        <span class="count-pill">線上 ${online} · 共 ${list.length} 台</span>
      </div>
      <div class="block-sub">🟢 線上（15 分內有心跳）　🟡 今日曾上線　⚫ 離線。盒子每 90 秒心跳，遠端指令在下次心跳執行。</div>
      <input type="text" class="search" id="devSearch" placeholder="🔍 搜尋編號 / 暱稱 / 機型 / 正在看的頻道" oninput="filterDevs()">
      <div class="filters" id="devFilters">
        <button type="button" class="fchip active" data-f="all" onclick="setDevFilter(this)">全部</button>
        <button type="button" class="fchip" data-f="online" onclick="setDevFilter(this)">線上</button>
        <button type="button" class="fchip" data-f="offline" onclick="setDevFilter(this)">離線</button>
        <button type="button" class="fchip" data-f="unauth" onclick="setDevFilter(this)">未授權</button>
        <button type="button" class="fchip" data-f="blocked" onclick="setDevFilter(this)">已封鎖</button>
        ${latestVer ? `<button type="button" class="fchip" data-f="oldver" onclick="setDevFilter(this)">舊版 App</button>` : ""}
        ${onBackup ? `<button type="button" class="fchip" data-f="backup" onclick="setDevFilter(this)">走備援線路（${onBackup}）</button>` : ""}
        ${stallCount ? `<button type="button" class="fchip" data-f="stall" onclick="setDevFilter(this)">播放卡頓（${stallCount}）</button>` : ""}
      </div>
      <div class="bulk-row">
        <span class="bulk-label">全部裝置</span>
        <form class="row-form" method="POST" action="/admin/device" data-confirm="確定送出給所有裝置？">
          <input type="hidden" name="action" value="cmd_all">
          <select name="value" class="mini-select">${cmdOpts}</select>
          <button class="btn-mini btn-info">送出指令</button>
        </form>
        <form class="row-form" method="POST" action="/admin/device" data-confirm="確定把「全部」裝置的開機自啟改為開？"><input type="hidden" name="action" value="autostart_all"><input type="hidden" name="value" value="on"><button class="btn-mini">自啟全開</button></form>
        <form class="row-form" method="POST" action="/admin/device" data-confirm="確定把「全部」裝置的開機自啟改為關？關掉後盒子重開機不會自動進偉電視。"><input type="hidden" name="action" value="autostart_all"><input type="hidden" name="value" value="off"><button class="btn-mini">自啟全關</button></form>
        <a class="btn-mini" href="/admin/export?what=devices" style="text-decoration:none">⬇️ CSV</a>
        ${stale ? `<form class="row-form" method="POST" action="/admin/device" data-confirm="刪除 ${stale} 台超過 30 天未上線的裝置紀錄？"><input type="hidden" name="action" value="delete_stale"><button class="btn-mini btn-danger">清 30 天未上線（${stale}）</button></form>` : ""}
      </div>
      <div class="dev-list" id="devList">${body}</div>
      <div class="empty" id="devEmpty" style="display:none;margin-top:10px">沒有符合條件的裝置</div>
    </div>`;
}

export function renderDeviceCard(d, config, latestVer, nowMs, hp) {
  const id = String(d && d.id != null ? d.id : "");
  const nick = String(d && d.nick ? d.nick : "");
  const title = nick || id || "（未命名）";
  const blocked = !!(d && d.blocked);
  const msg = String(d && d.msg ? d.msg : "");
  const msgLevel = d && d.msgLevel === "warn" ? "warn" : "info";
  const idAttr = esc(id);
  const model = d && d.m ? d.m : "";
  const ver = d && d.v ? d.v : "";
  const state = onlineState(d, nowMs);
  const stateText = state === "online" ? "線上" : state === "today" ? "剛離線" : "離線";

  const authed = !!(d && d.authorized);
  const dExpireAt = d && d.expireAt ? d.expireAt : "";
  const dExpired = authed && dExpireAt && (Date.parse(dExpireAt) || 0) <= nowMs;
  const authActive = authed && !dExpired;
  const authText = !authed ? "未授權" : dExpired ? "已到期" : dExpireAt ? "至 " + formatTaipeiFull(dExpireAt) : "永久";

  const hasAutostart = d && typeof d.autostart === "boolean";
  const autostartOn = hasAutostart ? d.autostart : !!config.autostart;
  const autostartText = hasAutostart ? (autostartOn ? "開" : "關") : (autostartOn ? "開（全域）" : "關（全域）");
  const isOld = !!(latestVer && verNum(ver) && verNum(ver) < latestVer);
  const fsEff = effectiveFontScale(d, config);
  const fsOverride = d && d.fontScale ? d.fontScale : "";
  const cmd = pendingCmd(d, nowMs);
  // 目前播放用的線路（App 心跳 ln：0 主線路、1 備援線路）；家用代理當哪條線就標出來
  const ln = d && typeof d.ln === "number" ? d.ln : null;
  const onBackupNow = ln === 1 && state === "online";
  let lineFact;
  if (ln == null) lineFact = ["線路", "未回報（舊版 App）", "mute"];
  else {
    const lines = effectiveLines(config, hp || null, d.ip, nowMs);
    const homeTag = (ln === 0 && lines.homeProxy === "primary") || (ln === 1 && lines.homeProxy === "backup") ? "（家用代理）" : "";
    lineFact = ln === 1
      ? ["線路", "備援線路" + homeTag + (d.lnAt ? " · " + relativeTime(d.lnAt, nowMs) + "切換" : ""), "info"]
      : ["線路", "主線路" + homeTag, "ok"];
  }

  const badges =
    (config.requireActivation
      ? authActive ? `<span class="badge ok-b">已授權</span>` : dExpired ? `<span class="badge warn-b">已到期</span>` : `<span class="badge danger-b">未授權</span>`
      : authActive ? `<span class="badge mute-b">已授權</span>` : "") +
    (blocked ? `<span class="badge danger-b">已封鎖</span>` : "") +
    (onBackupNow ? `<span class="badge info-b" title="主線路連續失敗，盒子自動改用備援線路">備援線路中</span>` : "") +
    (state === "online" && smoothness(d, nowMs).level === "bad" ? `<span class="badge danger-b" title="近 10 分鐘卡 3 次以上或合計停住 10 秒以上">常卡</span>` : "") +
    (d && d.watch === true ? `<span class="badge info-b" title="離線超過門檻會 Telegram 通知">重點監控</span>` : "") +
    (isOld ? `<span class="badge warn-b" title="最新 v${latestVer}">舊版</span>` : "");

  let srcFact;
  if (d && d.lastResultAt) srcFact = d.lastOk ? ["來源", "✓ " + (d.lastCount != null ? d.lastCount : 0) + " 台 · " + relativeTime(d.lastResultAt, nowMs), "ok"] : ["來源", "✕ 載入失敗 · " + relativeTime(d.lastResultAt, nowMs), "bad"];
  else srcFact = ["來源", "未回報", "mute"];
  const ph = playHealth(d, nowMs);
  const phFact = ["播放", ph.level === "unknown" ? "未回報（舊版 App）" : ph.text + (d && d.peAt && ph.level !== "unknown" ? " · " + relativeTime(d.peAt, nowMs) : ""), ph.level === "bad" ? "bad" : ph.level === "warn" ? "warn" : ph.level === "ok" ? "ok" : "mute"];

  // 流暢度（App 1.0.0.29+）：卡頓 + 換台速度、緩衝、下載速度；整列顯示，數字多也不擠
  const sm = smoothness(d, nowMs);
  const smText = sm.level === "unknown" ? sm.text : [sm.text].concat(smoothDetail(d)).join(" · ");
  const stallNow = state === "online" && (sm.level === "bad" || sm.level === "warn");
  const facts = [
    ["授權", authText, authActive ? "ok" : dExpired || (config.requireActivation && !authed) ? "bad" : "mute"],
    srcFact,
    ["流暢度", smText, sm.level === "bad" ? "bad" : sm.level === "warn" ? "warn" : sm.level === "ok" ? "ok" : "mute", "wide"],
    phFact,
    lineFact,
    ["最後上線", (relativeTime(d && d.lastSeen, nowMs) || "-") + "（" + stateText + "）", state === "online" ? "ok" : "mute"],
    ["版本", ver ? ver + (isOld ? " ↑可更新" : "") : "-", isOld ? "warn" : "mute"],
    ["機型", model || "-", "mute"],
    ["字體", fontShort(fsEff) + (fsOverride ? "（單機）" : "（全域）") + (d && d.fs && d.fs !== fsEff ? " · 盒子 " + fontShort(d.fs) : ""), "mute"],
    ["開機自啟", autostartText, "mute"],
    ["IP", d && d.ip ? d.ip : "-", "mute"],
    ["首次上線", d && d.firstSeen ? formatTaipeiFull(d.firstSeen) : "-", "mute"],
    ["回報次數", (d && d.count != null ? d.count : 0) + " 次" + (d && typeof d.up === "number" ? " · App 已開 " + fmtUptime(d.up) : ""), "mute"],
  ];
  const factsHtml = facts.map((f) => `<div class="fact${f[3] ? " " + f[3] : ""}"><span class="fk">${f[0]}</span><span class="fv ${f[2]}">${esc(f[1])}</span></div>`).join("");

  const nowRow = d && d.now
    ? `<div class="dev-now"><span class="lbl">📺 正在看</span><span class="val">${esc(d.now)}</span><span class="ago">${esc(relativeTime(d.nowAt || d.lastSeen, nowMs))}</span></div>`
    : "";
  const currentMsg = msg ? `<div class="dev-curmsg ${msgLevel === "warn" ? "lv-warn" : "lv-info"}">💬 ${esc(msg)}</div>` : "";
  const cmdRow = cmd
    ? `<div class="dev-cmd">⏳ 待送達：<b>${esc(CMD_TYPES[cmd.type] || cmd.type)}${cmd.type === "tune" ? " → 第 " + esc(cmd.arg) + " 台" : ""}</b><span style="color:var(--text-faint);font-size:12px">${esc(relativeTime(d.cmd.at, nowMs))}</span>${devForm(idAttr, "clearcmd", "取消", "")}</div>`
    : d && d.lastAck
    ? `<div class="inline-note" style="margin-top:8px">上次指令「${esc(CMD_TYPES[d.lastAck.type] || d.lastAck.type)}${d.lastAck.type === "tune" ? " " + esc(d.lastAck.arg) : ""}」已於 ${esc(relativeTime(d.lastAck.at, nowMs))} 執行 ✓</div>`
    : "";

  const blockForm = blocked ? devForm(idAttr, "unblock", "解除封鎖", "ok") : devForm(idAttr, "block", "封鎖", "danger", `確定封鎖 ${esc(title)}？該台約 90 秒內停播。`);
  const authForms = config.requireActivation
    ? `
      <form class="row-form" method="POST" action="/admin/device">
        <input type="hidden" name="id" value="${idAttr}"><input type="hidden" name="action" value="authorize">
        <input type="number" name="value" class="mini-input mini-days" placeholder="天" value="0" min="0" title="0＝永久">
        <button class="btn-mini btn-ok">授權</button>
      </form>
      ${authed ? devForm(idAttr, "deauthorize", "撤銷授權", "danger", `確定撤銷 ${esc(title)} 的授權？綁定的啟動碼會一併作廢。`) : ""}`
    : "";
  const primary = `${authForms}
      ${blockForm}
      <form class="row-form" method="POST" action="/admin/device"><input type="hidden" name="id" value="${idAttr}"><input type="hidden" name="action" value="cmd"><input type="hidden" name="value" value="reload"><button class="btn-mini btn-info" title="讓這台重新抓清單並繼續播放">🔁 重載頻道</button></form>`;

  const fsOptions = [["", "跟隨全域（" + fontShort(config.fontScale) + "）"]].concat(FONT_SCALE_OPTIONS)
    .map(([v, l]) => `<option value="${v}"${fsOverride === v ? " selected" : ""}>${l}</option>`).join("");

  const more = `
      <div class="sect">遠端協助</div>
      <form class="row-form wide" method="POST" action="/admin/device">
        <input type="hidden" name="id" value="${idAttr}"><input type="hidden" name="action" value="cmd"><input type="hidden" name="value" value="tune">
        <input type="number" name="arg" class="mini-input mini-days" placeholder="台號" min="1" max="9999" required>
        <button class="btn-mini btn-info">📺 幫他切台</button>
        <span class="inline-note" style="margin:0">輸入頻道號碼，盒子約 90 秒內切到該台</span>
      </form>
      <div class="btn-row" style="gap:8px">
        ${devForm(idAttr, "cmd", "🔄 重啟 App", "", `重啟 ${esc(title)} 的偉電視？約 3 秒黑畫面後自動回到播放。`, "restart")}
        ${devForm(idAttr, "cmd", "🧹 清快取重載", "", null, "clearcache")}
      </div>
      <div class="sect">傳話</div>
      <form class="row-form wide" method="POST" action="/admin/device">
        <input type="hidden" name="id" value="${idAttr}"><input type="hidden" name="action" value="message">
        <input type="text" name="value" class="mini-input grow" maxlength="200" placeholder="顯示在該台畫面上的訊息…" value="${esc(msg)}">
        <select name="level" class="mini-select"><option value="info"${msgLevel === "info" ? " selected" : ""}>一般</option><option value="warn"${msgLevel === "warn" ? " selected" : ""}>警告</option></select>
        <button class="btn-mini btn-ok">傳話</button>
        ${msg ? devForm(idAttr, "clearmsg", "清除", "") : ""}
      </form>
      <div class="sect">畫面與行為</div>
      <form class="row-form wide" method="POST" action="/admin/device">
        <input type="hidden" name="id" value="${idAttr}"><input type="hidden" name="action" value="fontscale">
        <span class="inline-note" style="margin:0">字體</span>
        <select name="value" class="mini-select" style="flex:1 1 auto">${fsOptions}</select>
        <button class="btn-mini">套用</button>
      </form>
      <div class="btn-row" style="gap:8px">
        <form class="row-form" method="POST" action="/admin/device"><input type="hidden" name="id" value="${idAttr}"><input type="hidden" name="action" value="autostart"><input type="hidden" name="value" value="${autostartOn ? "off" : "on"}"><button class="btn-mini">開機自啟：改為${autostartOn ? "關" : "開"}</button></form>
        <form class="row-form" method="POST" action="/admin/device"><input type="hidden" name="id" value="${idAttr}"><input type="hidden" name="action" value="watch"><input type="hidden" name="value" value="${d && d.watch === true ? "off" : "on"}"><button class="btn-mini${d && d.watch === true ? "" : " btn-info"}" title="離線超過門檻（警示分頁可調）就 Telegram 通知">${d && d.watch === true ? "🔕 取消重點監控" : "🔔 設為重點監控"}</button></form>
      </div>
      <div class="sect">名稱與紀錄</div>
      <form class="row-form wide" method="POST" action="/admin/device">
        <input type="hidden" name="id" value="${idAttr}"><input type="hidden" name="action" value="rename">
        <input type="text" name="value" class="mini-input grow" maxlength="40" placeholder="裝置暱稱，例如：客廳 / 阿嬤房" value="${esc(nick)}">
        <button class="btn-mini">改暱稱</button>
      </form>
      ${devForm(idAttr, "delete", "🗑️ 刪除裝置紀錄", "danger", `確定刪除 ${esc(title)} 的紀錄？（盒子下次上線會重新登記，授權會消失）`)}`;

  const searchKey = (id + " " + nick + " " + model + " " + (d && d.now ? d.now : "")).toLowerCase().replace(/"/g, "");
  return `<div class="dev-card${blocked ? " is-blocked" : ""}${onBackupNow ? " on-backup" : ""}" data-search="${esc(searchKey)}" data-online="${state === "online" ? 1 : 0}" data-authed="${authActive ? 1 : 0}" data-blocked="${blocked ? 1 : 0}" data-oldver="${isOld ? 1 : 0}" data-backup="${onBackupNow ? 1 : 0}" data-stall="${stallNow ? 1 : 0}">
    <div class="dev-head">
      <div class="dev-title"><span class="sdot ${state}" title="${stateText}"></span><div><div class="dev-name">${esc(title)}</div><div class="dev-id mono">${idAttr}</div></div></div>
      <div class="dev-badges">${badges}</div>
    </div>
    ${nowRow}
    <div class="facts">${factsHtml}</div>
    ${currentMsg}
    ${cmdRow}
    <div class="dev-primary">${primary}</div>
    <details class="dev-more"><summary>更多操作 ▾（遠端協助 / 傳話 / 字體 / 暱稱）</summary><div class="dev-more-body">${more}</div></details>
  </div>`;
}

/** 只有隱藏欄位 + 單一按鈕的裝置操作小表單 */
function devForm(idAttr, action, label, kind, confirmText, value) {
  const cls = kind === "ok" ? " btn-ok" : kind === "danger" ? " btn-danger" : kind === "info" ? " btn-info" : "";
  return `<form class="row-form" method="POST" action="/admin/device"${confirmText ? ` data-confirm="${confirmText}"` : ""}>
        <input type="hidden" name="id" value="${idAttr}"><input type="hidden" name="action" value="${action}">${value != null ? `<input type="hidden" name="value" value="${esc(value)}">` : ""}
        <button class="btn-mini${cls}">${label}</button>
      </form>`;
}

/** App 已運行時間（分鐘 → 人話） */
function fmtUptime(min) {
  const m = Math.max(0, parseInt(min, 10) || 0);
  if (m < 60) return m + " 分鐘";
  if (m < 1440) return Math.floor(m / 60) + " 小時" + (m % 60 ? " " + (m % 60) + " 分" : "");
  return Math.floor(m / 1440) + " 天" + (Math.floor((m % 1440) / 60) ? " " + Math.floor((m % 1440) / 60) + " 小時" : "");
}

/* ================================================================
 *  警示（Telegram）
 * ================================================================ */

export function renderAlertsPanel(ctx) {
  const { config, devices, mon } = ctx;
  const nowMs = Date.now();
  const devList = Array.isArray(devices) ? devices : [];
  const ready = telegramReady(config);
  const hasToken = isValidTgToken(config.tgBotToken);
  const watched = devList.filter((d) => d && d.watch === true);
  const sw = (id, label, hint, checked) => `
      <div class="switch-row" onclick="var c=this.querySelector('input');if(event.target!==c)c.checked=!c.checked;">
        <input type="checkbox" id="${id}" name="${id}" ${checked ? "checked" : ""}>
        <label for="${id}">${label}<span class="hint">${hint}</span></label>
      </div>`;
  const statusBanner = ready
    ? `<div class="banner on"><span class="bi">🔔</span><div>Telegram 警示 <b>已啟用</b>：直播源異常超過 ${esc(config.alertSourceMin)} 分鐘、恢復、重點盒子離線超過 ${esc(config.alertDeviceOfflineMin)} 分鐘${config.alertBoxFail !== false ? "、盒子載入頻道失敗" : ""}${config.alertStall !== false ? "、盒子播放常卡" : ""}都會通知${config.alertQuiet ? "；靜音時段 " + esc(config.alertQuiet) + " 時" : ""}。${String(config.backupSubscriptionUrl || "").trim() ? "主 / 備援線路各自監控：主線路壞但備援正常標為「較不緊急」，兩條都壞才是緊急。" : ""}</div></div>`
    : `<div class="banner warn"><span class="bi">🔕</span><div>Telegram 警示 <b>尚未啟用</b>。監控每 5 分鐘照樣在跑、事件會記在下方，但不會有人收到通知。照下面三步接上 Telegram，直播源出事你會第一個知道，不必等長輩打電話來。</div></div>`;

  return `
    <div class="block">
      <div class="block-head"><span class="block-title"><span class="ic">🔔</span>警示通知（Telegram）</span>${mon && mon.lastTick ? `<span class="count-pill">監控最近寫入 ${esc(relativeTime(new Date(mon.lastTick).toISOString(), nowMs))}</span>` : `<span class="count-pill">監控尚未執行</span>`}</div>
      ${statusBanner}
      <details class="howto" ${hasToken ? "" : "open"}>
        <summary>怎麼拿 Bot Token 和 Chat ID？（3 步，約 2 分鐘）</summary>
        <ol class="steps">
          <li>在 Telegram 搜尋 <b>@BotFather</b> → 傳 <code>/newbot</code> → 照提示取名字 → 會給你一串 <b>Token</b>（像 <code>123456789:AAxxxxxxxx</code>），貼到下面。</li>
          <li>搜尋你剛建的機器人，按 <b>Start</b> 跟它說一句話（機器人不能主動先找你）。想發到家人群組就把機器人加進群組、在群組說一句。</li>
          <li>搜尋 <b>@userinfobot</b> 按 Start，它會回你的 <b>Chat ID</b>（數字）；群組的話把 @userinfobot 加進群組也會回群組 ID（負數）。貼到下面 → 按「測試發送」→ 手機收到就成功。</li>
        </ol>
      </details>
      <form method="POST" action="/admin/save" id="alertsForm">
        <input type="hidden" name="_fields" value="alerts">
        ${sw("alertsEnabled", "啟用 Telegram 警示", "關閉時仍會記錄事件，只是不發訊息", config.alertsEnabled)}
        <label for="tgBotToken">Bot Token<span class="hint">${hasToken ? "已設定（為安全不顯示）。要換就貼新的；留空維持不變。" : "從 @BotFather 取得"}</span></label>
        <input type="password" id="tgBotToken" name="tgBotToken" autocomplete="off" placeholder="${hasToken ? "已設定，留空不變" : "123456789:AAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"}">
        ${hasToken ? `<div class="switch-row" style="margin-top:8px" onclick="var c=this.querySelector('input');if(event.target!==c)c.checked=!c.checked;"><input type="checkbox" id="clearTg" name="clearTg"><label for="clearTg">清除已儲存的 Token</label></div>` : ""}
        <label for="tgChatId">Chat ID<span class="hint">個人是正數，群組是負數（例如 -1001234567890）</span></label>
        <input type="text" id="tgChatId" name="tgChatId" inputmode="numeric" value="${esc(config.tgChatId || "")}" placeholder="123456789">
        <div class="row2">
          <div><label for="alertSourceMin">直播源異常幾分鐘才通知<span class="hint">看門狗 5～15 分內多半自己修好，建議 10</span></label><input type="number" id="alertSourceMin" name="alertSourceMin" min="5" max="120" value="${esc(config.alertSourceMin || 10)}"></div>
          <div><label for="alertDeviceOfflineMin">重點盒子離線幾分鐘才通知<span class="hint">長輩會關電視，別設太短；建議 180</span></label><input type="number" id="alertDeviceOfflineMin" name="alertDeviceOfflineMin" min="30" max="1440" value="${esc(config.alertDeviceOfflineMin || 180)}"></div>
        </div>
        <label for="alertQuiet">靜音時段（選填）<span class="hint">台灣時間「起-迄」小時，例如 23-7；此時段不發訊息只記錄</span></label>
        <input type="text" id="alertQuiet" name="alertQuiet" value="${esc(config.alertQuiet || "")}" placeholder="例如 23-7">
        ${sw("alertBoxFail", "盒子回報「載入頻道失敗」時通知", "每台每小時最多一則", config.alertBoxFail !== false)}
        ${sw("alertStall", "盒子播放常卡時通知", "新版 App 會回報卡頓；連續約 10 分鐘都常卡才通知，每台每小時最多一則", config.alertStall !== false)}
        <div class="btn-row">
          <button type="submit" class="btn btn-primary">💾 儲存警示設定</button>
          <button type="submit" class="btn btn-secondary" formaction="/admin/alerts" name="action" value="test">📨 測試發送</button>
        </div>
      </form>
    </div>

    <div class="block">
      <div class="block-head"><span class="block-title"><span class="ic">🩺</span>直播源 24 小時健康</span>
        <form method="POST" action="/admin/alerts" style="margin:0"><input type="hidden" name="action" value="run"><button class="btn-mini btn-info">▶ 立即檢查一次</button></form></div>
      ${renderHistoryStrip(mon, nowMs)}
    </div>

    <div class="block">
      <div class="block-head"><span class="block-title"><span class="ic">📌</span>重點監控的盒子</span><span class="count-pill">${watched.length} 台</span></div>
      <div class="block-sub">在「裝置」分頁每台卡片的「更多操作 → 設為重點監控」加入。離線超過門檻通知、回來也通知；沒設的盒子關機不會吵你。</div>
      ${watched.length ? `<div class="now-list">${watched.map((d) => {
        const st = onlineState(d, nowMs);
        return `<div class="now-row"><span class="sdot ${st}"></span><span class="nm">${esc(d.nick || d.id)}</span><span class="ch" style="color:var(--text-dim)">${esc(st === "online" ? "線上" : "離線 · 最後 " + relativeTime(d.lastSeen, nowMs))}</span><span class="tm">${d.now ? esc(d.now) : ""}</span></div>`;
      }).join("")}</div>` : `<div class="empty">尚未指定重點監控的盒子</div>`}
    </div>

    <div class="block">
      <div class="block-head"><span class="block-title"><span class="ic">🗒️</span>警示紀錄</span>
        ${mon && mon.log && mon.log.length ? `<form method="POST" action="/admin/alerts" data-confirm="清除全部警示紀錄？" style="margin:0"><input type="hidden" name="action" value="clear_log"><button class="btn-mini">清除</button></form>` : ""}</div>
      ${renderAlertRows(mon && mon.log, nowMs, 40)}
    </div>`;
}

/* ================================================================
 *  通知
 * ================================================================ */

export function renderNoticePanel(ctx) {
  const { config } = ctx;
  const nowMs = Date.now();
  const marqueeActive = config.marquee && config.marqueeUntil && (Date.parse(config.marqueeUntil) || 0) > nowMs;
  const noticeActive = config.notice && (!config.noticeUntil || (Date.parse(config.noticeUntil) || 0) > nowMs);
  return `
    <form class="block" method="POST" action="/admin/save">
      <input type="hidden" name="_fields" value="marquee">
      <div class="block-head"><span class="block-title"><span class="ic">🏃</span>臨時跑馬燈</span>${marqueeActive ? `<span class="badge on">進行中</span>` : `<span class="badge off">未顯示</span>`}</div>
      <div class="block-sub">在盒子畫面底部像電視台一樣滾動，適合「今晚 8 點停機維護」「請家人回電」這類臨時通知。</div>
      <label for="marquee">跑馬燈文字</label>
      <textarea id="marquee" name="marquee" maxlength="300" placeholder="例如：系統將於今晚 23:00 維護 10 分鐘，造成不便敬請見諒">${esc(config.marquee || "")}</textarea>
      <label for="marqueeMinutes">顯示分鐘數<span class="hint">時間到自動消失；${marqueeActive ? "留空＝維持原到期時間，只改文字；" : ""}填 0 或清空文字＝停止</span></label>
      <input type="number" id="marqueeMinutes" name="marqueeMinutes" min="0" value="${marqueeActive ? "" : 30}" placeholder="${marqueeActive ? "維持原到期（剩 " + Math.max(1, Math.round((Date.parse(config.marqueeUntil) - nowMs) / 60000)) + " 分）" : "例如 30"}">
      ${marqueeActive ? `<div class="hint-line">⏱ 目前跑馬燈將於 <b>${esc(formatTaipeiFull(config.marqueeUntil))}</b> 自動消失</div>` : ""}
      <div class="preview-tv"><div class="ptitle">盒子畫面預覽</div><div class="pm"><span id="pmText">${esc(config.marquee || "（跑馬燈文字預覽）")}</span></div></div>
      <div class="btn-row">
        <button type="submit" class="btn btn-primary">📣 發送跑馬燈</button>
        ${marqueeActive ? `<button type="submit" class="btn btn-danger" formaction="/admin/system" name="action" value="clear_marquee">⏹ 立即停止</button>` : ""}
      </div>
    </form>

    <form class="block" method="POST" action="/admin/save">
      <input type="hidden" name="_fields" value="notice">
      <div class="block-head"><span class="block-title"><span class="ic">📢</span>公告（固定膠囊）</span>${noticeActive ? `<span class="badge on">顯示中</span>` : `<span class="badge off">未顯示</span>`}</div>
      <div class="block-sub">盒子開機／換台時在畫面下方顯示幾秒鐘的固定文字，適合長期提醒（例如客服電話）。</div>
      <label for="notice">公告文字<span class="hint">留空則不顯示</span></label>
      <textarea id="notice" name="notice" maxlength="500">${esc(config.notice || "")}</textarea>
      <label for="noticeHours">自動撤下時數<span class="hint">0＝常駐；例如 24＝一天後自動撤下${config.notice && config.noticeUntil ? "；留空＝維持原到期時間，只改文字" : ""}</span></label>
      <input type="number" id="noticeHours" name="noticeHours" min="0" step="0.5" value="${config.notice && config.noticeUntil ? "" : 0}" placeholder="${config.notice && config.noticeUntil ? "維持原到期（剩 " + Math.max(0.5, Math.round(((Date.parse(config.noticeUntil) - nowMs) / 3600000) * 2) / 2) + " 小時）" : "0"}">
      ${config.notice && config.noticeUntil ? `<div class="hint-line">⏱ 目前公告將於 <b>${esc(formatTaipeiFull(config.noticeUntil))}</b> 自動撤下</div>` : ""}
      <div class="preview-tv center"><div class="ptitle" style="text-align:left">盒子畫面預覽</div><span class="pn" id="pnText">${esc(config.notice || "（公告文字預覽）")}</span></div>
      <div class="btn-row">
        <button type="submit" class="btn btn-primary">💾 儲存公告</button>
        ${noticeActive ? `<button type="submit" class="btn btn-danger" formaction="/admin/system" name="action" value="clear_notice">⏹ 撤下公告</button>` : ""}
      </div>
    </form>

    <div class="block">
      <div class="block-head"><span class="block-title"><span class="ic">📷</span>聯絡我們 QR（顯示在 App）</span>${config.contactQrVer > 0 ? `<span class="badge on">已上傳</span>` : `<span class="badge off">未上傳</span>`}</div>
      <div class="block-sub">顯示在啟動碼輸入頁與資訊頁，讓長輩的家人能掃碼加 LINE 或撥電話找你。</div>
      ${config.contactQrVer > 0 ? `<div class="qr-preview"><img src="/asset/qr?v=${config.contactQrVer}" alt="聯絡 QR"></div>` : ""}
      <form method="POST" action="/admin/save">
        <input type="hidden" name="_fields" value="contact">
        <label for="contactText">聯絡說明文字<span class="hint">顯示在 QR 旁，例如「掃碼加 LINE 客服」或「電話 0912-345-678」</span></label>
        <input type="text" id="contactText" name="contactText" maxlength="200" value="${esc(config.contactText || "")}">
        <button type="submit" class="btn btn-secondary">💾 儲存聯絡文字</button>
      </form>
      <form method="POST" action="/admin/upload" enctype="multipart/form-data" style="margin-top:12px" data-reset>
        <label>上傳 QR 圖檔<span class="hint">PNG / JPG，小於 2MB</span></label>
        <input type="file" name="file" accept="image/*" class="file-input" required>
        <button type="submit" class="btn btn-primary">⬆️ 上傳 QR</button>
      </form>
      ${config.contactQrVer > 0 ? `<form method="POST" action="/admin/upload" data-confirm="確定移除 QR 圖？" style="margin-top:8px"><input type="hidden" name="action" value="remove"><button class="btn btn-danger">移除 QR</button></form>` : ""}
    </div>`;
}

/* ================================================================
 *  系統
 * ================================================================ */

export function renderSystemPanel(ctx) {
  const { config, ota, hasGithubToken, origin, audit, hist } = ctx;
  const nowMs = Date.now();
  const fsOptions = FONT_SCALE_OPTIONS.map(([v, l]) => `<option value="${v}"${config.fontScale === v ? " selected" : ""}>${l}</option>`).join("");
  const sw = (id, label, hint, checked) => `
      <div class="switch-row" onclick="var c=this.querySelector('input');if(event.target!==c)c.checked=!c.checked;">
        <input type="checkbox" id="${id}" name="${id}" ${checked ? "checked" : ""}>
        <label for="${id}">${label}<span class="hint">${hint}</span></label>
      </div>`;
  let otaCard;
  if (!hasGithubToken) {
    otaCard = `<div class="banner warn"><span class="bi">📦</span><div>尚未設定 <code>GITHUB_TOKEN</code>。到 Cloudflare → 此 Worker → Settings → Variables and Secrets 新增 Secret <code>GITHUB_TOKEN</code>（GitHub Fine-grained token，只給 weid4t-app 的 Contents: Read-only），盒子才會自動收到新版。</div></div>`;
  } else if (!ota) {
    otaCard = `<div class="banner warn"><span class="bi">📦</span><div>已設定 token 但目前查不到 Release（權限不足或尚無 Release）。</div></div>`;
  } else {
    otaCard = `<div class="kv">
        <div class="item"><div class="k">最新版本</div><div class="v">${esc(ota.name)}（版本碼 ${esc(ota.version)}）</div></div>
        <div class="item"><div class="k">APK 大小</div><div class="v">${(ota.size / 1024 / 1024).toFixed(1)} MB</div></div>
        <div class="item"><div class="k">發佈時間</div><div class="v">${ota.publishedAt ? esc(formatTaipeiFull(ota.publishedAt)) : "-"}</div></div>
        <div class="item"><div class="k">快取時間</div><div class="v">${esc(relativeTime(new Date(ota.fetchedAt).toISOString()))}（15 分鐘）</div></div>
        <div class="item full"><div class="k">更新說明</div><div class="v" style="font-weight:500;font-size:13.5px;white-space:pre-wrap">${esc((ota.notes || "").slice(0, 600)) || "（無）"}</div></div>
      </div>`;
  }
  const histList = Array.isArray(hist) ? hist : [];
  const histRows = histList.length
    ? histList.map((h, i) => {
        const next = i === 0 ? config : histList[i - 1];   // 這份被「下一份」取代時改了什麼
        const changed = diffConfigKeys(h, next).map(configLabel);
        return `<div class="hist-row"><div class="hist-meta"><b>v${esc(h.version != null ? h.version : "?")}</b><span>${esc(formatTaipeiFull(h.updatedAt))}（${esc(relativeTime(h.updatedAt, nowMs))}）</span></div><div class="hist-diff">${changed.length ? "之後改了：" + esc(changed.join("、")) : "與後一版相同"}</div><div class="hist-src mono">${esc(h.subscriptionUrl ? maskToken(h.subscriptionUrl).slice(0, 90) + (h.subscriptionUrl.length > 90 ? "…" : "") : "（無直播源）")}${h.backupSubscriptionUrl ? "<br>備援 " + esc(maskToken(h.backupSubscriptionUrl).slice(0, 90) + (h.backupSubscriptionUrl.length > 90 ? "…" : "")) : ""}</div><form method="POST" action="/admin/system" data-confirm="把設定還原成 v${esc(h.version)} 的內容？（會另存成新版本，可再還原回來）"><input type="hidden" name="action" value="restore_config"><input type="hidden" name="idx" value="${i}"><button class="btn-mini btn-gold">↩ 還原成這版</button></form></div>`;
      }).join("")
    : `<div class="empty">尚無歷史（每次儲存設定會自動留一份，最多 12 份）</div>`;
  const auditList = Array.isArray(audit) ? audit : [];
  const auditRows = auditList.length
    ? `<div class="audit">${auditList.slice(0, 40).map((a) => `<div class="audit-row"><span class="at">${esc(formatTaipeiFull(a.at))}</span><span class="what">${esc(a.what)}</span><span class="ip mono">${esc(a.ip || "")}</span></div>`).join("")}</div>`
    : `<div class="empty">尚無操作紀錄</div>`;
  return `
    <form class="block" method="POST" action="/admin/save">
      <input type="hidden" name="_fields" value="system">
      <div class="block-head"><span class="block-title"><span class="ic">⚙️</span>系統設定</span></div>
      <label for="pollIntervalMinutes">盒子重載頻道間隔（分鐘）<span class="hint">10～1440；心跳（封鎖／傳話／指令）固定 90 秒，不受此影響</span></label>
      <input type="number" id="pollIntervalMinutes" name="pollIntervalMinutes" min="10" max="1440" value="${esc(config.pollIntervalMinutes)}">
      <label for="fontScale">全域字體大小<span class="hint">「自動」＝電視盒放大 1.4 倍、手機平板維持標準；長輩看不清楚可選「大」或「特大」。個別裝置可在「裝置」分頁覆蓋。</span></label>
      <select id="fontScale" name="fontScale" class="sel">${fsOptions}</select>
      ${sw("showClock", "播放畫面右上角顯示時鐘", "長輩常問幾點了；時間以網路校時為準，不靠盒子時鐘", config.showClock)}
      ${sw("autostart", "開機自動啟動（全域預設）", "可在「裝置」分頁個別覆蓋", config.autostart)}
      ${sw("otaEnabled", "允許盒子提示 App 更新（OTA）", "關閉後所有盒子都不會跳出「發現新版本」視窗", config.otaEnabled !== false)}
      ${sw("forceRefresh", "強制刷新旗標", "盒子每次輪詢立即重載清單；平常請關閉", config.forceRefresh)}
      <button type="submit" class="btn btn-primary">💾 儲存系統設定</button>
    </form>

    <div class="block">
      <div class="block-head"><span class="block-title"><span class="ic">📦</span>App 版本（OTA）</span></div>
      ${otaCard}
      ${hasGithubToken ? `<form method="POST" action="/admin/system" style="margin-top:10px"><input type="hidden" name="action" value="ota_refresh"><button class="btn btn-secondary">🔄 重新讀取最新 Release</button></form>` : ""}
    </div>

    <div class="block">
      <div class="block-head"><span class="block-title"><span class="ic">🕘</span>設定版本歷史</span><span class="count-pill">目前 v${esc(config.version)} · 歷史 ${histList.length} 份</span></div>
      <div class="block-sub">改錯直播源、誤刪公告都能一鍵退回。還原會另存成新版本（不會覆蓋歷史），盒子下次輪詢套用。</div>
      <div class="hist-list">${histRows}</div>
    </div>

    <div class="block">
      <div class="block-head"><span class="block-title"><span class="ic">💾</span>備份與搬家</span></div>
      <div class="block-sub">匯出目前設定成 JSON（含直播源、公告、授權設定、警示設定），換 Worker 或重建時匯入即可，不必重填。裝置與啟動碼另有 CSV 匯出。</div>
      <div class="btn-row">
        <a class="btn btn-secondary" href="/admin/export?what=config" style="text-decoration:none">⬇️ 匯出設定 JSON</a>
        <a class="btn btn-secondary" href="/admin/export?what=devices" style="text-decoration:none">⬇️ 裝置 CSV</a>
        <a class="btn btn-secondary" href="/admin/export?what=codes" style="text-decoration:none">⬇️ 啟動碼 CSV</a>
      </div>
      <form method="POST" action="/admin/upload" enctype="multipart/form-data" style="margin-top:12px" data-reset data-confirm="匯入會覆蓋目前設定（舊設定會留在版本歷史，可還原）。確定？">
        <input type="hidden" name="action" value="import_config">
        <label>匯入設定 JSON<span class="hint">只接受本頁匯出的檔案格式</span></label>
        <input type="file" name="file" accept="application/json,.json" class="file-input" required>
        <button type="submit" class="btn btn-secondary">⬆️ 匯入並套用</button>
      </form>
    </div>

    <div class="block">
      <div class="block-head"><span class="block-title"><span class="ic">📜</span>操作紀錄</span>
        <span class="count-pill">最近 ${Math.min(40, auditList.length)} 筆</span></div>
      <div class="block-sub">誰在什麼時候改了什麼（IP 為管理者連線位置），出問題時可以回頭對照。</div>
      ${auditRows}
      ${auditList.length ? `<form method="POST" action="/admin/system" data-confirm="清除全部操作紀錄？" style="margin-top:10px"><input type="hidden" name="action" value="clear_audit"><button class="btn-mini">清除紀錄</button></form>` : ""}
    </div>

    <div class="block">
      <div class="block-head"><span class="block-title"><span class="ic">🔗</span>端點</span></div>
      <div class="kv">
        <div class="item full"><div class="k">盒子設定端點（App 內建）</div><div class="v mono">${esc(origin)}/api/config</div></div>
        <div class="item"><div class="k">對時</div><div class="v mono">${esc(origin)}/api/time</div></div>
        <div class="item"><div class="k">健康檢查</div><div class="v mono">${esc(origin)}/api/health</div></div>
        <div class="item"><div class="k">OTA 查詢</div><div class="v mono">${esc(origin)}/api/update</div></div>
        <div class="item"><div class="k">APK 下載</div><div class="v mono">${esc(origin)}/dl/latest.apk</div></div>
        <div class="item full"><div class="k">家用備援登記（家裡電腦的代理用，POST）</div><div class="v mono">${esc(origin)}/api/home-proxy</div></div>
      </div>
      <div class="inline-note">KV 寫入節流：盒子心跳沒有變化時最多每 10 分鐘寫一次；監控每 15 分鐘寫一次歷史。免費方案每日 1000 次寫入也夠用。</div>
    </div>`;
}

/* ================================================================
 *  結果頁（無 JS 時的後備）
 * ================================================================ */

export function renderResultPage(success, message, config) {
  const accent = success ? "#2DD4BF" : "#FF5C6C";
  const html = `<!DOCTYPE html><html lang="zh-Hant"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>偉電視 · ${success ? "完成" : "操作失敗"}</title>
<style>
:root{color-scheme:dark}*{box-sizing:border-box}
body{margin:0;background:radial-gradient(1200px 600px at 50% -10%,rgba(45,212,191,.07),transparent 60%),linear-gradient(165deg,#060810,#0B1018);background-attachment:fixed;color:#EEF2F7;font-family:-apple-system,"PingFang TC","Noto Sans TC","Microsoft JhengHei",system-ui,sans-serif;padding:40px 16px;line-height:1.6}
.wrap{max-width:640px;margin:0 auto}
.card{background:linear-gradient(180deg,#121826,#0E1420 130%);border:1px solid ${accent}66;border-radius:16px;padding:22px;box-shadow:0 10px 30px -18px rgba(0,0,0,.85)}
.head{display:flex;align-items:center;gap:14px}
.icon{width:46px;height:46px;flex:none;border-radius:13px;display:flex;align-items:center;justify-content:center;font-size:24px;font-weight:800;background:${accent}29;color:${accent}}
.title{font-size:18px;font-weight:700}
.msg{margin-top:16px;padding:14px 15px;border-radius:12px;background:${accent}12;border:1px solid ${accent}66;font-size:15px}
.meta{color:#98A3B6;font-size:13px;margin-top:16px;display:flex;flex-wrap:wrap;gap:6px 18px}.meta b{color:#EEF2F7}
a.btn{display:flex;align-items:center;justify-content:center;text-decoration:none;margin-top:22px;background:linear-gradient(135deg,#2DD4BF,#0EA5A0);color:#04201E;padding:16px;border-radius:13px;font-size:16px;font-weight:700}
</style></head><body><div class="wrap"><div class="card">
<div class="head"><div class="icon">${success ? "✓" : "✕"}</div><div class="title">${success ? "完成" : "操作失敗"}</div></div>
<div class="msg">${esc(message)}</div>
<div class="meta"><span>版本 <b>v${esc(config && config.version)}</b></span><span>時間 <b>${esc(formatTaipeiFull((config && config.updatedAt) || new Date().toISOString()))}</b></span></div>
<a class="btn" href="/admin">返回管理中心</a>
</div></div></body></html>`;
  return new Response(html, {
    status: success ? 200 : 400,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

export function renderCodesResultPage(codes, days, note) {
  const list = Array.isArray(codes) ? codes : [];
  const term = days > 0 ? days + " 天" : "永久";
  const rows = list.map((c) => `<div class="cg-row">${esc(c)}</div>`).join("");
  const html = `<!DOCTYPE html><html lang="zh-Hant"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>偉電視 · 啟動碼已產生</title>
<style>
:root{color-scheme:dark}*{box-sizing:border-box}
body{margin:0;background:linear-gradient(165deg,#060810,#0B1018);color:#EEF2F7;font-family:-apple-system,"PingFang TC","Noto Sans TC","Microsoft JhengHei",system-ui,sans-serif;padding:40px 16px;line-height:1.6}
.wrap{max-width:640px;margin:0 auto}
.card{background:linear-gradient(180deg,#121826,#0E1420 130%);border:1px solid rgba(45,212,191,.4);border-radius:16px;padding:22px}
.title{font-size:18px;font-weight:700}.meta{color:#98A3B6;font-size:13px;margin-top:10px}.meta b{color:#EEF2F7}
.code-box{margin-top:16px;max-height:340px;overflow:auto;border:1px solid #232C3D;border-radius:12px;background:#0B1018;padding:6px}
.cg-row{padding:9px 12px;border-bottom:1px solid #1b2231;font-size:20px;letter-spacing:2.5px;font-family:ui-monospace,Menlo,monospace;color:#2DD4BF;font-weight:700}.cg-row:last-child{border-bottom:0}
.btn{display:flex;align-items:center;justify-content:center;text-decoration:none;margin-top:16px;background:linear-gradient(135deg,#2DD4BF,#0EA5A0);color:#04201E;padding:15px;border-radius:13px;font-size:16px;font-weight:700;border:none;width:100%;cursor:pointer;font-family:inherit}
.btn2{background:transparent;color:#EEF2F7;border:1px solid #232C3D}
</style></head><body><div class="wrap"><div class="card">
<div class="title">已產生 ${list.length} 組啟動碼</div>
<div class="meta">有效期 <b>${term}</b>${note ? ` · 備註 <b>${esc(note)}</b>` : ""}</div>
<div class="code-box">${rows || '<div class="cg-row">（沒有產生，請重試）</div>'}</div>
<button class="btn" onclick="var t=document.getElementById('all');t.focus();t.select();try{document.execCommand('copy');alert('已複製');}catch(e){alert('複製失敗，請手動選取');}">📋 複製全部</button>
<a class="btn btn2" href="/admin">返回管理中心</a>
</div></div><textarea id="all" style="position:absolute;left:-9999px;top:0">${esc(list.join("\n"))}</textarea></body></html>`;
  return new Response(html, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

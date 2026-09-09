/**
 * 偉電視（WeiTV）控制平面 — 管理頁 HTML 產生器
 * ----------------------------------------------------------------
 * renderAdminHtml(ctx)      整頁
 * renderPartial(name, ctx)  單一區塊（前端局部刷新用）
 * ctx = { config, devices, codes, ota, origin, hasGithubToken }
 */

import {
  CMD_TYPES,
  FONT_SCALE_OPTIONS,
  escapeHtml as esc,
  effectiveFontScale,
  formatTaipeiFull,
  onlineState,
  pendingCmd,
  relativeTime,
} from "./lib.js";
import { ADMIN_CSS, ADMIN_JS } from "./ui_assets.js";

const DAY = 86400000;

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
  const { config, devices, codes } = ctx;
  const nowMs = Date.now();
  const devList = Array.isArray(devices) ? devices : [];
  const unauth = devList.filter((d) => !devAuthed(d, nowMs)).length;
  const online = devList.filter((d) => onlineState(d, nowMs) === "online").length;
  const unusedCodes = (codes || []).filter((c) => c && c.status === "unused").length;

  const tab = (name, label, extra) =>
    `<button type="button" class="tab" data-tab="${name}" onclick="showTab('${name}')">${label}${extra || ""}</button>`;

  return `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<meta name="robots" content="noindex,nofollow">
<meta name="theme-color" content="#0B1018">
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
    ${tab("system", "⚙️ 系統")}
  </nav></div>

  <section class="panel active" data-panel="overview"><div data-part="overview">${renderOverview(ctx)}</div></section>
  <section class="panel" data-panel="devices"><div data-part="devices">${renderDevicesSection(ctx)}</div></section>
  <section class="panel" data-panel="source"><div data-part="source">${renderSourcePanel(ctx)}</div></section>
  <section class="panel" data-panel="auth"><div data-part="auth">${renderAuthSettings(ctx)}</div><div data-part="codes">${renderCodesSection(ctx)}</div></section>
  <section class="panel" data-panel="notice"><div data-part="notice">${renderNoticePanel(ctx)}</div></section>
  <section class="panel" data-panel="system"><div data-part="system">${renderSystemPanel(ctx)}</div></section>

  <div class="footnote">App 端點 <code>/api/config</code> · <code>/api/activate</code> · <code>/api/update</code> · <code>/api/time</code><br>所有操作即時生效；盒子每 90 秒心跳一次、每 ${esc(config.pollIntervalMinutes)} 分鐘重載頻道。</div>
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
    case "auth": return renderAuthSettings(ctx);
    case "notice": return renderNoticePanel(ctx);
    case "system": return renderSystemPanel(ctx);
    default: return null;
  }
}

/* ================================================================
 *  總覽
 * ================================================================ */

export function renderOverview(ctx) {
  const { config, devices, codes, ota } = ctx;
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
    .map(
      (d) => `<div class="now-row"><span class="sdot online"></span><span class="nm">${esc(d.nick || d.id)}</span><span class="ch">${esc(d.now)}</span><span class="tm">${esc(relativeTime(d.nowAt || d.lastSeen, nowMs))}</span></div>`
    )
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

  const banners = [];
  // 直播源伺服器看門狗（VPS 每 5 分鐘實測頻道解析與切片）
  const ss = ctx.sourceStatus;
  if (ss) {
    const ageMs = ss.checked_at_ms ? nowMs - ss.checked_at_ms : NaN;
    const stale = !Number.isFinite(ageMs) || ageMs > 20 * 60 * 1000;
    const when = ss.checked_at_ms ? relativeTime(new Date(ss.checked_at_ms).toISOString(), nowMs) : "-";
    const ipTxt = ss.public_ip ? `出口 IP ${esc(ss.public_ip)}` : "出口 IP 未知";
    const epgTxt = ss.epg_updated ? `節目表更新於 ${esc(String(ss.epg_updated).slice(5, 16))}` : "";
    const actTxt = ss.last_action && ss.last_action !== "none"
      ? `最近自動處置：${esc(ss.last_action)}${ss.last_action_at ? "（" + esc(relativeTime(ss.last_action_at, nowMs)) + "）" : ""}`
      : "";
    const reasonTxt = { vpn: "VPN 出口斷線", api_blocked: "4gtv 封鎖了目前出口 IP（API 400）", stale: "快取的播放網址失效", upstream: "上游 4gtv 不通" }[ss.reason] || "上游 4gtv 不通";
    if (stale) {
      banners.push(`<div class="banner warn"><span class="bi">⚠️</span><div>直播源伺服器的看門狗 <b>${when === "-" ? "沒有回報" : when + "後就沒再回報"}</b>，VPS 可能離線或排程停了。</div></div>`);
    } else if (ss.healthy) {
      banners.push(`<div class="banner off"><span class="bi">🟢</span><div>直播源伺服器 <b>正常</b>（實測熱門台切片與冷門台 API 解析，${when}）。${ipTxt}。${epgTxt}${actTxt ? " " + actTxt : ""}</div></div>`);
    } else {
      banners.push(`<div class="banner warn"><span class="bi">🔴</span><div>直播源伺服器 <b>異常</b>：連續 <b>${esc(ss.consecutive_failures)}</b> 次實測失敗（${esc(reasonTxt)}，${when}，${ipTxt}）。看門狗會自動清快取、重啟與更換出口節點${actTxt ? "；" + actTxt : ""}。若 30 分鐘內未恢復請通知維護人員。</div></div>`);
    }
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
    <div class="block">
      <div class="block-head"><span class="block-title"><span class="ic">📊</span>營運概覽</span><span class="count-pill">更新於 ${esc(formatTaipeiFull(new Date().toISOString()))}</span></div>
      <div class="stat-grid">
        <div class="stat-box"><div class="sb-num">${stat.total}</div><div class="sb-label">總裝置</div></div>
        <div class="stat-box"><div class="sb-num ok">${stat.online}</div><div class="sb-label">線上</div></div>
        <div class="stat-box"><div class="sb-num accent">${stat.today}</div><div class="sb-label">今日上線</div></div>
        <div class="stat-box"><div class="sb-num ${config.requireActivation ? "ok" : "mute"}">${stat.authed}</div><div class="sb-label">已授權</div></div>
        <div class="stat-box"><div class="sb-num ${stat.unauth > 0 && config.requireActivation ? "warn" : "mute"}">${stat.unauth}</div><div class="sb-label">未授權</div></div>
        <div class="stat-box"><div class="sb-num mute">${unusedCodes}</div><div class="sb-label">未用碼</div></div>
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
        <div class="item full"><div class="k">最後更新</div><div class="v mono">${esc(formatTaipeiFull(config.updatedAt))}</div></div>
        <div class="item full"><div class="k">目前訂閱網址</div><div class="v mono">${config.subscriptionUrl ? esc(config.subscriptionUrl) : "（尚未設定）"}</div></div>
      </div>
      <div class="inline-note">啟動碼：未用 ${unusedCodes} · 已用 ${usedCodes} · 共 ${codeList.length}${stat.blocked ? ` ｜ 已封鎖裝置 ${stat.blocked} 台` : ""}</div>
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
      <label for="subscriptionUrl">訂閱網址<span class="hint">例如 http://你的IP:5050/channel?type=m3u&amp;token=…（HTTP 端口對老盒子最穩）</span></label>
      <textarea id="subscriptionUrl" name="subscriptionUrl" spellcheck="false">${esc(config.subscriptionUrl)}</textarea>
      <div class="btn-row">
        <button type="button" class="btn btn-secondary" onclick="testSource()">🔍 測試來源</button>
        <button type="submit" class="btn btn-primary">💾 儲存直播源</button>
      </div>
      <div id="testResult"></div>
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
  const body = list.length
    ? list.map((d) => renderDeviceCard(d, config, latestVer, nowMs)).join("")
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
      </div>
      <div class="bulk-row">
        <span class="bulk-label">全部裝置</span>
        <form class="row-form" method="POST" action="/admin/device" data-confirm="確定送出給所有裝置？">
          <input type="hidden" name="action" value="cmd_all">
          <select name="value" class="mini-select">${cmdOpts}</select>
          <button class="btn-mini btn-info">送出指令</button>
        </form>
        <form class="row-form" method="POST" action="/admin/device"><input type="hidden" name="action" value="autostart_all"><input type="hidden" name="value" value="on"><button class="btn-mini">自啟全開</button></form>
        <form class="row-form" method="POST" action="/admin/device"><input type="hidden" name="action" value="autostart_all"><input type="hidden" name="value" value="off"><button class="btn-mini">自啟全關</button></form>
        <a class="btn-mini" href="/admin/export?what=devices" style="text-decoration:none">⬇️ CSV</a>
        ${stale ? `<form class="row-form" method="POST" action="/admin/device" data-confirm="刪除 ${stale} 台超過 30 天未上線的裝置紀錄？"><input type="hidden" name="action" value="delete_stale"><button class="btn-mini btn-danger">清 30 天未上線（${stale}）</button></form>` : ""}
      </div>
      <div class="dev-list" id="devList">${body}</div>
      <div class="empty" id="devEmpty" style="display:none;margin-top:10px">沒有符合條件的裝置</div>
    </div>`;
}

export function renderDeviceCard(d, config, latestVer, nowMs) {
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
  const stateText = state === "online" ? "線上" : state === "today" ? "今日曾上線" : "離線";

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

  const badges =
    (config.requireActivation
      ? authActive ? `<span class="badge ok-b">已授權</span>` : dExpired ? `<span class="badge warn-b">已到期</span>` : `<span class="badge danger-b">未授權</span>`
      : authActive ? `<span class="badge mute-b">已授權</span>` : "") +
    (blocked ? `<span class="badge danger-b">已封鎖</span>` : "") +
    (isOld ? `<span class="badge warn-b" title="最新 v${latestVer}">舊版</span>` : "");

  let srcFact;
  if (d && d.lastResultAt) srcFact = d.lastOk ? ["來源", "✓ " + (d.lastCount != null ? d.lastCount : 0) + " 台 · " + relativeTime(d.lastResultAt, nowMs), "ok"] : ["來源", "✕ 載入失敗 · " + relativeTime(d.lastResultAt, nowMs), "bad"];
  else srcFact = ["來源", "未回報", "mute"];

  const facts = [
    ["授權", authText, authActive ? "ok" : dExpired || (config.requireActivation && !authed) ? "bad" : "mute"],
    srcFact,
    ["最後上線", (relativeTime(d && d.lastSeen, nowMs) || "-") + "（" + stateText + "）", state === "online" ? "ok" : "mute"],
    ["版本", ver ? ver + (isOld ? " ↑可更新" : "") : "-", isOld ? "warn" : "mute"],
    ["機型", model || "-", "mute"],
    ["字體", fontShort(fsEff) + (fsOverride ? "（單機）" : "（全域）") + (d && d.fs && d.fs !== fsEff ? " · 盒子 " + fontShort(d.fs) : ""), "mute"],
    ["開機自啟", autostartText, "mute"],
    ["IP", d && d.ip ? d.ip : "-", "mute"],
    ["首次上線", d && d.firstSeen ? formatTaipeiFull(d.firstSeen) : "-", "mute"],
    ["回報次數", (d && d.count != null ? d.count : 0) + " 次", "mute"],
  ];
  const factsHtml = facts.map((f) => `<div class="fact"><span class="fk">${f[0]}</span><span class="fv ${f[2]}">${esc(f[1])}</span></div>`).join("");

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
  const primary = `
      <form class="row-form" method="POST" action="/admin/device">
        <input type="hidden" name="id" value="${idAttr}"><input type="hidden" name="action" value="authorize">
        <input type="number" name="value" class="mini-input mini-days" placeholder="天" value="0" min="0" title="0＝永久">
        <button class="btn-mini btn-ok">授權</button>
      </form>
      ${authed ? devForm(idAttr, "deauthorize", "撤銷授權", "danger", `確定撤銷 ${esc(title)} 的授權？`) : ""}
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
      </div>
      <div class="sect">名稱與紀錄</div>
      <form class="row-form wide" method="POST" action="/admin/device">
        <input type="hidden" name="id" value="${idAttr}"><input type="hidden" name="action" value="rename">
        <input type="text" name="value" class="mini-input grow" maxlength="40" placeholder="裝置暱稱，例如：客廳 / 阿嬤房" value="${esc(nick)}">
        <button class="btn-mini">改暱稱</button>
      </form>
      ${devForm(idAttr, "delete", "🗑️ 刪除裝置紀錄", "danger", `確定刪除 ${esc(title)} 的紀錄？（盒子下次上線會重新登記，授權會消失）`)}`;

  const searchKey = (id + " " + nick + " " + model + " " + (d && d.now ? d.now : "")).toLowerCase().replace(/"/g, "");
  return `<div class="dev-card${blocked ? " is-blocked" : ""}" data-search="${esc(searchKey)}" data-online="${state === "online" ? 1 : 0}" data-authed="${authActive ? 1 : 0}" data-blocked="${blocked ? 1 : 0}" data-oldver="${isOld ? 1 : 0}">
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
      <label for="marqueeMinutes">顯示分鐘數<span class="hint">時間到自動消失；填 0 或清空文字＝停止</span></label>
      <input type="number" id="marqueeMinutes" name="marqueeMinutes" min="0" value="${marqueeActive ? 30 : 30}" placeholder="例如 30">
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
      <label for="noticeHours">自動撤下時數<span class="hint">0＝常駐；例如 24＝一天後自動撤下</span></label>
      <input type="number" id="noticeHours" name="noticeHours" min="0" step="0.5" value="0" placeholder="0">
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
  const { config, ota, hasGithubToken, origin } = ctx;
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
      <div class="block-head"><span class="block-title"><span class="ic">🔗</span>端點</span></div>
      <div class="kv">
        <div class="item full"><div class="k">盒子設定端點（App 內建）</div><div class="v mono">${esc(origin)}/api/config</div></div>
        <div class="item"><div class="k">對時</div><div class="v mono">${esc(origin)}/api/time</div></div>
        <div class="item"><div class="k">健康檢查</div><div class="v mono">${esc(origin)}/api/health</div></div>
        <div class="item"><div class="k">OTA 查詢</div><div class="v mono">${esc(origin)}/api/update</div></div>
        <div class="item"><div class="k">APK 下載</div><div class="v mono">${esc(origin)}/dl/latest.apk</div></div>
      </div>
      <div class="inline-note">KV 寫入節流：盒子心跳沒有變化時最多每 10 分鐘寫一次，免費方案每日 1000 次寫入也夠用。</div>
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

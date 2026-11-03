/**
 * 偉電視（WeiTV）直播源同步控制平面 — Cloudflare Worker 進入點
 * ----------------------------------------------------------------
 * 用途：
 *   1. 安卓電視盒 App 開機／定時輪詢的設定端點（GET /api/config），
 *      同時登記裝置、接收回報、下發遠端指令（重載 / 切台 / 重啟）。
 *   2. 管理員用手機瀏覽器登入的管理頁（GET /admin）：換直播源、公告、跑馬燈、
 *      啟動碼授權、裝置管理、字體大小、OTA。
 *   3. OTA：代理私有 GitHub Release 的 APK 給盒子。
 *   4. 家用備援：家裡電腦的代理自動登記（POST /api/home-proxy），只下發給同一個家的盒子。
 *
 * 設計重點：
 *   - 零依賴，只用 Workers 內建 Web API；程式拆成 lib / api / admin / ui 四個模組。
 *   - 設定與裝置都存 KV（binding：CONFIG_KV）；心跳寫入有節流，適合免費方案。
 *   - 管理頁 Basic Auth（env.ADMIN_PASSWORD）＋同源 CSRF 檢查；啟動碼有 IP 限速。
 *   - 影片串流不經過本 Worker（盒子直連源站），流量極小。
 */

import { CORS_HEADERS, QR_ASSET_KEY, htmlResponse, jsonResponse, textResponse, wantsJson } from "./lib.js";
import {
  handleActivate,
  handleDownloadApk,
  handleGetConfig,
  handleHealth,
  handleHomeProxy,
  handleTime,
  handleUpdateInfo,
} from "./api.js";
import {
  handleAdminAlerts,
  handleAdminCodes,
  handleAdminDevice,
  handleAdminExport,
  handleAdminPage,
  handleAdminPartial,
  handleAdminSave,
  handleAdminSystem,
  handleAdminTest,
  handleAdminUpload,
} from "./admin.js";
import { runMonitorTick } from "./monitor.js";

export default {
  /** Cron Trigger（wrangler.toml 每 5 分鐘）：監控直播源與盒子、必要時發 Telegram 警示 */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      runMonitorTick(env).catch((err) => console.error("監控執行失敗:", err && err.stack ? err.stack : err))
    );
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;
    // HEAD 視同 GET（監控 / 下載工具會先 HEAD 探測）；Workers 回應 HEAD 時會自動丟掉 body
    const method = request.method === "HEAD" ? "GET" : request.method;

    try {
      if (method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      }

      // ── App 端 ──
      if (pathname === "/api/config" && method === "GET") return await handleGetConfig(request, env, ctx);
      if (pathname === "/api/activate" && method === "GET") return await handleActivate(request, env);
      if (pathname === "/api/update" && method === "GET") return await handleUpdateInfo(request, env);
      if (pathname === "/api/time" && method === "GET") return handleTime();
      if (pathname === "/api/health" && method === "GET") return await handleHealth(env);
      if (pathname === "/api/home-proxy" && method === "POST") return await handleHomeProxy(request, env);
      if (pathname === "/dl/latest.apk" && method === "GET") return await handleDownloadApk(request, env);
      if (pathname === "/asset/qr" && method === "GET") return await handleAssetQr(env);
      if (pathname === "/manifest.webmanifest" && method === "GET") return manifestResponse(url.origin);
      if (pathname === "/asset/icon.svg" && method === "GET") return iconResponse();

      // ── 管理頁 ──
      if (pathname === "/admin" && method === "GET") return await handleAdminPage(request, env);
      if (pathname === "/admin/partial" && method === "GET") return await handleAdminPartial(request, env);
      if (pathname === "/admin/export" && method === "GET") return await handleAdminExport(request, env);
      if (pathname === "/admin/save" && method === "POST") return await handleAdminSave(request, env);
      if (pathname === "/admin/test" && method === "POST") return await handleAdminTest(request, env);
      if (pathname === "/admin/device" && method === "POST") return await handleAdminDevice(request, env);
      if (pathname === "/admin/codes" && method === "POST") return await handleAdminCodes(request, env);
      if (pathname === "/admin/upload" && method === "POST") return await handleAdminUpload(request, env);
      if (pathname === "/admin/system" && method === "POST") return await handleAdminSystem(request, env);
      if (pathname === "/admin/alerts" && method === "POST") return await handleAdminAlerts(request, env);

      if (pathname === "/" && method === "GET") return htmlResponse(landingHtml(), 200);
      if (pathname === "/robots.txt") return textResponse("User-agent: *\nDisallow: /\n", 200);

      return textResponse("Not Found", 404);
    } catch (err) {
      console.error("Unhandled error:", err && err.stack ? err.stack : err);
      const reqId = (request.headers.get("cf-ray") || "").split("-")[0] || "";
      // API 與管理頁的 fetch 呼叫都期待 JSON，不要回純文字讓前端 r.json() 炸掉
      if (pathname.startsWith("/api/") || wantsJson(request)) {
        return jsonResponse({ ok: false, error: "伺服器內部錯誤，請稍後再試", reqId }, 500);
      }
      return textResponse("Internal Server Error" + (reqId ? " (" + reqId + ")" : ""), 500);
    }
  },
};

/** PWA 資訊檔：手機「加到主畫面」後像 App 一樣開 */
function manifestResponse(origin) {
  const m = {
    name: "偉電視管理中心",
    short_name: "偉電視",
    start_url: "/admin",
    scope: "/",
    display: "standalone",
    background_color: "#0B1018",
    theme_color: "#0B1018",
    icons: [{ src: origin + "/asset/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }],
  };
  return new Response(JSON.stringify(m), {
    status: 200,
    headers: { "Content-Type": "application/manifest+json; charset=utf-8", "Cache-Control": "public, max-age=86400" },
  });
}

function iconResponse() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2DD4BF"/><stop offset="1" stop-color="#0EA5A0"/></linearGradient></defs><rect width="128" height="128" rx="30" fill="#0B1018"/><rect x="14" y="14" width="100" height="100" rx="24" fill="url(#g)"/><text x="64" y="86" font-size="62" font-weight="900" text-anchor="middle" font-family="PingFang TC, Noto Sans TC, sans-serif" fill="#052A26">偉</text></svg>`;
  return new Response(svg, {
    status: 200,
    headers: { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=604800", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox" },
  });
}

/** GET /asset/qr — 公開回傳聯絡 QR 圖（從 KV）；沒有則 404 */
async function handleAssetQr(env) {
  let value = null;
  let metadata = null;
  try {
    const r = await env.CONFIG_KV.getWithMetadata(QR_ASSET_KEY, { type: "arrayBuffer" });
    value = r.value;
    metadata = r.metadata;
  } catch (_) {
    value = null;
  }
  if (!value) return textResponse("Not Found", 404);
  return new Response(value, {
    status: 200,
    headers: {
      "Content-Type": (metadata && metadata.ct) || "image/png",
      "Cache-Control": "public, max-age=86400",
      "X-Content-Type-Options": "nosniff",
      // 就算有人上傳了帶 script 的圖,也不准在本站網域執行
      "Content-Security-Policy": "default-src 'none'; sandbox",
      ...CORS_HEADERS,
    },
  });
}

function landingHtml() {
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>偉電視 · 控制平面</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:linear-gradient(170deg,#0B1018,#060810);color:#EEF2F7;font-family:-apple-system,"PingFang TC","Noto Sans TC","Microsoft JhengHei",system-ui,sans-serif}
.c{text-align:center;padding:32px}.l{width:56px;height:56px;border-radius:18px;margin:0 auto 14px;background:linear-gradient(135deg,#2DD4BF,#0EA5A0);display:flex;align-items:center;justify-content:center;font-weight:900;font-size:26px;color:#052A26}
h1{font-size:20px;margin:0 0 6px}p{color:#98A3B6;font-size:14px;margin:0 0 18px}a{display:inline-block;padding:12px 22px;border-radius:12px;background:#2DD4BF;color:#04201E;font-weight:700;text-decoration:none}</style></head>
<body><div class="c"><div class="l">偉</div><h1>偉電視控制平面運作中</h1><p>盒子設定端點 /api/config</p><a href="/admin">進入管理中心</a></div></body></html>`;
}

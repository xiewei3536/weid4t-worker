/**
 * 偉電視（WeiTV）直播源同步控制平面 — Cloudflare Worker 進入點
 * ----------------------------------------------------------------
 * 用途：
 *   1. 安卓電視盒 App 開機／定時輪詢的設定端點（GET /api/config），
 *      同時登記裝置、接收回報、下發遠端指令（重載 / 切台 / 重啟）。
 *   2. 管理員用手機瀏覽器登入的管理頁（GET /admin）：換直播源、公告、跑馬燈、
 *      啟動碼授權、裝置管理、字體大小、OTA。
 *   3. OTA：代理私有 GitHub Release 的 APK 給盒子。
 *
 * 設計重點：
 *   - 零依賴，只用 Workers 內建 Web API；程式拆成 lib / api / admin / ui 四個模組。
 *   - 設定與裝置都存 KV（binding：CONFIG_KV）；心跳寫入有節流，適合免費方案。
 *   - 管理頁 Basic Auth（env.ADMIN_PASSWORD）＋同源 CSRF 檢查；啟動碼有 IP 限速。
 *   - 影片串流不經過本 Worker（盒子直連源站），流量極小。
 */

import { CORS_HEADERS, QR_ASSET_KEY, htmlResponse, textResponse } from "./lib.js";
import {
  handleActivate,
  handleDownloadApk,
  handleGetConfig,
  handleHealth,
  handleTime,
  handleUpdateInfo,
} from "./api.js";
import {
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

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;

    try {
      if (method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      }

      // ── App 端 ──
      if (pathname === "/api/config" && method === "GET") return await handleGetConfig(request, env);
      if (pathname === "/api/activate" && method === "GET") return await handleActivate(request, env);
      if (pathname === "/api/update" && method === "GET") return await handleUpdateInfo(request, env);
      if (pathname === "/api/time" && method === "GET") return handleTime();
      if (pathname === "/api/health" && method === "GET") return await handleHealth(env);
      if (pathname === "/dl/latest.apk" && method === "GET") return await handleDownloadApk(request, env);
      if (pathname === "/asset/qr" && method === "GET") return await handleAssetQr(env);

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

      if (pathname === "/" && method === "GET") return htmlResponse(landingHtml(), 200);
      if (pathname === "/robots.txt") return textResponse("User-agent: *\nDisallow: /\n", 200);

      return textResponse("Not Found", 404);
    } catch (err) {
      console.error("Unhandled error:", err && err.stack ? err.stack : err);
      return textResponse("Internal Server Error", 500);
    }
  },
};

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

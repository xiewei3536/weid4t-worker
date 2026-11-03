/**
 * 偉電視（WeiTV）控制平面 — 直播源「實際播放」測試（測活）
 * ----------------------------------------------------------------
 * 管理頁「測試主線路 / 測試備援」與每 5 分鐘的監控都用這裡：抓清單 → 挑一台（預設民視第一台）→ 抓它的 m3u8
 * →（多畫質就再抓子清單）→ 抓最新一片切片的前 64 KB。跟盒子播放走同一條路，通過 = 這條線現在真的播得出來，
 * 不是只有清單檔還在（清單是 nginx 的靜態檔，VPN 斷了照樣抓得到）。
 *
 * Cloudflare Worker 不能直接連 IP 位址：fetch("http://161.33.196.222:5050/…") 會被 Cloudflare 自己擋下，
 * 回 403「error code: 1003」，根本沒出門（2 ms 就回）。所以網址主機是公網 IPv4 時改連 sslip.io 的對應網域
 * （161-33-196-222.sslip.io 由 DNS 解析回同一個 IP，連線一樣直達那台主機；sslip.io 查不到再試 nip.io）。
 * 盒子拿到的網址不變。區網網址（家用代理）雲端本來就連不到，直接回 lan:true，由家用代理自己回報實測結果。
 */

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const UA = "WeiTV-Monitor/2.4 (stream-probe)";
/** 切片至少要拿到這麼多才算播得出來（真的切片約 1 MB；錯誤頁只有幾百 bytes） */
export const MIN_SEGMENT_BYTES = 16 * 1024;
const READ_BYTES = 64 * 1024;
/** 預設挑來測的台（依序找名稱含這些字的第一台；都沒有就用清單第一台） */
export const PROBE_PREFER = ["民視第一台", "民視", "中視", "台視"];

/** 私有 / 區網 / 本機位址（雲端連不到） */
export function isLanHost(host) {
  const h = String(host || "").toLowerCase();
  if (h === "localhost" || h.endsWith(".local")) return true;
  const m = IPV4_RE.exec(h);
  if (!m) return false;
  const a = +m[1];
  const b = +m[2];
  return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
    (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
}

export function isLanUrl(url) {
  try {
    return isLanHost(new URL(String(url || "").trim()).hostname);
  } catch (_) {
    return false;
  }
}

/** Worker 自己要連的網址：公網 IPv4 主機換成 sslip.io（alt = true 換 nip.io）的對應網域；其他原樣 */
export function workerFetchUrl(url, alt) {
  try {
    const u = new URL(String(url));
    const h = u.hostname;
    if (IPV4_RE.test(h) && !isLanHost(h)) {
      u.hostname = alt ? h + ".nip.io" : h.replace(/\./g, "-") + ".sslip.io";
      return u.toString();
    }
  } catch (_) {}
  return String(url);
}

/**
 * 從 Worker 連來源：IP 網址自動改網域；sslip.io 查不到（連線例外或 Cloudflare 回 530）再試 nip.io。
 * 回 fetch 的 Response（呼叫端自己讀 body）。init.signal 由呼叫端給（逾時）。
 */
export async function workerFetch(url, init) {
  const first = workerFetchUrl(url, false);
  const second = workerFetchUrl(url, true);
  const opts = { ...(init || {}), headers: { "User-Agent": UA, ...((init && init.headers) || {}) }, cf: { cacheTtl: 0 } };
  let resp;
  try {
    resp = await fetch(first, opts);
  } catch (err) {
    if (second === first || (err && err.name === "AbortError")) throw err;
    return await fetch(second, opts);
  }
  if (resp.status === 530 && second !== first) return await fetch(second, opts);
  return resp;
}

/** 逾時 ms 內抓完整段文字（清單、m3u8 都只有幾十 KB） */
export async function getText(url, ms) {
  const c = new AbortController();
  const timer = setTimeout(() => c.abort(), ms || 10000);
  const t0 = Date.now();
  try {
    const resp = await workerFetch(url, { signal: c.signal });
    const text = await resp.text();
    // url = 轉址後的實際網址：清單裡的相對網址要以它為基準（播放器也是這樣解析）
    return { status: resp.status, ok: resp.ok, text, ms: Date.now() - t0, url: resp.url || url, date: resp.headers.get("Date") || "" };
  } finally {
    clearTimeout(timer);
  }
}

/** 逾時 ms 內讀前 max bytes 就關掉（切片不必整片下載） */
async function getPrefix(url, max, ms) {
  const c = new AbortController();
  const timer = setTimeout(() => c.abort(), ms || 12000);
  const t0 = Date.now();
  try {
    const resp = await workerFetch(url, { signal: c.signal });
    let bytes = 0;
    let first = -1;
    if (resp.body) {
      const reader = resp.body.getReader();
      while (bytes < max) {
        const { done, value } = await reader.read();
        if (done) break;
        if (first < 0 && value && value.length) first = value[0];
        bytes += value ? value.length : 0;
      }
      try {
        await reader.cancel();
      } catch (_) {}
    }
    return { status: resp.status, bytes, first, ms: Date.now() - t0 };
  } finally {
    clearTimeout(timer);
  }
}

function isM3u(text) {
  return /^\s*#EXTM3U/.test(String(text || ""));
}

function uris(m3u8) {
  return String(m3u8 || "").split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith("#"));
}

function errText(err) {
  if (err && err.name === "AbortError") return "逾時";
  return "連線失敗" + (err && err.message ? "：" + String(err.message).slice(0, 80) : "");
}

/** 從 m3u 清單挑一台來測：名稱依序含 prefer 的第一台，都沒有就第一台。回 { name, url, total } 或 null */
export function pickProbeChannel(text, baseUrl, prefer) {
  const list = [];
  let name = null;
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#EXTINF")) {
      const i = line.lastIndexOf(",");
      name = i >= 0 ? line.slice(i + 1).trim() : "";
      continue;
    }
    if (line.startsWith("#")) continue;
    if (name !== null) {
      list.push({ name, url: line });
      name = null;
    }
  }
  if (!list.length) return null;
  let pick = null;
  for (const w of prefer && prefer.length ? prefer : PROBE_PREFER) {
    pick = list.find((c) => c.name.includes(w));
    if (pick) break;
  }
  pick = pick || list[0];
  let url = pick.url;
  try {
    url = new URL(pick.url, baseUrl).toString();
  } catch (_) {}
  return { name: pick.name, url, total: list.length };
}

/**
 * 實測一台頻道：m3u8（多畫質再抓第一個子清單）→ 最新一片切片前 64 KB。
 * 回 { ok, step, error, m3u8Ms, segMs, bytes, ts }（step：失敗在哪一步 m3u8 / segment；ts：切片開頭是 MPEG-TS 同步碼）
 */
export async function probeStream(url) {
  const res = { ok: false, step: "m3u8", error: "", m3u8Ms: 0, segMs: 0, bytes: 0, ts: false };
  try {
    let r = await getText(url, 10000);
    let pl = r.url;
    res.m3u8Ms = r.ms;
    if (!r.ok) return { ...res, error: `頻道播放清單回 HTTP ${r.status}` };
    if (!isM3u(r.text)) return { ...res, error: "頻道網址回的不是播放清單（m3u8）" };
    if (/#EXT-X-STREAM-INF/i.test(r.text)) {
      const sub = uris(r.text)[0];
      if (!sub) return { ...res, error: "多畫質清單裡沒有子清單" };
      r = await getText(new URL(sub, pl).toString(), 10000);
      pl = r.url;
      res.m3u8Ms += r.ms;
      if (!r.ok || !isM3u(r.text)) return { ...res, error: `子清單回 HTTP ${r.status}` };
    }
    const segs = uris(r.text);
    if (!segs.length) return { ...res, error: "播放清單裡沒有切片" };
    res.step = "segment";
    const s = await getPrefix(new URL(segs[segs.length - 1], pl).toString(), READ_BYTES, 12000);
    res.segMs = s.ms;
    res.bytes = s.bytes;
    res.ts = s.first === 0x47;
    if (s.status !== 200 && s.status !== 206) return { ...res, error: `切片回 HTTP ${s.status}` };
    if (s.bytes < MIN_SEGMENT_BYTES) return { ...res, error: `切片只拿到 ${s.bytes} bytes` };
    return { ...res, ok: true };
  } catch (err) {
    return { ...res, error: (res.step === "segment" ? "切片" : "播放清單") + errText(err) };
  }
}

/**
 * 實測一條線路（訂閱網址）：清單 → 挑台 → probeStream。
 * 回 { at, ok, lan, playlist: {status, ms, channels} | null, channel, stream, error }
 */
export async function probeLine(subscriptionUrl, nowMs) {
  const url = String(subscriptionUrl || "").trim();
  const out = { at: nowMs || Date.now(), ok: false, lan: false, playlist: null, channel: "", stream: null, error: "" };
  if (!url) return { ...out, error: "沒有網址" };
  if (isLanUrl(url)) return { ...out, lan: true, error: "區網網址，雲端連不到" };
  let p;
  try {
    p = await getText(url, 10000);
  } catch (err) {
    return { ...out, error: "頻道清單" + errText(err) };
  }
  const channels = (p.text.match(/#EXTINF/gi) || []).length;
  out.playlist = { status: p.status, ms: p.ms, channels };
  if (!p.ok) return { ...out, error: `頻道清單回 HTTP ${p.status}` };
  if (!isM3u(p.text) || !channels) return { ...out, error: "頻道清單不是 m3u 或沒有頻道" };
  const ch = pickProbeChannel(p.text, url);
  if (!ch) return { ...out, error: "頻道清單裡沒有可測的頻道" };
  out.channel = ch.name;
  out.stream = await probeStream(ch.url);
  out.ok = out.stream.ok;
  if (!out.ok) out.error = `${ch.name}：${out.stream.error}`;
  return out;
}

/** 存進監控狀態 / 顯示用的精簡版（不含網址與 token） */
export function probeSummary(p) {
  if (!p) return null;
  return {
    at: p.at,
    ok: !!p.ok,
    lan: !!p.lan,
    channel: String(p.channel || "").slice(0, 40),
    error: String(p.error || "").slice(0, 160),
    listMs: p.playlist ? p.playlist.ms : 0,
    m3u8Ms: p.stream ? p.stream.m3u8Ms : 0,
    segMs: p.stream ? p.stream.segMs : 0,
    bytes: p.stream ? p.stream.bytes : 0,
  };
}

/** 實測結果的一句話（「民視第一台 播放正常（清單 0.8 秒、切片 1.1 秒）」/「失敗：…」） */
export function probeText(s) {
  if (!s) return "";
  if (s.lan) return "區網網址，雲端連不到（看家用代理自己的實測）";
  const sec = (ms) => (ms / 1000).toFixed(1) + " 秒";
  if (s.ok) return `${s.channel || "測試台"} 播放正常（播放清單 ${sec(s.m3u8Ms || 0)}、切片 ${sec(s.segMs || 0)}）`;
  return `播不出來：${s.error || "原因不明"}`;
}

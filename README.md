# 偉電視 · 控制中心(Cloudflare Worker)

直播源的**遠端管理中心**。部署後用手機瀏覽器開 `/admin` 登入,就能遠端換 token、發公告,所有電視盒下次輪詢自動同步——不必再碰盒子。

影片不經過這裡(盒子直連),這個 Worker 只同步「設定」,流量極小,**免費額度綽綽有餘**。

---

## 🚀 一鍵部署(推薦,全程點按)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/xiewei3536/weid4t-worker)

點上面的按鈕,Cloudflare 會帶你走完全部:

1. 登入 / 連結你的 **GitHub**(會把這個 repo 複製到你帳號)
2. **自動建立 KV 資料庫**(存設定用,免手動)
3. **跳出來請你輸入管理密碼**(`ADMIN_PASSWORD`)— 設一個只有你知道的
4. 自動部署,給你一個網址:`https://weitv-control.<你的子網域>.workers.dev`

> 之後你只要 push 到複製出來的 repo,Cloudflare 會**自動重新部署**(Workers Builds)。

### 部署完成後做兩件事
- **App 端**:電視盒「偉電視 → 設定 → 遠端管理」填入 `https://<你的網址>/api/config`
- **管理端**:手機瀏覽器開 `https://<你的網址>/admin`(帳號隨意、密碼 = 你剛設的)

---

## 🔑 設定 / 修改管理密碼(ADMIN_PASSWORD)

一鍵部署時若沒跳出輸入框、或之後想改密碼,到 Cloudflare 後台設定(**這是用後台,不是 CLI**):

1. Cloudflare 後台 → **Workers & Pages** → 點開 `weid4t-worker`
2. 上方 **Settings** → **Variables and Secrets**(變數與密鑰)
3. **+ Add** → Type 選 **Secret**(加密)→ Name 填 `ADMIN_PASSWORD`、Value 填你的密碼 → **Deploy**

設好後重新整理 `/admin` 就能登入(帳號隨意、密碼 = 你設的)。
> 還沒設密碼時開 `/admin`,頁面會**直接畫出上面這幾步**,照著做即可。

---

## 🔁 日常維護:換 token

手機開 `/admin` → 把新的 m3u8 直播源網址貼進「訂閱網址」→ 按「儲存」。完成。
(可先按「測試來源」確認新網址解析得到頻道,再儲存。)

---

## 🛠 手動部署(CLI,進階)

需要 Node.js。在本資料夾底下:

```bash
npm install
npx wrangler login
npx wrangler kv namespace create CONFIG_KV   # 把印出的 id 貼進 wrangler.toml 的 id 欄
npx wrangler secret put ADMIN_PASSWORD        # 設管理密碼
npm run deploy
```

---

## 📡 API / 路由

| 路由 | 說明 |
|---|---|
| `GET /api/config` | 電視盒讀取目前設定(JSON) |
| `GET /admin` | 管理頁(Basic Auth,密碼 = `ADMIN_PASSWORD`) |
| `POST /admin/save` | 儲存設定(version +1) |
| `POST /admin/test` | 測試來源網址有效性 |

## 📁 檔案

- `src/index.js` — Worker 主程式(原生 fetch,零依賴)
- `wrangler.toml` — 設定(KV 綁定;一鍵部署會自動填 id)
- `.dev.vars.example` — 一鍵部署時會提示輸入的 secret(管理密碼)
- `package.json` — `deploy` / `dev` / `tail` 指令

> 本範本**不含任何 token**,可安全公開。直播源網址在部署後才由你在 `/admin` 設定。

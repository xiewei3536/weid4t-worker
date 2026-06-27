# 偉電視 · 控制中心(Cloudflare Worker)

電視盒的**遠端管理中心**。手機瀏覽器開 `/admin` 登入,就能:換直播源 token、發公告、**啟動碼授權與防盜用**、封鎖/傳話、看裝置上線狀況、推 OTA 更新——全部不必碰盒子。

影片不經過這裡(盒子直連源站),Worker 只同步「設定」與「授權」,流量極小,**免費額度綽綽有餘**。

---

## 🚀 一鍵部署(推薦,全程點按)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/xiewei3536/weid4t-worker)

點按鈕,Cloudflare 會帶你走完：

1. 登入 / 連結你的 **GitHub**(把這個 repo 複製到你帳號)
2. **自動建立 KV 資料庫**(存設定/裝置/啟動碼,免手動)
3. **跳出來請你輸入管理密碼**(`ADMIN_PASSWORD`)
4. 自動部署,給你一個網址：`https://weid4t-worker.<你的子網域>.workers.dev`

部署完成後做兩件事：
- **App 端**：電視盒已內建管理中心網址(`/api/config`),通常免設定。
- **管理端**：手機瀏覽器開 `https://<你的網址>/admin`(帳號隨意、密碼 = 你剛設的)。

---

## 🔑 設定 / 修改管理密碼(ADMIN_PASSWORD)

一鍵部署若沒跳出輸入框、或想改密碼，用 **Cloudflare 後台**(不是 CLI)：

1. Cloudflare 後台 → **Workers & Pages** → 點開 `weid4t-worker`
2. 上方 **Settings** → **Variables and Secrets**(變數與密鑰)
3. **+ Add** → Type 選 **Secret** → Name 填 `ADMIN_PASSWORD`、Value 填密碼 → **Deploy**

> 還沒設密碼時開 `/admin`，頁面會**直接畫出上面這幾步**，照著做即可。

---

## 🔐 啟動碼授權(防止 APK 外流盜用)

開啟後，**沒有有效啟動碼的盒子無法觀看**——拿不到直播源、開 App 只會看到「請輸入啟動碼」畫面。適合對外散布 App、做付費授權或試用期管理。

### 啟用步驟(順序很重要)

1. `/admin` → 捲到 **🎟️ 啟動碼管理** → 先按 **「🔓 一鍵授權所有現有裝置（永久）」**
   > ⚠️ **一定要先做這步**，否則開啟授權後你目前在用的盒子會被一起鎖在外面。
2. 捲到 **「編輯設定」最下方 🔐 授權與啟動畫面**：
   - 勾選 **「啟用啟動碼授權」**
   - 填 **啟動畫面標題 / 說明文字**(App 開啟與輸入碼時顯示，可放歡迎語、客服 LINE 等)
   - 設 **啟動碼位數**(預設 8 位數字，方便遙控器輸入)
   - 按 **「儲存設定」**

### 產生啟動碼

`/admin` → **🎟️ 啟動碼管理**：

- **產生數量**:要幾組就填幾(可批量，單次上限 200)
- **有效天數**:填 `0` = 永久；填 `30` = 啟用後 30 天到期(到期日從盒子「輸入碼那一刻」起算)
- **備註**:選填,例如「某經銷商」「王先生」「春節檔」
- 按 **「＋ 產生啟動碼」** → 會列出新碼,可按 **「📋 複製全部」** 一次複製,貼給客戶

### 管理 / 授權單一裝置

`/admin` → **📺 裝置管理**,每張裝置卡可：
- **授權(天,0=永久)**:在輸入框填天數 → 按「授權」,直接開通該台(不必用碼)
- **撤銷授權**:立即停用該台(它約 90 秒內、或下次開機就停播)
- 卡片會顯示該台目前 **授權狀態 + 到期日**

### 到期會怎樣

- 盒子端會**自我檢測到期**(開機檢查 + 每 90 秒心跳),到期自動跳出「授權已到期,請輸入新啟動碼續期」畫面。
- 伺服器端同步把關:到期 / 被撤銷的裝置,`/api/config` 不再下發直播源(**雙保險,改 App 也繞不過**)。
- 續期:產一組新碼給對方輸入,或在裝置卡直接「授權」設定新天數。

> 不想用授權機制?保持「啟用啟動碼授權」**不勾選**即可——所有盒子照常觀看(預設就是關的)。

---

## 🔁 日常維護:換 token

手機開 `/admin` → 把新的 m3u8 直播源網址貼進「**訂閱網址**」→ 按「**儲存**」。完成。
(可先按「測試來源」;雲端 IP 被源站擋是正常的,以盒子實測為準。)

> App **不內建任何源 token**,源一律由這裡下發 → APK 就算被複製也拿不到你的源。

---

## 📦 OTA 自動更新

盒子會自動偵測新版、下載、跳安裝。需在 Cloudflare 設一把唯讀 GitHub token：

1. GitHub 建 **Fine-grained token**:只給 `weid4t-app` 的 **Contents: Read-only**。
2. Cloudflare → `weid4t-worker` → **Settings → Variables and Secrets → + Add → Secret**:Name `GITHUB_TOKEN`、Value 貼 token → **Deploy**。
3. 驗證:開 `https://<你的網址>/api/update` 應回最新版本 JSON。

---

## 🛠 手動部署 / 改完程式後重新部署(CLI)

本資料夾改了 `src/index.js` 後,要重新部署才會生效:

```bash
npx wrangler login     # 第一次,或登入過期時(會開瀏覽器授權)
npx wrangler deploy    # 部署
```

> wrangler 的登入 token **會過期**;過期時在「互動終端」重跑 `npx wrangler login`,或設環境變數 `CLOUDFLARE_API_TOKEN`。
> 部署前可先驗證打包:`npx wrangler deploy --dry-run`。

---

## 📡 API / 路由

| 路由 | 說明 |
|---|---|
| `GET /api/config` | 盒子讀設定(JSON);含授權狀態、到期、啟動畫面文字;未授權時不回直播源 |
| `GET /api/activate?id=&code=` | 盒子輸入啟動碼激活,綁定該機並計算到期 |
| `GET /api/update` | 查最新 App 版本(OTA) |
| `GET /dl/latest.apk` | 代理下載最新 APK(OTA) |
| `GET /admin` | 管理頁(Basic Auth,密碼 = `ADMIN_PASSWORD`) |
| `POST /admin/save` | 儲存設定(源/公告/輪詢/授權開關/啟動畫面) |
| `POST /admin/test` | 測試來源網址有效性 |
| `POST /admin/codes` | 啟動碼:生成(單筆/批量)、撤銷、刪除 |
| `POST /admin/device` | 裝置:封鎖/傳話/改暱稱/開機自啟/授權/撤銷/刪除 |

## 🗄 KV 資料

- `config` — 全域設定(源、公告、`requireActivation`、啟動畫面文字、碼位數)
- `dev:<裝置id>` — 每台裝置(上線時間、機型、封鎖、`authorized`、`expireAt`)
- `code:<啟動碼>` — 每組啟動碼(狀態、綁定裝置、天數、到期)

## 📁 檔案

- `src/index.js` — Worker 主程式(原生 fetch,零依賴)
- `wrangler.toml` — 設定(KV 綁定;一鍵部署自動填 id)
- `package.json` — `deploy` / `dev` / `tail` 指令

> 本程式**不含任何 token**,可安全公開。直播源與授權都在部署後於 `/admin` 設定。

# 偉電視 · 管理中心(Cloudflare Worker)

電視盒 App「偉電視」的**遠端管理中心**。手機瀏覽器開 `/admin` 登入,就能:換直播源 token、發公告與跑馬燈、**啟動碼授權與防盜用**、封鎖 / 傳話、看每台盒子在線與**正在看的頻道**、**遠端協助(重載頻道 / 幫他切台 / 重啟 App)**、**遠端調字體大小**、推 OTA 更新——全部不必碰盒子。

影片不經過這裡(盒子直連源站),Worker 只同步「設定」與「授權」,流量極小;裝置心跳有寫入節流,**免費額度綽綽有餘**。

---

## 🚀 一鍵部署(推薦,全程點按)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/xiewei3536/weid4t-worker)

點按鈕,Cloudflare 會帶你走完:

1. 登入 / 連結你的 **GitHub**(把這個 repo 複製到你帳號)
2. **自動建立 KV 資料庫**(存設定 / 裝置 / 啟動碼,免手動)
3. **跳出來請你輸入管理密碼**(`ADMIN_PASSWORD`)
4. 自動部署,給你一個網址:`https://weid4t-worker.<你的子網域>.workers.dev`

部署完成後:
- **App 端**:電視盒已內建管理中心網址(`/api/config`),通常免設定。
- **管理端**:手機瀏覽器開 `https://<你的網址>/admin`(帳號隨意、密碼 = 你剛設的)。

---

## 🔑 設定 / 修改管理密碼(ADMIN_PASSWORD)

一鍵部署若沒跳出輸入框、或想改密碼,用 **Cloudflare 後台**(不是 CLI):

1. Cloudflare 後台 → **Workers & Pages** → 點開 `weid4t-worker`
2. 上方 **Settings** → **Variables and Secrets**
3. **+ Add** → Type 選 **Secret** → Name 填 `ADMIN_PASSWORD`、Value 填密碩 → **Deploy**

> 還沒設密碼時開 `/admin`,頁面會**直接畫出上面這幾步**,照著做即可。

---

## 🧭 管理頁導覽(六個分頁,所有操作免跳頁、即時 toast 回饋)

| 分頁 | 內容 |
|---|---|
| 📊 **總覽** | 總裝置 / 線上 / 今日上線 / 已授權 / 未授權 / 未用碼;授權、OTA、公告、跑馬燈狀態橫幅;**正在觀看**(哪台盒子在看哪個頻道);**App 版本分布**(幾台還是舊版);快速操作 |
| 📺 **裝置** | 每台一張卡:🟢線上 / 🟡今日 / ⚫離線、正在看、授權、來源實測、版本、字體、IP…<br>主操作:授權(天數)/ 撤銷 / 封鎖 / **重載頻道**<br>更多操作:**幫他切台**(輸入台號)、**重啟 App**、清快取重載、傳話、**字體(單機覆蓋)**、開機自啟、改暱稱、刪除<br>批量:對全部裝置送指令、自啟全開 / 全關、匯出 CSV、清 30 天未上線 |
| 📡 **直播源** | 訂閱網址 + 「測試來源」(HTTP 狀態、頻道數、分類統計、頻道範例、EPG 網址、盒子實測)+ 「所有盒子重新載入頻道」 |
| 🎟️ **授權** | 開關授權機制、啟動畫面文字、碼位數;產生啟動碼(批量 / 天數 / 備註,結果彈窗一鍵複製)、一鍵授權現有裝置、清單搜尋篩選、每組可複製 / 撤銷 / 刪除、匯出 CSV |
| 📣 **通知** | 跑馬燈(分鐘數、盒子畫面預覽、立即停止)、公告(時數、預覽、撤下)、聯絡 QR 上傳 |
| ⚙️ **系統** | 重載間隔、**全域字體大小**(自動 / 標準 / 大 / 特大)、**右上角時鐘**、開機自啟、**OTA 提示開關**、強制刷新;OTA 最新版資訊與重新讀取;端點一覽 |

總覽與裝置分頁每 60 秒自動刷新;右上角有台灣時間與「重新整理」。

---

## 🛠 遠端協助長輩(重點功能)

長輩電話來說「電視沒畫面」時,不用跑一趟:

1. `/admin` → **裝置** → 找到那台(可用暱稱如「阿嬤房」搜尋),看「正在看」「來源」「最後上線」判斷狀況。
2. 按 **🔁 重載頻道**(重抓清單繼續播)或 **更多操作 → 📺 幫他切台**(輸入台號,例如 12)、**🔄 重啟 App**。
3. 盒子每 90 秒心跳一次,收到指令即執行並回傳回條;卡片會顯示「待送達」或「已於 x 分鐘前執行 ✓」。未送達的指令 6 小時後自動作廢。
4. 字太小?**字體** 選「大」或「特大」→ 套用,盒子下一次心跳自動重繪畫面。

---

## 🔐 啟動碼授權(防止 APK 外流盜用)

開啟後,**沒有有效啟動碼的盒子無法觀看**——拿不到直播源、開 App 只會看到「請輸入啟動碼」畫面。

### 啟用步驟(順序很重要)
1. **授權** 分頁 → 先按 **「🔓 一鍵授權所有現有裝置(永久)」**(否則你目前在用的盒子會被一起鎖在外面)。
2. 勾選 **「啟用啟動碼授權」**,填啟動畫面標題 / 說明文字、啟動碼位數 → **儲存授權設定**。

### 產生與管理
- 產生數量(單次上限 200)、有效天數(0 = 永久,從盒子輸入碼那一刻起算)、備註 → 結果彈窗可一鍵複製。
- 裝置卡可直接「授權(天數)」/「撤銷授權」;撤銷啟動碼會同時停用綁定的盒子。
- 到期:盒子自我檢測(開機 + 每 90 秒)跳續期畫面;伺服器端同步不下發直播源(雙保險)。
- 同一 IP 每 10 分鐘最多 30 次啟動碼嘗試(防暴力猜碼)。

---

## 🔁 日常維護:換 token

`/admin` → **直播源** → 貼上新網址 → 「測試來源」→ 「儲存直播源」→(可選)「所有盒子重新載入頻道」立刻生效。
App **不內建任何源 token**,源一律由這裡下發 → APK 就算被複製也拿不到你的源。

---

## 📦 OTA 自動更新

1. GitHub 建 **Fine-grained token**:只給 `weid4t-app` 的 **Contents: Read-only**。
2. Cloudflare → `weid4t-worker` → **Settings → Variables and Secrets → + Add → Secret**:Name `GITHUB_TOKEN` → **Deploy**。
3. 系統分頁會顯示最新版、大小、更新說明;可「重新讀取最新 Release」;不想長輩看到更新視窗可關閉「允許盒子提示 App 更新」。

---

## 🧪 開發與測試

```bash
npm install                 # 只裝 wrangler(開發用)
npm test                    # 零依賴端到端測試(MockKV,17 組:相容性、節流、授權、限速、CSRF、指令…)
npm run preview             # 本機預覽 http://localhost:8787/admin(密碼 test,內含示範裝置)
node test/serve.mjs 8799 test "http://你的源/channel?type=m3u&token=…"   # 指定訂閱網址,可供模擬器 App 連線
npx wrangler deploy --dry-run   # 驗證打包
```

### 部署
**主要方式:push 到 GitHub 自動部署。** 本 repo 接了 Cloudflare Workers Builds——push 到 `main`,Cloudflare 會自動重新部署(幾分鐘生效)。備選:`npx wrangler login && npx wrangler deploy`。

---

## 📡 API / 路由

| 路由 | 說明 |
|---|---|
| `GET /api/config?id=&v=&m=&fs=&now=&ok=&ch=&as=&ack=` | 盒子讀設定;登記裝置與回報(版本、機型、字體、正在看、來源結果、自啟、指令回條);回應含授權、字體、時鐘、OTA 開關、待送指令、伺服器時間 |
| `GET /api/activate?id=&code=` | 啟動碼激活(IP 限速) |
| `GET /api/update` · `GET /dl/latest.apk` | OTA 查詢 / 下載(帶 Content-Length 供進度) |
| `GET /api/time` · `GET /api/health` | 對時備援 / 健康檢查 |
| `GET /asset/qr` | 聯絡 QR 圖 |
| `GET /admin` · `GET /admin/partial?name=` · `GET /admin/export?what=` | 管理頁 / 局部刷新片段 / CSV 匯出 |
| `POST /admin/save` `/test` `/device` `/codes` `/upload` `/system` | 管理動作(Basic Auth + 同源 CSRF 檢查;帶 `X-Requested-With: fetch` 回 JSON,否則回結果頁) |

## 🗄 KV 資料

- `config` — 全域設定(源、公告、跑馬燈、授權、`fontScale`、`showClock`、`otaEnabled`…;舊資料缺欄位自動補預設值)
- `dev:<裝置id>` — 每台裝置(上線 / 版本 / 授權 / 封鎖 / 暱稱 / `now` 正在看 / `fontScale` 覆蓋 / `cmd` 待送指令 / `lastAck`);無變化時最多每 10 分鐘寫回一次
- `code:<啟動碼>` — 啟動碼(狀態、綁定裝置、天數、到期)
- `rl:act:<ip>` — 啟動碼限速計數(自動過期)
- `update_cache` / `asset:qr` — OTA 快取 / QR 圖

## 📁 檔案

```
src/index.js      路由進入點
src/lib.js        常數、預設設定、KV 讀寫、回應工具、狀態判定
src/api.js        /api/* 與 OTA、裝置登記(寫入節流)、啟動碼
src/admin.js      /admin/* 後端(驗證、CSRF、儲存、測試、裝置、啟動碼、上傳、系統、匯出)
src/ui.js         管理頁 HTML(整頁 + 局部片段)
src/ui_assets.js  管理頁 CSS / 前端 JS(AJAX、toast、局部刷新、篩選、預覽)
test/run.mjs      端到端測試;test/mockkv.mjs 模擬 KV;test/serve.mjs 本機預覽伺服器
wrangler.toml     設定(KV 綁定;一鍵部署自動填 id)
```

> 本程式**不含任何 token**,可安全公開。直播源與授權都在部署後於 `/admin` 設定。

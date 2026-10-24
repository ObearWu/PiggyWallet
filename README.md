# 大小豬錢包 — 前端

兩個人用的私密分帳網頁，手機優先，可以「加到主畫面」當 App 用。
純靜態檔案、沒有 build 步驟，部署在 GitHub Pages：<https://obearwu.github.io/PiggyWallet/>

- 所有資料都來自後端（`PiggyWallet-backend`，Render），這個 repo 不含任何帳本資料。
- `noindex` 加上 `robots.txt` 全擋，不會被搜尋引擎收錄。
- `localStorage` 只存登入 token 和上一次看到的資料（冷啟動時先顯示），登出時一併清掉。
- `sw.js` 只快取網站外殼，一律網路優先，改版後下一次開啟就是新版。

| 檔案 | 用途 |
|---|---|
| `index.html` | 頁面骨架 |
| `assets/app.js` | 全部的畫面邏輯 |
| `assets/style.css` | 樣式（含深色模式） |
| `manifest.webmanifest`、`sw.js`、`assets/icon*` | 加到主畫面用 |

本機開發：`python3 -m http.server 8020`，在 localhost 開啟時會自動改打 `http://127.0.0.1:5001` 的後端。

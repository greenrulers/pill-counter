# REA 分析紀錄（2026-10-25）

REA（Reverse Engineer Anything，github.com/morluto/rea，MIT）是給 Claude Code 等代理用的逆向工程 MCP 伺服器與指令列工具。這台 Mac 已全域安裝 `rea-agents` 6.7.0 並登錄到 Claude Code（`rea setup --client claude_code --yes`）。本文記錄用 REA 對「數藥 app 這一類軟體」做了哪些分析、結果是什麼、哪些刻意沒做。

## 1. 用 REA 靜態分析本專案

```bash
rea analyze-javascript-application ~/work/pill-counter --format json > own-app.json
```

| 項目 | 結果 |
|---|---|
| 盤點檔案 | 11 個；JS 解析成功 8 個、失敗 0 |
| AST 節點 | 14,080 |
| 應用圖 | 55 節點、75 邊（imports 27、exposes 17、contains 20、persists_to 4、calls 3、loads 3） |
| 語意圖 | 9,485 節點、8,445 關係、140 個函式指紋 |
| 恢復出的執行環境 | 1 個 Web Worker（`new Worker('./worker.js')`）、1 個 Service Worker（`register('./sw.js')`） |
| 儲存 | localStorage（getItem／setItem）、Cache Storage（sw.js） |
| 網路端點候選 | 2 個，皆為本地：`params.get('img')`（網址參數載入測試圖）、sw.js 的 `e.request`（快取攔截） |

結論：圖上**沒有任何對外主機的請求**，與「影像只在手機內運算、不上傳」的設計一致。REA 自己標註的限制：靜態分析不執行程式，只能證明「沒看到」，不能證明「不存在」。證據 ID `ev_276622f4…`，15 MB 原始 JSON 留在 session 暫存，不入 repo。

## 2. 用 REA 分析正式網址的網頁 bundle

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new \
  --remote-debugging-port=9222 --user-data-dir=/tmp/rea-chrome \
  "https://greenrulers.github.io/pill-counter/?img=samples/sample1.jpg" &
rea list-browser-targets http://127.0.0.1:9222 --format json      # 取得 targetId
rea analyze-web-bundle http://127.0.0.1:9222 <targetId> --observation-ms 4000 --format json
```

結果：擷取 2 個腳本（counter.js 24,269 bytes、app.js 19,024 bytes）全數解析，9,772 AST 節點；routes 0、endpoints 0、只有 1 個低信心端點候選（同上 `img` 參數）；完整度 complete。

這條流程就是之後拿來分析「任何網頁版數藥工具」的標準做法。注意無頭 Chrome 一次只能開一個網址，多個目標要開多個實例（不同 port）。

## 3. 對 PillEye 做了什麼、沒做什麼

### 官網（公開網頁）

- 同樣流程對 https://www.pilleye.com/en 跑 REA：這是 Next.js 網站，bundle 很大，REA 的 JavaScript 分析器在 4 GB 與 8 GB heap（`NODE_OPTIONS=--max-old-space-size=8192`）都記憶體不足、exit 134。
- 改用輕量檢查：抓 HTML 與 29 個腳本（共 1.3 MB）做關鍵字比對，**沒有** tensorflow／onnx／opencv／wasm／getUserMedia 等字樣 → 官網沒有瀏覽器端的計數功能，計數全在原生 app。
- 官網文案：Vision AI、LIVE 模式即時數到 1,000 顆、宣稱 99.999%、支援半錠與透明軟膠囊、方案含「PillEye API（另計價）」與「AI 模型自動更新」。

推論：PillEye 的計數是**原生 app 內的深度學習偵測模型**（模型持續用新資料更新），並另售雲端 API。這與創辦人訪談（訓練多個模型、反覆處理例外，準確率 98.7% → 99.2%）一致。

### 安裝檔（沒有做）

- iOS 的 IPA 受 FairPlay 加密，要越獄裝置才能取得可分析的二進位檔。
- Android APK 只能從第三方鏡像站下載（未授權的轉載來源，也是下載未知檔案）；這一步需要組長明確同意才會做。
- 就算分析，也只看結構性資訊（用哪個推論框架、模型輸入尺寸、是否完全離線、有無上傳），**不複製其模型或程式碼**——那是著作權問題，和非營利無關。
- 這台 Mac 也還沒裝 APK 分析引擎：`rea doctor` 顯示 jadx／apktool／Ghidra 皆未設定。

## 4. 若之後要用 REA 分析一個合法取得的 APK

```bash
rea doctor                                    # 看缺哪些引擎
rea extract-artifact <app.apk> --output <空資料夾>   # 安全解壓：看 assets/ 有無 .tflite .onnx .mlmodel、lib/ 有無 libtensorflowlite libonnxruntime libopencv
rea identify-flutter-build <app.apk>          # 是否 Flutter（純解析，不需引擎）
rea decode-android-resources <app.apk>        # 需 apktool
rea analyze <app.apk> / rea decompile ...     # 需 JADX（REA_JADX_MCP_JAR）或 Ghidra（GHIDRA_INSTALL_DIR）
rea evidence-export ...                       # 保存證據
```

## 5. 對本專案的啟示

1. PillEye 類 app 的差異化在「即時模式、一次 1,000 顆、半錠與透明膠囊」，靠資料驅動的偵測模型。本專案的古典方法（背景色距離＋距離轉換）對**透明膠囊、重疊堆疊**會弱；第二階段若要追上，用自己拍的照片訓練小型偵測模型（YOLO → ONNX，在瀏覽器用 onnxruntime-web 離線跑）。
2. 「不上傳」是可以被驗證的：REA 的端點清單為 0。之後每次改版可重跑第 1、2 節，並用 `rea compare-application-versions` 做回歸比對。
3. 即時模式、拍照模式、人工修正、紀錄分享，是這類 app 的共同骨架；本專案都有，差在模型能力與實拍驗證。

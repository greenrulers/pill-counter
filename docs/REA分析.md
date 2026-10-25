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

### 安裝檔（2026-10-25 晚，已做：Android 3.14.0 結構分析）

組長親自從 APKPure 下載 PillEye 的 Android 安裝檔並同意只做結構分析後，用 REA＋androguard 做了靜態分析。**沒有安裝、沒有執行、沒有呼叫它的伺服器、沒有複製任何程式碼或模型**；分析用的解壓檔與完整輸出留在 session 暫存區，不進 repo，這裡只放結論與 REA 的 Flutter 辨識證據（`docs/rea-evidence/`）。

**檔案身分**

| 項目 | 內容 |
|---|---|
| 檔名／來源 | `PillEye – tablet, pill counter_3.14.0_APKPure.xapk`（APKPure 鏡像） |
| 大小 | 57,929,439 bytes（55.2 MiB） |
| SHA-256 | `fde534189e6ef3b4f55fd5935d4d5b3518f2a8459072516fc47613a492be9033`（與 APKPure 頁面公布值一致） |
| 套件 | `com.rocateer.mediscount`，versionName 3.14.0，versionCode 817，minSdk 24，targetSdk 36 |
| 組成 | base 36.3 MB＋`config.arm64_v8a` 21.5 MB＋語言／密度分包；manifest 有 `com.android.stamp.source = play.google.com/store`，是 Play 原始分發的 split APK |

**框架與依賴**（`rea identify-flutter-build`、`rea extract-artifact`、androguard 4.1.4）

- Flutter 應用：`libflutter.so` build-id `2bb32ee9…`、Dart AOT 快照 hash `1ce86630…`，用 Android NDK clang 19.0.1 編譯。Dart 端套件名 `pilleye_flutter`，約 150 個 .dart 檔（controllers／screens／service／widgets）。原生殼 `com.rocateer.mediscount.MainActivity`（Kotlin，R8 混淆成單字母套件）。
- 主要套件：Sentry（錯誤回報＋畫面重播）、Firebase Core／Messaging（analytics 關閉）、Play Billing 8.0.0（訂閱）、Google ML Kit **條碼掃描** 18.3.1（`com.google.mlkit.vision.DEPENDENCIES = barcode`，只有條碼）、CameraX（camera2／core／lifecycle／video／view）、flutter_inappwebview（首頁是 WebView）、go_router、GetX、sqflite、chopper／http、Tolgee（多語翻譯）、video_player（內建 40 支 en／ja／ko 教學影片）。
- 權限：CAMERA、INTERNET、ACCESS_NETWORK_STATE、ACCESS_WIFI_STATE、WAKE_LOCK、POST_NOTIFICATIONS、BILLING、FCM RECEIVE。沒有儲存、定位、麥克風權限。

**核心發現：Android 版的計數在雲端，不在手機裡**

1. 安裝檔內 **0 個模型檔**（沒有 .tflite／.onnx／.pb／.mlmodel），arm64 原生庫只有 Flutter、Sentry、CameraX、dart_jni；沒有 TensorFlow Lite、ONNX Runtime、OpenCV、ncnn。dex 裡的 `tflite` 字串全部屬於 Google ML Kit 內部（`tflite_dynamite`，條碼用）。
2. 原生 MethodChannel `pilleye.io/camera` 的 `prepareModel` 直接回傳空字串；`predictWithBytes` 收到 width／height／image 後只印出參數，回傳**寫死的** `{"count": 1, "boxes": [{"x": 50, "y": 50, "width": 20, "height": 50}]}`——是占位實作，不是推論。
3. pigeon 介面 `PilleyeCameraController` 的 17 個方法（含 activatePillDetection、activateTrayDetection、takePillDetection）Android 都有註冊，但回報結果用的 `handlePillDetected`、`handleTrayDetected`、`handlePillCount`、`handleDetectionResults`、`handleExternalCameraConnection` **只存在 Dart 端**，Android 原生程式從未發送。Android 原生只做相機預覽、縮放、拍照、條碼、方向。
4. 文案證實：「Currently Live mode is only available on iOS」「Live Mode … compatible only with iOS 16 or later … iPhone 11 or later」「Please wait a little while for Android」。即時（Live）模式只在 iOS 版，推測用 Core ML／Neural Engine；另需 PillEye Stand 專用托盤硬體（`pilleye_hardware_modal`、`mount_detector`、Prism 模式）。
5. 拍照（Photo）模式流程：`pilleye.io/image` 的 `toJPEG` 把 YUV 影格轉 JPEG → Dart `image_service.dart` 用 `MultipartFile` 上傳到 `api-v2.pilleye.io`／`mobile-v2.pilleye.io` 的 `/images/`、`/images/summary` → 回應 `PredictResult.fromJson`（欄位 predictions、boxes、confidence、label、pill_count、dots、image_id、thumbnail_url）。文案「PillEye saves the image for AI analysis」「Count up to 500 pills from a single photo」「10 free shots per day」。**照片會離開手機**。
6. 其他：Rx 條碼查藥走 `/drug-products/barcode/`（韓、日藥品庫）；偵測與即時畫面日誌送 `log.data.medility.net`；`.env` 內含 Tolgee 翻譯服務金鑰與健康檢查密鑰的鍵名（值未記錄、未使用）。

**沒做、不做的事**：沒有反編譯出可讀原始碼（REA 的 JADX 引擎未設定，androguard 只看類別、字串與指令流）；沒有呼叫其 API；沒有試圖取得其雲端模型；留在暫存區的解壓檔隨 session 清掉。

## 4. 這次實際用的指令

```bash
shasum -a 256 <xapk>                                   # 核對 APKPure 公布的 SHA-256
rea extract-artifact <xapk> --format json             # 安全解壓、產生 artifact graph（8 節點）
rea identify-flutter-build <config.arm64_v8a.apk>     # Flutter 偵測、libapp/libflutter 雜湊、snapshot hash、toolchain
rea inspect-android-package <base.apk>                # 需 REA_JADX_MCP_JAR，未設 → 改用 androguard
uv run --with androguard==4.1.4 python -I <腳本> <apk>  # manifest、元件、權限、類別套件直方圖、字串 xref、方法指令流
strings libapp.so | grep 'package:pilleye_flutter/'    # Dart AOT 快照裡的模組結構、網址、pigeon 通道
```

`rea doctor`：Hopper／Ghidra／IDA／JADX／Kuna 皆未設定；這次只用到不需引擎的 extract-artifact 與 identify-flutter-build，Java 層用 androguard 補。

## 5. 對本專案的啟示

1. **隱私取捨不同**：Android 版 PillEye 的拍照計數是雲端推論，照片上傳；本專案完全離線（REA 端點清單 0 個）。藥局情境下病人處方量不離開手機，本專案的取捨更合適，之後文宣可以明講。
2. **即時模式的門檻**：PillEye 的 Live 綁 iPhone 11＋iOS 16 與專用托盤硬體，不是純軟體就能做到；本專案 PWA 的「連拍」模式沒有即時 AI，但跨平台、零硬體。
3. **結果結構**：對方回傳 boxes＋confidence＋label＋dots，和本專案 `pills[{x,y,r,uncertain}]` 概念一致；第二階段若訓練小型 YOLO→ONNX，輸出就照這個概念設計（概念層次，不是程式碼）。
4. PillEye 的差異化（透明膠囊、半錠、1,000 顆）靠資料驅動模型與硬體；本專案的古典方法對透明膠囊、重疊堆疊會弱，要補就靠自己拍的照片訓練，離線跑 onnxruntime-web。
5. 「不上傳」可被驗證：每次改版重跑第 1、2 節，用 `rea compare-application-versions` 回歸比對。

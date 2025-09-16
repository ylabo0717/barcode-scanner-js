# ブラウザ向けバーコードスキャナー調査・実装案

## 要求仕様整理
- PC/スマホ双方で動作し、カメラを起動してバーコードを検出できること
- 検出したバーコード位置をバウンディングボックスで表示すること
- デコードした文字列をブラウザ内のテキストボックスに表示すること
- 同時に複数のバーコードを検出して処理できること

## 候補技術比較
| 技術 | 概要 | マルチバーコード | バウンディングボックス | 対応フォーマット/ライセンス | 備考 |
| --- | --- | --- | --- | --- | --- |
| [Barcode Detection API](https://developer.mozilla.org/docs/Web/API/Barcode_Detection_API) | ブラウザ内蔵の形状検出 API。`BarcodeDetector` で `detect()` を呼び出すだけで利用できる | ✅ `detect()` が常に配列を返す | ✅ `boundingBox` プロパティで矩形取得 | ブラウザ依存 (主に Chromium 系)。追加ライブラリ不要 | Chrome/Edge/Android Chrome では安定。iOS Safari, Firefox の未対応がネック。 |
| [`@zxing/browser` + `@zxing/library`](https://github.com/zxing-js/library) | Java/CPP ZXing を WebAssembly/TypeScript 化。`BrowserCodeReader` や低レベル API を提供 | ✅ `ZXing.MultiFormatReader().decodeMultiple()` を自前ループで利用可能 | ⚠️ `ResultPoint` しか得られないため外接矩形を算出する処理を実装する | Apache-2.0 / 対応フォーマット多数 | 互換性が高い。WASM 初期化コストあり。 |
| [QuaggaJS (Quagga2)](https://github.com/ericblade/quagga2) | 純 JS のリアルタイムバーコード認識。WebWorker＋Canvas で動作 | ⚠️ `locate` オプションで複数候補を返すが確定デコードは 1 件ずつ | ✅ `Quagga.onProcessed` で検出候補の矩形情報を取得可能 | MIT / 1D コード中心 | パフォーマンス良好。2D コード (QR 等) のサポートは限定的。 |
| [Dynamsoft Barcode Reader](https://www.dynamsoft.com/barcode-reader/sdk-javascript/) | 商用ライブラリ (JS SDK)。高精度のマルチバーコード読み取り | ✅ 複数を高精度に検出 | ✅ SDK が矩形情報を返す | 商用 (有償) / 主要 1D + 2D を網羅 | トライアル可だがライセンス費用が発生する。 |

### 候補からの示唆
- 標準 API が使える環境では `BarcodeDetector` が最も実装負荷が低く、マルチ検出と矩形情報をネイティブに提供する。
- 非対応ブラウザ (特に iOS Safari) をカバーするためにはライブラリによるフォールバックが必須。
- オープンソース限定で実現する場合、`@zxing/library` を用いたカスタム実装が最も柔軟。`QuaggaJS` は 1D コード寄りであり QR 対応や複数検出要件に難がある。
- 商用採用が許される場合は Dynamsoft のような SDK を使用すると品質面のリスクを最小化できるが、ここではオープンソースベース案を中心に検討する。

## 推奨アーキテクチャ概要
1. **プログレッシブ検出戦略**
   - `window.BarcodeDetector` が利用可能な場合は標準 API を使用。
   - 非対応ブラウザでは `@zxing/browser` の `ZXingBrowser.BrowserMultiFormatReader` を利用し、内部で `ZXing.MultiFormatReader` を直接呼び出して `decodeMultiple` を実行するフォールバックを提供。

2. **メディア取得**
   - `navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })` でリアルタイムプレビューを取得。
   - デバイスリストは `enumerateDevices()` で取得し、ユーザーがカメラを切り替えられる UI を用意 (PC の複数カメラやスマホのフロント/バック対応のため)。

3. **描画レイヤ構成**
   - `<video>` 要素: カメラ映像。
   - `<canvas>` 要素: 検出結果をオーバーレイ (バウンディングボックス描画、ラベル表示)。`position: absolute` で `<video>` と重ねる。
   - `<textarea>` or `<div>`: 取得したバーコード文字列を一覧表示。複数同時検出に備え、フレームごとに配列で管理し重複排除を行う。

4. **検出ループ制御**
   - `requestAnimationFrame` ベースのループでフレームをサンプリング。
   - フレーム毎に以下を実行:
     1. 標準 API 利用時: `detector.detect(video)` の結果配列を取得。
     2. ZXing フォールバック時: `<canvas>` に現在のフレームを描画し `CanvasRenderingContext2D.getImageData()` を取得。`RGBLuminanceSource` → `BinaryBitmap` に変換し `multiFormatReader.decodeMultiple()` を呼び出す。
   - 過剰な CPU 使用を避けるため、内部で `throttle` (例: 200ms 間隔) を適用。
   - 結果配列ごとに bounding box 描画とデコード値のセット更新を実施。

5. **バウンディングボックス生成**
   - BarcodeDetector: `boundingBox` (DOMRectReadOnly) をそのまま使用。
   - ZXing: `ResultPoint` の最小/最大 X, Y を使って矩形推定。必要に応じて余白を加算し描画。QR のような 4 点が得られる場合は凸包を描画しても良い。

6. **状態管理**
   - 検出結果は `{ value: string, format: BarcodeFormat, box: Rect, timestamp: number }` の配列で保持。
   - 同一値のバーコードが連続検出された場合は最後の `timestamp` を更新するだけにし、UI には一度だけ表示。
   - ユーザーが選択したバーコード値をコピーできるようにクリック操作などを検討。

7. **アクセシビリティ/UX 配慮**
   - カメラ利用許諾が拒否された場合のエラー表示。
   - `prefers-reduced-motion` を考慮した描画 (アニメーション抑制)。
   - スキャン結果の履歴をクリアするボタン。

## 詳細実装ステップ案
1. **開発環境準備**
   - パッケージマネージャ (npm / pnpm / yarn) を選定。
   - 依存追加: `@zxing/browser`, `@zxing/library`。
   - TypeScript 使用を検討 (型安全性向上)。ここではプレーン JS でも可だが TS の方が ZXing API の利用が容易。

2. **UI スケルトン作成**
   - `<main>` に動画領域、結果パネル、カメラ切替ドロップダウン、結果履歴表示を配置。
   - 結果パネルには複数結果をリスト表示する `<ul>` または `<textarea readonly>` を用意。

3. **カメラ制御モジュール**
   - `initCamera(deviceId?)` で `MediaStream` を生成し `<video>` にストリームを設定。
   - ストリーム再生成時には以前のトラックを停止する (`track.stop()`)。

4. **検出サービス層**
   - `createDetector()` が `BarcodeDetector` による実装か ZXing 実装かを返すファクトリ。
   - ZXing 実装では WASM 初期化 (`BrowserMultiFormatReader`) を行い、`decodeFrame(imageData)` で `Result[]` を返す関数を構築。
   - API 差異を吸収する共通インターフェース `{ detect(imageSource: HTMLVideoElement | ImageData): Promise<DetectedBarcode[]> }` を定義。

5. **オーバーレイ描画**
   - Canvas の座標系をビデオの実際の描画サイズに同期 (`video.videoWidth/Height`)。
   - 各 Detection の bounding box を矩形描画し、バーコード値またはフォーマットをラベルとして描画。

6. **結果 UI 更新**
   - 複数バーコードを配列で保持し、UI では最新の検出を上に表示。
   - 既知の値が連続する場合は `lastSeen` を更新して「xx 秒前に検出」といった補助情報を表示可能。

7. **追加機能 (任意)**
   - デバッグ用に「サンプル画像をアップロードして検出」機能を用意 (ZXing 実装を流用し `FileReader` で ImageData 化)。
   - 結果コピー・クリアボタンの実装。

## リスクと対策
- **ブラウザ依存**: Safari、Firefox では BarcodeDetector が未対応。→ ZXing フォールバックを実装し、初期化時に API 利用可否を判定する。
- **パフォーマンス**: ZXing の WASM 処理は CPU 負荷が高い。→ サンプリング間隔の調整・`OffscreenCanvas` や Web Worker 化を検討 (将来的に分離可能なよう設計する)。
- **カメラ解像度**: 高解像度すぎると decoding コストが増加。→ `getUserMedia` の制約で `width`/`height` を適度に制限 (例: 1280x720)。
- **ライト条件**: 暗所では検出率が下がる。→ ユーザーへガイダンス表示、照明ボタン (モバイルの `ImageCapture` API でトーチ制御) を将来的に検討。

## テスティング戦略
- サンプルバーコード画像 (1D/2D) を複数用意し、静止画検出ルートでユニットテスト化 (ZXing モジュール)。
- 手動テスト: PC (Chrome, Edge, Safari)、iOS Safari、Android Chrome でカメラ起動とマルチ検出を確認。
- パフォーマンス計測: `requestAnimationFrame` ループに要した時間・CPU 使用率を DevTools Performance で計測し、しきい値を確認。

## 今後の実装タスク一覧
1. プロジェクト初期化 (Vite 等の開発サーバセットアップ)。
2. 上記 UI スケルトンとスタイル実装。
3. カメラ制御およびデバイス選択 UI 実装。
4. 検出サービス (`BarcodeDetector` + ZXing フォールバック) 実装。
5. オーバーレイ描画および結果表示ロジック実装。
6. ZXing マルチ検出のパフォーマンステスト・調整。
7. 手動テスト結果のドキュメンテーションと既知の制限整理。

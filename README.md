# vscode-npc-gen-runner

VSCode 拡張 — あなたの NPC サイトから generator を取得し、`gen.py` を保存して開き、seed を順に実行して `main.py` / `main.cpp` を動かし、結果を `out_<seed>.txt` と `out.txt` に保存します。

## セットアップ
1. このプロジェクトを作成して上記ファイルを配置する。
2. ターミナルで `npm install`。
3. `npm run compile`。
4. VSCode で F5（拡張をデバッグ起動）。

## 使い方
### 1) Generator を取得して `gen.py` に保存
- コマンドパレット (Ctrl/Cmd+Shift+P) → `NPC: Fetch Generator`
- 入力欄に **短縮形式**（例: `NPC004B`）または **フル URL** を入力
- 拡張がページを取得して Python generator を `gen.py`（または設定されたファイル名）として保存し、エディタで開きます
- **ユーザーが `gen.py` を編集して `print()` で問題の入力フォーマットを出力**する想定です

### 2) Generator を使って main を実行（seed ごと）
- コマンドパレット → `NPC: Run with Generator(s)`
- 任意で URL / 短縮を与えると再取得して `gen.py` を更新します（空なら保存済み `gen.py` を使用）
- 拡張はページ中の `seed値` ブロック（固定フォーマット）から `10 21 40 575 1103` のようなシード列を自動抽出します
  - 固定フォーマット: `<h3>seed値</h3>` の直後に `<div class="code-box"><pre>...</pre></div>`
- 自動抽出が無い場合は手入力で seed をカンマ区切りで指定できます
- 実行時、`gen.py` に `seed = <n>` を埋めた一時ファイルを作り `python` で実行、その stdout を `main.py` / `main_exec` に渡して実行結果を `out_<seed>.txt` に保存します
- すべての `out_*.txt` を連結して `out.txt` を生成します

## 設定（settings.json）
設定は `npc` 名前空間にあります（`settings > Extensions > NPC Gen Runner` でも編集可能）:

- `npc.pythonPath` (default: `python3`) — Python 実行コマンド
- `npc.genFilename` (default: `gen.py`) — 取得した generator の保存先名
- `npc.mainFilename` (default: `main.py`) — 実行するメインソース名（`main.py` / `main.cpp`）
- `npc.timeoutMs` (default: `30000`) — 各プロセスのタイムアウト（ms）
- `npc.maxOutputBytes` (default: `10000000`) — 出力サイズ上限（バイト）

## 注意
- `gen.py` は取得後に必ずエディタで開かれるので、問題ごとの入力フォーマットに合わせて `print()` を編集してください。
- 既定で **タイムアウト** と **出力サイズ制限** を適用します（必須）。
- C++ を使う場合は `g++` が必要です。


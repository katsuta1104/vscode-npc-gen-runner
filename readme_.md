# NPC Runner 拡張 — README（草案）

このファイルは拡張機能の README 修正案です。実際の README へ反映する内容はこのファイルを参照してください。

## 概要
`NPC Runner` は VS Code 用の自動ジャッジ支援拡張です。ジェネレータ (gen.py) で入力を作成し、利用者の `main` を実行、必要に応じて `scorer` を実行して結果を集計します。WSL と Windows の両方を想定していますが、環境に応じた設定が必要です。

## 主なコマンド
- `npc.fetchGenerator` — Web からジェネレータを取得して `gen.py` として保存します。
- `npc.runWithGenerators` — 指定した seeds を用いてジェネレータ→main を実行し、出力と summary を生成します。
- `npc.runHeuristic` — main 実行後に scorer がある場合は scorer も実行して結果を詳しく保存します。
- `npc.runJudge` — `seeds.txt` を読み judge ロジック（TL判定やリトライ）で実行します。
- `npc.generateEnvHelper` — 現在の環境を調べ、推奨 `npc.*` 設定スニペットを含む `NPC_ENVIRONMENT.md` をワークスペースに生成します（トラブルシュート用）。

## 主要設定項目（`settings.json` に記載）
- `npc.pythonPath` : Python 実行コマンド（例: `py`, `python`, `python3`）
- `npc.genCommand` : ジェネレータ（wrapper）実行コマンド（例: `python3 {wrapper}`）
- `npc.mainRunCommand` : main 実行コマンド（例: `python3 {main}` または `./{out}` または `{out}.exe`）
- `npc.mainBuildCommand` / `npc.mainBuildEnabled` : C/C++ のビルド方法と有効フラグ
- `npc.scorerRunCommand` / `npc.scorerBuildCommand` / `npc.scorerBuildEnabled`

### 設定サンプル
- Windows 用（例）:
```json
{
  "npc.pythonPath": "py",
  "npc.genCommand": "py {wrapper}",
  "npc.mainRunCommand": "py {main}",
  "npc.mainBuildEnabled": false
}
```
- WSL / Linux 用（例）:
```json
{
  "npc.pythonPath": "python3",
  "npc.genCommand": "python3 {wrapper}",
  "npc.mainRunCommand": "python3 {main}",
  "npc.mainBuildEnabled": false
}
```

## Diagnostics 出力の意味
拡張起動時および `npc.generateEnvHelper` 実行時に `NPC Runner` 出力チャネルへ診断情報が表示されます。主な行の意味は以下の通りです。

- `Diagnostics: platform=...` — 実行ホストの OS (`win32`, `linux`, `darwin`)。WSL では `linux` となる場合があります。
- `Diagnostics: node version=...` — 拡張が動く Node.js のバージョン。
- `Diagnostics: tmpdir=... cwd=...` — 一時ディレクトリおよびカレントディレクトリ。ラッパー／出力一時ファイルの配置に影響します。
- `Diagnostics: PATH=...` — 拡張が参照する環境変数 `PATH`。どのコマンドが見つかるかはこれに依存します。
- `Diagnostics: <cmd> -> <path or <not found>>` — そのコマンドがシステム上で見つかったパス、または見つからないことを示します。ここで `python3` や `g++` が見つからなければ、`npc.generateEnvHelper` の提案に従うかフルパスを設定してください。

## トラブルシューティング
- TLE（タイムアウト）が効かない / first-run が重い: これはプロセス起動オーバーヘッドやアンチウイルスログスキャンなどの初期コストが原因で、拡張は各ワーカー起動時に1回のウォームアップを実行するようになりました。必要ならウォームアップ回数の増加を検討してください。
- CPU時間の計測が粗い（16ms など）: Windows の API や PowerShell による取得は分解能や丸めの制約があります。高精度の CPU 時間が必要なら、別途ネイティブの計測ラッパ（POSIX: `wait4`/`getrusage`、Windows: `GetProcessTimes`）を導入することを検討してください。
- コマンドが見つからない場合: `NPC_ENVIRONMENT.md` を参照し、推奨設定を `.vscode/settings.json` に反映してください。WSL では `python3` / `./{out}` を推奨します。

## 付録: 主要な実行例
- ジェネレータを使って手動で1つのシードを実行する:
  1. `npc.fetchGenerator` で `gen.py` を取得（必要な場合）
  2. `npc.runWithGenerators` を実行してシードを入力
- Judge 実行（seeds.txt を使用）:
  1. ワークスペースルートに `seeds.txt`（1行につき 1 seed）を作成
  2. `npc.runJudge` を実行

## 最後に
この README 草案を `readme.md` に反映する前に、必要な表現の追加や修正があれば教えてください。生成される `NPC_ENVIRONMENT.md` は自動生成の候補なので、環境に応じて微調整してください。

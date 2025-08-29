NPC(Nanyo Programming Contest)のテストを自動で行うVSCodeを想定した拡張機能です。以下の内容には必ず目を通してください。

## 機能

コマンドパレット上(ctrl + shift + Pで表示)で二つのコマンドが追加されます。

1. `NPC: Fetch Generator`

2. `NPC: Run With Generator(s)`

### `NPC: Fetch Generator`
実行した後入力を求められますが、これは参照する問題のページを探しています。
ユーザーは、次の二つのうちいずれかの形式で入力しなければなりません。

- `NPC<num><id>`

- `https://sites.google.com/view/nanyocompetitiveprogramming/%E3%82%B3%E3%83%B3%E3%83%86%E3%82%B9%E3%83%88%E4%B8%80%E8%A6%A7/contest<num>/problems/<id>`

例えば、Nanyo Programming Contest 001 の A問題を参照させる場合は、

- `NPC001A`

- `https://sites.google.com/view/nanyocompetitiveprogramming/%E3%82%B3%E3%83%B3%E3%83%86%E3%82%B9%E3%83%88%E4%B8%80%E8%A6%A7/contest001/problems/a`

と入力してください。

入力した後は、自動で指定されたページから `Python`生成コードを取得し、それを`gen.py`に保存します。

### 2. `NPC: Run With Generator(s)`

解法を書いたコード(`main.py`,`main.cpp`)と`gen.py`を使ってテストケースを一括で回します。

まず、生成コードを尋ねられます。ここで、何も入力しなかった場合は、現在存在している`gen.py`を生成コードとして実行し、先述のURL指定法に基づいた文を投げるとそのURLの生成コードを新たに`gen.py`とした上で生成コードとして実行します。

次に、シード値を獲得します。

~~シード値は基本的に指定されたURLから自動的に拾われます~~<font color = red>(このバージョンでは作動しないことが判明しています。)</font>

自動的にシード値が拾われなかった場合は、手動でシード値を入力することになります。シード値を複数入れる場合は、半角空白区切りあるいはカンマ区切りで入力してください。

それらを入力し終えると、ついに実行が始まります。右下に表示されるポップアップでも見ながら優雅にお茶でも飲んでください。


実行が終わると、ルートディレクトリ内に各テストケースの出力結果が`out_<seed>.txt`として保存され、すべてのテストケースの結果が`out.txt`に保存されます。


## 使用上の注意
- 生成コード内では必ず 
```py
seed = 97
N = generator(seed)
```
のように、seedという変数を用いてseed値を宣言してください。でないと、正常にシード値を変えて実行できない恐れがあります。また、`generator(int(input()))`,`seed = int(input())`のような記法はしないでください。必ず、`seed = <num>`という形でお願いします。

- 生成コード内で出力された結果が`main.py/cpp`の標準入力に渡されます。`main.py/cpp`での入力受け取り形式と、生成コードでの出力形式が違うと適切な結果が得られないので注意してください。
**そのため、`NPC: Run With Generator(s)`で生成コードを取得するのではなく、一度`NPC: Fetch Generator`から生成コードを入手し、目で確認することを強くお勧めします。**

- 万一生成コードが無限ループに陥ったり、あるいは悪質であったりするときのために、テスト実行するときの一連の流れ (すべてのテストケース生成および`main.py/cpp`での実行時間を含む) の制限時間を30000ms(30s)に設定しています。また、生成コードの出力制限は10000000 bytes です。なお、どちらの設定もVSCode内に読み込んだあとに拡張機能の設定から任意の値に変更することができます。

## 要求環境

- Visual Studio Code
- Python(生成コードの実行に必須)
- Node.js
- npm
- g++ (C++を使用する場合)



Node.jsは[Node.jsのホームページ](https://nodejs.org/ja/)の方からインストールしてください。

npmは設定->システム->開発者向け->sudoの有効化 をonにしてから、
```powershall
sudo npm install -g npm
```

を実行することによってインストールできます。

## インストール方法(VSCode内の拡張機能導入まで)

1. [当リポジトリのRelease](https://github.com/katsuta1104/vscode-npc-gen-runner/releases/tag/run-gen)から拡張子が`.vsix`であるものをダウンロードする。

2. VSCodeを開き、左のサイドバーから拡張機能の部分を開く(ctrl + shift + X でも可)。

3. 一番上に「拡張機能(英語のままならおそらくEXTENSIONS)」という文字があると思うが、そのすぐ右にある詳細ボタンから「VSIXからのインストール...」というものがあるので、そこから先ほどダウンロードした`vsix`形式のファイルを選択する。


## 履歴
2025/08/16 READMEを追加。version0.1.2

2025/08/29 GUIから設定を変更できるように修正 version0.1.3

# justic

生成モデルが書いた設計書をレビューし、**指摘の採用と却下がそのまま学習データになる**仕組み。

検出対象は2つ。**設計内容の欠陥**と**直訳調の日本語**。

| 文書 | 中身 |
|---|---|
| [要件](docs/design-review-api-requirements-v2.md) | 層の構成、検出対象、評価。草案は [こちら](docs/design-review-api-requirements.md) |
| [追加設計の地図](docs/design-00-overview.md) | 6本への分割、依存の順序、共通の決定 |
| [01 測定](docs/design-01-measurement.md) | 未検知の記録と recall。**実装済み** |
| [02 実行基盤](docs/design-02-runtime.md) | 走査を束ね、非同期にし、繰り返しを0回にする。**書いた** |
| [03 入力](docs/design-03-input.md) / [04 観点](docs/design-04-aspects.md) | 未着手。解くべき問題の一覧 |
| [05 LLM の接続先](docs/design-05-llm-endpoints.md) | 接続先を複数持ち、レビューごとに選ぶ。OpenRouter 対応と API キーの置き場所。**書いた** |
| [06 MCP からの呼び出し](docs/design-06-mcp.md) | Claude Code などの AI の道具から、貼り付け・PR・ブランチ・採否の経路を MCP のツールとして呼ぶ。**書いた。実装済み** |
| [OpenRouter の確認メモ](docs/openrouter-2026-09-11.md) | 公式ドキュメントから一次確認した事実 (2026-09-11)。設計 05 の出典 |

## 起動

```sh
./run.sh                 # http://127.0.0.1:5180
JUSTIC_L3=0 ./run.sh     # 設計チェック (LLM) を切る
```

設計チェックはこの道具の本体なので既定で有効。推論サーバーが居なければ
文体チェックの結果だけを返し、繋がらなかった理由を画面に出す。

2つの検査の違い。

> httpリクエストのJSONに不備があると、プロセスは黙って壊れる。

| | 判定 | 理由 |
|---|---|---|
| 文体チェック (L1) | 素通し | 助詞も冗長表現も問題ない |
| 設計チェック (L3) | 指摘 | 不正な入力に対する振る舞いが書かれていない |

文体チェックは書いてある文字を見る。設計チェックは書いていないことを見る。

待ち受けは `127.0.0.1` と `::1` の両方。`localhost` でも `127.0.0.1` でも開く
(Windows 側のブラウザは `localhost` を `::1` から先に引くため、IPv4 だけでは
フォールバック頼みになる)。**ループバック以外では待たない。** WSL のミラーリング
モードでは `0.0.0.0` にすると LAN の他の端末から届き、トークンを持った画面が外に出る。

状態を変える要求は `Origin` と `Host` を見て、この機械の画面から来たものだけを通す。
ループバックでも、利用者が踏んだ外部のページからは POST が届く。`.env` の PAT モードでは
cookie 無しで通るため、塞がないと勝手に issue が立つ。

OAuth を使うときは、**登録した callback と同じホスト名で開く**。cookie はホストごとに
付くので、`localhost` で開いて callback が `127.0.0.1` だとログインが別の origin に
乗る。`/auth/login` は `JUSTIC_ORIGIN` (既定 `http://127.0.0.1:5180`) に寄せてから
OAuth に出すので、どちらで開いても最後は1つの origin に揃う。

## 接続先

L3 (設計チェック) がどの LLM に送るかは `~/.config/justic/endpoints.json` で決める。
リポジトリ直下の `endpoints.example.json` を写して URL・モデル・`key_file` を直す
(キーは書かない)。設定ファイルが無ければ、いまどおり `.env` の `JUSTIC_BASE_URL` /
`JUSTIC_MODEL` / `JUSTIC_API_KEY` から手元用の接続先を1つ組み立てる。

```sh
mkdir -p ~/.config/justic
cp endpoints.example.json ~/.config/justic/endpoints.json
# URL・モデル・key_file を編集する
```

キーは接続先ごとの1行ファイルに置き、`endpoints.json` の `key_file` にパスを書く。
**group と other に読み権限があれば読まずに拒む (0600 か 0400 にする)**
(`chmod 600 <パス>` で直す。ファイルが無い・1行目が空のときも同じく拒む)。
`key_file` を書かない接続先はキーを送らないだけで、失敗にはならない。

```sh
echo "sk-xxxxx" > ~/.config/justic/openrouter-key
chmod 600 ~/.config/justic/openrouter-key
```

画面には接続先の一覧が出る。**外部の接続先を選ぶと、本文の全文がそこへ送られる**
(抜粋や要約ではない)。選ぶと直下に注記が出る。選択は覚えない。画面を開き直すと
`/api/health` の既定に戻る。

接続先の一覧は起動時に1回だけ読むので、足したり消したりしたら再起動が要る。
キーファイルは呼び出しのたびに読み直すので、キーの差し替え (失効・再発行) は
再起動なしで効く。詳しくは [設計 05](docs/design-05-llm-endpoints.md)。

## MCP から使う

Claude Code のような AI の道具から、justic の検査・採否を直接呼べる。justic の
プロセスが `/mcp` (Streamable HTTP) で受ける。別のプロセスは立たない。

```sh
claude mcp add --transport http --scope user justic http://127.0.0.1:5180/mcp
```

登録したら Claude Code を起動し直す (設定は起動時にしか読まない)。justic は先に
起動しておく。止まっていると、そのセッションではツールが見えない。

ツールは 8 つ。Claude Code の中では `mcp__justic__review_document` のような
名前で見える。

| ツール | すること |
|---|---|
| `health` | DB・L3・接続先・GitHub トークンの有無を返す |
| `stats` | 文書・レビュー・指摘・採否・注釈の件数を返す |
| `list_reviews` | 最近のレビューを新しい順に返す |
| `get_review` | レビュー1件の指摘を返す |
| `review_document` | 文書を1件検査する。本文は `body` か、絶対パスの `path` で渡す |
| `review_pull_request` | GitHub の PR が変更した Markdown を検査する |
| `review_branch` | リポジトリ (既定はデフォルトブランチ) の Markdown を検査する |
| `set_verdict` | 指摘の採否 (`accepted` / `rejected`) を記録する |

**本文は返さない。** `get_review` は文書の本文 (`body`) を含めない。justic の DB
に溜まった実務の文書を、AI の道具が番号だけで読めてしまうのを防ぐため。指摘の
`evidence` (該当行) は返す。

**`useL3` は `endpoint` を名前で指定したときだけ走る。** 省略すると L1 (文体) だけで
終わる。`useL3: true` で `endpoint` を省くと拒む。`endpoint` に外部
(`external: true`) の接続先を指定しても拒む。外部の接続先を選ぶのは画面からだけ。

**MCP から押した採否は `decided_by = 'mcp'` として記録される。** 画面から人が
押したものとは値で区別できる。

詳しくは [設計 06](docs/design-06-mcp.md)。

## 対象の選び方

| モード | 何を見るか |
|---|---|
| 貼り付け | 本文をそのまま |
| PR の差分 | **その PR が足した行**の文体指摘だけ。もとからあった行は出さない |
| ブランチ走査 | デフォルトブランチの Markdown。**採用した指摘から issue を立てられる** |

書き手(出自)も選べる。**生成モデル**か**人**かの二択で、既定は生成モデル。
直訳調の分類器 (L4) の学習データは、この出自で正例・負例を振り分ける
(生成モデル → 正例、人 → 負例)。人が書いた文書を入れるときは必ず「人」を選ぶ。
同じ本文を別の出自で登録し直すことはできない。

PR で L1 (文体) を差分の行に絞るのは、その PR が持ち込んでいない指摘で画面が埋まるのを防ぐため。
L3 (設計内容) は差分では判定できない。「異常系が書かれていない」は書かれていないことの指摘なので、
全文を見たうえで差分の内か外かを `in_diff` に記録する。

起票は**採用された指摘からだけ**行う。未判断の LLM 出力をそのまま issue にすると repo が荒れる。
人手で見つけた指摘も、注釈の一覧から起票できる。

同じ指摘から二度立たないよう、**どの指摘・注釈がどの issue に載ったかを id で記録**して
突き合わせる。内容のハッシュ (marker) は補助で、再走査して id が変わった指摘を
拾うためだけに使う。内容だけで同一性を決めると、同じ行に出た別の指摘 (evidence が
行全文なので一致する) が潰れて、片方が永久に起票できなくなる。

判定は押す前に解決して画面に出す。issue の状態も見る。

| GitHub 側 | 画面 | 起票 |
|---|---|---|
| open | `起票済み #N` | 止める |
| closed / completed | `#N 解決済み` | **再発として立てられる** |
| closed / not_planned | `#N 対応しない` | 止める。断られた指摘を蒸し返さない |

## 誰が使うか

| 使い方 | 設定 | 誰として記録されるか |
|---|---|---|
| 一人 | `.env` に `JUSTIC_GITHUB_TOKEN` | `local` |
| 複数 | GitHub OAuth | ログインした本人 |

複数人で使うなら OAuth を設定する。`.env` の PAT は1本しか置けないので、
採否を押した本人が残らず、issue も PAT の持ち主として立つ。

**アクセストークンは DB に置かない。** AES-256-GCM で封をした httpOnly cookie に入れて
ブラウザに持たせる。DB の控えが漏れても資格情報は出ない。鍵は `JUSTIC_SESSION_SECRET`。

OAuth App は GitHub の Settings > Developer settings で作る。
コールバックの欄は **「Redirect URIs」** (旧「Authorization callback URL」)。
`http://127.0.0.1:5180/auth/callback` を入れ、「Allow wildcard matching」は外したままにする。

## 構成

| 場所 | 中身 |
|---|---|
| `web/` | 画面とサーバー。textlint (L1) と観点別 LLM パス (L3) |
| `db/` | スキーマと運用スクリプト (`pg.sh start\|stop\|status\|psql\|backup\|restore`) |
| `tuning/` | 学習データの切り出し、分類器の学習、評価、ONNX 書き出し |
| `docs/` | 要件 |

## 層

| 層 | 担当 | 手段 | 状態 |
|---|---|---|---|
| L1 | 直訳調のうち決定的に書ける分 | textlint | 実装済み |
| L2 | 設計内容のうち決定的に取れる分 | 抽出パーサと突合 | 未着手 |
| L3 | 設計内容の欠陥 | 観点別の LLM パス | D-01 のみ実装 |
| L4 | 直訳調の判定、L3 の採否 | 学習した分類器 | 学習の枠だけ |

## データの集め方

画面で指摘を**採用**または**却下**すると `verdicts` に入る。
これが L4 の教師データになるので、コーパスを外から用意する必要がない。

壊れ方を3つ、設計で塞いである。

- **採否は追記のみ。** 押し直しても前の行は消えない。訂正の履歴が残るので学習データを戻せる。
- **「無視」と「却下」を分ける。** 判断していないものは `labeled_findings` に入らない。閉じただけのものを負例にしない。
- **出し方を記録する。** `exposure` が `ranked` / `random` / `hidden`。出さなかったものは教師にせず、無作為に混ぜた分は区別する。

## 見落としを記録する

採否だけでは precision しか測れない。システムが**出さなかった**指摘を記録しないと
recall の分母が作れない。「本文と注釈」を開くと本文が行番号つきで出るので、
行をクリックして範囲を選び「ここが問題」で登録する。

```sh
cd tuning && ../.venv/bin/python measure_recall.py --aspect D-01 --save
```

**「この観点は全部見た」を押した文書だけ**が集計の対象になる。押していない文書を
混ぜると、注釈ゼロの文書が分子にだけ寄与し recall が自動的に 1.0 に近づく。
注釈が0件でも押してよい。ゼロは「システムが全部拾った」という記録になる。

注釈は `findings` ではなく別表に持つ。`findings` は review 単位なので、
再レビューすると注釈が古い review に取り残されるため。

## 環境

`sudo` を使わずに済ませてある。

```sh
micromamba create -p ./.pg   -c conda-forge postgresql
micromamba create -p ./.node -c conda-forge nodejs
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
cd web && npm install
```

PostgreSQL は port 5433、TCP を開けず Unix ソケットのみ。データは `pgdata/`。

## 控え

```sh
./db/pg.sh backup            # pg_dump -Fc のあと pg_restore --list で可読性を確認
./db/pg.sh restore <file>
```

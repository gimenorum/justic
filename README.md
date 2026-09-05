# justic

生成モデルが書いた設計書をレビューし、**指摘の採用と却下がそのまま学習データになる**仕組み。

検出対象は2つ。**設計内容の欠陥**と**直訳調の日本語**。
要件は [docs/design-review-api-requirements-v2.md](docs/design-review-api-requirements-v2.md) を参照。

## 起動

```sh
./run.sh                 # http://127.0.0.1:5180
JUSTIC_L3=1 ./run.sh     # L3 (設計内容の観点パス) も有効にする
```

L3 は既定で無効。推論サーバーを別プロセスが使っていることがあるため、明示的に有効にしない限り叩かない。

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

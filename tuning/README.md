# tuning

直訳調分類器 (8.1, ModernBERT-Ja) の学習データ作成と学習。
要件は docs/design-review-api-requirements-v2.md 8.1 / 8.3.1。

## 台帳
`negatives.json` — 負例 (人が最初から日本語で書いた技術文書、ChatGPT 公開 2022-11-30 より前の
コミット) の取得元台帳。repo / sha / paths (glob) / format / license / date / why_japanese /
note を記録する (L4-12)。台帳は手で書く。書き換えはこのファイルの目的ではない。

## 手順 (取得 → 分割 → 学習 → 評価)
1. 取得: `python3 fetch_negatives.py` (`--force` で再取得)。rd/rst/adoc は Markdown 相当に
   変換して `data/raw/negative/<owner>__<repo>/<元のパス>.md` に、リポジトリごとの
   `SOURCE.json` (取得ファイル一覧とライセンス等) も書く。取得済みは再取得しない。
   正例 `data/raw/positive/**.md` は生成モデルが書いた文書で、対象外・別途投入する
2. 分割: `python3 prepare_data.py` で `data/{train,valid,test}.jsonl` を作る (文書単位で分割)
3. 学習: `python3 train.py`
4. 評価: `python3 evaluate.py`

変換は完全ではない (地の文が文として残ることが目的)。字下げの定義リストが落ちる場合がある。

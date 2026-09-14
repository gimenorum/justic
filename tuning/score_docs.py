"""Markdown 文書を文単位で採点し、直訳調と判定された文を報告する。

学習済みの直訳調分類器 (runs/translationese/current) を読み込み、文ごとに
label 1 (直訳調) の確率を出す。文書は書き換えない。DB にも API にも触らない。

文の切り出しは prepare_data.py の strip_markdown / to_sentences をそのまま使う。
学習データの文の定義と揃えるため、切り出し方をここで変えない。
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import torch
from transformers import AutoModelForSequenceClassification, AutoTokenizer

sys.path.insert(0, str(Path(__file__).resolve().parent))
from prepare_data import strip_markdown, to_sentences  # noqa: E402

FALLBACK_TOKENIZER = "sbintuitions/modernbert-ja-310m"


def collect_sentences(paths: list[Path]) -> list[dict]:
    """各ファイルを文に切り出す。戻り値は file / sent_idx / sentence の列。"""
    rows: list[dict] = []
    for path in paths:
        text = path.read_text(encoding="utf-8")
        idx = 0
        for para in strip_markdown(text):
            for sent in to_sentences(para):
                rows.append({"file": str(path), "sent_idx": idx, "sentence": sent})
                idx += 1
    return rows


def load_model(checkpoint: Path, device: torch.device):
    """チェックポイントからモデルを読む。tokenizer が無ければベースモデルから読む。"""
    has_tokenizer = (checkpoint / "tokenizer_config.json").exists()
    tokenizer_source = str(checkpoint) if has_tokenizer else FALLBACK_TOKENIZER
    tokenizer = AutoTokenizer.from_pretrained(tokenizer_source)
    model = AutoModelForSequenceClassification.from_pretrained(checkpoint).to(device)
    model.eval()
    return tokenizer, model, tokenizer_source


@torch.no_grad()
def score_all(rows: list[dict], tokenizer, model, device: torch.device,
              max_length: int, batch_size: int) -> list[float]:
    """label 1 (直訳調) の確率をバッチで求める。"""
    scores: list[float] = []
    sentences = [r["sentence"] for r in rows]
    for i in range(0, len(sentences), batch_size):
        batch = sentences[i:i + batch_size]
        enc = tokenizer(batch, padding=True, truncation=True, max_length=max_length,
                         return_tensors="pt")
        enc = {k: v.to(device) for k, v in enc.items()}
        logits = model(**enc).logits.float()
        probs = torch.softmax(logits, dim=-1)[:, 1]
        scores.extend(probs.cpu().tolist())
    return scores


def write_jsonl(path: Path, rows: list[dict]) -> None:
    """一時ファイルに書いてから置き換える。実行中のファイルを直接上書きしない。"""
    tmp = path.with_suffix(path.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    tmp.replace(path)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("docs", nargs="+", type=Path, help="採点する Markdown ファイル")
    ap.add_argument("--checkpoint", type=Path, default=Path("runs/translationese/current"),
                     help="読み込むチェックポイント")
    ap.add_argument("--device", default="cpu", help="既定は cpu。GPU には他のモデルが載っている")
    ap.add_argument("--threshold", type=float, default=0.5, help="直訳調とみなすスコアの下限")
    ap.add_argument("--top", type=int, default=None,
                     help="閾値以上の文を表示する件数の上限。省略時は全件")
    ap.add_argument("--max-length", type=int, default=256, help="学習時と揃える")
    ap.add_argument("--batch-size", type=int, default=16)
    ap.add_argument("--json", type=Path, default=None,
                     help="全文のスコアを JSONL で書き出す先 (file / sent_idx / sentence / score / flagged)")
    args = ap.parse_args()

    for p in args.docs:
        if not p.is_file():
            raise SystemExit(f"{p} が無い")

    t0 = time.time()
    device = torch.device(args.device)
    tokenizer, model, tokenizer_source = load_model(args.checkpoint, device)
    t_load = time.time()

    rows = collect_sentences(args.docs)
    if not rows:
        raise SystemExit("対象文書から文が1つも取れなかった")

    scores = score_all(rows, tokenizer, model, device, args.max_length, args.batch_size)
    for r, s in zip(rows, scores):
        r["score"] = s
        r["flagged"] = s >= args.threshold
    t_score = time.time()

    # 文書ごとの集計。引数で渡された順に出す。
    print(f"{'文書':<45} {'文数':>6} {'閾値以上':>8} {'割合':>7} {'平均':>7}")
    for p in args.docs:
        doc_rows = [r for r in rows if r["file"] == str(p)]
        n = len(doc_rows)
        n_flag = sum(1 for r in doc_rows if r["flagged"])
        mean = sum(r["score"] for r in doc_rows) / n if n else 0.0
        ratio = n_flag / n if n else 0.0
        print(f"{str(p):<45} {n:>6} {n_flag:>8} {ratio:>6.1%} {mean:>7.3f}")

    flagged = sorted((r for r in rows if r["flagged"]), key=lambda r: r["score"], reverse=True)
    shown = flagged if args.top is None else flagged[: args.top]
    print(f"\n閾値 {args.threshold} 以上の文 {len(flagged)} 件"
          + (f" (上位 {len(shown)} 件を表示、残り {len(flagged) - len(shown)} 件)" if len(shown) < len(flagged) else ""))
    for r in shown:
        print(f"{r['score']:.3f}\t{r['file']}\t{r['sentence']}")

    if args.json:
        write_jsonl(args.json, rows)
        print(f"\nJSONL 出力: {args.json} ({len(rows)} 行)")

    t_end = time.time()
    print(f"\nモデル読み込み {t_load - t0:.1f} 秒 / 採点 {t_score - t_load:.1f} 秒 "
          f"/ 合計 {t_end - t0:.1f} 秒 (device={device}, tokenizer={tokenizer_source})")


if __name__ == "__main__":
    main()

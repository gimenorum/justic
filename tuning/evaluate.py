"""学習した分類器を test 集合で測り、閾値を決める。

閾値は severity にマップして露出する (要件 L4-04) ので、
1つの数字ではなく掃引した表を出す。誤判定の実例も出す。
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import torch
from torch.utils.data import DataLoader

from train import Jsonl, make_collate, predict
from transformers import AutoModelForSequenceClassification, AutoTokenizer


def sweep(scores: np.ndarray, labels: np.ndarray) -> list[dict]:
    rows = []
    for t in np.arange(0.05, 1.0, 0.05):
        pred = (scores >= t).astype(int)
        tp = int(((pred == 1) & (labels == 1)).sum())
        fp = int(((pred == 1) & (labels == 0)).sum())
        fn = int(((pred == 0) & (labels == 1)).sum())
        prec = tp / (tp + fp) if tp + fp else 0.0
        rec = tp / (tp + fn) if tp + fn else 0.0
        f1 = 2 * prec * rec / (prec + rec) if prec + rec else 0.0
        rows.append({"threshold": round(float(t), 2), "precision": prec, "recall": rec, "f1": f1, "fp": fp, "fn": fn})
    return rows


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--model", type=Path, default=Path("runs/translationese"))
    ap.add_argument("--data", type=Path, default=Path("data/test.jsonl"))
    ap.add_argument("--max-length", type=int, default=256)
    ap.add_argument("--batch-size", type=int, default=32)
    ap.add_argument("--show", type=int, default=5, help="誤判定を何件表示するか")
    ap.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu")
    args = ap.parse_args()

    device = torch.device(args.device)
    tokenizer = AutoTokenizer.from_pretrained(args.model)
    model = AutoModelForSequenceClassification.from_pretrained(args.model).to(device)

    ds = Jsonl(args.data)
    dl = DataLoader(ds, batch_size=args.batch_size, collate_fn=make_collate(tokenizer, args.max_length))
    scores, labels = predict(model, dl, device)

    from sklearn.metrics import average_precision_score, roc_auc_score
    print(f"件数 {len(labels)}  正例 {int(labels.sum())}  負例 {int((1 - labels).sum())}")
    if labels.min() != labels.max():
        print(f"PR-AUC {average_precision_score(labels, scores):.4f}   ROC-AUC {roc_auc_score(labels, scores):.4f}\n")

    print("閾値      precision  recall     F1      FP    FN")
    for r in sweep(scores, labels):
        print(f"  {r['threshold']:.2f}      {r['precision']:.3f}      {r['recall']:.3f}   {r['f1']:.3f}  {r['fp']:>5} {r['fn']:>5}")

    best = max(sweep(scores, labels), key=lambda r: r["f1"])
    print(f"\nF1 最大の閾値 {best['threshold']:.2f} (P {best['precision']:.3f} / R {best['recall']:.3f})")
    print("severity にマップするときは、warn を precision の高い側、info を recall の側に置く。")

    order = np.argsort(scores)
    fp = [i for i in order[::-1] if labels[i] == 0][: args.show]
    fn = [i for i in order if labels[i] == 1][: args.show]
    print(f"\n--- 自然と付けたのにスコアが高い文 (負例の偽陽性 上位{args.show}) ---")
    for i in fp:
        print(f"  {scores[i]:.3f}  {ds.rows[i]['text'][:90]}")
    print(f"\n--- 直訳調と付けたのにスコアが低い文 (正例の偽陰性 上位{args.show}) ---")
    for i in fn:
        print(f"  {scores[i]:.3f}  {ds.rows[i]['text'][:90]}")
    print("\nこの2つを読んで、ラベルの付け方 (どの文書をどちらに置いたか) が妥当かを確かめる。")


if __name__ == "__main__":
    main()

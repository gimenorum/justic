"""学習した分類器を ONNX に書き出す。

API 側は onnxruntime-node から CPU で呼ぶ (要件 L4-05)。
別サービスを立てず、textlint と同じプロセスに載せる。
"""

from __future__ import annotations

import argparse
from pathlib import Path

import torch
from transformers import AutoModelForSequenceClassification, AutoTokenizer


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--model", type=Path, default=Path("runs/translationese"))
    ap.add_argument("--out", type=Path, default=Path("runs/translationese/model.onnx"))
    ap.add_argument("--max-length", type=int, default=256)
    ap.add_argument("--opset", type=int, default=17)
    args = ap.parse_args()

    tokenizer = AutoTokenizer.from_pretrained(args.model)
    model = AutoModelForSequenceClassification.from_pretrained(args.model).eval()

    sample = tokenizer("不正な入力に対する振る舞いを定義しているか。", return_tensors="pt",
                       padding="max_length", truncation=True, max_length=args.max_length)
    names = [k for k in ("input_ids", "attention_mask") if k in sample]
    inputs = tuple(sample[k] for k in names)

    args.out.parent.mkdir(parents=True, exist_ok=True)
    torch.onnx.export(
        model,
        inputs,
        str(args.out),
        input_names=names,
        output_names=["logits"],
        dynamic_axes={n: {0: "batch", 1: "sequence"} for n in names} | {"logits": {0: "batch"}},
        opset_version=args.opset,
        do_constant_folding=True,
    )
    print(f"書き出し {args.out} ({args.out.stat().st_size / 1e6:.1f} MB)")

    try:
        import numpy as np
        import onnxruntime as ort
    except ImportError:
        print("onnxruntime が無いので照合を省略した。")
        return

    sess = ort.InferenceSession(str(args.out), providers=["CPUExecutionProvider"])
    onnx_logits = sess.run(None, {n: sample[n].numpy() for n in names})[0]
    with torch.no_grad():
        torch_logits = model(**{n: sample[n] for n in names}).logits.numpy()
    diff = float(np.abs(onnx_logits - torch_logits).max())
    print(f"PyTorch との最大差 {diff:.2e}  {'一致' if diff < 1e-3 else '不一致。opset か入力を見直す'}")


if __name__ == "__main__":
    main()

"""直訳調の二値分類器を学習する。

ModernBERT-Ja に分類ヘッドを付け、文単位で「直訳調か」を判定する。
出力はスコアであり、閾値は evaluate.py で決める (要件 L4-04)。

Trainer ではなく素の PyTorch ループで書いてある。transformers の
TrainingArguments は版によって引数名が変わるため、そこに依存させない。

学習は何度でもやり直せる。既存の実行結果を上書きしない。

    runs/<name>/<run_id>/manifest.json   何をどのデータで学習したか
    runs/<name>/<run_id>/epoch-1 .. N    各エポックの重み。任意の時点に戻せる

既定は毎回ベースモデルから学習し直す。モデルがデータの関数になるので、
戻す操作がデータを戻す操作と一致する。前の結果から続けるなら --resume-from を使う。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import platform
import random
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import torch
from torch.utils.data import DataLoader, Dataset
from transformers import AutoModelForSequenceClassification, AutoTokenizer, get_linear_schedule_with_warmup

MODEL_ID = "sbintuitions/modernbert-ja-310m"


class Jsonl(Dataset):
    def __init__(self, path: Path):
        self.path = path
        raw = path.read_text(encoding="utf-8")
        self.fingerprint = hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]
        self.rows = [json.loads(l) for l in raw.splitlines() if l.strip()]
        if not self.rows:
            raise SystemExit(f"{path} が空。先に prepare_data.py を実行する。")

    def __len__(self) -> int:
        return len(self.rows)

    def __getitem__(self, i: int) -> dict:
        return self.rows[i]


def make_collate(tokenizer, max_length: int):
    def collate(batch: list[dict]) -> dict:
        enc = tokenizer(
            [b["text"] for b in batch],
            padding=True,
            truncation=True,
            max_length=max_length,
            return_tensors="pt",
        )
        enc["labels"] = torch.tensor([b["label"] for b in batch], dtype=torch.long)
        return enc
    return collate


@torch.no_grad()
def predict(model, loader, device) -> tuple[np.ndarray, np.ndarray]:
    model.eval()
    scores, labels = [], []
    for batch in loader:
        labels.append(batch.pop("labels").numpy())
        batch = {k: v.to(device) for k, v in batch.items()}
        logits = model(**batch).logits.float()
        scores.append(torch.softmax(logits, dim=-1)[:, 1].cpu().numpy())
    return np.concatenate(scores), np.concatenate(labels)


def pr_auc(scores: np.ndarray, labels: np.ndarray) -> float:
    from sklearn.metrics import average_precision_score
    if labels.min() == labels.max():
        return float("nan")
    return float(average_precision_score(labels, scores))


def set_seed(seed: int) -> None:
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    torch.cuda.manual_seed_all(seed)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--data", type=Path, default=Path("data"))
    ap.add_argument("--runs", type=Path, default=Path("runs"))
    ap.add_argument("--name", default="translationese", help="実験名。runs/<name>/ 以下に積む")
    ap.add_argument("--model", default=MODEL_ID)
    ap.add_argument("--resume-from", type=Path, default=None,
                    help="過去のチェックポイントから続ける。既定はベースモデルから学習し直す")
    ap.add_argument("--epochs", type=int, default=3)
    ap.add_argument("--batch-size", type=int, default=16)
    ap.add_argument("--lr", type=float, default=2e-5)
    ap.add_argument("--max-length", type=int, default=256)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--note", default="", help="manifest に残す一言")
    ap.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu")
    args = ap.parse_args()

    set_seed(args.seed)
    device = torch.device(args.device)
    run_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    run_dir = args.runs / args.name / run_id
    run_dir.mkdir(parents=True, exist_ok=True)

    init_from = str(args.resume_from) if args.resume_from else args.model
    print(f"run_id={run_id}  device={device}  init_from={init_from}")

    # モデルの取得より先にデータを見る。片方のラベルしかないまま
    # 600MB を落としても無駄になる。
    train_ds, valid_ds = Jsonl(args.data / "train.jsonl"), Jsonl(args.data / "valid.jsonl")
    n_pos = sum(r["label"] for r in train_ds.rows)
    n_neg = len(train_ds) - n_pos
    if n_pos == 0 or n_neg == 0:
        raise SystemExit(
            f"train.jsonl のラベルが片方しかない (正例 {n_pos} / 負例 {n_neg})。\n"
            "data/raw/negative に、人が日本語で書いた技術文書を置いてから prepare_data.py を実行する。"
        )

    tokenizer = AutoTokenizer.from_pretrained(init_from)
    model = AutoModelForSequenceClassification.from_pretrained(init_from, num_labels=2).to(device)

    collate = make_collate(tokenizer, args.max_length)
    train_dl = DataLoader(train_ds, batch_size=args.batch_size, shuffle=True, collate_fn=collate)
    valid_dl = DataLoader(valid_ds, batch_size=args.batch_size * 2, collate_fn=collate)

    # 出自でラベルを付けるので、正例と負例の量は揃わない。損失側で補正する。
    weight = torch.tensor(
        [len(train_ds) / (2 * n_neg), len(train_ds) / (2 * n_pos)],
        dtype=torch.float, device=device,
    )
    print(f"train 文 {len(train_ds)} (正例 {n_pos} / 負例 {n_neg})  class_weight={weight.tolist()}")
    loss_fn = torch.nn.CrossEntropyLoss(weight=weight)

    # 何をどのデータで学習したかを残す。これが無いと戻しても再現できない。
    manifest = {
        "run_id": run_id,
        "name": args.name,
        "note": args.note,
        "init_from": init_from,
        "base_model": args.model,
        "resumed": args.resume_from is not None,
        "data": {
            "train": {"path": str(train_ds.path), "sha256_16": train_ds.fingerprint,
                      "n": len(train_ds), "n_pos": n_pos, "n_neg": n_neg},
            "valid": {"path": str(valid_ds.path), "sha256_16": valid_ds.fingerprint, "n": len(valid_ds)},
        },
        "hyperparams": {"epochs": args.epochs, "batch_size": args.batch_size, "lr": args.lr,
                        "max_length": args.max_length, "seed": args.seed},
        "env": {"torch": torch.__version__, "device": str(device), "python": platform.python_version()},
        "epochs": [],
        "best": None,
        "started_at": datetime.now(timezone.utc).isoformat(),
    }

    def save_manifest() -> None:
        (run_dir / "manifest.json").write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")

    save_manifest()

    steps = len(train_dl) * args.epochs
    optim = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=0.01)
    sched = get_linear_schedule_with_warmup(optim, int(steps * 0.1), steps)
    use_bf16 = device.type == "cuda" and torch.cuda.is_bf16_supported()

    best = -1.0
    for epoch in range(1, args.epochs + 1):
        model.train()
        total, t0 = 0.0, time.time()
        for step, batch in enumerate(train_dl, 1):
            labels = batch.pop("labels").to(device)
            batch = {k: v.to(device) for k, v in batch.items()}
            with torch.autocast("cuda", dtype=torch.bfloat16, enabled=use_bf16):
                logits = model(**batch).logits
            loss = loss_fn(logits.float(), labels)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            optim.step()
            sched.step()
            optim.zero_grad(set_to_none=True)
            total += loss.item()
            if step % 50 == 0:
                print(f"  epoch {epoch} step {step}/{len(train_dl)} loss {total / step:.4f}")

        scores, labels = predict(model, valid_dl, device)
        score = pr_auc(scores, labels)
        # 全エポックを残す。最良だけを残すと、後から1つ手前に戻せない。
        ckpt = run_dir / f"epoch-{epoch}"
        model.save_pretrained(ckpt)
        tokenizer.save_pretrained(ckpt)
        manifest["epochs"].append({
            "epoch": epoch, "checkpoint": str(ckpt),
            "train_loss": total / len(train_dl), "valid_pr_auc": score,
            "seconds": round(time.time() - t0, 1),
        })
        if not (score != score) and score > best:  # NaN でない、かつ改善
            best = score
            manifest["best"] = {"epoch": epoch, "checkpoint": str(ckpt), "valid_pr_auc": score}
        save_manifest()
        print(f"epoch {epoch}  train_loss {total / len(train_dl):.4f}  valid_pr_auc {score:.4f}  -> {ckpt}")

    manifest["finished_at"] = datetime.now(timezone.utc).isoformat()
    save_manifest()
    print(f"\n最良 {manifest['best']}\n実行 {run_dir}")


if __name__ == "__main__":
    main()

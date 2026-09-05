"""学習した実行を一覧し、使うチェックポイントを切り替える。

    python runs.py list
    python runs.py use 20260905T231500Z            最良エポックを採用
    python runs.py use 20260905T231500Z --epoch 2  1つ手前に戻す

採用したものは runs/<name>/current.json に記録し、current というリンクを張る。
API はこのリンクを見る。戻す操作はリンクの張り替えだけで、重みは消さない。
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path


def load_runs(base: Path) -> list[dict]:
    out = []
    for m in sorted(base.glob("*/manifest.json")):
        try:
            out.append(json.loads(m.read_text(encoding="utf-8")))
        except json.JSONDecodeError:
            print(f"読めない manifest: {m}")
    return out


def cmd_list(base: Path) -> None:
    runs = load_runs(base)
    if not runs:
        raise SystemExit(f"{base} に実行がない。")
    current = None
    cur_path = base / "current.json"
    if cur_path.exists():
        current = json.loads(cur_path.read_text(encoding="utf-8")).get("checkpoint")

    print(f"{'':2} {'run_id':22} {'最良':>6} {'ep':>3} {'訓練文':>7} {'データ':10} note")
    for r in runs:
        best = r.get("best") or {}
        mark = "*" if current and current.startswith(str(Path(*Path(best.get("checkpoint", "x")).parts[:-1]))) else " "
        auc = f"{best.get('valid_pr_auc', float('nan')):.4f}" if best else "  --  "
        print(f"{mark:2} {r['run_id']:22} {auc:>6} {best.get('epoch', '-'):>3} "
              f"{r['data']['train']['n']:>7} {r['data']['train']['sha256_16'][:10]:10} {r.get('note', '')}")
    print("\n* が現在採用中。各実行の全エポックが残っているので、どこにでも戻せる。")


def cmd_use(base: Path, run_id: str, epoch: int | None) -> None:
    manifest_path = base / run_id / "manifest.json"
    if not manifest_path.exists():
        raise SystemExit(f"{manifest_path} がない。python runs.py list で確認する。")
    m = json.loads(manifest_path.read_text(encoding="utf-8"))

    if epoch is None:
        if not m.get("best"):
            raise SystemExit("この実行には最良エポックが記録されていない。--epoch で指定する。")
        chosen = m["best"]
    else:
        found = [e for e in m["epochs"] if e["epoch"] == epoch]
        if not found:
            have = [e["epoch"] for e in m["epochs"]]
            raise SystemExit(f"epoch {epoch} がない。あるのは {have}。")
        chosen = found[0]

    ckpt = Path(chosen["checkpoint"])
    if not ckpt.is_dir():
        raise SystemExit(f"{ckpt} が無い。重みが消えている。")

    (base / "current.json").write_text(json.dumps({
        "run_id": run_id,
        "epoch": chosen["epoch"],
        "checkpoint": str(ckpt),
        "valid_pr_auc": chosen.get("valid_pr_auc"),
        "data_sha256_16": m["data"]["train"]["sha256_16"],
        "switched_at": datetime.now(timezone.utc).isoformat(),
    }, ensure_ascii=False, indent=2), encoding="utf-8")

    link = base / "current"
    if link.is_symlink() or link.exists():
        link.unlink()
    link.symlink_to(ckpt.resolve(), target_is_directory=True)
    print(f"採用 {run_id} epoch {chosen['epoch']}  PR-AUC {chosen.get('valid_pr_auc')}\n  {link} -> {ckpt}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--runs", type=Path, default=Path("runs"))
    ap.add_argument("--name", default="translationese")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("list")
    p_use = sub.add_parser("use")
    p_use.add_argument("run_id")
    p_use.add_argument("--epoch", type=int, default=None)
    args = ap.parse_args()

    base = args.runs / args.name
    if args.cmd == "list":
        cmd_list(base)
    else:
        cmd_use(base, args.run_id, args.epoch)


if __name__ == "__main__":
    main()

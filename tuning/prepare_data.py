"""Markdown を文単位の学習データ (JSONL) に変換する。

ラベルは出自から付ける。人手のアノテーションを要しない。

    data/raw/positive/**.md   生成モデルが日本語で書いた文書   -> label 1 (直訳調)
    data/raw/negative/**.md   人が日本語で書いた技術文書       -> label 0 (自然)

分割は文ではなく文書の単位で行う。同じ文書の文は互いに相関するため、
文単位で分割すると検証データに訓練データの情報が漏れ、精度を過大評価する。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import unicodedata
from dataclasses import dataclass, asdict
from pathlib import Path

# 文として扱う最短の長さ。これを下回るものは直訳調かどうかを判別できない。
MIN_CHARS = 15
# 長すぎるものは文の切り出しに失敗している可能性が高い。
MAX_CHARS = 300

FENCE = re.compile(r"^\s*(```|~~~)")
HTML_COMMENT = re.compile(r"<!--.*?-->", re.S)
HEADING = re.compile(r"^\s{0,3}#{1,6}\s")
TABLE_ROW = re.compile(r"^\s*\|")
LIST_MARKER = re.compile(r"^\s*(?:[-*+]|\d+[.)])\s+")
QUOTE_MARKER = re.compile(r"^\s*>\s?")
MD_LINK = re.compile(r"\[([^\]]*)\]\([^)]*\)")
MD_IMAGE = re.compile(r"!\[[^\]]*\]\([^)]*\)")
CODE_SPAN = re.compile(r"`([^`]*)`")
EMPHASIS = re.compile(r"\*{1,3}([^*]+)\*{1,3}")
# 文末。閉じ括弧が続く場合はそこまでを一文とする。
SENT_END = re.compile(r"(?<=。)(?![」』）\)])")


@dataclass
class Sample:
    text: str
    label: int
    doc_id: str
    sent_idx: int
    source: str


def strip_markdown(md: str) -> list[str]:
    """Markdown から地の文の段落だけを取り出す。

    コードブロック、見出し、表は落とす。設計書ではこれらが文になっておらず、
    直訳調の判定に使えないため。
    """
    md = HTML_COMMENT.sub("", md)
    paragraphs: list[str] = []
    buf: list[str] = []
    in_fence = False

    for line in md.splitlines():
        if FENCE.match(line):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        if HEADING.match(line) or TABLE_ROW.match(line):
            continue
        if line.startswith("    ") and not buf:  # 字下げによるコードブロック
            continue

        line = QUOTE_MARKER.sub("", line)
        line = LIST_MARKER.sub("", line)
        line = MD_IMAGE.sub("", line)
        line = MD_LINK.sub(r"\1", line)
        line = CODE_SPAN.sub(r"\1", line)
        line = EMPHASIS.sub(r"\1", line)
        line = line.strip()

        if line:
            buf.append(line)
        elif buf:
            paragraphs.append("".join(buf))  # 日本語は行末で連結する。空白を挟まない
            buf = []

    if buf:
        paragraphs.append("".join(buf))
    return paragraphs


def to_sentences(paragraph: str) -> list[str]:
    out = []
    for s in SENT_END.split(paragraph):
        s = unicodedata.normalize("NFKC", s).strip()
        if not s.endswith("。"):
            continue  # 体言止めと見出し的な断片を落とす
        if not (MIN_CHARS <= len(s) <= MAX_CHARS):
            continue
        out.append(s)
    return out


def collect(root: Path, label: int) -> list[Sample]:
    samples: list[Sample] = []
    if not root.is_dir():
        return samples
    for path in sorted(root.rglob("*.md")):
        doc_id = str(path.relative_to(root))
        text = path.read_text(encoding="utf-8")
        idx = 0
        for para in strip_markdown(text):
            for sent in to_sentences(para):
                samples.append(
                    Sample(text=sent, label=label, doc_id=doc_id, sent_idx=idx, source=str(path))
                )
                idx += 1
    return samples


def split_key(doc_id: str) -> float:
    """文書 ID から決定的に [0,1) を作る。実行のたびに分割が変わらないようにする。"""
    h = hashlib.sha256(doc_id.encode("utf-8")).hexdigest()
    return int(h[:8], 16) / 0x1_0000_0000


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--raw", type=Path, default=Path("data/raw"))
    ap.add_argument("--out", type=Path, default=Path("data"))
    ap.add_argument("--valid-ratio", type=float, default=0.15)
    ap.add_argument("--test-ratio", type=float, default=0.15)
    args = ap.parse_args()

    samples = collect(args.raw / "positive", 1) + collect(args.raw / "negative", 0)
    if not samples:
        raise SystemExit(
            f"{args.raw}/positive と {args.raw}/negative に .md がない。\n"
            "positive は生成モデルが書いた文書、negative は人が書いた技術文書を置く。"
        )

    splits: dict[str, list[Sample]] = {"train": [], "valid": [], "test": []}
    for s in samples:
        k = split_key(s.doc_id)
        if k < args.test_ratio:
            splits["test"].append(s)
        elif k < args.test_ratio + args.valid_ratio:
            splits["valid"].append(s)
        else:
            splits["train"].append(s)

    args.out.mkdir(parents=True, exist_ok=True)
    for name, rows in splits.items():
        path = args.out / f"{name}.jsonl"
        with path.open("w", encoding="utf-8") as f:
            for r in rows:
                f.write(json.dumps(asdict(r), ensure_ascii=False) + "\n")
        pos = sum(r.label for r in rows)
        docs = len({r.doc_id for r in rows})
        print(f"{path}  文 {len(rows):>6}  うち正例 {pos:>6}  文書 {docs:>4}")

    n_pos = sum(s.label for s in samples)
    print(f"\n合計 文 {len(samples)}  正例 {n_pos}  負例 {len(samples) - n_pos}")
    if n_pos == 0 or n_pos == len(samples):
        print("警告: 片方のラベルしかない。学習できない。")


if __name__ == "__main__":
    main()

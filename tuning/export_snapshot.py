"""PostgreSQL の採否ログを、学習に使える JSONL に固める。

DB は使うたびに変わる。学習した時点のデータを別に固めておかないと、
チェックポイントを戻しても同じモデルを作り直せない。
書き出しの sha256 は training_snapshots に記録し、
train.py の manifest 側の値と突き合わせられるようにする。

    python export_snapshot.py --kind translationese
    python export_snapshot.py --kind verdict

translationese  直訳調の指摘のうち、採用されたものを正例、却下されたものを負例とする。
                「自然な日本語」のコーパスを外から用意せずに済む。
verdict         L3 の指摘が採用されるかどうかを学ぶ。草案 L4 の後段フィルタ。

どちらも exposure が hidden のものは入らない (labeled_findings が除いている)。
出していないものは判断されていない。
"""

from __future__ import annotations

import argparse
import hashlib
import json
from dataclasses import dataclass
from pathlib import Path

import psycopg

DSN_DEFAULT = "host=/home/oosaw/justic/pgdata port=5433 user=oosaw dbname=justic"

QUERIES = {
    # 文単位。evidence が対象の文そのもの。
    # L1 の文体指摘 (style/*) と L4 の分類器の指摘、どちらも教師になる。
    # 採用された文が直訳調 (正例)、却下された文が自然 (負例)。
    # 「自然な日本語」のコーパスを外から用意せずに済むのはこの経路のため。
    "translationese": """
        select evidence                        as text,
               (verdict = 'accepted')::int     as label,
               document_sha256                 as doc_id,
               finding_id, rule_id, layer, exposure, decided_at
        from labeled_findings
        where (layer = 'L4' or rule_id like 'style/%%')
          and evidence is not null
          and length(evidence) between 15 and 300
        order by finding_id
    """,
    # 指摘単位。採用されるかどうか。
    "verdict": """
        select message                         as text,
               (verdict = 'accepted')::int     as label,
               document_sha256                 as doc_id,
               finding_id, rule_id, layer, severity, evidence, confidence,
               exposure, l3_model_id, prompt_version, decided_at
        from labeled_findings
        where layer in ('L2','L3')
        order by finding_id
    """,
}


def split_key(doc_id: str) -> float:
    return int(hashlib.sha256(doc_id.encode()).hexdigest()[:8], 16) / 0x1_0000_0000


@dataclass
class Written:
    path: Path
    n: int
    n_pos: int
    docs: int


def write_jsonl(path: Path, rows: list[dict]) -> Written:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False, default=str) + "\n")
    return Written(path, len(rows), sum(r["label"] for r in rows), len({r["doc_id"] for r in rows}))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--kind", choices=sorted(QUERIES), required=True)
    ap.add_argument("--dsn", default=DSN_DEFAULT)
    # prepare_data.py が書く data/ を潰さないように分ける。
    # data/        Markdown から起こした初期コーパス
    # data-labeled/ 画面の採否から起こした教師データ
    ap.add_argument("--out", type=Path, default=Path("data-labeled"))
    ap.add_argument("--name", default=None, help="training_snapshots に残す名前。既定は kind")
    ap.add_argument("--run-id", default=None, help="対応させる学習の run_id")
    ap.add_argument("--valid-ratio", type=float, default=0.15)
    ap.add_argument("--test-ratio", type=float, default=0.15)
    ap.add_argument("--note", default="")
    args = ap.parse_args()

    query = QUERIES[args.kind]
    with psycopg.connect(args.dsn) as conn:
        with conn.cursor(row_factory=psycopg.rows.dict_row) as cur:
            cur.execute(query)
            rows = cur.fetchall()

        if not rows:
            raise SystemExit(
                f"kind={args.kind} に該当する採否ログがない。\n"
                "画面で指摘を採用または却下すると溜まる。無視 (判断なし) は入らない。"
            )

        splits: dict[str, list[dict]] = {"train": [], "valid": [], "test": []}
        for r in rows:
            k = split_key(str(r["doc_id"]))
            name = "test" if k < args.test_ratio else "valid" if k < args.test_ratio + args.valid_ratio else "train"
            splits[name].append(r)

        written = {name: write_jsonl(args.out / f"{name}.jsonl", rs) for name, rs in splits.items()}
        for name, w in written.items():
            print(f"{w.path}  {w.n:>6} 件  正例 {w.n_pos:>6}  文書 {w.docs:>4}")

        # 学習に食わせるのは train。manifest 側と突き合わせるのもこれ。
        train_path = written["train"].path
        digest = hashlib.sha256(train_path.read_bytes()).hexdigest()
        with conn.cursor() as cur:
            cur.execute(
                """insert into training_snapshots (name, run_id, kind, query, row_count, sha256, path, note)
                   values (%s, %s, %s, %s, %s, %s, %s, %s) returning id""",
                (args.name or args.kind, args.run_id, args.kind, query.strip(),
                 written["train"].n, digest, str(train_path.resolve()), args.note),
            )
            snap_id = cur.fetchone()[0]
        conn.commit()

    total = sum(w.n for w in written.values())
    pos = sum(w.n_pos for w in written.values())
    print(f"\n合計 {total} 件 (正例 {pos} / 負例 {total - pos})")
    print(f"snapshot id={snap_id}  train sha256={digest[:16]}")
    print("train.py の manifest に出る sha256_16 と、この値が一致していることを確かめる。")
    if pos == 0 or pos == total:
        print("警告: 片方のラベルしかない。学習できない。")


if __name__ == "__main__":
    main()

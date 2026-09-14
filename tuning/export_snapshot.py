"""PostgreSQL の採否ログと文書の出自を、学習に使える JSONL に固める。

DB は使うたびに変わる。学習した時点のデータを別に固めておかないと、
チェックポイントを戻しても同じモデルを作り直せない。
書き出しの sha256 は training_snapshots に記録し、
train.py の manifest 側の値と突き合わせられるようにする。

    python export_snapshot.py --kind translationese
    python export_snapshot.py --kind verdict

translationese  documents.origin でラベルを付ける (要件 L4-02, L4-13)。
                origin='model' の文書の文を正例、'human' の文書の文を負例とする。
                文への分割は prepare_data.py の初期コーパスと同じ処理を使う
                (strip_markdown / to_sentences)。人手のアノテーションを要しない。
verdict         L3 の指摘が採用されるかどうかを学ぶ。草案 L4 の後段フィルタ (8.2)。
                exposure が hidden のものは入らない (labeled_findings が除いている)。
                出していないものは判断されていない。

2026-09-10 追記: translationese は以前 labeled_findings (採否ログ) から
verdict でラベルを付けていたが、レビュー対象は常に生成モデルの文書のため、
指摘を却下しても「人が書いた自然な日本語」にはならず負例が作れなかった
(要件 8.3.1 で正例202・負例0と確認済み)。documents.origin による方式に
置き換えた。8.2 (L3 の採否を学ぶ経路、--kind verdict) は変えていない。
"""

from __future__ import annotations

import argparse
import hashlib
import json
from dataclasses import dataclass
from pathlib import Path

import psycopg

from prepare_data import strip_markdown, to_sentences

DSN_DEFAULT = "host=/home/oosaw/justic/pgdata port=5433 user=oosaw dbname=justic"

KINDS = ("translationese", "verdict")

# verdict のみ。translationese は documents から文単位に組み立てるので
# 固定の SQL を持たない (rows_for_translationese を使う)。
QUERIES = {
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

TRANSLATIONESE_QUERY = """
    select sha256 as doc_id, origin, body
    from documents
    order by id
"""


def rows_for_translationese(cur) -> list[dict]:
    """documents.origin でラベルを付ける (L4-02, L4-13)。

    model → 1 (直訳調の学習対象)、human → 0 (自然な日本語)。
    文への分割は data/ の初期コーパス (prepare_data.py) と同じ処理を再利用する。
    """
    cur.execute(TRANSLATIONESE_QUERY)
    rows: list[dict] = []
    for d in cur.fetchall():
        label = 1 if d["origin"] == "model" else 0
        idx = 0
        for para in strip_markdown(d["body"]):
            for sent in to_sentences(para):
                rows.append({
                    "text": sent, "label": label,
                    "doc_id": d["doc_id"], "sent_idx": idx, "origin": d["origin"],
                })
                idx += 1
    return rows


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
    ap.add_argument("--kind", choices=KINDS, required=True)
    ap.add_argument("--dsn", default=DSN_DEFAULT)
    # prepare_data.py が書く data/ を潰さないように分ける。
    # data/         Markdown から起こした初期コーパス
    # data-labeled/ DB (documents の出自、採否ログ) から起こした教師データ
    ap.add_argument("--out", type=Path, default=Path("data-labeled"))
    ap.add_argument("--name", default=None, help="training_snapshots に残す名前。既定は kind")
    ap.add_argument("--run-id", default=None, help="対応させる学習の run_id")
    ap.add_argument("--valid-ratio", type=float, default=0.15)
    ap.add_argument("--test-ratio", type=float, default=0.15)
    ap.add_argument("--note", default="")
    args = ap.parse_args()

    with psycopg.connect(args.dsn) as conn:
        with conn.cursor(row_factory=psycopg.rows.dict_row) as cur:
            if args.kind == "translationese":
                query = TRANSLATIONESE_QUERY.strip()
                rows = rows_for_translationese(cur)
            else:
                query = QUERIES[args.kind]
                cur.execute(query)
                rows = cur.fetchall()

        if not rows:
            if args.kind == "translationese":
                raise SystemExit(
                    "documents に origin 起点の学習データが無い。\n"
                    "生成モデルの文書 (origin='model') と人が書いた文書 (origin='human') の"
                    "両方が、ある程度の長さの地の文を持っている必要がある。"
                )
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
                (args.name or args.kind, args.run_id, args.kind, query,
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

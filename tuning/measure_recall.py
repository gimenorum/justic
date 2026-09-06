"""recall を測る。docs/design-01-measurement.md の7章。

    python measure_recall.py --aspect D-01
    python measure_recall.py --aspect D-01 --model '(サーバー既定)' --prompt d01-v1
    python measure_recall.py --aspect D-01 --save

前提が4つ揃わなければ計算しない。

    1. 全数注釈済みの印   annotation_completions
    2. 観点 ID           human_annotations.aspect_id (未分類は観点別集計から外す)
    3. 同一判定の規則     行範囲の重なり + 観点の一致
    4. 走った観点の記録   review_aspects

labeled_findings は使わない。あのビューは line も aspect_id も document_id も
返さないため、行範囲の判定も文書の突合もできない。findings に直接当たる。
"""

from __future__ import annotations

import argparse

import psycopg

DSN_DEFAULT = "host=/home/oosaw/justic/pgdata port=5433 user=oosaw dbname=justic"

# 対象: 生きている全数注釈の印が立った文書。
# 分子候補: 本番構成 (exposure='ranked') で出て採用された指摘。
#   exposure='random' は「緩めれば出る」ものであって本番構成の値ではないので除く。
TP_SQL = """
select f.id, r.document_id, f.line,
       coalesce(f.end_line, f.line) as end_line
from findings f
join reviews r         on r.id = f.review_id
join current_verdicts v on v.finding_id = f.id and v.verdict = 'accepted'
join review_aspects ra on ra.review_id = f.review_id and ra.aspect_id = f.aspect_id
join annotation_completions c
     on c.document_id = r.document_id and c.aspect_id = f.aspect_id and c.revoked_at is null
where f.aspect_id = %(aspect)s
  and f.exposure = 'ranked'
  and ra.status = 'ok'
  and r.finished_at is not null
  -- NULL の型を推論できないので明示する
  and (%(model)s::text  is null or ra.model_id       = %(model)s::text)
  and (%(prompt)s::text is null or ra.prompt_version = %(prompt)s::text)
"""

# 分母の残り: 対象文書の生きている注釈。
# 観点が一致するもの、および未分類のもの (設計書 5章)。
ANN_SQL = """
select a.id, a.document_id, a.start_line, a.end_line, a.aspect_id, a.quoted_text
from live_annotations a
join annotation_completions c
     on c.document_id = a.document_id and c.aspect_id = %(aspect)s and c.revoked_at is null
where a.aspect_id = %(aspect)s or a.aspect_id is null
"""

DOCS_SQL = """
select distinct document_id from annotation_completions
where aspect_id = %(aspect)s and revoked_at is null
"""


def overlaps(a: dict, f: dict) -> bool:
    """行範囲が重なれば同一の欠陥とみなす (設計書 7.2)。

    畳まないと、同じ欠陥が分子と分母に二重計上され recall が押し下げられる。
    """
    if f["line"] is None:
        return False
    return a["start_line"] <= f["end_line"] and f["line"] <= a["end_line"]


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--aspect", default="D-01")
    ap.add_argument("--model", default=None, help="ra.model_id で絞る")
    ap.add_argument("--prompt", default=None, help="ra.prompt_version で絞る")
    ap.add_argument("--dsn", default=DSN_DEFAULT)
    ap.add_argument("--save", action="store_true", help="recall_runs に記録する")
    ap.add_argument("--note", default="")
    args = ap.parse_args()

    params = {"aspect": args.aspect, "model": args.model, "prompt": args.prompt}
    with psycopg.connect(args.dsn) as conn:
        with conn.cursor(row_factory=psycopg.rows.dict_row) as cur:
            cur.execute(DOCS_SQL, params)
            docs = [r["document_id"] for r in cur.fetchall()]
            if not docs:
                raise SystemExit(
                    f"観点 {args.aspect} の全数注釈済み文書がない。\n"
                    "画面で「この観点は全部見た」を押すと対象になる。\n"
                    "印が無いまま集計すると、注釈ゼロの文書が分子にだけ寄与し、\n"
                    "recall が自動的に 1.0 に近づく (設計書 3.1)。"
                )
            cur.execute(TP_SQL, params)
            tps = cur.fetchall()
            cur.execute(ANN_SQL, params)
            anns = cur.fetchall()

        by_doc: dict[int, list[dict]] = {}
        for f in tps:
            by_doc.setdefault(f["document_id"], []).append(f)

        fns = [a for a in anns if not any(overlaps(a, f) for f in by_doc.get(a["document_id"], []))]

        tp, fn = len(tps), len(fns)
        recall = tp / (tp + fn) if tp + fn else float("nan")

        print(f"観点 {args.aspect}"
              + (f"  model={args.model}" if args.model else "")
              + (f"  prompt={args.prompt}" if args.prompt else ""))
        print(f"対象 {len(docs)} 文書 (全数注釈済み)")
        print(f"  TP {tp:>4}  システムが出して採用された")
        print(f"  FN {fn:>4}  人が見つけたがシステムが出さなかった")
        print(f"  recall {recall:.4f}")
        print("\nこれは上界。人手注釈も見落とすため、真の欠陥の全数ではない。")

        if fns:
            print(f"\n--- 見落とし {min(len(fns), 10)} 件 ---")
            for a in fns[:10]:
                mark = "" if a["aspect_id"] else "  (観点未分類)"
                print(f"  doc {a['document_id']} L{a['start_line']}-{a['end_line']}{mark}")
                print(f"    {a['quoted_text'][:80]}")

        if args.save:
            with conn.cursor() as cur:
                cur.execute(
                    """insert into recall_runs
                       (aspect_id, model_id, prompt_version, document_ids, annotation_ids,
                        tp, fn, recall, note)
                       values (%s,%s,%s,%s,%s,%s,%s,%s,%s) returning id""",
                    (args.aspect, args.model, args.prompt, docs, [a["id"] for a in anns],
                     tp, fn, recall, args.note),
                )
                run_id = cur.fetchone()[0]
            conn.commit()
            print(f"\nrecall_runs id={run_id} に記録した。"
                  "注釈は追記され続けるので、版を切らないと同じ数字が出ない。")


if __name__ == "__main__":
    main()

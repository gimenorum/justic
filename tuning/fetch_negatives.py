"""台帳 negatives.json をもとに、人が最初から日本語で書いた技術文書を GitHub から取り込む。

要件 docs/design-review-api-requirements-v2.md 8.3.1 L4-12 の負例 (直訳調分類器 8.1 の label 0)。
台帳の各項目 (repo, sha, paths, format ...) について

    1. `gh api repos/O/R/git/trees/SHA?recursive=1` でそのコミットのファイル一覧を取る
    2. paths (glob) に合うものだけ `gh api repos/O/R/contents/PATH?ref=SHA` で取得する
    3. format に応じて地の文中心の Markdown 相当に変換する
    4. data/raw/negative/<owner>__<repo>/<元のパス (拡張子を .md に)> に書く
    5. リポジトリごとに SOURCE.json (取得ファイルの一覧と台帳の項目) を書く

台帳 (negatives.json) はここでは読むだけで変更しない。取得済みのファイルは --force を
付けない限り再取得しない (ネットワークに投げない)。ファイルはその場で上書きせず、
一時ファイルに書いてから置き換える。
"""

from __future__ import annotations

import argparse
import base64
import json
import re
import subprocess
import sys
from collections import defaultdict
from pathlib import Path

GH_TIMEOUT = 60


class FetchError(Exception):
    pass


# ---------------------------------------------------------------------------
# gh api 呼び出し
# ---------------------------------------------------------------------------

def gh_api_json(path: str) -> dict:
    """`gh api <path>` を実行して JSON を返す。失敗したら FetchError。"""
    proc = subprocess.run(
        ["gh", "api", path],
        capture_output=True,
        text=True,
        timeout=GH_TIMEOUT,
    )
    if proc.returncode != 0:
        raise FetchError(f"gh api {path} 失敗: {proc.stderr.strip()}")
    return json.loads(proc.stdout)


def get_tree(repo: str, sha: str) -> list[dict]:
    data = gh_api_json(f"repos/{repo}/git/trees/{sha}?recursive=1")
    if data.get("truncated"):
        print(f"  警告: {repo}@{sha} のツリーが truncated=true。一覧が不完全な可能性がある", file=sys.stderr)
    return [e for e in data.get("tree", []) if e.get("type") == "blob"]


def get_content_bytes(repo: str, path: str, sha: str) -> bytes:
    # パスに含まれる特殊文字 (# など) をエスケープする
    from urllib.parse import quote

    data = gh_api_json(f"repos/{repo}/contents/{quote(path)}?ref={sha}")
    if data.get("encoding") != "base64" or "content" not in data:
        raise FetchError(f"{repo}:{path} の content が base64 で返らなかった (encoding={data.get('encoding')})")
    return base64.b64decode(data["content"])


# ---------------------------------------------------------------------------
# glob マッチ ( ** は 0 個以上のディレクトリにマッチ)
# ---------------------------------------------------------------------------

import fnmatch


def _match_parts(pattern_parts: list[str], path_parts: list[str]) -> bool:
    if not pattern_parts:
        return not path_parts
    head, rest = pattern_parts[0], pattern_parts[1:]
    if head == "**":
        if _match_parts(rest, path_parts):
            return True
        if path_parts and _match_parts(pattern_parts, path_parts[1:]):
            return True
        return False
    if not path_parts:
        return False
    if not fnmatch.fnmatchcase(path_parts[0], head):
        return False
    return _match_parts(rest, path_parts[1:])


def glob_match(pattern: str, path: str) -> bool:
    return _match_parts(pattern.split("/"), path.split("/"))


# ---------------------------------------------------------------------------
# フォーマット別変換。 出力は Markdown 相当の地の文に寄せる。
# 完全な変換である必要はない。地の文が文として残ることを目的とする。
# ---------------------------------------------------------------------------

def new_stats() -> dict:
    return defaultdict(int)


def convert_markdown(text: str) -> tuple[str, dict]:
    return text, new_stats()


# rd (rurema): 見出しは `=` の数が深さ。 ((<表示|URL>)) ((<term>)) (({code})) は表示部分だけ残す。
# 実際の refm/doc/spec/*.rd は [[type:target]] という角括弧の相互参照も使っているので、
# 同じ趣旨で target 部分だけ残す (台帳の rd の説明にはないが、変換の目的 (地の文を保つ) に合わせた)。
# #@ で始まる行 (プリプロセッサ) は落とす。ただし #@samplecode 〜 #@end はコードなので ``` で囲む。
# //emlist{ 〜 //} もコードとして ``` で囲む。
# 字下げ (先頭に空白 2 つ以上) の整形済みブロックは ``` で囲む。

_RD_HEADING = re.compile(r"^(=+)(\[[^\]]*\])?\s+(\S.*)$")
_RD_INDENT = re.compile(r"^ {2,}\S")
_RD_LINK_FULL = re.compile(r"\(\(<([^|>]*)\|[^>]*>\)\)")
_RD_LINK_TERM = re.compile(r"\(\(<([^>]*)>\)\)")
_RD_LINK_CODE = re.compile(r"\(\(\{([^}]*)\}\)\)")
_RD_XREF = re.compile(r"\[\[[a-z]+:([^\]]*)\]\]")


def _rd_inline(s: str) -> str:
    s = _RD_LINK_FULL.sub(r"\1", s)
    s = _RD_LINK_TERM.sub(r"\1", s)
    s = _RD_LINK_CODE.sub(r"\1", s)
    s = _RD_XREF.sub(r"\1", s)
    return s


def convert_rd(text: str) -> tuple[str, dict]:
    stats = new_stats()
    out: list[str] = []
    indent_buf: list[str] = []
    in_samplecode = False
    in_emlist = False

    def flush_indent() -> None:
        if indent_buf:
            out.append("```")
            out.extend(indent_buf)
            out.append("```")
            indent_buf.clear()
            stats["code_blocks"] += 1

    for raw in text.split("\n"):
        line = raw.rstrip()

        if in_emlist:
            if line.strip() == "//}":
                out.append("```")
                in_emlist = False
            else:
                out.append(line)
            continue

        if not in_samplecode and line.strip() == "//emlist{":
            flush_indent()
            out.append("```")
            in_emlist = True
            stats["code_blocks"] += 1
            continue

        if re.match(r"^#@samplecode\b", line):
            flush_indent()
            out.append("```")
            in_samplecode = True
            stats["code_blocks"] += 1
            stats["dropped_directives"] += 1
            continue

        if re.match(r"^#@end\b", line):
            if in_samplecode:
                out.append("```")
                in_samplecode = False
            stats["dropped_directives"] += 1
            continue

        if line.startswith("#@"):
            stats["dropped_directives"] += 1
            continue

        if in_samplecode:
            out.append(line)
            continue

        m = _RD_HEADING.match(line)
        if m:
            flush_indent()
            depth = min(len(m.group(1)), 6)
            out.append("#" * depth + " " + _rd_inline(m.group(3)))
            stats["headings"] += 1
            continue

        if _RD_INDENT.match(line):
            indent_buf.append(line)
            continue

        flush_indent()
        out.append(_rd_inline(line))

    flush_indent()
    return "\n".join(out), stats


# rst (janome): ====/----/~~~~ の下線付き見出しを # に (深さは下線文字の初出順、RST の実際の規則に合わせた)。
# .. code-block:: と、行末が :: で終わる行に続く字下げブロックを ``` で囲む。
# `text <url>`_ は text だけ残す。``literal`` も同様に中身だけ残す。
# .. で始まるディレクティブ行は落とす (code-block はコード化するので例外)。

_RST_UNDERLINE = re.compile(r"^([^\w\s])\1{2,}$")
_RST_LINK = re.compile(r"`([^`<]+?)\s*<[^>]*>`_+")
_RST_NAMED = re.compile(r"`([^`]+)`_+")
_RST_LITERAL = re.compile(r"``([^`]+)``")


def _rst_inline(s: str) -> str:
    s = _RST_LINK.sub(r"\1", s)
    s = _RST_NAMED.sub(r"\1", s)
    s = _RST_LITERAL.sub(r"\1", s)
    return s


def _rst_underline_char(line: str) -> str | None:
    m = _RST_UNDERLINE.match(line.rstrip())
    return m.group(1) if m else None


def _collect_indented_block(lines: list[str], start: int) -> tuple[list[str], int]:
    j = start
    while j < len(lines) and lines[j].strip() == "":
        j += 1
    block: list[str] = []
    pending_blank = False
    while j < len(lines):
        if lines[j].strip() == "":
            pending_blank = True
            j += 1
            continue
        if lines[j].startswith((" ", "\t")):
            if pending_blank:
                block.append("")
                pending_blank = False
            block.append(lines[j])
            j += 1
        else:
            break
    while block and block[-1] == "":
        block.pop()
    return block, j


def convert_rst(text: str) -> tuple[str, dict]:
    stats = new_stats()
    lines = text.split("\n")
    n = len(lines)
    out: list[str] = []
    seen_chars: dict[str, int] = {}
    i = 0

    def heading_depth(ch: str) -> int:
        if ch not in seen_chars:
            seen_chars[ch] = min(len(seen_chars) + 1, 6)
        return seen_chars[ch]

    while i < n:
        line = lines[i].rstrip()

        if re.match(r"^\.\.\s", line) or line == "..":
            if re.match(r"^\.\.\s+code-block::", line):
                j = i + 1
                while j < n and lines[j].strip() == "":
                    j += 1
                while j < n and re.match(r"^\s+:\S+:", lines[j]):
                    j += 1
                block, j = _collect_indented_block(lines, j)
                if block:
                    out.append("```")
                    out.extend(l.strip() for l in block)
                    out.append("```")
                    stats["code_blocks"] += 1
                stats["dropped_directives"] += 1
                i = j
                continue
            stats["dropped_directives"] += 1
            i += 1
            continue

        # フィールドリスト (:description: ... など)。ディレクティブのオプションで地の文ではない。
        # ディレクティブ行自体は上で落ちるが、その下のフィールド行は個別の行なので別に落とす
        # (実物の .. meta:: の下で見つかったため追加した)。
        if re.match(r"^\s+:[^:\s][^:]*:(\s|$)", line):
            stats["dropped_directives"] += 1
            i += 1
            continue

        # 見出し: over+text+under、または text+under
        u_here = _rst_underline_char(line)
        if u_here and i + 2 < n and lines[i + 1].strip() != "" and _rst_underline_char(lines[i + 2]) == u_here:
            title = lines[i + 1].strip()
            depth = heading_depth(u_here)
            out.append("#" * depth + " " + _rst_inline(title))
            stats["headings"] += 1
            i += 3
            continue

        if line.strip() and not u_here and i + 1 < n:
            u_next = _rst_underline_char(lines[i + 1])
            if u_next and len(lines[i + 1].rstrip()) >= 3:
                depth = heading_depth(u_next)
                out.append("#" * depth + " " + _rst_inline(line.strip()))
                stats["headings"] += 1
                i += 2
                continue

        if line.endswith("::"):
            text_part = line[:-2].rstrip()
            block, j = _collect_indented_block(lines, i + 1)
            if text_part:
                out.append(_rst_inline(text_part))
            if block:
                out.append("```")
                out.extend(block)
                out.append("```")
                stats["code_blocks"] += 1
            i = j
            continue

        out.append(_rst_inline(line))
        i += 1

    return "\n".join(out), stats


# adoc (promises-book): == 見出し を # に。 [source,...] + ---- のブロックを ``` で囲む。
# include:: 行と ifdef::/endif:: は落とす。 <<ref,text>> は text、<<ref>> は ref。 link:url[text] は text。
# __text__ (AsciiDoc の強調) は地の文に強調記号がそのまま残ってしまうので中身だけ残す
# (台帳の adoc の説明にはないが、実物 (promise-then.adoc) に多用されていたため追加した)。
# ==== (example) や ____ (quote) などのブロック区切り行 (例: [NOTE]\n====\n本文\n====) も
# そのままだと直前直後の段落と地続きになり文の先頭に "====" が残ってしまうため、
# 単独行がその区切り文字だけの場合は落とす (これも実物で見つけたため追加した)。

_ADOC_HEADING = re.compile(r"^(=+)\s+(\S.*)$")
_ADOC_XREF2 = re.compile(r"<<([^,>]+),([^>]+)>>")
_ADOC_XREF1 = re.compile(r"<<([^>]+)>>")
_ADOC_LINK = re.compile(r"link:\S*?\[([^\]]*)\]")
_ADOC_EMPH2 = re.compile(r"__([^_]+)__")
_ADOC_ANCHOR_LINE = re.compile(r"^\[\[[^\]]*\]\]$")
_ADOC_ATTR_LINE = re.compile(r"^\[[^\[\]]*\]$")
_ADOC_DELIM_LINE = re.compile(r"^([=\-*._/])\1{3,}$")


def _adoc_inline(s: str) -> str:
    s = _ADOC_XREF2.sub(lambda m: m.group(2).strip(), s)
    s = _ADOC_XREF1.sub(r"\1", s)
    s = _ADOC_LINK.sub(r"\1", s)
    s = _ADOC_EMPH2.sub(r"\1", s)
    return s


def convert_adoc(text: str) -> tuple[str, dict]:
    stats = new_stats()
    lines = text.split("\n")
    n = len(lines)
    out: list[str] = []
    i = 0

    while i < n:
        line = lines[i].rstrip()

        if line.startswith("include::"):
            stats["dropped_directives"] += 1
            i += 1
            continue
        if line.startswith("ifdef::") or line.startswith("endif::"):
            stats["dropped_directives"] += 1
            i += 1
            continue
        if line.startswith("image::"):
            stats["dropped_directives"] += 1
            i += 1
            continue

        m = _ADOC_HEADING.match(line)
        if m:
            depth = max(1, min(len(m.group(1)) - 1, 6))
            out.append("#" * depth + " " + _adoc_inline(m.group(2)))
            stats["headings"] += 1
            i += 1
            continue

        if line.startswith("[source"):
            # 続くキャプション (.xxx) やアンカー ([[xxx]]) を読み飛ばして最初の ---- を探す
            j = i + 1
            while j < n and lines[j].strip() != "----" and not lines[j].startswith("----"):
                if lines[j].strip() == "":
                    j += 1
                    continue
                if lines[j].startswith(".") or _ADOC_ANCHOR_LINE.match(lines[j].strip()) or _ADOC_ATTR_LINE.match(lines[j].strip()):
                    j += 1
                    continue
                break  # [source,...] の直後が期待した形でない。深追いしない
            if j < n and lines[j].rstrip() == "----":
                k = j + 1
                block = []
                while k < n and lines[k].rstrip() != "----":
                    block.append(lines[k])
                    k += 1
                out.append("```")
                out.extend(block)
                out.append("```")
                stats["code_blocks"] += 1
                i = k + 1 if k < n else k
                continue
            # 期待した形にならなかった場合はこの行だけ属性行として落とす
            stats["dropped_directives"] += 1
            i += 1
            continue

        if _ADOC_ANCHOR_LINE.match(line.strip()) or _ADOC_ATTR_LINE.match(line.strip()):
            stats["dropped_directives"] += 1
            i += 1
            continue

        if _ADOC_DELIM_LINE.match(line.strip()):
            stats["dropped_directives"] += 1
            i += 1
            continue

        out.append(_adoc_inline(line))
        i += 1

    return "\n".join(out), stats


CONVERTERS = {
    "markdown": convert_markdown,
    "rd": convert_rd,
    "rst": convert_rst,
    "adoc": convert_adoc,
}


# ---------------------------------------------------------------------------
# 書き込み。その場で上書きせず一時ファイルに書いて置き換える。
# ---------------------------------------------------------------------------

def atomic_write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(content, encoding="utf-8")
    tmp.replace(path)


def atomic_write_json(path: Path, obj) -> None:
    atomic_write_text(path, json.dumps(obj, ensure_ascii=False, indent=2) + "\n")


# ---------------------------------------------------------------------------
# 台帳
# ---------------------------------------------------------------------------

REQUIRED_KEYS = {"repo", "sha", "paths", "format"}


def load_ledger(path: Path) -> list[dict]:
    try:
        raw = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        raise FetchError(f"台帳が無い: {path}")
    try:
        items = json.loads(raw)
    except json.JSONDecodeError as e:
        raise FetchError(f"台帳 {path} が JSON として壊れている: {e}")
    if not isinstance(items, list):
        raise FetchError(f"台帳 {path} はリストである必要がある")
    for i, item in enumerate(items):
        missing = REQUIRED_KEYS - item.keys()
        if missing:
            raise FetchError(f"台帳 {path} の {i} 番目の項目にキーが足りない: {missing}")
        if item["format"] not in CONVERTERS:
            raise FetchError(f"台帳 {path} の {i} 番目 ({item['repo']}) の format が未対応: {item['format']}")
    return items


# ---------------------------------------------------------------------------
# メイン処理
# ---------------------------------------------------------------------------

def process_repo(item: dict, out_root: Path, force: bool) -> dict:
    repo = item["repo"]
    sha = item["sha"]
    fmt = item["format"]
    owner, _, name = repo.partition("/")
    dest_dir = out_root / f"{owner}__{name}"

    result = {
        "repo": repo, "sha": sha, "matched": 0, "fetched": 0, "skipped": 0,
        "failed": [], "bytes": 0, "stats": new_stats(), "files": [],
    }

    try:
        blobs = get_tree(repo, sha)
    except FetchError as e:
        result["failed"].append(f"[tree] {e}")
        return result

    patterns = item["paths"]
    matched = [b for b in blobs if any(glob_match(p, b["path"]) for p in patterns)]
    result["matched"] = len(matched)

    for blob in sorted(matched, key=lambda b: b["path"]):
        src_path = blob["path"]
        dest_rel = Path(src_path).with_suffix(".md")
        dest_path = dest_dir / dest_rel
        result["bytes"] += blob["size"]

        file_entry = {"path": src_path, "bytes": blob["size"], "sha": blob["sha"], "dest": str(dest_rel)}
        result["files"].append(file_entry)

        if dest_path.exists() and not force:
            result["skipped"] += 1
            continue

        try:
            raw = get_content_bytes(repo, src_path, sha)
        except FetchError as e:
            result["failed"].append(f"[content] {src_path}: {e}")
            continue

        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError as e:
            result["failed"].append(f"[decode] {src_path}: {e}")
            continue

        converted, stats = CONVERTERS[fmt](text)
        for k, v in stats.items():
            result["stats"][k] += v

        atomic_write_text(dest_path, converted)
        result["fetched"] += 1

    source_json = dest_dir / "SOURCE.json"
    if result["files"]:
        atomic_write_json(source_json, {"ledger": item, "files": result["files"]})

    return result


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--ledger", type=Path, default=Path("negatives.json"))
    ap.add_argument("--out", type=Path, default=Path("data/raw/negative"))
    ap.add_argument("--force", action="store_true", help="取得済みでも上書きして再取得する")
    args = ap.parse_args()

    try:
        items = load_ledger(args.ledger)
    except FetchError as e:
        print(f"エラー: {e}", file=sys.stderr)
        raise SystemExit(1)

    total_fetched = total_skipped = total_bytes = 0
    all_failed: list[str] = []

    for item in items:
        r = process_repo(item, args.out, args.force)
        total_fetched += r["fetched"]
        total_skipped += r["skipped"]
        total_bytes += r["bytes"]
        all_failed.extend(f"{r['repo']}: {msg}" for msg in r["failed"])

        stats_s = ", ".join(f"{k} {v}" for k, v in sorted(r["stats"].items())) or "-"
        print(
            f"{r['repo']:35s} 一致 {r['matched']:3d}  取得 {r['fetched']:3d}  "
            f"スキップ {r['skipped']:3d}  失敗 {len(r['failed']):2d}  "
            f"{r['bytes']:7d} bytes  変換: {stats_s}"
        )

    print(f"\n合計  取得 {total_fetched}  スキップ (取得済み) {total_skipped}  {total_bytes} bytes")
    if all_failed:
        print("\n失敗:")
        for msg in all_failed:
            print(f"  {msg}")
        raise SystemExit(1)


if __name__ == "__main__":
    main()

#!/usr/bin/env bash
# justic を起動する。PostgreSQL が止まっていれば先に上げる。
#
#   ./run.sh            画面を開く (http://127.0.0.1:5180)
#   JUSTIC_L3=1 ./run.sh   L3 (設計内容の観点パス) も有効にする
#
# L3 は既定で無効。推論サーバーを別プロセスが使っていることがあるため、
# 明示的に有効にしない限り叩かない。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PATH="$ROOT/.node/bin:$PATH"

if ! "$ROOT/.pg/bin/pg_ctl" -D "$ROOT/pgdata" status >/dev/null 2>&1; then
    echo "PostgreSQL を起動する"
    "$ROOT/db/pg.sh" start
fi

echo "L3: ${JUSTIC_L3:-0}  (1 で有効)"
cd "$ROOT/web"
exec node server.js

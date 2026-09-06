#!/usr/bin/env bash
# justic を起動する。PostgreSQL が止まっていれば先に上げる。
#
#   ./run.sh              画面を開く (http://127.0.0.1:5180)
#   JUSTIC_L3=0 ./run.sh   設計チェック (LLM) を切る
#
# 設計チェックはこの道具の本体なので既定で有効。
# 推論サーバーが居なければ文体チェックの結果だけを返し、理由を画面に出す。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PATH="$ROOT/.node/bin:$PATH"

if ! "$ROOT/.pg/bin/pg_ctl" -D "$ROOT/pgdata" status >/dev/null 2>&1; then
    echo "PostgreSQL を起動する"
    "$ROOT/db/pg.sh" start
fi

echo "設計チェック(LLM): ${JUSTIC_L3:-1}  (0 で切る)"
cd "$ROOT/web"
# .env があれば読む (GitHub の PAT など)。node 本体の機能で、依存は増やさない。
if [ -f "$ROOT/.env" ]; then
    exec node --env-file="$ROOT/.env" server.js
else
    exec node server.js
fi

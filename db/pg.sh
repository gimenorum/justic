#!/usr/bin/env bash
# プロジェクト内の PostgreSQL を操作する。
#
#   ./db/pg.sh start | stop | status | psql | backup | restore <file>
#
# TCP は開けていない。Unix ソケットは $PGDATA に置く。
# 外から繋がらないので、認証は trust のままにしてある。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGBIN="$ROOT/.pg/bin"
export PGDATA="$ROOT/pgdata"
export PGPORT=5433
export PGDATABASE=justic
export PGUSER=oosaw
BACKUP_DIR="$ROOT/db/backups"
KEEP=14

psql_() { "$PGBIN/psql" -h "$PGDATA" -p "$PGPORT" -U "$PGUSER" "$@"; }

case "${1:-}" in
start)
    "$PGBIN/pg_ctl" -D "$PGDATA" \
        -o "-p $PGPORT -k $PGDATA -c listen_addresses=" \
        -l "$PGDATA/server.log" start
    ;;
stop)
    # fast は走行中のトランザクションを巻き戻して落とす。immediate は使わない
    # (次回起動時に復旧処理が入り、壊れたように見えるため)。
    "$PGBIN/pg_ctl" -D "$PGDATA" -m fast stop
    ;;
status)
    "$PGBIN/pg_ctl" -D "$PGDATA" status || true
    psql_ -d "$PGDATABASE" -c "select count(*) as documents from documents" \
        -c "select layer, count(*) from findings group by layer order by layer" \
        -c "select verdict, count(*) from current_verdicts group by verdict" 2>/dev/null || true
    ;;
psql)
    shift
    psql_ -d "$PGDATABASE" "$@"
    ;;
backup)
    # 壊れたときに戻せるかどうかを決めるのは、エンジンではなくこれ。
    mkdir -p "$BACKUP_DIR"
    out="$BACKUP_DIR/justic-$(date -u +%Y%m%dT%H%M%SZ).dump"
    "$PGBIN/pg_dump" -h "$PGDATA" -p "$PGPORT" -U "$PGUSER" -Fc -d "$PGDATABASE" -f "$out"
    "$PGBIN/pg_restore" --list "$out" > /dev/null   # 読めることまで確かめる
    echo "backup $out ($(du -h "$out" | cut -f1))"
    ls -1t "$BACKUP_DIR"/justic-*.dump 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do
        echo "  古い控えを削除 $old"; rm -f "$old"
    done
    ;;
restore)
    file="${2:?restore するファイルを指定する}"
    echo "$PGDATABASE を $file で置き換える。中身は失われる。"
    read -r -p "続けるなら yes と入力: " ans
    [ "$ans" = "yes" ] || { echo "中止"; exit 1; }
    "$PGBIN/dropdb" -h "$PGDATA" -p "$PGPORT" -U "$PGUSER" --if-exists "$PGDATABASE"
    "$PGBIN/createdb" -h "$PGDATA" -p "$PGPORT" -U "$PGUSER" "$PGDATABASE"
    "$PGBIN/pg_restore" -h "$PGDATA" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" "$file"
    echo "restore 完了"
    ;;
*)
    sed -n '2,8p' "${BASH_SOURCE[0]}"
    exit 1
    ;;
esac

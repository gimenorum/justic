-- 測定の再現性。docs/design-01-measurement.md の 6.4。
--
-- 注釈は追記され続けるので、日をまたぐと同じ数字が出ない。
-- 段階導入の門番が「D-01 の precision / recall が出ていること」を条件にする以上、
-- 判断の根拠になる数字は再現できなければならない (要件 EV-04, EV-05)。
--
-- training_snapshots には混ぜない。あちらは学習データの版で、分割と sha256 突合を持つ。
-- 測定はどちらも要らず、必要なのは対象集合の固定である。

begin;

create table if not exists recall_runs (
    id             bigserial primary key,
    aspect_id      text not null references aspects on delete restrict,
    model_id       text,
    prompt_version text,
    document_ids   bigint[] not null,      -- 対象にした文書
    annotation_ids bigint[] not null,      -- 分母に使った注釈
    tp             int    not null,
    fn             int    not null,
    recall         double precision not null,
    note           text,
    created_at     timestamptz not null default now()
);

commit;

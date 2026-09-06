-- 未検知の記録。docs/design-01-measurement.md の 6.3。
--
-- 人手注釈は findings に入れない。理由は3つ (設計書 2.1)。
--   (a) findings は review 単位。再レビューすると注釈が古い review に取り残される
--   (b) findings.layer は要件 §10 で L1..L4 と型付けされている。SARIF 変換が壊れる
--   (c) labeled_findings は current_verdicts と内部結合しており、採否を持たない行は通らない
--
-- 外部キーはすべて restrict。注釈と印は測定の基準なので、
-- 親を消して静かに消えてはいけない。

begin;

create table if not exists human_annotations (
    id          bigserial primary key,
    -- 注釈は文書の「版」に付く。自動で新版へ引き継がない (設計書 00 の 4.2c)
    document_id bigint not null references documents on delete restrict,
    start_line  int    not null,
    end_line    int    not null,
    quoted_text text   not null,           -- 版が変わったときの照合候補
    -- 登録時は任意。後からまとめて分類する (設計書 5章)
    aspect_id   text   references aspects on delete restrict,
    note        text,
    -- 誰が総ざらいしたかは測定の前提。NULL を許す理由がない
    user_id     bigint not null references users on delete restrict,
    created_at  timestamptz not null default now(),
    check (start_line <= end_line)
);
create index if not exists human_annotations_doc_idx
    on human_annotations (document_id, aspect_id);

-- 取り消しは追記。物理削除しない (schema.sql の方針1)
create table if not exists human_annotation_events (
    id            bigserial primary key,
    annotation_id bigint not null references human_annotations on delete cascade,
    action        text   not null check (action in ('created','retracted','restored')),
    user_id       bigint not null references users on delete restrict,
    note          text,
    created_at    timestamptz not null default now()
);
create index if not exists human_annotation_events_idx
    on human_annotation_events (annotation_id, created_at desc, id desc);

-- 全数注釈済みの印。(文書, 観点) ごと。
-- 「全部」という値は持たない。観点が増えたときに嘘になるため (設計書 3.4)。
-- 注釈0件でも立てられる。ゼロは recall=1.0 側の標本 (設計書 3.3)。
create table if not exists annotation_completions (
    id           bigserial primary key,
    document_id  bigint not null references documents on delete restrict,
    aspect_id    text   not null references aspects on delete restrict,
    user_id      bigint not null references users on delete restrict,
    completed_at timestamptz not null default now(),
    revoked_at   timestamptz,
    unique (document_id, aspect_id, user_id)
);
create index if not exists annotation_completions_live_idx
    on annotation_completions (aspect_id, document_id) where revoked_at is null;

-- 生きている注釈。events が無いものは生きている扱い
create or replace view live_annotations as
select a.*
from human_annotations a
where coalesce((
    select e.action from human_annotation_events e
    where e.annotation_id = a.id
    order by e.created_at desc, e.id desc limit 1
), 'created') <> 'retracted';

commit;

-- 測定の土台。docs/design-01-measurement.md の 6.2。
--
-- 観点 ID の台帳、文書の論理的な同一性、指摘と観点の結びつけ、
-- 観点ごとの実行記録。

begin;

-- 観点の台帳 (docs/design-00-overview.md の 4.1)。
-- 4箇所が同じ ID 空間を参照する。自由記述の text にすると、表記ゆれ1件で
-- 結合が静かに外れ、recall が下がったように見える。
create table if not exists aspects (
    id         text primary key,
    prefix     text not null,
    title      text not null,
    question   text not null,
    applies_to text[] not null default array['*'],
    unit       text not null default 'document' check (unit in ('document','span')),
    added_at   timestamptz not null default now(),
    -- 廃止しても行は消さない。過去の findings と completions が参照する
    retired_at timestamptz
);

insert into aspects (id, prefix, title, question) values
('D-01', 'D', '異常系の未定義',
 '不正な入力・失敗・例外に対する振る舞いを定義しているか。' ||
 '定義せずに結果だけを書いている箇所、および失敗時の扱いに触れていない処理の記述を挙げよ。')
on conflict (id) do nothing;

-- 同じファイルの別の版を辿る (docs/design-00-overview.md の 4.2)。
-- documents は本文 hash で一意なので、文書が直ると別行になる。
create table if not exists document_keys (
    id         bigserial primary key,
    repo       text,                       -- 'owner/name'。貼り付けは NULL
    path       text,
    created_at timestamptz not null default now(),
    unique (repo, path)
);

alter table documents add column if not exists document_key_id bigint
    references document_keys on delete set null;
create index if not exists documents_key_idx on documents (document_key_id, created_at desc);

-- どの観点で出た指摘か。観点別 precision に要る (要件 EV-02)
alter table findings add column if not exists aspect_id text
    references aspects on delete restrict;
create index if not exists findings_aspect_idx on findings (aspect_id);

-- 既存の L3 指摘は D-01 しか無い
update findings set aspect_id = 'D-01' where layer = 'L3' and aspect_id is null;

-- 観点ごとの実行記録。findings の有無と独立に残す。
-- 失敗した観点は findings 行を作らないので、これが無いと「走った観点」を復元できない。
create table if not exists review_aspects (
    review_id      bigint not null references reviews on delete cascade,
    aspect_id      text   not null references aspects on delete restrict,
    status         text   not null
                   check (status in ('ok','empty','timeout','parse_error','error','skipped')),
    findings_n     int    not null default 0,
    -- 観点ごとにモデルを変える (要件 §7 は D-08 に Opus 5)。review 単位では足りない
    model_id       text,
    prompt_version text,
    error          text,
    started_at     timestamptz,
    finished_at    timestamptz,
    primary key (review_id, aspect_id)
);

-- ブランチ走査を PR として記録していた。CHECK は追加できないので貼り直す。
alter table reviews drop constraint if exists reviews_source_kind_check;
update reviews set source_kind = 'github_branch'
 where source_kind = 'github_pr' and source_ref ? 'ref';
alter table reviews add constraint reviews_source_kind_check
    check (source_kind in ('paste','github_pr','github_branch'));

commit;

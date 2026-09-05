-- レビューの出どころを残す。
-- 貼り付けた本文なのか、GitHub の PR なのかを区別できないと、
-- 教師データがどの文書から来たのかを後から辿れない。

begin;

alter table reviews
    add column if not exists source_kind text not null default 'paste'
        check (source_kind in ('paste', 'github_pr')),
    add column if not exists source_ref jsonb;

-- source_ref の中身 (github_pr のとき)
--   {"owner":..., "repo":..., "number":..., "head_sha":..., "path":..., "html_url":...}
create index if not exists reviews_source_idx on reviews (source_kind);
create index if not exists reviews_source_ref_idx on reviews using gin (source_ref);

-- 指摘が差分の中にあるかどうか。
-- PR では、その PR が持ち込んだ行の指摘と、もとからあった行の指摘を分けて出す。
alter table findings
    add column if not exists in_diff boolean;

commit;

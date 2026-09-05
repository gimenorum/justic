-- 起票した issue を覚えておく。
-- 同じ指摘から二度立てないための鍵が marker。
-- 走査は何度でも回すので、これが無いと同じ issue が積み上がる。

begin;

create table if not exists github_issues (
    id          bigserial primary key,
    owner       text        not null,
    repo        text        not null,
    number      int         not null,
    html_url    text        not null,
    title       text        not null,
    -- owner/repo/path/rule_id/evidence から決まる。本文にも埋めるので検索でも当たる。
    marker      text        not null,
    finding_ids bigint[]    not null,
    created_at  timestamptz not null default now(),
    unique (owner, repo, marker)
);

create index if not exists github_issues_marker_idx on github_issues (marker);

commit;

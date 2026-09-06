-- 人手注釈からの起票。
--
-- finding_ids は findings の id 配列。注釈の id をそのまま混ぜると別物を指す
-- (集計クエリで実際に誤って突き合わせた)。列を分ける。

begin;

alter table github_issues
    add column if not exists annotation_ids bigint[] not null default '{}';

create index if not exists github_issues_annotation_idx
    on github_issues using gin (annotation_ids);

commit;

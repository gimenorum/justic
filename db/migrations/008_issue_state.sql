-- 起票の重複判定に、GitHub 側の状態を入れる。
--
-- これまでは (owner, repo, marker) を一意にしていたので、
-- 一度直して閉じた指摘が再発しても新しい issue を立てられなかった。
--
-- marker は「どの問題か」を指す鍵であって「issue そのもの」ではない。
-- 同じ問題が時間をおいて再発すれば issue は複数あってよい。
-- 一意制約を外し、最後に立てたものを見て判断する。

begin;

alter table github_issues
    add column if not exists state            text not null default 'open',
    add column if not exists state_checked_at timestamptz;

alter table github_issues drop constraint if exists github_issues_owner_repo_marker_key;

create index if not exists github_issues_marker_latest_idx
    on github_issues (owner, repo, marker, created_at desc);

commit;

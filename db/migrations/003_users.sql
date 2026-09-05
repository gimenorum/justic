-- 利用者。GitHub の OAuth で入る。
--
-- アクセストークンはここに置かない。暗号化した cookie に入れてブラウザに持たせる。
-- DB に置くと、漏れたときに全員ぶんのトークンが一度に出る。
-- 置かなければ、DB の控えを取り違えても資格情報は出ない。

begin;

create table if not exists users (
    id          bigserial   primary key,
    github_id   bigint      not null unique,
    login       text        not null,
    name        text,
    avatar_url  text,
    created_at  timestamptz not null default now(),
    last_seen_at timestamptz not null default now()
);

-- 誰が押したかを users に繋ぐ。既存の行は 'local' のまま残す。
alter table verdicts add column if not exists user_id bigint references users on delete set null;
create index if not exists verdicts_user_idx on verdicts (user_id, decided_at desc);

-- 起票した本人。
alter table github_issues add column if not exists user_id bigint references users on delete set null;

commit;

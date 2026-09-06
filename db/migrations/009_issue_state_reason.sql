-- close の理由を記録する。
--
-- GitHub の close には理由がある。not_planned は「直さないと決めた」という意味で、
-- completed とは扱いが違う。state だけを見ていると、断られた指摘を
-- 「再発」として立て直してしまう。
--
-- 併せて、起票時に確認時刻を入れる。入れないと立てた直後から stale 扱いになり、
-- 次の要求で必ず GitHub を叩く。

begin;

alter table github_issues
    add column if not exists state_reason text,
    -- 取得に失敗した時刻。成功と分けて持ち、届かない issue を毎回叩かないようにする
    add column if not exists state_error_at timestamptz;

-- 既存行は「確認済み」にしておく。立てた直後の再確認を避ける
update github_issues set state_checked_at = coalesce(state_checked_at, created_at);

commit;

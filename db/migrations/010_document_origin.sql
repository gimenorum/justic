-- 出自 (生成モデルが書いたか、人が書いたか) の列。
-- 学習データの正例・負例を出自で振り分ける前提になる (要件 8.3.1 の L4-02, L4-13)。
--
-- 既存行はすべて生成モデルが書いた設計書なので、既定 'model' で問題ない。
-- L4-14 (出自導入時に既存の記録を初期化する) はこの移行の対象外。今回は L4-13 のみ実装する。

begin;

alter table documents
    add column if not exists origin text not null default 'model'
        check (origin in ('model', 'human'));

commit;

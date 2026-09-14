-- docs/design-05-llm-endpoints.md の 10章。本書は 02 より先に入る (1.2、10.4)。

begin;

-- 本文を送った先の名前 (3.2)。
-- 送っていない行 (キャッシュの写し、skipped) は NULL のまま (7.4)
alter table review_aspects add column if not exists endpoint text;

-- そのとき外部だったか (7.3)。設定ファイルを後から書き換えても
-- 過去の記録の意味が変わらないように、参照ではなく値を持つ
alter table review_aspects add column if not exists endpoint_external boolean;

-- 応答の choices[0].finish_reason をそのまま。'length' は途中で切れた印 (8.5)。
-- status の CHECK は増やさない
alter table review_aspects add column if not exists finish_reason text;

-- usage から。集計に使う4つを列にし、残りは usage_raw に置く (10.2)
alter table review_aspects add column if not exists prompt_tokens int;
alter table review_aspects add column if not exists completion_tokens int;
-- 接続先が課金した額。単位は接続先による (OpenRouter は credits。EP-07)。
-- 手元のルーターは返さないので NULL
alter table review_aspects add column if not exists cost numeric(12,6);
alter table review_aspects add column if not exists usage_raw jsonb;

-- 「どの文書が外に出たか」(7.4)。外へ出した行は一部なので部分索引で足りる
create index if not exists review_aspects_external_idx
    on review_aspects (started_at desc) where endpoint_external;

-- キャッシュ用の索引はここで張らない。キャッシュは 02 が作るものなので、
-- 02 の移行が endpoint を含む形で最初から張る (11.3)

commit;

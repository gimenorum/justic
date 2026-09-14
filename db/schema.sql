-- 設計書レビュー: 指摘と採否の保存先
--
-- 方針は3つ。
--   1. 採否は追記のみ。UPDATE で書き換えない。訂正は新しい行を足す。
--      間違えて押しても履歴が残るので、学習データを戻せる。
--   2. 「無視」と「却下」を構造で分ける。verdicts に行が無いものは未判断であり、
--      負例ではない。閉じただけのものを負例に混ぜると判定器が壊れる。
--   3. 出し方を記録する。スコア順に出したものだけを集めると、
--      判定器はスコアの高い領域しか学べない。無作為に混ぜた分を区別する。

begin;

create table documents (
    id         bigserial primary key,
    sha256     text        not null unique,   -- 本文の hash。同じ文書の再レビューを重複させない
    title      text,
    body       text        not null,
    -- 生成モデルが書いたか人が書いたか。学習データの正例・負例を分ける前提になる (要件 L4-02, L4-13)
    origin     text        not null default 'model' check (origin in ('model', 'human')),
    created_at timestamptz not null default now()
);

create table reviews (
    id             bigserial primary key,
    document_id    bigint      not null references documents on delete restrict,
    profile        text        not null default 'default',
    layers         text[]      not null,      -- 実際に走らせた層。どこまで検査したかを応答に含める
    l3_model_id    text,                      -- 観点パスに使ったモデル
    prompt_version text,
    classifier_run text,                      -- L4 に使ったチェックポイント (runs.py の current)
    started_at     timestamptz not null default now(),
    finished_at    timestamptz
);

create table findings (
    id         bigserial primary key,
    review_id  bigint  not null references reviews on delete cascade,
    rule_id    text    not null,              -- 例 struct/missing-section, design/undefined-error-path
    layer      text    not null check (layer in ('L1','L2','L3','L4')),
    severity   text    not null check (severity in ('error','warn','info')),
    line       int,
    col        int,
    end_line   int,
    end_col    int,
    message    text    not null,
    evidence   text,                          -- L3 は必須。原文に存在することを検証済みのもの
    suggestion text,
    confidence double precision,

    -- ranked  スコア順に出した
    -- random  学習データの分布のために無作為に混ぜて出した
    -- hidden  閾値に届かず出さなかった。判断されていないので教師データにしない
    exposure   text    not null check (exposure in ('ranked','random','hidden')),
    shown_at   timestamptz,
    created_at timestamptz not null default now()
);

-- 採否。追記のみ。同じ finding に何度でも足せる。
create table verdicts (
    id             bigserial primary key,
    finding_id     bigint      not null references findings on delete cascade,
    verdict        text        not null check (verdict in ('accepted','rejected')),
    corrected_text text,                      -- 採用して直したときの修正後。二値より価値が高い
    note           text,
    decided_by     text        not null,
    decided_at     timestamptz not null default now()
);

-- 学習に使ったデータを固める。DB は変わり続けるので、
-- これが無いと「あのときのモデル」を作り直せない。
create table training_snapshots (
    id         bigserial primary key,
    name       text        not null,          -- runs/<name>/<run_id> と対応させる
    run_id     text,
    kind       text        not null check (kind in ('translationese','verdict')),
    query      text        not null,          -- 切り出しに使った SQL
    row_count  int         not null,
    sha256     text        not null,          -- 書き出した JSONL の hash。manifest と突き合わせる
    path       text        not null,
    note       text,
    created_at timestamptz not null default now()
);

create index findings_review_idx    on findings (review_id);
create index findings_layer_idx     on findings (layer, exposure);
create index verdicts_finding_idx   on verdicts (finding_id, decided_at desc);
create index reviews_document_idx   on reviews (document_id);

-- 各 finding の最新の判断。訂正すると新しい行が勝つ。
create view current_verdicts as
select distinct on (finding_id)
       finding_id, verdict, corrected_text, note, decided_by, decided_at
from verdicts
order by finding_id, decided_at desc, id desc;

-- 学習に使ってよい教師データ。
-- 出していないもの (hidden) と、出したが判断されていないものは入らない。
create view labeled_findings as
select f.id            as finding_id,
       f.review_id,
       f.rule_id,
       f.layer,
       f.severity,
       f.message,
       f.evidence,
       f.confidence,
       f.exposure,
       v.verdict,
       v.corrected_text,
       v.decided_at,
       r.l3_model_id,
       r.prompt_version,
       d.sha256        as document_sha256
from findings f
join current_verdicts v on v.finding_id = f.id
join reviews r          on r.id = f.review_id
join documents d        on d.id = r.document_id
where f.exposure in ('ranked','random');

commit;

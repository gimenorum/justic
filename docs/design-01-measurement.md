# 未検知の記録と recall の測定

[design-00-overview.md](design-00-overview.md) の 01。共通の決定はそちらを参照し、
ここでは再定義しない。2026-09-06。

## 1. 解く問題

`P-03` — 記録できるのはシステムが出した指摘への採否だけで、
**出さなかったものが残らない。** precision しか測れず、recall の分母が作れない。
要件 `EV-02` の「観点ごとに recall と precision を分けて測る」が満たせない。

**この文書だけで完結する。** 新しい実行基盤も抽出器も要らない。
対象は Markdown、観点は `D-01` の1本、画面は既存のものへの追加。

## 2. 何を記録するか

利用者が本文中の範囲を選び、「ここが問題」として登録する。
システムが出さなかった指摘であり、**偽陰性の記録**にあたる。

これは要件 `EV-01` の「ゴールデンセットとして過去の設計書 20〜50 本に
人手の指摘を付ける」作業そのもの。別作業にせず画面の中で行う。

### 2.1 `findings` に入れない

理由が3つある。

**(a) `findings` はレビュー単位。** `review_id` に外部キーを持つ。モデルや
プロンプトを変えて再レビューすると新しい `review` ができ、注釈は古い review に
取り残される。要件 `EV-04` (変更時に CI でゴールデンセットを流す) は
注釈が世代をまたいで再利用できることを前提にしている。

**(b) 要件 §10 の finding スキーマが壊れる。** `layer` は
`"L1"|"L2"|"L3"|"L4"` と型付けされている。`human` を足すと `API-04`
(層をまたいで同一スキーマ) と `API-05` (SARIF 変換) の後方互換が失われる。
SARIF に「ツールではなく人が書いた result」の置き場は無い。
`server.js` の issue タイトルも `[human]` になる。

**(c) `labeled_findings` を通れない。** このビューは
`join current_verdicts` (内部結合) と `where exposure in ('ranked','random')` を持つ。
採否を持たない注釈は構造的に落ちる。ビューを緩めると今度はシステム側の集計が汚れる。

**別表にすれば3つとも起きない。既存のビューにも制約にも手を入れない。**

### 2.2 記録しないもの

**注釈の起票は行わない。** `db.js` の `acceptedFindings` は `verdicts` を内部結合しており、
採否を持たない注釈は通らない。注釈は測定のためのもので、指摘として外に出すものではない。
外に出したい欠陥を見つけたなら、それは観点が足りていない証拠なので、
観点を作ってシステムに検出させる (5章)。

## 3. 全数注釈

### 3.1 なぜ要るか

recall の分母は「その文書に存在する真の欠陥」でなければならない。
人手注釈が分母になれるのは、**利用者がその文書を最後まで見た場合だけ**。

注釈が疎なまま集計すると、注釈ゼロの文書は分子 (システムの採用) にだけ寄与する。
**recall は自動的に 1.0 に近づく。測るほど嘘が大きくなる。**

### 3.2 定義

**全数注釈**: ある文書のある観点について、全単位 (00 の 4.3) を見て、
注釈を付けるか付けないかを判断し終えた状態。

Markdown は 1ファイル = 1単位なので、「その文書を最後まで読んで、
その観点について判断し終えた」と同じ。

### 3.3 印を立てる条件

**注釈が 0 件でも立てられる。**

注釈ゼロの完了は「システムが真の欠陥を全部拾った」という**正の情報**であり、
recall = 1.0 の側の標本になる。「自分の注釈がある文書だけ」に限ると、
分母に入る文書が「見落としを見つけた文書」に偏り、**測定値が系統的に下振れする。**
3.1 で防ごうとした偏りの逆向きが入る。

### 3.4 観点ごとに立てる

印は `(文書, 観点)` の組に対して立てる。**「全部」という値を持たない。**

観点は段階的に増える。「全部」の印を立てた文書は、あとから観点が増えても
印が残る。利用者はその観点を探していないのに分母に入り、
**偽陰性が入らないのでその観点の recall が 1.0 に張り付く。** 3.1 と同じ壊れ方。

## 4. 使われるようにする

未検知の登録は手作業で、やらなくても画面は動く。放っておけば溜まらない (R-04)。
4つで対処する。

### 4.1 終わりのある作業にする

recall は全文書で測る必要がない。少数を漏れなくラベル付ければ計算できる
(要件 `EV-01` の 20〜50 本)。

「ゴールデンセット作成」を独立したモードにし、**残り何本かを表示する。**
日常の走査では未検知の登録を求めない。求めるのは最初の 20 本と、
モデルやプロンプトを変えたときだけ。

### 4.2 探させず、選ばせる

人は探すより選ぶほうが速い、と**仮定する**。この仮定が外れた場合は 4.4 で気づく。

システムに「確信が低いものも挙げよ」と指示した変種のプロンプトで1回走らせ、
出たものを採用・却下してもらう。手作業が「読んで探す」から「押す」に変わる。
その走査の結果は `exposure='random'` で保存する。

**閾値を下げる方式は採らない。** L3 はスコアを返さないプロンプトなので閾値が存在せず、
閾値は要件 `L4-04` のもので L4 は未実装。実装済みの機構で実行できるのは
プロンプトの変種のほうである。

**この経路で拾えたものは、本番構成の偽陰性ではない。** 「本番のプロンプトでは
出ないが、緩めれば出る」もので、プロンプトの調整で回収できる。
`exposure` で区別して集計する (6.3)。人手注釈でしか拾えないものが、
真に観点が足りていない部分になる。

### 4.3 読んでいる最中に取る

利用者が文書を読むのは、システムの指摘を判断しているときである。
その画面に本文を全部出し、指摘をその場に埋め込む。見落としを付ける操作と
指摘を却下する操作を、同じ場所・同じ手つきにする。別画面に移らせるとそこで止まる。

### 4.4 沈黙を可視化する

R-04 の怖さは「静かに何も起きない」こと。

```
走査した文書       120 本
全数注釈済み (D-01)  2 本   ← ゼロに近ければ 4.1〜4.3 は失敗している
```

これを画面に出す。一定期間ゼロなら方式を変える。

## 5. 観点が足りない信号として使う

人が付けた注釈を後から分類すると、既存の観点のどれにも当てはまらないものが出る。
これは重みの問題ではなく**問いが足りていない**という信号であり、
`D-09` 以降を作る根拠になる (04 が使う)。

そのため注釈に観点 ID が要る。要件 `EV-02` の観点別集計にも要る。
ただし登録時に必須にすると 4.1〜4.3 の手間削減と衝突する。

**登録時は任意、後からまとめて分類する画面を別に持つ。**
分類前の注釈は「観点未分類」として扱い、**観点別の集計には入れない** (6.3)。

## 6. データモデル

### 6.1 変更しないもの

`findings` の `layer` と `exposure` の CHECK、`labeled_findings` ビュー、
`current_verdicts` ビュー、`verdicts` 表。2.1 の別表方式により不要になった。

### 6.2 追加と変更

```sql
-- 004_measurement.sql

begin;

-- 00 の 4.1。観点の台帳。4箇所から参照する
create table aspects (
    id         text primary key,
    prefix     text not null,
    title      text not null,
    question   text not null,
    applies_to text[] not null default array['*'],
    unit       text not null default 'document' check (unit in ('document','span')),
    added_at   timestamptz not null default now(),
    retired_at timestamptz
);

insert into aspects (id, prefix, title, question) values
('D-01', 'D', '異常系の未定義',
 '不正な入力・失敗・例外に対する振る舞いを定義しているか。定義せずに結果だけを書いている箇所を挙げよ。');

-- 00 の 4.2(b)。同じファイルの別の版を辿る
create table document_keys (
    id         bigserial primary key,
    repo       text,                       -- 'owner/name'。貼り付けは NULL
    path       text,
    created_at timestamptz not null default now(),
    unique (repo, path)
);

alter table documents add column if not exists document_key_id bigint
    references document_keys on delete set null;
create index if not exists documents_key_idx on documents (document_key_id, created_at desc);

-- どの観点で出た指摘か。観点別 precision に要る
alter table findings add column if not exists aspect_id text references aspects on delete restrict;
create index if not exists findings_aspect_idx on findings (aspect_id);

-- 既存の L3 指摘は D-01 しか無い
update findings set aspect_id = 'D-01' where layer = 'L3' and aspect_id is null;

-- 観点ごとの実行記録。findings の有無と独立に残す。
-- 失敗した観点は findings 行を作らないので、これが無いと「走った観点」を復元できない
create table review_aspects (
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

commit;
```

### 6.3 人手注釈

```sql
-- 005_human_annotations.sql

begin;

-- 注釈は文書の版に付く (00 の 4.2(c))。review には紐づけない
create table human_annotations (
    id          bigserial primary key,
    document_id bigint not null references documents on delete restrict,
    start_line  int    not null,           -- 元ファイル基準
    end_line    int    not null,
    quoted_text text   not null,           -- 選択された文字列。版が変わったときの照合候補
    aspect_id   text   references aspects on delete restrict,   -- 5章。後から付けてよい
    note        text,
    user_id     bigint not null references users on delete restrict,
    created_at  timestamptz not null default now(),
    check (start_line <= end_line)
);
create index human_annotations_doc_idx on human_annotations (document_id, aspect_id);

-- 取り消しは追記。物理削除しない (schema.sql の方針1)
create table human_annotation_events (
    id            bigserial primary key,
    annotation_id bigint not null references human_annotations on delete cascade,
    action        text   not null check (action in ('created','retracted','restored')),
    user_id       bigint not null references users on delete restrict,
    note          text,
    created_at    timestamptz not null default now()
);
create index human_annotation_events_idx
    on human_annotation_events (annotation_id, created_at desc, id desc);

-- 全数注釈済みの印。(文書, 観点) ごと。「全部」という値は持たない (3.4)
create table annotation_completions (
    id           bigserial primary key,
    document_id  bigint not null references documents on delete restrict,
    aspect_id    text   not null references aspects on delete restrict,
    user_id      bigint not null references users on delete restrict,
    completed_at timestamptz not null default now(),
    revoked_at   timestamptz,              -- 取り消しも追記ではなく列。印は履歴を持たない
    unique (document_id, aspect_id, user_id)
);
create index annotation_completions_live_idx
    on annotation_completions (aspect_id, document_id) where revoked_at is null;

-- 生きている注釈
create view live_annotations as
select a.*
from human_annotations a
where coalesce((
    select e.action from human_annotation_events e
    where e.annotation_id = a.id
    order by e.created_at desc, e.id desc limit 1
), 'created') <> 'retracted';

commit;
```

**登録時に必ず `created` の行を1件入れる。** `coalesce` があるので無くても動くが、
入れる実装と入れない実装が混ざると「履歴が残る」が半分しか成立しない。

**外部キーはすべて `restrict`。** 注釈と印は測定の基準なので、
親を消して静かに消えてはいけない。`documents` を消したいときは注釈を先に処理する。

`user_id` は **NOT NULL**。誰が総ざらいしたかは測定の前提であり、NULL を許す理由がない。
主キーに入れないのは、`on delete restrict` と併せて `users` の削除を
無条件に失敗させないため。

### 6.4 再現性

注釈は追記され続けるので、日をまたぐと同じ数字が出ない。
段階導入の門番 (04) が「`D-01` の precision / recall が出ていること」を条件にする以上、
**判断の根拠になる数字は再現できなければならない** (要件 `EV-04`, `EV-05`)。

```sql
-- 006_recall_runs.sql
create table recall_runs (
    id             bigserial primary key,
    aspect_id      text not null references aspects on delete restrict,
    model_id       text,
    prompt_version text,
    document_ids   bigint[] not null,      -- 対象にした文書
    annotation_ids bigint[] not null,      -- 分母に使った注釈
    tp             int not null,
    fn             int not null,
    recall         double precision not null,
    note           text,
    created_at     timestamptz not null default now()
);
```

`training_snapshots` には混ぜない。あちらは学習データの版で、分割と sha256 突合を持つ。
測定はどちらも要らず、必要なのは対象集合の固定である。

## 7. recall の計算

### 7.1 前提

**4つが揃わなければ計算しない。**

| 前提 | どこで満たすか |
|---|---|
| 全数注釈済みの印 | `annotation_completions` (3章) |
| 観点 ID | `human_annotations.aspect_id`。未分類は観点別集計から外す (5章) |
| 同一判定の規則 | 7.2 |
| 走った観点の記録 | `review_aspects` (6.2) |

### 7.2 同一判定

同じ文書内で、**注釈の行範囲とシステム指摘の行範囲が重なり、かつ観点が一致する**
(または注釈側が未分類) なら同一とみなす。

システム指摘の行範囲は `findings.line` から `findings.end_line`
(NULL なら `line` と同じ) とする。

畳まなければ同じ欠陥が分子と分母に二重計上され、recall が構造的に押し下げられる。

### 7.3 式

```
対象   annotation_completions が revoked_at is null で立っている (文書, 観点) の組
       かつ review_aspects.status = 'ok'
       かつ reviews.finished_at is not null       -- 途中で落ちた review を除く
       かつ findings.exposure = 'ranked'          -- random は本番構成ではない (4.2)
       かつ (model_id, prompt_version) が指定と一致

TP     対象の中で、採用されたシステム指摘
FN     対象の中で、どの採用済みシステム指摘とも重ならない注釈
recall TP / (TP + FN)
```

注釈ゼロの完了は `FN = 0` として寄与する (3.3)。

**`labeled_findings` は使わない。** このビューは `line` も `aspect_id` も
`document_id` も返さないため、7.2 の判定も文書の突合もできない。
`measure_recall.py` は `findings` に直接当たり、`current_verdicts` で採否を取り、
`reviews` 経由で `documents` に結合する。

同じ文書を複数人が完了した場合、注釈は**和集合**を取り、文書は1件と数える。

### 7.4 得られる値の性質

**上界である。** 人手注釈も見落とすため、真の欠陥の全数ではない。
報告するときは必ず「注釈済み N 文書に対する測定値」と併記する。

`exposure='random'` の走査で拾えた指摘は分子に入れない (4.2)。
別に数え、「本番構成では見落とすが、プロンプトを緩めれば出るもの」として報告する。

## 8. 権限

### 8.1 いまの認証機構

`auth.sessionOf(req)` は暗号化 cookie を要求し、cookie を発行するのは
`/auth/callback` の `setSession` だけ。`auth.oauthConfigured()` は
`CLIENT_ID` / `CLIENT_SECRET` / `SESSION_SECRET` が揃わないと false を返し、
`/auth/login` は 400 を返す。

**つまり `.env` の PAT モードにはログインする手段が無い。**
README はこれを一人運用の正規の使い方として挙げている。

### 8.2 ローカルセッション

`JUSTIC_SESSION_SECRET` があり OAuth が未設定のとき、
**`/auth/local` でローカルセッションを発行する。**

- `users` に `github_id = 0`、`login = 'local'` の1行を作る (無ければ)
- 同じ cookie 機構でセッションを張る。トークンは持たない
- `github.token` は `.env` の PAT に落ちる (現状のまま)

これが無いと、8.3 でログインを要求した4操作がすべて 401 になり、
**一人運用では 2章から 7章までが丸ごと使えない。** R-05 は「一人だと
注釈の量が足りない」と書いているが、実際にはゼロになる。

### 8.3 操作ごとの要求

| 操作 | 要求 |
|---|---|
| 走査 | 不要 (現状のまま) |
| 指摘の採否 | 不要 (現状のまま) |
| **注釈の登録** | **セッション必須** (OAuth かローカル) |
| 注釈の取り消し・復活 | セッション必須。**自分が付けたもののみ** |
| 注釈の観点分類 | セッション必須。誰でも |
| 全数注釈の印 | セッション必須。**その文書に自分の注釈があるか、0件で確認したか** |
| 印の取り消し | セッション必須。自分が立てたもののみ |

注釈は recall の分母を決める。匿名で書けると誰が付けたか分からない注釈が
測定の基準になる。

## 9. API

要件 `API-04` (finding は層をまたいで同一スキーマ) に注釈は含めない。
注釈は finding ではないので、別のスキーマで返す。

| メソッド | パス | 本文 / 応答 | 権限 |
|---|---|---|---|
| POST | `/api/documents/:id/annotations` | `{startLine, endLine, quotedText, aspectId?, note?}` → 注釈 | セッション |
| POST | `/api/annotations/:id/retract` | `{note?}` → イベント | 本人 |
| POST | `/api/annotations/:id/restore` | `{note?}` → イベント | 本人 |
| PATCH | `/api/annotations/:id` | `{aspectId}` → 注釈。観点の後付けのみ | セッション |
| POST | `/api/documents/:id/completions` | `{aspectId}` → 印 | 8.3 |
| DELETE | `/api/documents/:id/completions/:aspectId` | → `revoked_at` を立てる | 本人 |
| GET | `/api/documents/:id/annotations` | 注釈と印の一覧 | 不要 |
| GET | `/api/golden-set` | 対象文書、完了状況、残り本数 | 不要 |
| GET | `/api/reviews/:id` | **`review_aspects` を追加** | 不要 |
| GET | `/api/stats` | **全数注釈済み文書数を追加** (4.4) | 不要 |

注釈のスキーマ

```ts
{
  id: number;
  documentId: number;
  startLine: number; endLine: number;
  quotedText: string;
  aspectId: string | null;      // 未分類は null (5章)
  note: string | null;
  author: string;               // users.login
  createdAt: string;
  retracted: boolean;
}
```

`findings.aspect_id` を要件 §10 の finding スキーマに足すかは **04 が決める**。
足さない場合、観点別 precision は API では集計できず、DB から直接測ることになる。

## 10. 画面

| 追加 | 理由 |
|---|---|
| 本文の全文表示と範囲選択 | 注釈の登録。指摘をその場に埋め込む (4.3) |
| ゴールデンセット作成モード | 残り本数の表示 (4.1) |
| 「この観点は全部見た」ボタン | 3章。注釈0件でも押せる |
| 走った観点と結果の表示 | `review_aspects` から。指摘0件の意味を読ませる |
| 注釈の進み具合 | 走査した文書数と全数注釈済み文書数 (4.4) |
| 注釈の観点分類画面 | 5章。後からまとめて付ける |

**再読み込みで消えないこと。** `db.js` の `getReview` は `reviews.*` を返すので
`layers` と `body` は既に取れている。返っていないのは `l3Errors`・`notChecked`・
`droppedByEvidenceCheck`・`l1OutsideDiff` で、いずれも POST の応答にしか存在しない。
`review_aspects` に永続化し、`app.js` を GET 経由の再描画に変える。

## 11. 実装で変える箇所

| 場所 | 変更 |
|---|---|
| `llm.js` `parseFindings` | JSON 破損でも `[]` を返す。正当な「該当なし」(要件 `L3-06`) と区別できない。`{ok, findings, reason}` に変える |
| `llm.js` `reviewAspect` | 返り値に `aspectId` を足す |
| `db.js` `insertFindings` | `aspect_id` を書く |
| `server.js` `reviewOne` | `review_aspects` を書く。`model_id` と `prompt_version` も |
| `server.js` `reviewOne` | トランザクションで囲む。途中で落ちると findings が半分入った review が `finished_at` NULL で残り、7.3 の除外に頼ることになる |
| `server.js` ブランチ走査 | `sourceKind` が `github_pr` になっている。`github_branch` を足して直す |
| `llm.js` `ASPECTS` | `aspects` 表から読む |
| `auth.js` | 8.2 のローカルセッション |

`prompt_version` は現状どこにも記録されていない (`reviews.prompt_version` は
43行すべて NULL)。`llm.js` の各観点に版の定数を持たせ、`review_aspects` に書く。

## 12. 移行

| 対象 | 手順 |
|---|---|
| `reviews_source_kind_check` | `drop constraint` → 既存行の更新 → `add constraint`。CHECK は追加できない |
| 既存の `github_pr` 行 | `source_ref->>'ref'` があればブランチ走査。実データで 37 行中 25 行が該当 |
| `findings.aspect_id` | 既存の L3 指摘は全件 `D-01`。6.2 の `update` で埋める |
| `documents.document_key_id` | 既存行は NULL のまま。`source_ref` から埋め戻せるが、必須ではない |

```sql
-- 004 に含める
alter table reviews drop constraint if exists reviews_source_kind_check;
update reviews set source_kind = 'github_branch'
 where source_kind = 'github_pr' and source_ref ? 'ref';
alter table reviews add constraint reviews_source_kind_check
    check (source_kind in ('paste','github_pr','github_branch'));
```

## 13. 未決事項

| ID | 項目 | 決めないと止まるもの | 決め方 |
|---|---|---|---|
| M-01 | 注釈を直訳調の分類器に混ぜるか | 学習データの構成 | **当面は混ぜない** (下記)。注釈 100 件で比較評価する |
| M-02 | 版が変わったときの再アンカーの提示規則 | 00 の 4.2(c) の運用 | 空白正規化して完全一致、複数一致なら提示しない |
| M-03 | 4.2 の変種プロンプトの具体的な文言 | 4.2 の実行 | 実装時に決め、`prompt_version` で区別する |
| M-04 | ゴールデンセットの対象文書をどう選ぶか | 4.1 の「20本」 | 未決 |

**M-01 について。** システム由来の正例/負例は「システムが提示すると決めたもの」から
来るが、注釈由来の正例は「利用者が独力で気づいたもの」から来る。分布が違い、
**注釈由来の負例が存在しない。** 正例だけが別分布から一方的に入ると、分類器は
「直訳調か」ではなく「人が手で登録した種類の文か」を学ぶ。`train.py` の
class weight は有病率の偏りを補正するが、**選択の偏りは補正しない。**
当面は recall の測定にのみ使う。

## 14. リスク

| ID | 内容 | 度合い | 手当て |
|---|---|---|---|
| R-04 | 注釈が使われず、recall が永久に測れない | **高** | 4.1〜4.3。効かなければ 4.4 で気づく |
| R-05 | 利用者が1人だと注釈の量が足りない | 中 | 要件 `OPEN-01` と同じ。8.2 が無いとゼロになる |
| R-08 | 文書が直ると版が変わり、注釈が旧版に残る | 中 | 00 の 4.2(c)。自動で引き継がない |
| R-09 | 注釈の観点分類が後回しになり、観点別 recall が出ない | 中 | 5章。未分類は全体集計にのみ入れる |
| R-10 | 誤登録した注釈が分母に残り続ける | 低 | 6.3 の `retracted` |

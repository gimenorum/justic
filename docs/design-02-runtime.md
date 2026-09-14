# 実行基盤 — 走査を束ね、非同期にし、繰り返しを0回にする

[design-00-overview.md](design-00-overview.md) の 02。共通の決定はそちらを参照し、
ここでは再定義しない。2026-09-10。

## 1. 解く問題

観点を増やすと呼び出し回数が単位数 × 観点数で増える (00 の 4.3)。
いまの実行基盤はその増加に耐えない。壊れ方は4つある。

| # | いまの状態 | 確認した場所 |
|---|---|---|
| 1 | 全ファイルを `await` で逐次処理し、1つの JSON を返す同期 HTTP | `server.js` の `/api/reviews/github/branch` |
| 2 | 同じ本文を何度走査しても毎回 LLM を呼ぶ | `db.js` の `upsertDocument` は重複を防ぐが `createReview` は毎回新規 |
| 3 | 複数のレビューを束ねる行が無い | `reviews` に走査を指す列が無い |
| 4 | 上限が無い。二重クリックで呼び出しが2倍になる | `server.js` の3経路に冪等性の判定が無い |

**この文書は呼び出し回数を減らす側にある** (00 の3章)。減らし方は3つ。

| 手段 | 効き方 |
|---|---|
| 本文 hash によるキャッシュ (6章) | 変更のないファイルを **0回** にする |
| 冪等性 (5章) | 二重クリックを **0回** にする |
| 上限 (7章) | 青天井を止める |

**03 と 04 はこの文書が終わるまで着手しない。**

### 1.1 この文書で決めないもの

- 検査の単位 (00 の 4.3)。03 が決める。上限は回数で置くので、単位が段落に変わっても
  上限の定義は変わらない (7章)
- 観点を増やすかどうか。04 が決める
- 注釈と recall の測定。01 で決まっている。**01 の 7.3 の集計条件を壊さないことだけを守る** (6.4)

## 2. 走査という単位

### 2.1 状況

`reviews` を束ねる行が無い。`server.js` の `reviewOne` は 1文書 1 review を作る。
3つの経路 (`/api/reviews`、`/api/reviews/github/pr`、`/api/reviews/github/branch`) は、
どれも配列を組み立て、メモリの上だけで持っている。

「1走査あたりの上限」「実行中の同じ走査があればその ID を返す」「呼び出し回数の
事前表示」「残りを一覧で出す」は、すべて複数のレビューをまたぐ行を要求する。

### 2.2 決定

**`scans` 表と `reviews.scan_id` を作る。貼り付けも1件の走査として扱う。**

走らせる対象は `scan_items` に1行ずつ持つ。

### 2.3 検討した代替案とそれを採らない理由

| 案 | 採らない理由 |
|---|---|
| `reviews` に `batch_id text` を足すだけ | 状態・終了時刻・呼び出し回数の置き場が無い。自由記述の ID は 00 の 4.1 が観点で退けたのと同じ壊れ方をする |
| 走査は `app.js` のメモリにだけ置く | いまがそれ。再読み込みで消える。12.1 の置き換えが成立しない |
| 貼り付けは走査にしない | 上限・冪等性・キャッシュの判定にそれぞれ「走査が無い場合」の分岐が要る。判定の数だけ穴が増える |
| `scan_items` を作らず `planned_n` と完了数だけ持つ | 「残りを一覧で出す」(9章、12章) が満たせない。どのファイルで止まったかも分からない |

### 2.4 代償

貼り付け1件でも `scans` と `scan_items` に1行ずつ増える。
既存のレビューは `scan_id` が NULL のまま残り、集計では「NULL は1件で1走査」と
読み替えることになる (14章)。

## 3. 非同期化

要件 `API-01`「`POST /reviews` は非同期。review_id を返す」は決定済みで未実装。

**「10分を超えたら非同期に切り替える」は実装できない。** 同期 HTTP は応答を
返し始める前に同期か非同期かが決まる。最初から非同期にするか、しないかである。

### 3.1 ジョブの保存先

**状況。** いまのプロセスは1つ (`run.sh` が `exec node server.js`)。
待ち受けは 127.0.0.1 と ::1 の2つだが、`app.listen` を2回呼ぶだけで
プロセスは1つである。依存は5件 (`web/package.json`)。

**決定。ジョブは PostgreSQL に置く。`scans` と `scan_items` がそのまま待ち行列になる。**

**検討した代替案。**

| 案 | 採らない理由 |
|---|---|
| メモリ上の待ち行列 | プロセスが落ちると走査が消える。「走っていた」という記録も残らないので、利用者は結果が出ないことしか分からない |
| `pg-boss` などの待ち行列ライブラリ | 依存が増える。同時実行数は1と決めた (8章) ので、待ち行列の機能をほとんど使わない |
| Redis を足す | `run.sh` の起動手順に1つ増える。PostgreSQL で足りるものに常駐プロセスを増やす理由が無い |

**代償。** 進捗はポーリングで取ることになる (3.4)。

### 3.2 走査を進める処理の形

**決定。同じ node プロセスの中に、走査を1本ずつ取って進めるループを1つ置く。**

- `status='queued'` の走査を、`created_at` の古い順に1本取り、`running` にする
- 取るのは `update … set status='running' where id = (select id … for update skip locked)` の1文で行う
- 進める対象が無ければ1秒待って見直す

**検討した代替案。**

| 案 | 採らない理由 |
|---|---|
| 別プロセス (`node worker.js`) | `run.sh` が2プロセスになり、片方だけ落ちた状態が生まれる。PostgreSQL の接続 (`db.js` の `max: 4`) と `.env` の読み込みも二重になる |
| 要求ごとに `setImmediate` で投げっぱなしにする | 同時実行数を1に保てない。二重クリックの2本目が走り出す |

**代償。** 走査中は同じイベントループで HTTP も捌く。L3 の待ちは I/O なので
他の要求を止めないが、**L1 (textlint) は CPU で回る**ので、大きな文書を検査している
間は画面の応答が遅れる。03 で単位が段落になり回数が桁で増えたら測り直す (15章 RT-05)。

### 3.3 状態遷移

```
queued ──▶ running ──┬──▶ done       予定した全レビューを終えた
                     ├──▶ stopped    上限・レート制限・推論サーバー不達で打ち切った
                     ├──▶ cancelled  利用者が止めた
                     └──▶ failed     続けられない。再起動で回収したものを含む
```

**終端に入った走査は再開しない。** やり直すときは新しい走査を始める。

理由: 再開すると、途中まで別のモデルで走った走査が1つの `scan_id` にまとまり、
`review_aspects.model_id` が1走査の中で混ざる。要件 `EV-05` の
「評価結果にモデル ID とプロンプトのバージョンを紐付けて保存する」が崩れる。
やり直しても、済んだファイルはキャッシュで0回になる (6章) ので損はしない。

**プロセスが落ちたときの回収。** 起動時に `running` の走査を
`failed` (`stop_reason='restart'`) にする。走っていないものを走っていると
表示し続けるのが一番悪い。途中まで書いた `reviews` は `finished_at` が NULL のまま
残り、01 の 7.3 が集計から除外する。

### 3.4 進捗の取得口

**決定。`GET /api/scans/:id` を1〜2秒ごとに引く。**

**検討した代替案。**

| 案 | 採らない理由 |
|---|---|
| SSE / WebSocket | 走査は数分、更新は数秒ごとで足りる。接続を張り続けると `server.js` の Origin / Host の検査と再接続の扱いが増える |
| PostgreSQL の LISTEN / NOTIFY | 通知の受け手が同じプロセスの中にいる。間に DB を挟む理由が無い |

**代償。** 最大2秒の遅れが出る。

### 3.5 取り消し

**決定。`POST /api/scans/:id/cancel` は印を立てるだけ。いま走っている
LLM 呼び出しは最後まで待ち、次の呼び出しを始める前に止まる。**

理由: 呼び出しの途中で捨てても、その呼び出しの費用は既に払っている。
`llm.js` の `chat()` はタイムアウト用に `AbortController` を持っているので、
切ること自体はできる。しかし切ると `review_aspects` に `'error'` が残り、
**「落ちた」と「止めた」が混ざる。**

**検討した代替案。** `review_aspects.status` に `'cancelled'` を足して切る案。
CHECK を貼り直す必要があり (14章)、01 の 7.3 が `status='ok'` で絞っている以上
集計には影響しないが、得るものが「最大1観点ぶん早く止まる」だけで釣り合わない。

**代償。** 取り消しを押してから実際に止まるまで、最大で1観点ぶん (暫定 120 秒) かかる。
画面には「止めています」と出す (12章)。

## 4. 3つの経路を1つに寄せる

### 4.1 状況

いまは3経路がそれぞれ `reviewOne` を呼び、それぞれの形の JSON を返している。
非同期にすると `{reviews: [...]}` を返せなくなるので、**どの経路も本文は変わる。**

### 4.2 決定

- 検査は `POST /api/scans` の1経路にする。3つの対象 (貼り付け / PR / ブランチ) は
  本文の `kind` で分ける
- `POST /api/reviews` は **L1 だけの同期経路として残す**。`useL3` は受け取らない

理由: 要件 `API-03` が「L1 と L2 のみの同期モード」を求めている。
L1 は textlint をその場で回すだけで、非同期にする理由が無い。

### 4.3 検討した代替案とそれを採らない理由

| 案 | 採らない理由 |
|---|---|
| 3経路をそのまま残し、中で非同期にする | 返す本文がどのみち変わる。名前だけ残しても呼ぶ側は書き直す |
| 3経路を残し、新しい経路と併存させる | 上限・冪等性・キャッシュの判定が片方に掛からない。掛け忘れは静かに起きる |

### 4.4 代償

`app.js` の `ENDPOINTS` と `$("run").onclick` を書き直す。
外から `/api/reviews/github/branch` を叩いている利用者がいれば壊れる
(README には載せていない)。

## 5. 冪等性

### 5.1 状況

走査は冪等でない。`upsertDocument` は本文 hash で重複を防ぐが、
`createReview` と `insertFindings` は毎回新規。**同じブランチを2回走査すると
`findings` が倍になり、二重クリックで呼び出しが2倍になる。**
`db.js` の `stats()` が数える「提示した指摘」も倍になる。

### 5.2 決定

**実行中の同じ鍵の走査があれば、新しく始めずにその走査を返す。**

走査の鍵 (`scans.scan_key`) は、要求を受けた時点で分かる材料だけで作る。

```
sha256( source_kind ⏎ repo ⏎ ref ⏎ 観点 ID を昇順に並べたもの ⏎
        JUSTIC_MODEL の設定値 ⏎ プロンプト版を昇順に並べたもの ⏎ no_cache )
```

**材料には接続先の名前も入る。`JUSTIC_MODEL の設定値` の隣に置く (05 の 11.2)。**

- 貼り付けは `repo` と `ref` のどちらも無い。鍵の材料としてだけ、`ref` の位置に本文の sha256 を置く
  (`scans.ref` の列は NULL のままにする)
- 判定は `scans (scan_key) where status in ('queued','running')` の一意インデックスに任せる。
  `insert` が一意制約で落ちたら、生きている走査を読み直して返す
- 応答は 200 と `{scanId, deduped: true}`。409 にはしない

**モデルの扱いに注意。** ここで鍵に入れるのは `JUSTIC_MODEL` の**設定値**であって、
実際に答えるモデルではない。`.env` では `JUSTIC_MODEL=` が空なので、この材料は
いま常に空文字である。**キャッシュの鍵とは別物**で、あちらは実際に答えたモデルを使う (6.3)。

### 5.3 検討した代替案とそれを採らない理由

| 案 | 採らない理由 |
|---|---|
| アプリ側で `select` してから `insert` する | 二重クリックの窓が閉じない。押した2回の間隔はミリ秒 |
| 409 を返す | 二重クリックは誤りではない。利用者は結果が見たいだけで、既存の走査を見せれば済む。既存の起票経路 (`/api/issues`) も `deduped` を返して同じ形をしている |
| 終わった走査も同じ鍵なら返す | 走査は「いまの状態を見る」操作で、GitHub 側は変わる。キャッシュがあるので2度目は速い |

### 5.4 代償

`no_cache` を鍵に入れたので、「キャッシュを使わずにやり直す」は同じ対象でも
別の走査として走る。意図した動きだが、鍵の材料が1つ増えている。

## 6. 本文 hash によるキャッシュ

要件 `API-06`「本文の hash で結果をキャッシュする」は決定済みで未実装。

**優先順に注意。** R-03 が壊れるのは初回走査と変更のあったファイル、つまり
キャッシュミスになる場面である。キャッシュは常用時の緩和にはなるが、
最悪待ち時間を有界にはしない。それができるのは非同期化のほうである。

### 6.1 決定 — キャッシュの表を作らない

**状況。** `documents` は本文 sha256 で一意 (00 の 4.2a)。
01 が入れた `review_aspects` は観点ごとに `status`、`model_id`、
`prompt_version` を持ち、`findings` は `aspect_id` を持つ。
つまり「この本文をこの観点・このモデル・このプロンプト版で検査した結果」は
**既に DB にある。**

**決定。新しい表を作らず、既存の3表への問い合わせをキャッシュとする。**

```sql
select ra.review_id, ra.status
  from review_aspects ra
  join reviews r on r.id = ra.review_id
 where r.document_id     = $1          -- 本文 sha256 で一意化された文書
   and ra.aspect_id      = $2
   and ra.model_id       = $3          -- 実際に答えたモデル (6.3)
   and ra.prompt_version = $4
   and ra.status in ('ok','empty')
   and r.finished_at is not null
 order by ra.finished_at desc nulls last, ra.review_id desc
 limit 1;
```

**鍵には接続先の名前も入る。`and ra.endpoint = $5` を足す (05 の 11.1)。**

**`$3` が NULL か `'(サーバー既定)'`、または `$4` が NULL のときは、この問い合わせを
投げない。呼ぶ前に弾く。**

`=` は NULL に当たらないので結果は空になる。
だが **`is not distinct from` に書き換えたくなる誘惑をここで断つ。**
書き換えると NULL 同士が当たり、どのモデルが答えたか分からない記録が当たりになる。

**検討した代替案。**

| 案 | 採らない理由 |
|---|---|
| `aspect_results` のようなキャッシュ表を作る | 同じ内容が2箇所に載る。片方だけ消えたときにどちらが正か決まらない。既存の3表で引ける |
| `documents` に結果を持たせる | 文書は観点もモデルも知らない。1文書に複数の結果が付くので列にできない |

**代償。** 問い合わせが `review_aspects` と `reviews` の結合になる。
`findings_aspect_idx` はあるが、この問い合わせ用の索引を1つ足す (10章)。

### 6.2 決定 — 当たったときに何を返すか

**状況。** 02 の前の版が挙げた二択はどちらも壊れる。
新しい `review` を作って `findings` を複製すると `labeled_findings` に
同じ指摘が2度入る。古い `review_id` を返すと、その review の
`layers` / `source_ref` / `in_diff` は前回の走査のものになる。
これが画面と食い違う (PR 走査では `in_diff` が別の PR の値になる)。

**決定。新しい `review` を作り、保存されている `findings` をそこへ写す。
LLM は呼ばない。写した行には `origin_id` に元の finding の id を入れる。**

- `layers` / `source_ref` / `in_diff` / `exposure` は**今回の走査の値**で付け直す。
  だから画面と食い違わない
- `review_aspects` には `from_cache = true` と `cached_from = 元の review_id` を入れる
- 教師データの重複は `origin_id` で畳む。写しの写しは元の `origin_id` を引き継ぐので
  連鎖しない

**検討した代替案。**

| 案 | 採らない理由 |
|---|---|
| 古い `review_id` を返す | `in_diff` が別の PR のものになる。走査ごとの記録も残らない |
| 写しに採否を付けさせない | 利用者は画面に出ているものを判断する。押せない指摘が混ざる方が分かりにくい |
| `labeled_findings` を書き換えて畳む | 01 の 6.1 が「変更しない」と決めている。切り出しは `tuning/export_snapshot.py` の側で畳める |

**代償。** `findings` の行数は減らない。学習データの切り出し
(`export_snapshot.py` の2つの問い合わせ) は `labeled_findings` に直接当たっている。
そのため、この2つの問い合わせを、`findings` を結合して `origin_id` を
見るように直す必要がある (13章)。
畳み方そのものは 15章 RT-06 で決める。

### 6.3 決定 — モデル ID を実測値にしてからキャッシュを有効にする

**状況。** `llm.js` の `runL3` は `modelId` に `MODEL || "(サーバー既定)"` を書く。
`.env` の `JUSTIC_MODEL` は空なので、**いまの記録は全件が同じ文字列**である。
`JUSTIC_BASE_URL` は 18080 のルーターを指しており、ルーターはバックエンドを
切り替える。つまり「どのモデルが答えたか」は記録されていない。

このままキャッシュを有効にすると、**別のモデルが出した結果を同じモデルの結果として
返す。** キャッシュの鍵で最も効く材料が定数になっている。

**決定。**

1. `llm.js` の `chat()` の返り値を `{content, model}` に変え、応答の `model` を使う。
   いまは `json.choices?.[0]?.message?.content` しか返していない
2. `model` が取れなければ `null` を書く。**`null` と `'(サーバー既定)'` は
   キャッシュの当たりにしない** (6.1 の条件)
3. **1走査の最初の呼び出しは、必ず実際に呼ぶ。** その応答の `model` を
   `scans.model_id` に入れ、2件目以降のキャッシュ判定に使う
4. 応答の `model` が `scans.model_id` と食い違ったら、`scans.model_id` を実測値で
   上書きし、以降はそちらで判定する。走査は止めない

**検討した代替案。**

| 案 | 採らない理由 |
|---|---|
| 走査の前に `GET /v1/models` を引く | ルーターが列挙する ID と、実際に答えるモデルが一致する保証を justic 側で持てない。18080 は複数のバックエンドを切り替える |
| `JUSTIC_MODEL` を必ず設定させる | 設定しても、ルーターがその名前をどのバックエンドに割り当てているかは justic には見えない。実測値のほうが確実 |
| 既存の `'(サーバー既定)'` を書き換える | どのモデルが答えたかの記録が無い。推測で埋めると、その推測がキャッシュの当たりになる |

**代償。** 全ファイルがキャッシュに当たる走査でも、必ず1回は LLM を呼ぶ。
10ファイルなら10回が1回になるので、狙い (呼び出しを減らす) は達成する。

### 6.4 決定 — `status` に `'cached'` を足さない

**状況。** キャッシュに当たったことを `review_aspects.status = 'cached'` で
表したくなる。

**決定。`status` は書き換えず、`from_cache boolean` を足す。**

理由: 01 の 7.3 が recall の対象を `review_aspects.status = 'ok'` で絞っている。
`'cached'` という値を入れると、**キャッシュに当たった走査が recall の対象から
静かに落ちる。** 落ちたことは画面とログのどちらにも出ない。分母が縮んだことに気づけない。

`from_cache` なら 01 の 7.3 の条件は無傷で、キャッシュを使った測定と使わない測定を
同じ式で出せる。CHECK を貼り直す必要も無い (14章)。

**代償。** `review_aspects` の列が1つ増える。

### 6.5 無効化の条件

| 条件 | どう外れるか |
|---|---|
| 本文が変わった | `documents` が別の行になる (00 の 4.2a)。鍵が変わる |
| プロンプトの文言を変えた | `llm.js` の `promptVersion` を上げる。上げ忘れると外れない → 6.6 |
| モデルが変わった | 実測値が変わる (6.3) |
| 観点の `question` を `aspects` 表で書き換えた | **外れない。** `promptVersion` は `llm.js` にあり、表の側には無い → 15章 RT-07 |
| textlint のバージョンが変わった (要件 `L1-09`) | **無関係。L1 はキャッシュしない** |

**L1 をキャッシュしない理由。** textlint はその場で回して数十ミリ秒で終わる。
キャッシュすると要件 `L1-09` が求める「バージョンを評価結果と組で記録する」の
対象が増え、得るものが無い。代償として、走査のたびに L1 は必ず走る
(裏返せば、常に最新のルールで判定される)。

### 6.6 明示的に外す口

走査の要求に `noCache` を持たせる。理由: プロンプトの文言を変えたのに
`promptVersion` を上げ忘れる事故から抜ける口が要る。6.5 の表のうち2行は
justic 側の操作ミスで外れなくなるもので、その場で回復できないと使えない。

**代替案。** 「キャッシュを全部消す」操作を置く案は採らない。キャッシュは
既存の `reviews` と `findings` そのものなので (6.1)、消すと過去の記録が消える。

**代償。** `noCache` の走査は全ファイルを呼び直すので、押し間違えると
上限 (7章) を丸ごと使う。既定は off にし、画面では畳んだ場所に置く。

### 6.7 `prompt_version` が全件 NULL の現状

02 の前の版は「実データで `reviews.prompt_version` は 43 行すべて NULL」と書いている
(この文書では DB を読んでいないので、行数は前の版の記述をそのまま引く)。

**決定。埋め戻さない。**

理由: どのプロンプト版で走ったかの記録が無い。`llm.js` の `d01-v1` が当時の文言と
同じである保証も無い。推測で `'d01-v1'` を入れると、**別の文言で出した結果が
「同じ版の結果」としてキャッシュに当たる。**

埋め戻さなくても困らない。6.1 の問い合わせが `prompt_version is not null` を
要求するので、古い記録は自動的に対象外になる。`'unknown'` のような値を入れる案も
同じ効果だが、無い情報を書かずに済むほうを採る。

**これから作る記録は埋まる。** 01 の実装で `server.js` の `reviewOne` は
`createReview` に `promptVersion` を渡している。02 の前の版の
「`server.js` は `createReview` に `promptVersion` を渡していない」は、
01 の実装で解消済み。

## 7. 上限

### 7.1 状況

決まっていない。要件 `OPEN-06` (許容レビュー時間) および `OPEN-08` (コスト上限) が
決まらないと暫定にしかならない。

前の版は「同時実行数1・タイムアウト120秒・上限200回・目標10分」と書いたが、
逐次で200回を600秒に収めるには1回平均3秒が要り、**タイムアウト1回で予算の20%を使う。**
両立しない。

### 7.2 決定 — 上限は呼び出し回数で置く。時間では切らない

**上限は警告ではなく、超えたら止まるものとする。**

**時間で切らない理由。** 時間で切ると、切れる位置が観点の途中になる。
途中で止めた review は `finished_at` が NULL で残るので 01 の 7.3 が集計から
除外し、測定は守られる。守られないのは画面のほうで、**指摘0件の review が
「指摘なし」に見える。** 回数で切れば、切れる位置が必ずレビューの境界に揃う。

**単位が決まっていない (00 の 4.3) 問題への答え。** 上限を「呼び出し回数」で置くと、
03 が単位を段落に変えても上限の**定義**は変わらない。変わるのは実数だけで、
それは 03 が置き直す (15章 RT-04)。「ファイル数の上限」で置くとこうはならない。

**代償。** 待ち時間は有界にならない。遅いモデルなら 200 回でも数時間になる。
待ち時間のほうを受け持つのは非同期化 (3章) で、上限が受け持つのは費用である。
要件 `OPEN-06` (許容レビュー時間) が決まっても、それをこの上限に翻訳はしない。

### 7.3 暫定値と、決まったら差し替える場所

| 項目 | 暫定値 | 根拠 | 差し替える場所 |
|---|---|---|---|
| 1走査あたりの呼び出し上限 | 200 回 | 前の版の値を引き継ぐ。根拠は無い | `.env.example` の `JUSTIC_SCAN_MAX_CALLS` と `scans.max_calls` |
| 1観点のタイムアウト | 120 秒 | `llm.js` の `JUSTIC_L3_TIMEOUT_MS` の既定と同じ | `.env.example` の `JUSTIC_L3_TIMEOUT_MS` |
| 1走査あたりのファイル数 | 50 | `server.js` が `Math.min(maxFiles, 50)` で既に切っている | `server.js` のブランチ走査と `index.html` の `maxFiles` |
| 同時に走る走査 | 1本 | 8章 | `scans` を取る問い合わせ |

**要件 `OPEN-06` / `OPEN-08` が決まったら、この表の「暫定値」を直す。**

実際に使った値は走査ごとに `scans.max_calls` へ書き残す。
上限を変えても、過去の走査がどの上限で走ったかは分かる。

### 7.4 決定 — 超えるなら始めない

1. 走査を作って `queued` にする
2. 対象の一覧を取る (ブランチ走査はここで GitHub を叩く。LLM は呼ばない)
3. `planned_n × 観点数` を出し、`max_calls` を超えるなら
   `stopped` (`stop_reason='limit'`) にして **LLM を1回も呼ばずに終える**
4. 超えなければ進める

理由: 始めてから止めると、GitHub の取得だけ済ませて LLM の予算を使う。

**確認を挟まない。** 上限の内なら黙って全部使う。確認を挟むと走査が2往復になり、
非同期にした意味が薄れる。上限を超えたときだけ、数字と一緒に利用者へ返し、
上限を上げるか `prefix` で絞るかを選ばせる。

**代償。** 上限の内であれば、利用者は使う量を事前に承認していない。
呼び出し回数は走査中ずっと画面に出す (12章)。

### 7.5 数え方

| 事象 | 数える |
|---|---|
| 観点1本を投げた | 1 |
| タイムアウトした | 1 (予算を使ったのは事実) |
| JSON が壊れた | 1 |
| キャッシュに当たった | 0 |
| 上限で走らせなかった | 0 |

## 8. 並列化とプロンプトキャッシュ

`llm.js` は `SYSTEM` を system メッセージに置き、user メッセージの先頭に本文を、
末尾に観点の問いを置く (要件 `L3-07`)。同じ本文に観点を逐次に投げれば、
2回目以降は本文の prefill が接頭辞キャッシュに当たる、というのが前の版の想定だった。

前の版はこの効果を**未確認**と書いた。**確認した。**

### 8.1 確認結果

推論サーバーには要求を送っていない。`~/llm` と `~/llm-router.py`、
`~/escha-serve.sh`、`~/runtime/sglang/serve.sh` を読んだ結果である。

| # | 分かったこと | 根拠 |
|---|---|---|
| 1 | llama-server はスロット1本で起動する | `~/llm` 311行 (Windows 側) と 319行 (WSL 側) の `-np 1` |
| 2 | `--cache-reuse` は指定していない | `~/llm` 全体で `cache` に当たるのは 320行の `--cache-type-k` / `--cache-type-v` (KV の量子化) だけ |
| 3 | `--slot-save-path` も指定していない | 同上。スロットの内容をディスクに残す設定は無い |
| 4 | それでも接頭辞の再利用はある | `~/llm-router.py` 854-858行が、llama.cpp のログの `prompt eval time = … / N tokens` (新しく計算した分) と `release: … n_tokens = M` (スロット内の総数) の差を `cached_in` として記録している。差が出るのは、直前のスロットの内容と一致した接頭辞を計算し直さないため |
| 5 | バックエンドは1件ずつしか処理しない | `~/llm-router.py` 221行のコメント「-np 1 で同時実行は 1 件なので」 |
| 6 | sglang 構成では接頭辞キャッシュが**切ってある** | `~/escha-serve.sh` の `RADIX:=0` → `~/runtime/sglang/serve.sh` 249行が `--disable-radix-cache` を渡す。66-69行に理由: このハイブリッド構成では radix cache が overlap scheduler を無効にし、再利用の得より損が大きい |
| 7 | ルーターは system メッセージを書き換える | `~/llm-router.py` 405-434行。画面で設定した共通の文言を messages[0] に差し込む (空なら触らない) |

### 8.2 決定 — ファイル間もレビュー間も並列にしない

**この構成では並列化しても速くならない。** スロットが1本なので、並列に投げても
バックエンドの待ち行列に並ぶだけである (8.1 の 5)。加えて接頭辞が入れ替わるので
再利用が消える (同 1、2)。

**代替案。** `-np` を上げてスロットを増やす案は、justic の設計では採れない。
18080 のルーターと llama-server の起動設定は justic の外にあり、
justic のためにそこを変えると他の利用者に影響する。

**代償。** 逐次のままなので、待ち時間は呼び出し回数に比例する。
その手当ては上限 (7章) と非同期化 (3章) のほうで行う。

### 8.3 決定 — 接頭辞の再利用は「効いたら得」として扱い、見積りに入れない

再利用が成立する条件は3つそろったときだけである。

1. llama.cpp のバックエンドが動いている (sglang 構成では切ってある)
2. justic の呼び出しが**連続している**。スロットは1本で `--cache-reuse` も無いので、
   間に1件でも別の要求が入れば消える
3. その1件は **justic 以外からも来る**。18080 のルーターは複数の端末が共有している

**したがって、上限の見積り (7章) にはこの効果を入れない。**
上限は呼び出し回数で置いてあるので、再利用が効くかどうかによらず意味は変わらない。

**効果の大きさは測っていない。** 測るには要求を送る必要があるため、この設計では
測らない。測り方だけ決める: ルーターは記録に `cached_in` を持っているので、
justic 用に発行したキーの記録を `~/llm-tx` で見れば、走査1回あたりの再利用トークン数が
分かる。

**また、03 が単位を段落にすると本文が段落ごとに変わるので、この効果は消える。**

### 8.4 ルーターの共通システムプロンプトという穴

8.1 の 7 のとおり、ルーターは justic が送った system メッセージに、画面で設定した
文言を差し込む。つまり **`prompt_version` は justic 側の文言しか表していない。**
ルーターの設定を変えると、同じ `prompt_version` のまま結果が変わる。

キャッシュの鍵から見ると、これは 6.5 の表に載らない無効化条件である。
justic からルーターの設定を読む口は無い。当面は 6.6 の `noCache` で逃げる。
鍵に入れるかどうかは 15章 RT-03。

## 9. 失敗したとき

**どの場合も「検査した」と「指摘が無かった」を混同させない。**

| 失敗 | 決定 | 走査 |
|---|---|---|
| 推論サーバーに繋がらない | `runL3` が観点ごとに捕まえて `status='error'` にし、L1 の結果だけ残す (実装済み) | **同じ理由で2回続いたら止める** (`stopped` / `backend`) |
| 観点1本がタイムアウト | その観点だけ `status='timeout'`。他の観点は返す (実装済み) | 続ける |
| JSON が壊れて解釈できない | `status='parse_error'`。`llm.js` の `parseFindings` が `{ok, findings, reason}` を返す形になっており、正当な「該当なし」(要件 `L3-06`) と区別できる (01 の11章で実装済み) | 続ける |
| コンテキスト長を超えた | 入力を切らずに失敗させる。上流が断り、`chat()` が本文の先頭200文字を付けて投げる | 続ける |
| GitHub のレート制限 | `github.js` の `gh()` が 403 と `x-ratelimit-remaining: 0` を見て文言を付ける | **止める** (`stopped` / `rate_limit`)。済んだ `scan_items` はそのまま、残りは `pending` のまま残して一覧に出す |
| 走査の途中で落ちた | 起動時に `running` を `failed` (`restart`) にする (3.3) | — |
| 上限に達した | 残りの観点に `review_aspects.status='skipped'` の行を作る | **止める** (`stopped` / `limit`) |

### 9.1 「推論サーバーに繋がらない」で2回にする理由

繋がらないまま50ファイル走らせると、L1 だけの review が50件と
`review_aspects.status='error'` が50行残る。害は無いが利用者は最後まで待たされる。
1回で止めると、一時的な失敗で走査全体が落ちる。2回にする。

### 9.2 コンテキスト長の事前チェックをしない理由

コンテキスト長はモデルごとに違う。justic は `JUSTIC_MODEL` が空で、
どのモデルが答えるかを走らせるまで知らない (6.3)。**上流に断らせるほうが正確。**
代償として、長すぎる文書は呼び出し1回ぶんを無駄にする。

### 9.3 「指摘なし」の出し分け

いまの `app.js` の `reviewBlock` は `r.findings.length === 0` だけを見て
「指摘なし。」と出す。**L3 が全滅していても同じ表示になる。**

**決定。「指摘なし。」は、そのレビューの全観点が `ok` か `empty` で終わったときだけ出す。**

1本でも `timeout` / `parse_error` / `error` / `skipped` があれば、
「N 観点中 M 観点が終わらなかった」と観点ごとの理由を出す。

`skipped` の行を作る理由は 01 の 6.2 と同じ。**行が無いと「走らせなかった」が
復元できない。**

**検討した代替案。** 失敗した観点があるレビューを画面に出さない案は採らない。
L1 の指摘は出ているので、隠すと「文体も見ていない」に見える。
要件9章の「L1 のみが通った状態と、L3 まで通した状態を応答で区別する」に反する。

**代償。** 指摘が0件のレビューでも、観点ごとの結果を出すぶん行が増える。
全観点が `ok` か `empty` なら1行で済ませ、そうでないときだけ展開する。

## 10. データモデル

### 10.1 変更しないもの

- `findings` の `layer` と `exposure` の CHECK、`review_aspects.status` の CHECK
- `labeled_findings` ビュー、`current_verdicts` ビュー、`verdicts` 表
- `human_annotations` と `annotation_completions` (01)

6.4 の `from_cache` により、CHECK を貼り直す必要が無くなった。

### 10.2 追加と変更

`db/migrations/011_scans.sql` として入れる。

```sql
-- 011_scans.sql
-- docs/design-02-runtime.md の 10章。

begin;

-- 走査 = 1回の操作で走る複数のレビューの束 (00 の 5章)
create table if not exists scans (
    id             bigserial primary key,
    source_kind    text not null
                   check (source_kind in ('paste','github_pr','github_branch')),
    repo           text,                    -- 'owner/name'。貼り付けは NULL
    ref            text,                    -- ブランチ名、または PR 番号
    -- 要求を受けた時点の材料で作る (5.2)。作り方はアプリ側にある
    scan_key       text not null,
    -- 実際に答えたモデル。最初の呼び出しの応答から入れる (6.3)
    model_id       text,
    prompt_version text,
    status         text not null default 'queued'
                   check (status in ('queued','running','done','stopped',
                                     'cancelled','failed')),
    stop_reason    text check (stop_reason in ('limit','rate_limit',
                                               'backend','restart')),
    planned_n      int,                     -- 走らせる予定のレビュー数
    done_n         int not null default 0,
    call_count     int not null default 0,  -- 実際に投げた LLM 呼び出し回数
    max_calls      int not null,            -- この走査に許した上限 (7.3)
    no_cache       boolean not null default false,
    user_id        bigint references users on delete restrict,
    error          text,
    created_at     timestamptz not null default now(),
    started_at     timestamptz,
    finished_at    timestamptz
);

-- 実行中の同じ鍵は1本だけ (5.2)。終わった走査は同じ鍵で何本でも残る
create unique index if not exists scans_live_key_idx
    on scans (scan_key) where status in ('queued','running');
create index if not exists scans_recent_idx on scans (created_at desc);

-- 走らせる予定の観点。00 の 4.1 の台帳から外部キーを張る。
-- 配列の列にすると外部キーが張れないので別表にする
create table if not exists scan_aspects (
    scan_id   bigint not null references scans on delete cascade,
    aspect_id text   not null references aspects on delete restrict,
    primary key (scan_id, aspect_id)
);

-- 走査が見る対象。1行 = 1文書。
-- 「残りを一覧で出す」「進捗を出す」「取り消し後に何が済んだか」が
-- すべてこの表を要求する (2.3)
create table if not exists scan_items (
    scan_id     bigint not null references scans on delete cascade,
    seq         int    not null,
    path        text,                       -- 貼り付けは NULL
    title       text   not null,
    status      text   not null default 'pending'
                check (status in ('pending','running','done','failed')),
    review_id   bigint references reviews on delete restrict,
    error       text,
    started_at  timestamptz,
    finished_at timestamptz,
    primary key (scan_id, seq)
);
create index if not exists scan_items_pending_idx
    on scan_items (scan_id, seq) where status = 'pending';

-- どの走査のレビューか。走査は消さないので restrict
alter table reviews add column if not exists scan_id bigint
    references scans on delete restrict;
create index if not exists reviews_scan_idx on reviews (scan_id, started_at);

-- POST の応答にしか無かった数 (12.1)。再読み込みで消えないようにする
alter table reviews add column if not exists l1_outside_diff int not null default 0;

-- 前回の結果を写したか (6.2)。
-- status に 'cached' を足さない。01 の 7.3 が status='ok' で絞っており、
-- 足すとキャッシュに当たった走査が recall の対象から静かに落ちる (6.4)
alter table review_aspects add column if not exists from_cache boolean not null default false;
alter table review_aspects add column if not exists cached_from bigint
    references reviews on delete set null;
-- 引用が原文に無くて捨てた数。POST の応答にしか無かった (12.1)
alter table review_aspects add column if not exists dropped_n int not null default 0;

-- 6.1 のキャッシュ問い合わせ用
create index if not exists review_aspects_cache_idx
    on review_aspects (aspect_id, model_id, prompt_version, status);

-- 写しの元 (6.2)。写しの写しは根を引き継ぐので連鎖しない
alter table findings add column if not exists origin_id bigint
    references findings on delete restrict;
create index if not exists findings_origin_idx
    on findings (origin_id) where origin_id is not null;

commit;
```

## 11. API

走査は測定の基準ではないので、01 の 8.3 の「走査は権限不要」を変えない。
ログインしていれば `scans.user_id` に入れる。状態を変える要求は
`server.js` の Origin と Host の検査を通る。

| メソッド | パス | 本文 / 応答 | 権限 |
|---|---|---|---|
| POST | `/api/scans` | `{kind:'paste'\|'pr'\|'branch', …, useL3, noCache}` → `{scanId, deduped?}` | 不要 |
| GET | `/api/scans/:id` | 状態・進捗・`scan_items`・レビュー一覧 | 不要 |
| GET | `/api/scans` | 最近の走査 | 不要 |
| POST | `/api/scans/:id/cancel` | → `{status:'cancelled'}` | 不要 |
| POST | `/api/reviews` | **L1 だけの同期経路に変える** (4.2)。`useL3` を受け取らない | 不要 |
| GET | `/api/reviews/:id` | 変えない (01 で `review_aspects` を返している) | 不要 |
| GET | `/api/stats` | **走査数と累計呼び出し回数を追加** | 不要 |
| — | `/api/reviews/github/pr` | **廃止。`/api/scans` の `kind:'pr'` へ** | — |
| — | `/api/reviews/github/branch` | **廃止。`/api/scans` の `kind:'branch'` へ** | — |

走査のスキーマ

```ts
{
  id: number;
  kind: "paste" | "pr" | "branch";
  repo: string | null;
  ref: string | null;
  status: "queued" | "running" | "done" | "stopped" | "cancelled" | "failed";
  stopReason: "limit" | "rate_limit" | "backend" | "restart" | null;
  plannedN: number | null;      // 走らせる予定のレビュー数
  doneN: number;
  callCount: number;            // 実際に投げた LLM 呼び出し回数
  maxCalls: number;
  modelId: string | null;       // 実際に答えたモデル (6.3)
  items: {
    seq: number;
    path: string | null;
    title: string;
    status: "pending" | "running" | "done" | "failed";
    reviewId: number | null;
    fromCache: boolean;         // その review の観点が全部キャッシュに当たった
    error: string | null;
  }[];
  startedAt: string | null;
  finishedAt: string | null;
}
```

`GET /api/scans/:id` はレビューの本体を含めない。`items[].reviewId` から
既存の `GET /api/reviews/:id` を引く。理由: 走査は1〜2秒ごとに引くので、
毎回 50 ファイルぶんの指摘を返すと転送量が上限のほうに縛られる。

## 12. 画面

| 追加・変更 | 理由 |
|---|---|
| 走査の進捗 (`doneN`/`plannedN` ファイル、`callCount`/`maxCalls` 回) | 非同期にすると「押したのに何も起きない」に見える |
| いま何を見ているか (`running` の `scan_items` の `title`) | 同上 |
| 取り消しボタンと「止めています」の表示 | 3.5。押してから最大1観点ぶん待つ |
| 事前の回数表示 | 7.4。上限を超えたら数字と一緒に理由を出す |
| キャッシュに当たった行の印 | 6.2。「前回の結果を再利用」と出す |
| 「指摘なし」の出し分け | 9.3。全観点が `ok` か `empty` のときだけ |
| 止まったときの残り一覧 | 9章。`pending` の `scan_items` を出す |
| 再読み込みで消えない | URL に `#scan=<id>` を持たせる。01 の10章が同じことを要求している |
| `stats` に走査数と累計呼び出し回数 | 00 の3章の「減らす」が効いているかを見る |

### 12.1 `state.reviews` の置き換え

**状況。** `app.js` の `state.reviews` は POST の応答をそのまま持っている。
`reviewBlock(r)` が読むのは `r.reviewId` / `r.title` / `r.findings` / `r.issueUrl`。
走査全体の表示は `notChecked` / `l1OutsideDiff` / `droppedByEvidenceCheck` /
`l3Errors` を読む。**この4つは POST の応答にしか存在しない。**

**決定。`state.scanId` だけを持ち、表示は `GET /api/scans/:id` と
`GET /api/reviews/:id` から作る。**

4つの置き場を決める。

| 値 | 置き場 |
|---|---|
| `l3Errors` | `review_aspects.error`。01 で永続化済み |
| `notChecked` | `reviews.layers` から導ける。L3 が無ければ未検査 |
| `droppedByEvidenceCheck` | **保存されていない。** `review_aspects.dropped_n` を足す |
| `l1OutsideDiff` | **保存されていない。** `reviews.l1_outside_diff` を足す |

`GET /api/reviews/:id` は `reviews.*` をそのまま返すので列の名前が
`id` / `title` / `findings` になる。`reviewBlock` が読む形へ写す関数を1つ置く。
`reviewBlock` 自体の変更は 9.3 の「指摘なし」の出し分けだけにとどめる。

**代償。** 走査中は画面がポーリングで組み上がるので、結果が一度に出ない。

## 13. 実装で変える箇所

| 場所 | 変更 |
|---|---|
| `server.js` `reviewOne` | `scanId` と `seq` を受け取る。`l1OutsideDiff` を `reviews` に書く。呼び出し回数を `scans.call_count` に足す |
| `server.js` `/api/reviews` | L1 だけの同期経路にする (4.2) |
| `server.js` `/api/reviews/github/pr` `/branch` | 廃止し、`POST /api/scans` に寄せる |
| `server.js` ブランチ走査 | **`sourceKind` が `github_pr` のまま。`github_branch` に直す。** 01 の11章に挙がっているが未修正。移行 `004` は既存データと CHECK を直しただけで、コードは今も `github_pr` を書いている |
| `server.js` `app.listen` の前 | `running` の走査を `failed` (`restart`) に回収する (3.3) |
| `server.js` | 走査を進めるループを1つ足す (3.2) |
| `server.js` `/api/stats` | 走査数と累計呼び出し回数を足す |
| `llm.js` `chat` | 返り値を `{content, model}` にする。いまは content しか返していない (6.3) |
| `llm.js` `runL3` | `model` を実測値にする。`MODEL \|\| "(サーバー既定)"` をやめる |
| `llm.js` `runL3` | 観点ごとに1回を数え、上限に達したら残りを `skipped` で返す (9章) |
| `db.js` `createReview` | `scanId` と `l1OutsideDiff` を書く |
| `db.js` `recordAspectRun` | `from_cache` / `cached_from` / `dropped_n` を書く |
| `db.js` | `createScan` / `takeQueuedScan` / `updateScanProgress` / `finishScan` / `getScan` / `cachedAspectRun` / `copyFindings` を足す |
| `db.js` `stats` | 走査数と累計呼び出し回数 |
| `app.js` `state.reviews` | `state.scanId` とポーリングに置き換える (12.1) |
| `app.js` `ENDPOINTS` `$("run").onclick` | `/api/scans` を呼ぶ |
| `app.js` `reviewBlock` | 「指摘なし。」の条件を 9.3 に変える |
| `tuning/export_snapshot.py` | `labeled_findings` に `findings` を結合し、`origin_id` で写しを畳む (6.2、15章 RT-06) |
| `github.js` | 変えない |

## 14. 移行

| 対象 | 手順 |
|---|---|
| 既存の `reviews` | `scan_id` は **NULL のまま。埋め戻さない** |
| 既存の `review_aspects` | `from_cache` は false、`dropped_n` は 0。既定値で足りる |
| 既存の `findings` | `origin_id` は NULL。写しではないので正しい |
| 既存の `l3_model_id` | `'(サーバー既定)'` のまま。**書き換えない** (6.3)。6.1 の問い合わせが除く |
| 既存の `prompt_version` | NULL のまま。**埋め戻さない** (6.7)。6.1 の問い合わせが除く |
| CHECK 制約 | **貼り直さない。** 新設する表の CHECK は新規なので問題なく、`review_aspects.status` には触らない (6.4) |

**`scan_id` を埋め戻さない理由。** どのレビューが同じ操作の束だったかの記録が無い。
`started_at` が近いことは束の証拠にならない (PR 走査とブランチ走査が続けて走れば
混ざる)。推測で埋めると走査の統計が嘘になる。集計側は
「`scan_id is null` は1件で1走査」と読む。

**戻し方。** `010` は表の追加と列の追加だけで、既存の行にも既存の制約にも触らない。
戻すときは追加した表と列を落とす。`reviews.scan_id` を落としても
既存の経路は動く (01 までの状態に戻る)。

## 15. 未決事項

| ID | 項目 | 決めないと止まるもの | 決め方 |
|---|---|---|---|
| RT-01 | 1走査あたりの呼び出し上限の実数 | 7章の上限 | 要件 `OPEN-08`。暫定 200。差し替えは 7.3 の表 |
| RT-02 | 1観点のタイムアウトの実数 | 同上 | 要件 `OPEN-06`。暫定 120 秒。差し替えは 7.3 の表 |
| RT-03 | ルーターの共通システムプロンプトを鍵に入れるか | キャッシュの正しさ (8.4) | justic からルーターの設定を読む口が無い。当面は `noCache` で逃げる |
| RT-04 | 単位が段落になったときの上限の実数 | 03 | 上限の定義は変わらない (7.2)。実数は 03 が置き直す |
| RT-05 | 走査を別プロセスにするか | 03 で回数が桁で増えたとき | 1走査の呼び出しが3桁になったら、画面の応答の遅れを測って決める |
| RT-06 | 教師データの重複をどこで畳むか | L4 の学習 | `origin_id` は足す (6.2)。畳むのは `export_snapshot.py`。写しが 100 件溜まってから、畳む前後で比較する |
| RT-07 | `aspects.question` を書き換えたときに `promptVersion` をどう上げるか | 6.5 の無効化 | 問いは表に、版は `llm.js` にある。04 が観点を足すときに合わせて決める |

## 16. リスク

| ID | 内容 | 度合い | 手当て |
|---|---|---|---|
| R-11 | キャッシュが別のモデルの結果を返す | **高** | 6.3。モデル ID を実測値にするまでキャッシュを有効にしない。`'(サーバー既定)'` と NULL は当たりにしない |
| R-12 | `status` に `'cached'` を足して recall の分母が静かに縮む | **高** | 6.4。`from_cache` で持つ。01 の 7.3 の式に触らない |
| R-13 | 上限やレート制限で止まった走査が「指摘なし」に見える | 高 | 9.3 の出し分けと `skipped` の行 |
| R-14 | 非同期にしたが進捗が出ず、利用者が二度押す | 中 | 5章の冪等性で2度目は同じ `scanId`。12章の進捗表示 |
| R-15 | 走査中にプロセスが落ち、`running` が残り続ける | 中 | 3.3 の起動時の回収 |
| R-16 | 03 で単位が段落になり、キャッシュがほぼ当たらなくなる | 中 | 8.3。鍵は本文単位なので段落ごとに別鍵になる。02 の効き目は上限のほうに残る |
| R-17 | 経路を寄せたことで、外から古い経路を叩いていた利用者が壊れる | 低 | 4.4。README には載せていない |

# MCP からの呼び出し

本書は [design-00-overview.md](design-00-overview.md) の 06 である。共通の決定は 00 に従い、
ここでは再定義しない。SDK と Claude Code の挙動で確かめていない事項は 11.3 にまとめてある。

## 1. 目的と品質目標

### 1.1 解く問題

`P-05` — **justic の経路 (貼り付け / PR / ブランチ / 採否) を呼べるのは画面と
手書きのスクリプトだけで、AI の道具から呼ぶ決まった形が無い。**

設計書を書くのは Claude Code のような AI の道具で、書いた側が指摘の採否を押す (00 の運用)。
その AI の道具から justic を呼ぶ手段が無かった。壊れ方は 4 つあった。

| # | 実装前の状態 | 本書での扱い |
|---|---|---|
| 1 | 文書を通すには、毎回 `POST /api/reviews` を叩くスクリプトを書く | ツール `review_document` (5.3) |
| 2 | 採否を押すのも同じで、curl の指示書を毎回書く | ツール `set_verdict` (5.3) |
| 3 | 本文が要求の引数になる。AI の道具は 60 KB の本文を丸ごと生成して渡す | `path` で受ける (9.3) |
| 4 | 誰が押した採否かが `local` にまとまり、人が画面で押したものと区別が付かない | `decided_by = 'mcp'` (9.6) |

要件の `OPEN-03` (呼び出し元: CI、CLI、エディタ、MCP 経由の AI ツール) のうち、
本書は **MCP 経由の AI ツール** だけを決める。CI・CLI・エディタは決めない。

### 1.2 品質目標

**順位を付ける。** 下の順で、上が下に勝つ。

| 順位 | 目標 | 確かめ方 (10章) |
|---|---|---|
| 1 | 05 の 1 番をそのまま守る。MCP 経由の要求は、利用者の選んでいない接続先へ本文を出さない | Q-1、Q-2 |
| 2 | justic に溜まった本文は MCP 経由で外に出ない。ツールは文書の本文を返さない | Q-3 |
| 3 | 画面と同じ結果になる。同じ入力なら HTTP の経路と同じ検査・同じ記録になる | Q-4 |
| 4 | 使いやすさ。AI の道具が本文を書き出さずに済み、登録が 1 行で済む | Q-5、Q-6 |

順位が効く場面を 1 つ挙げる。AI の道具が過去のレビューの本文を引ければ修正案を
出しやすくなり 4 は上がるが、2 に反する。返さない (9.4)。

## 2. 制約

動かせない前提。以降の判断はこれを土台にしている。

| # | 制約 | 出所 |
|---|---|---|
| C-1 | justic は `127.0.0.1` と `::1` の 5180 でしか待たない | README「起動」。LAN に出すとトークンを持った画面が外に出る |
| C-2 | 状態を変える要求は Host と Origin の検査を通る (`server.js` の先頭のミドルウェア) | README「起動」。DNS リバインディングと他所のページからの POST を塞ぐ |
| C-3 | MCP の要求は cookie を持たない。ログインの仕組み (`auth.js`) は使えない | MCP の規約に cookie が無い |
| C-4 | 接続先は 05 の規則に従う。名前で選ぶ、無い名前は 400、黙った切り替えはしない | 05 の 6章 |
| C-5 | 02 (走査・非同期化) はまだ無い。3 つの経路は同期で、応答に結果が丸ごと入る | 02 の 7章「状態」 |
| C-6 | DB の表は変えない。移行を足さない | 本書の範囲 (9.6) |
| C-7 | SDK は `@modelcontextprotocol/*` 2.0.0。textlint 15.8 が `server` パッケージを既に持ち込んでいる | `web/package.json`、`npm ls` |
| C-8 | Claude Code は 1 回のツール呼び出しを既定 10 分で切り、応答を 25,000 トークンで切る | Claude Code の公式文書 (11.3 に注記) |

## 3. コンテキストと範囲

### 3.1 誰と何をやり取りするか

```
                 Streamable HTTP (POST /mcp)            HTTP (GET/POST /api/*)
 Claude Code  ───────────────────────────▶  justic  ◀──────────────────────  ブラウザ
 (AI の道具)   ◀─── ツールの結果 (JSON) ───  5180     ─── 画面・API の応答 ──▶  (人)
                                            │ │ │
                    ┌───────────────────────┘ │ └────────────────────┐
                    ▼                         ▼                      ▼
              PostgreSQL              LLM の接続先 (05)          GitHub API
        documents / reviews /       local (18080) など        PR・ブランチの
        findings / verdicts         external は MCP から      Markdown 取得
                                    は選べない (9.5)
```

| 相手 | 向き | 流れるもの | 流れないもの |
|---|---|---|---|
| Claude Code (MCP クライアント) | 入 | ツールの名前と引数 (文書の本文またはパス、採否) | cookie、ログイン |
| 同 | 出 | 指摘 (`findings`、`evidence` を含む)、レビューの番号、集計 | **文書の本文** (`documents.body`) |
| PostgreSQL | 双方向 | HTTP の経路と同じ読み書き | 新しい表・列 |
| LLM の接続先 | 出 | `useL3: true` で外部でない接続先を名指ししたときだけ本文 | 外部の接続先への本文 |
| GitHub API | 入 | PR とブランチの Markdown (`.env` の PAT で) | ログインした人のトークン |

### 3.2 範囲外

- 注釈 (`/api/documents/:id/annotations`) と完了の記録。01 の 8章がログインを必須にしており、C-3 で満たせない
- issue の起票 (`/api/issues`)。GitHub への書き込みを AI の道具に開けるかは別に決める (11.2 MC-03)
- 走査・非同期化・キャッシュ (02)。02 が入ったら 6.1 の流れは `scanId` を返す形に変わる (9.2 の結果)
- 接続先の増減とキーの置き場所 (05)
- CI・CLI・エディタからの呼び出し

## 4. 解決戦略

| 品質目標 | 方針 | 章 |
|---|---|---|
| 1 接続先を勝手に選ばない | `useL3: true` のときは `endpoint` を名前で必須にし、`external: true` の接続先は要求を作る前に拒む。05 の「省略時は既定」には落とさない | 9.5 |
| 2 本文を出さない | `get_review` は `documents.body` を落として返す。`list_reviews` は元から本文を持たない | 9.4 |
| 3 画面と同じ結果 | HTTP のハンドラの中身を `{status, json}` を返す関数に切り出し、HTTP とツールの両方がそれを呼ぶ。エラーの文言も 1 か所 | 9.2 |
| 4 使いやすさ | justic のプロセス内で `/mcp` を受け、URL 1 行で登録できる。`review_document` は絶対パスを受け、justic 側でファイルを読む | 9.1、9.3 |

## 5. 構成要素

### 5.1 依存関係

```
 Claude Code ──HTTP──▶ web/server.js
                        ├─ Host/Origin の検査
                        ├─ app.all("/mcp", mcpHandler({...}))  (express.json() より前)
                        ├─ express.json() / express.static
                        ├─ run* / buildHealth (切り出した中身)  ◀─┐
                        └─ 既存の HTTP の経路 (薄い包み)  ────────┤ 同じ関数を呼ぶ
                                                                  │
                       web/mcp.js ────────────────────────────────┘
                        ├─ @modelcontextprotocol/server  (McpServer, createMcpHandler)
                        ├─ @modelcontextprotocol/node    (toNodeHandler) ── @hono/node-server
                        ├─ zod/v4                        (引数の型)
                        ├─ web/endpoints.js              (接続先の名前と external の判定)
                        └─ web/github.js                 (envToken)
```

### 5.2 責務

| 構成要素 | 責務 | 公開する名前 |
|---|---|---|
| `web/server.js` | HTTP の経路。5 つのハンドラの中身を関数に切り出し、HTTP は `res.status(r.status).json(r.json)` だけを持つ | `runPasteReview(body, {token})`、`runPullRequestReview(body, {token})`、`runBranchReview(body, {token})`、`runVerdict(findingId, body, who)`、`buildHealth(session)` (module 内。`mcpHandler` に束で渡す) |
| `web/mcp.js` | ツールの定義と、`{status, json}` を MCP の結果に変える。`path` の読み込み。L3 の追加の規則 | `mcpHandler(api)` |
| `web/endpoints.js` | 接続先の一覧と検索 (05) | `get(name)`、`list()`、`defaultName()`、`describe()` |
| `web/db.js` | 読み書き (変更なし) | `getReview`、`recentReviews`、`stats`、`addVerdict`、`issuesForReview` |
| SDK `server` | 規約の実装。要求ごとに `McpServer` を作る (セッション無し)。引数の検査、`isError` への変換 | `McpServer`、`createMcpHandler(factory)` |
| SDK `node` | Node の `req` / `res` を Web 標準の `Request` / `Response` に変える | `toNodeHandler(handler)` |

`mcpHandler` に渡す束 `api` は、5.2 の `server.js` の 5 つの関数と `db` である。

### 5.3 ツール

| ツール | 引数 | 呼ぶ関数 | 結果の加工 | annotations |
|---|---|---|---|---|
| `health` | 無し | `buildHealth(null)` | `me` と `github.viaLogin` を落とす | 読むだけ |
| `stats` | 無し | `db.stats()` | 無し | 読むだけ |
| `list_reviews` | `limit` (整数 1〜100、既定 20) | `db.recentReviews(limit)` | 無し (配列のまま。8.6) | 読むだけ |
| `get_review` | `reviewId` (数値か数字文字列) | `db.getReview` + `db.issuesForReview` | **`body` を落とす** | 読むだけ |
| `review_document` | `title?`、`body?` か `path?` (排他)、`origin?`、`useL3?` (既定 false)、`endpoint?` | `runPasteReview` | 無し | 書く |
| `review_pull_request` | `ref`、`origin?`、`useL3?`、`endpoint?` | `runPullRequestReview` | `reviews[].findings` を `findingCount` に | 書く |
| `review_branch` | `ref`、`branch?`、`prefix?`、`maxFiles?` (1〜50、既定 10)、`origin?`、`useL3?`、`endpoint?` | `runBranchReview` | 同上 | 書く |
| `set_verdict` | `findingId`、`verdict` (`accepted` / `rejected`)、`note?`、`correctedText?` | `runVerdict(id, body, {decidedBy: "mcp", userId: null})` | 無し | 書く |

「読むだけ」は `{ readOnlyHint: true }` である。「書く」は `readOnlyHint: false` に
`destructiveHint: false` と `idempotentHint: false` を添えたものである。消す操作は無い。引数の型は `zod/v4` で書き、SDK がハンドラを呼ぶ前に検査する。

結果の形は 2 通りである。

- 成功 (`status` が 200): `content` に JSON の文字列、`structuredContent` に JSON そのもの
- 失敗: `{ content: [{ type: "text", text: json.error }], isError: true }`。文言は HTTP の経路と同じ

## 6. ランタイム

### 6.1 `review_document` を `path` で呼ぶ

```
Claude Code            server.js                 mcp.js                       server.js / db
    │  POST /mcp            │                        │                              │
    │ tools/call ──────────▶│ Host/Origin 検査        │                              │
    │                       │ app.all("/mcp") ──────▶│ SDK: 引数を zod で検査          │
    │                       │                        │ body と path の排他             │
    │                       │                        │ 絶対パス / 通常ファイル / 8 MiB │
    │                       │                        │ fs.readFile(path, "utf8")      │
    │                       │                        │ title 省略時は basename        │
    │                       │                        │ L3 の規則を判定 (9.5)           │
    │                       │                        │ runPasteReview({title, body,   │
    │                       │                        │   origin, useL3, endpoint}) ───▶│ parseOrigin / endpointForRequest
    │                       │                        │                                │ reviewOne → L1 (+L3) → 1 トランザクション
    │                       │                        │◀── {status: 200, json} ────────│
    │◀── content + structuredContent ────────────────│ 結果の形に変える (5.3)          │
```

- `path` の検査に落ちたときは `isError` で返り、DB には何も書かれない
- `useL3: true` で `endpoint` が無い、または外部の接続先なら、`runPasteReview` を呼ぶ前に `isError` で返る (9.5)。レビューは作られない (試験 7、8)
- `runPasteReview` が 400 を返したとき (本文が空、`origin` が不正、設定に無い接続先) は、その `error` の文言を `isError` にする

### 6.2 `set_verdict`

1. SDK が `findingId` を数値に直す (8.5)
2. `runVerdict(findingId, {verdict, note, correctedText}, {decidedBy: "mcp", userId: null})`
3. `verdict` が `accepted` / `rejected` 以外なら 400 の文言を `isError` に
4. `db.addVerdict` が `verdicts` に 1 行足す。`decided_by = 'mcp'`、`user_id = NULL`
5. 足した行をそのまま返す

### 6.3 他所のページからの POST

ブラウザで開いた他所のページが `POST /mcp` を投げると、`Origin` が `ALLOWED_HOSTS` に無いので
`server.js` の先頭のミドルウェアが 403 を返す。`/mcp` のハンドラには届かない。
`Host` が他所 (DNS リバインディング) のときも同じ。Claude Code の POST は `Origin` を持たないので通る。

### 6.4 失敗したとき

| 何が起きたか | ツールの結果 |
|---|---|
| 引数が型に合わない | SDK がハンドラを呼ばずに `isError` の結果を返す |
| 経路の関数が 400 / 404 を返した | `isError: true`、`content` にその `error` の文言 |
| `useL3` で `endpoint` 無し、または外部の接続先 | `isError: true` (9.5 の文言) |
| L3 の接続先が落ちている・時間切れ | HTTP と同じ。レビューは L1 だけで保存され、`l3Errors` / `stopped` に理由が入る。`isError` にしない (05 の 14章) |
| ハンドラが例外を投げた | SDK が捕まえて `isError` の結果にする。プロセスは落ちない |
| DB が落ちている | 例外になり、上と同じ。`health` を呼べば `db` で分かる |

justic は再試行しない (05 の 14.2)。

## 7. 配置

- **プロセスは 1 つ。** justic (`./run.sh`、`node --env-file=.env server.js`) が `/api/*` と `/mcp` の両方を 5180 で受ける。
  MCP のための別プロセスは無い。起動時の表示に `MCP: /mcp` が 1 行出る
- **待ち受けは変えない。** `127.0.0.1` と `::1` だけ (C-1)
- **Claude Code 側の登録** は利用者が 1 回だけ打つ。justic は `~/.claude.json` を書かない

  ```sh
  claude mcp add --transport http --scope user justic http://127.0.0.1:5180/mcp
  ```

  `--scope user` は `~/.claude.json` に入り、どのディレクトリから起動しても使える。`project` はリポジトリの
  `.mcp.json` に入るので使わない (利用者は justic の外で Claude Code を起動する)
- **順序。** justic を先に上げ、Claude Code を後から起動する。Claude Code は設定を起動時にしか読まないので、
  登録した後と、justic が止まっていた後は Claude Code を起動し直す
- **確かめ方。** `claude mcp list` が `justic: http://127.0.0.1:5180/mcp (HTTP) - ✔ Connected` を出す。
  Claude Code の中でツールは `mcp__justic__review_document` のような名前で見える

## 8. 横断的関心事

### 8.1 本文の行き先

本文が justic の外へ出るのは `useL3: true` のときだけで、行き先は名指しした外部でない接続先に限る (9.5)。
justic から MCP クライアントへは本文を返さない (9.4)。`review_document` の `path` で読んだ本文は
HTTP の貼り付け経路と同じく `documents` に保存される。

### 8.2 誰として記録されるか

MCP には cookie が無いので (C-3)、`actor()` の代わりに固定の `{decidedBy: "mcp", userId: null}` を渡す (9.6)。
GitHub のトークンは `.env` の `JUSTIC_GITHUB_TOKEN` (`gh.envToken()`) だけを使う。ログインした人のトークンは使えない。

### 8.3 Host と Origin

`/mcp` は既存のミドルウェアの後ろにある (5.1)。SDK にも `allowedHosts` / `allowedOrigins` の検査があるが、
SDK の文書は「外側のミドルウェアで検査せよ」として非推奨にしている。justic のミドルウェアがその役を
果たしているので、SDK 側の検査は使わない。検査を 2 か所に持たない。

### 8.4 応答の大きさ

Claude Code はツールの応答を既定 25,000 トークンで切る (C-8)。1 文書の指摘が数百件でも数千トークンに収まるが、
10 ファイルぶんの指摘を 1 つの応答に入れると上限に当たる。複数ファイルの経路は件数だけ返す (9.9)。

### 8.5 id の型

`reviews.id` と `findings.id` は `bigserial` で、`pg` は精度落ちを避けるためこれを JS の**文字列**で返す。
`review_document` が返す `reviewId` も文字列である。呼び出し側がそれをそのまま渡し直せるよう、
`get_review` の `reviewId` と `set_verdict` の `findingId` は数値と数字文字列の両方を受ける。
型は正の整数で、数字の文字列は数値に直してから検査する。

### 8.6 `structuredContent` が配列のとき

`list_reviews` は `db.recentReviews()` の配列をそのまま `structuredContent` に入れる。SDK は 2025 年版の
規約で繋いだクライアントに対してだけ、オブジェクトでない値を `{result: <値>}` に包む。
2025 年版の規約が `structuredContent` にオブジェクトを要求するためである。2026-07-28 版では包まない。`content` の文字列の JSON は
どちらでも生の配列である。

### 8.7 待ち時間

L3 を走らせる呼び出しは、接続先の `timeout_ms` (手元の `local` は 120 秒、`openrouter` は 180 秒) まで
応答を待つことがある。Claude Code の上限 10 分 (C-8) には収まるが、02 が入るまで時間は有界にならない
(05 の R-25 と同じ)。`useL3` の既定が `false` なので、何も書かなければ L1 だけで 1〜2 秒で返る。

## 9. アーキテクチャ決定

### 9.1 justic のプロセス内の `/mcp` で受ける

**状況。** MCP のサーバーには、クライアントが子プロセスとして起動し標準入出力で話す形 (stdio) と、
HTTP で待つ形 (Streamable HTTP) がある。justic は Express で 5180 に待っている (C-1、C-2)。

**決定。** justic のプロセスが `/mcp` を Streamable HTTP で受ける。セッションは持たず、要求ごとに
`McpServer` を作って捨てる (`createMcpHandler` の既定)。

**検討した代替案。**

| 代替案 | 採らない理由 |
|---|---|
| stdio のサーバー `web/mcp.js` を別に置き、Claude Code が子プロセスとして起動する。中身は 5180 へ HTTP を投げる | 5180 が要る点は同じで、プロセスが 1 つ増えるだけ。入力の検査を二重に持つか、自分自身へ HTTP を投げて Origin を付ける形になる。ポートを子プロセスに渡す設定も要る |
| textlint 自身の MCP サーバー (`textlint --mcp`) を使う | L1 の結果しか出ず、DB に残らない。採否も押せない |
| stdio と HTTP の両方を用意する | 呼ぶ側は Claude Code 1 つで、URL を 1 行登録すれば足りる |

**結果。** 登録が 1 行で済み、Host/Origin の検査がそのまま掛かる。代償は 2 つある。MCP の処理が画面と同じ
イベントループで動くので、ハンドラが `process.exit` を呼べば画面ごと止まる。もう 1 つは依存が増えることである (9.7)。

### 9.2 ツールは HTTP の経路と同じ関数を呼ぶ

**状況。** 3 つの検査の経路と採否の経路は、入力の検査と実行が 1 つのハンドラの中にあった。

**決定。** ハンドラの中身を「入力を受けて `{status, json}` を返す関数」(`runPasteReview` ほか、5.2) に
切り出し、HTTP の経路とツールの両方がそれを呼ぶ。HTTP の応答は 1 バイトも変えない (Q-4)。

**検討した代替案。**

| 代替案 | 採らない理由 |
|---|---|
| ツールから自分自身の `127.0.0.1:5180` へ HTTP を投げる | 本文の JSON 化と検査が 2 回走る。エラーが「ツールの失敗」と「HTTP の失敗」の 2 層になる。Origin の検査を通すために自分の Origin を付ける形になり、検査の意味が薄れる |
| 経路ごとにツールを作らず `call_api(method, path, body)` の 1 つにする | クライアントが経路の URL と本文の形を知る必要があり、スクリプトを書く手間と変わらない。引数の型検査も効かない |

**結果。** エラーの文言が 1 か所になり、画面と MCP で違う文言にならない。02 が入って 3 つの経路が
`/api/scans` に寄るときは、ツールも同じコミットで `scanId` を返す形に直す (02 の 13章に行を置いた)。
ツールの名前は経路の URL ではなく目的 (`review_document`) なので、そのとき名前は変わらない。

### 9.3 `review_document` は `path` でも受ける

**状況。** 1,100 行の設計書は約 60 KB あり、AI の道具がこれを引数として書き出すと、検査のたびに
数万トークンを生成する。ファイルは同じ機械にある。

**決定。** `body` の代わりに絶対パス `path` を渡せる。justic のプロセスがそのファイルを読む。
相対パスは拒む (プロセスの作業ディレクトリは `web/` で、クライアントと違う)。通常ファイルで 8 MiB
(`express.json` の上限と同じ) まで、UTF-8 で読む。`title` 省略時はファイル名。
`body` と `path` の両方があっても、どちらも無くても拒む。

**検討した代替案。** `body` だけにする。AI の道具が本文を生成し直す費用が毎回かかる。

**結果。** justic は同じ利用者のプロセスなので、利用者が読めるファイルは全部読める。クライアントも
同じ利用者で動いており、読める範囲は元から同じで、`path` で広がるものは無い。Markdown 以外のファイルを
渡されても拡張子では判定しない (11.1 R-29)。

### 9.4 ツールは文書の本文を返さない

**状況。** `db.getReview()` は `documents.body` を返し、`GET /api/reviews/:id` はそれを画面に渡している。
justic の DB には画面から通した実務の文書も入る。MCP を登録した AI の道具は、`get_review` に番号を
渡せばどのレビューも引ける。

**決定。** `get_review` は `body` を落として返す。指摘の `evidence` (該当行、300 文字まで) は返す。
指摘を直すのに要り、返さなければ `get_review` の意味が無い。

**検討した代替案。** MCP から作ったレビューだけを見せる。`reviews` に呼び出し元の列が要り (移行 1 本)、
C-6 に反するので今回は採らない (11.2 MC-02)。

**結果。** 全指摘の `evidence` を集めれば本文の一部が復元できる。これは代償として受け入れる (R-28)。

### 9.5 L3 は接続先の名前を書いたときだけ走り、外部の接続先は拒む

**状況。** 画面は既定の接続先を選択肢に見せ、利用者本人が選ぶ。MCP では AI の道具が選ぶので、
「利用者が選んだ」とは言えない。05 の `parseEndpoint` は `endpoint` 省略時に既定の接続先を返す。

**決定。** `useL3` の既定は `false`。`useL3: true` のときは `endpoint` を必須にし、無ければ
「useL3 のときは endpoint を名前で指定する。選べるのは: <外部でない名前>」で拒む。`endpoint` が
`external: true` の接続先なら「外部の接続先 '<名前>' は画面から選ぶ。MCP からは <外部でない名前> を選べる」で
拒む。どちらも `run*` を呼ぶ前に判定する。設定に無い名前は
`run*` に渡し、HTTP と同じ 400 の文言 (「接続先 '...' は無い。選べるのは: ...」) を `isError` にする。
`JUSTIC_L3=0` のときは HTTP と同じ挙動 (L1 だけ走り `notChecked` に出る) で、新しいエラーは足さない。

**検討した代替案。** 接続先の設定に「MCP から選べる」の項目を足して外部も許す。設定の項目が増え、
05 の品質目標 1 を守る責任が設定に移る。今回は採らない (11.2 MC-01)。

**結果。** MCP 経由では本文が機械の外に出ない。代償は、外部の接続先で検査したいときは画面を使うこと。

### 9.6 `decided_by` は `mcp`

**状況。** `actor()` はセッションが無いと `{userId: null, decidedBy: 'local'}` を返す。何もしなければ
MCP の採否は `local` になり、画面から未ログインで押したものと区別が付かない。要件 8.2 は採否を教師信号にする。

**決定。** `set_verdict` は `verdicts.decided_by` に固定の文字列 `mcp`、`user_id` に NULL を書く。
`decided_by` に型の制約が無いので、移行を足さずに済む (C-6)。

**検討した代替案。**

| 代替案 | 採らない理由 |
|---|---|
| クライアントの名前 (`clientInfo.name`) を入れる | セッションを持たない形では、ツールの呼び出しがどの初期化と組か SDK からは分からない (11.3)。`mcp` だけでも「人と分ける」には足りる |
| `.env` のローカルセッションを MCP にも張る | セッションは「押した本人」を表す (01 の 8.2)。AI の道具は本人ではない |
| ツールの引数で `decidedBy` を受ける | 呼ぶ側が名乗るだけで、値の信用が無い |

**結果。** 人が押した採否と AI の道具が押した採否を値で分けられる。`local` で溜まっている既存の行は、
人と curl の区別が付かないままである。

### 9.7 SDK は 2.0 系の分割パッケージ

**状況。** npm には 1 系の `@modelcontextprotocol/sdk` (1.30.0、1 パッケージ) と、2.0.0 の分割パッケージがある。
textlint 15.8.0 が `@modelcontextprotocol/server@2.0.0` と `zod@4` を既に持ち込んでいた。

**決定。** 2.0.0 を使う。`dependencies` に `@modelcontextprotocol/server`、`@modelcontextprotocol/node`、
`zod` (^4.6.5) の 3 つを宣言する。`@modelcontextprotocol/node` は `@hono/node-server` 1.19.17 を連れてくる。
`devDependencies` には `@modelcontextprotocol/client` を置き、試験でクライアントを演じさせる。
`@modelcontextprotocol/express` は使わない (中身が `express.json()` 付きの app と Host の検査で、どちらも justic に既にある)。

**検討した代替案。**

| 代替案 | 採らない理由 |
|---|---|
| 1 系の `@modelcontextprotocol/sdk` 1.30.0 | 1 系を足すと SDK が 2 組入る。import の形が 2 系と違い、後で書き直す |
| SDK を使わず JSON-RPC を自分で書く | 初期化の握手、`tools/list`、SSE の応答、規約の版の交渉を自分で持ち、規約が変わるたびに追う |

**結果。** `createMcpHandler` の既定 (`legacy: 'stateless'`) は 2026-07-28 版の規約とそれより前の版の両方を
セッション無しで受ける。代償は 2.0.0 が出たばかりで版の変化を追うこと (R-26)。

### 9.8 `/mcp` は `express.json()` より前に置く

**状況。** `toNodeHandler` が返す関数は `(req, res, parsedBody?)` の形をしている。`parsedBody` を渡さなければ
`req` から自分で本文を読み直す (パッケージの型定義にそう書いてある)。Express の `app.all` は
第 3 引数に `next` を渡すが、関数は本文と見なさず無視する。`express.json()` が先に本文を読むと、
`req` の流れは空になり MCP 側が読めない。

**決定。** `app.all("/mcp", ...)` を Host/Origin のミドルウェアの直後、`express.json()` の前に置く。

**検討した代替案。** `express.json()` の後ろに置き、`toNodeHandler` の第 3 引数に `req.body` を渡す包みを書く。
包みが 1 枚増えるだけで利点が無い。

**結果。** `/mcp` の本文は SDK が読み、`express.json()` の 8 MB の上限は掛からない。上限は SDK 側に任せる。

### 9.9 複数ファイルの経路は件数だけ返す

**状況。** `review_pull_request` / `review_branch` は最大 50 ファイルぶんのレビューを 1 つの応答に入れる。
Claude Code の応答の上限は 25,000 トークン (C-8)。

**決定。** `reviews[].findings` を落とし、`findingCount` (件数) に置き換える。
指摘の本体は `reviewId` で `get_review` を呼んで取る。02 の `GET /api/scans/:id` がレビューの本体を含めないのと同じ理由。

**検討した代替案。** そのまま返す。10 ファイルで上限に当たる。

**結果。** 呼び出しが 1 回増える。1 文書の経路 (`review_document`) はそのまま返す。

## 10. 品質要件

### 10.1 自動試験

`web/test/mcp.test.mjs` (15 件)。justic を子プロセスとして 5183 に起動する。環境は `PGDATABASE=justic_test` と
`JUSTIC_L3=0` である。`JUSTIC_ENDPOINTS` には一時ディレクトリの設定を渡す (`local-test` は external でない、
`ext-test` は external。どちらも繋がらないポート)。`@modelcontextprotocol/client` の `StreamableHTTPClientTransport` で繋ぐ。
18080 / 18090 / openrouter.ai には送らない。GPU も使わない。

実行: `cd web && ../.node/bin/node --test test/mcp.test.mjs`。

| ID | 目標 | 確かめること | 試験 |
|---|---|---|---|
| Q-1 | 1 | `useL3: true` で `endpoint` 無し → `isError`。`reviews` の件数が増えない (`pg` で数える) | 7 |
| Q-2 | 1 | `useL3: true, endpoint: "ext-test"` → `isError` に「画面から選ぶ」。`reviews` は増えない | 8 |
| Q-3 | 2 | `get_review` の結果に `body` が無く、`findings[].evidence` はある | 5 |
| Q-4 | 3 | `review_document` に助詞の重なった文を `body` で渡すと L1 の指摘が入り `reviewId` が返る。`endpoints.test.mjs` 15 件がそのまま通る | 2、既存 |
| Q-5 | 4 | 同じ文を一時ファイルに書いて `path` で渡すと同じ `documentSha256`、`title` がファイル名 | 3 |
| Q-6 | 4 | `tools/list` に 8 つがその名前で並ぶ | 1 |
| Q-7 | 2、C-2 | `Host: evil.example:5183` の生の POST が 403。`Origin: http://evil.example` の POST も 403 | 9 (2 件) |
| Q-8 | — | `path` が相対パス / 存在しない / ディレクトリ → `isError`。`body` と `path` の両方 / どちらも無し → `isError` | 4、5.1 |
| Q-9 | 9.6 | `set_verdict` のあと `verdicts.decided_by = 'mcp'`、`user_id` が NULL (`pg` で引く) | 6 |
| Q-10 | — | `get_review` に無い id → `isError`。`list_reviews` と `stats` が呼べる。`health` に `me` と `viaLogin` が無い。`GET /mcp` が 405 | 残り 4 件 |

### 10.2 配備後に手で確かめる項目

自動試験は試験用のポートと DB で走る。本番の 5180 では次を 1 回ずつ確かめる。

- `GET /mcp` が 405 を返す
- SDK のクライアントで `tools/list` に 8 つが並び、`health` に `me` と `viaLogin` が無い
- `review_document` に `path` で Markdown を 1 本渡すと、L1 だけ走って `reviewId` が返る。その番号で `get_review` を呼ぶと `body` が無い
- `claude mcp list` が `justic ... ✔ Connected` を出す

### 10.3 担保が無いもの

- Claude Code の中から実際にツールを呼ぶこと。自動試験は SDK のクライアントで代用している
- `review_pull_request` / `review_branch`。実 GitHub を叩くので自動試験に無い (05 の 16.4 と同じ)。HTTP と同じ関数を呼ぶことをコードで確認した
- 「`useL3: true` で設定に無い名前」の経路。`endpointForRequest` は `l3Available()` のときしか `parseEndpoint` に進まず、`JUSTIC_L3=0` の試験環境では再現できない

## 11. リスクと技術的負債

### 11.1 リスク

| ID | 内容 | 度合い | 手当て |
|---|---|---|---|
| R-26 | SDK 2.0.0 が出たばかりで、版が上がると import や `createMcpHandler` の形が変わる | 中 | `web/mcp.js` に閉じ込める。`server.js` は `app.all` の 1 行しか知らない |
| R-27 | L3 を伴う呼び出しが長く、クライアントの上限で切れる。切れても justic 側のレビューは完了して保存される | 中 | `useL3` の既定を `false` に。上限 10 分 (C-8)。02 で非同期にする (MC-04) |
| R-28 | `evidence` を集めると本文の一部が復元できる | 低 | 9.4 で受け入れた。MC-02 で範囲を絞れる |
| R-29 | `path` で読んだファイルが Markdown でない (PDF、バイナリ) | 低 | UTF-8 として読み L1 に渡す。壊れた文字はそのまま指摘に出る。Markdown 以外は 03 の範囲 |
| R-30 | 応答が 25,000 トークンを超えて Claude Code が切る | 低 | 複数ファイルの経路は件数だけ返す (9.9) |

### 11.2 未決事項

| ID | 項目 | 影響 |
|---|---|---|
| MC-01 | 外部の接続先を MCP から指名できるようにするか。するなら接続先の設定に許可の項目を足す | 9.5 |
| MC-02 | MCP から作ったレビューだけを `get_review` / `list_reviews` に見せるか。するなら `reviews` に呼び出し元の列 (移行 1 本) | 9.4 |
| MC-03 | issue の起票 (`/api/issues`) をツールにするか | 3.2 |
| MC-04 | 02 が入ったあと、L3 を伴う呼び出しを同期のまま残すか、`scanId` を返して待たせるか | 8.7 |

### 11.3 確かめていないこと

- Claude Code が Streamable HTTP のどの版で来るか。`createMcpHandler` はどちらもセッション無しで受けるが、Claude Code で試していない
- `readOnlyHint` を Claude Code が確認の要否に使うか。公式文書に記述が無い
- Windows 側の MCP クライアントから `127.0.0.1:5180/mcp` に届くか。画面は `localhost` で届いている (README) が、MCP では試していない
- セッションを持たない形で、ツールのハンドラがクライアントの名前 (`clientInfo`) を取れるか (9.6)
- Claude Code の待ち時間の既定 (C-8 の 10 分)。公式文書の中で記述が揃っていない

### 11.4 技術的負債

- `list_reviews` の `structuredContent` が配列で、2025 年版の規約で繋いだクライアントには `{result: [...]}` に包まれる (8.6)。`{reviews: [...]}` のオブジェクトにすれば包まれない
- `mcpHandler` に渡す `run*` は `server.js` の module 内の関数で、単体では試験できない。試験は子プロセス経由に限る

## 12. 用語

00 の 5章の語をそのまま使う。本書で足す語は次のとおり。

| 語 | 意味 |
|---|---|
| MCP | Model Context Protocol。AI の道具 (Claude Code など) が外の機能を呼ぶための規約。呼ぶ側を「クライアント」、呼ばれる側を「サーバー」と呼ぶ |
| ツール | MCP で呼べる機能の 1 つ。名前と引数の型と説明を持ち、クライアントは `tools/list` で一覧を取ってから `tools/call` で呼ぶ |
| Streamable HTTP | MCP の運び方の 1 つ。クライアントが HTTP の POST で要求を送り、応答は JSON か SSE で返る。本書は POST だけを使う |
| セッション無し | 要求のたびに `McpServer` を作って捨てる形。`Mcp-Session-Id` を持たない |
| `isError` | ツールの結果の印。処理は届いたが失敗した、という意味で、規約のエラー (JSON-RPC のエラー) とは別 |
| `MC-*` | 本書の未決事項の接頭辞 (11.2) |
| `Q-*` | 本書の品質要件の番号 (10.1) |

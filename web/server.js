import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";

import * as db from "./db.js";
import * as gh from "./github.js";
import * as auth from "./auth.js";
import { lintMarkdown } from "./lint.js";
import { l3Enabled, runL3, ASPECTS, toRuntimeAspects } from "./llm.js";
import * as endpoints from "./endpoints.js";
import { mcpHandler } from "./mcp.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT ?? 5180);
const ORIGIN = process.env.JUSTIC_ORIGIN ?? `http://127.0.0.1:${PORT}`;

// 接続先の設定は起動時に1回だけ読む (docs/design-05-llm-endpoints.md の 4.5)。
// 壊れていれば、どこへ送るか決まらないまま動かさない (4.4)。
try {
  endpoints.init();
} catch (e) {
  console.error(`接続先の設定が読めない: ${e.message}`);
  process.exit(1);
}

// L3 が実際に使えるか。接続先が0件なら JUSTIC_L3=0 と同じ扱いにする (4.4)。
const l3Available = () => l3Enabled() && endpoints.list().length > 0;

// ループバックで待っていても、この機械の上のブラウザからは誰でも届く。
// 利用者が踏んだ外部のページから POST されると、.env の PAT モードでは
// cookie 無しで通ってしまい、勝手に issue が立つ。
//
// Origin が違えば弾く。Origin を偽れないのがブラウザの前提なので、これで足りる。
// Host も見る。攻撃者のドメインを 127.0.0.1 に向ける DNS リバインディングを塞ぐ。
const ALLOWED_HOSTS = new Set([
  `127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`,
  ...(process.env.JUSTIC_ORIGIN ? [new URL(process.env.JUSTIC_ORIGIN).host] : []),
]);

app.use((req, res, next) => {
  if (req.headers.host && !ALLOWED_HOSTS.has(req.headers.host)) {
    return res.status(403).json({ error: `Host ${req.headers.host} は許可していない` });
  }
  // 読み取りは通す。状態を変えるものだけ Origin を見る。
  if (req.method === "GET" || req.method === "HEAD") return next();
  const origin = req.headers.origin;
  // Origin が無いのは curl などの非ブラウザ。ブラウザは他所からの POST に必ず付ける。
  if (origin && !ALLOWED_HOSTS.has(new URL(origin).host)) {
    return res.status(403).json({ error: `Origin ${origin} からは受け付けない` });
  }
  next();
});

// /mcp は express.json() より前に置く。toNodeHandler (@modelcontextprotocol/node)
// が返す (req, res, parsedBody?) は、parsedBody を渡さなければ req から自分で
// 本文を読み直す (node_modules/@modelcontextprotocol/node/dist/index.d.mts の
// toNodeHandler / NodeMcpRequestHandler の記述)。express.json() が先に本文を
// 読んでしまうと、その後ろでは req の流れが空になり MCP 側が読めなくなる。
// Host/Origin の検査 (上のミドルウェア) は既に通ったあとなので、/mcp にも掛かっている。
app.all("/mcp", mcpHandler({
  runPasteReview, runPullRequestReview, runBranchReview, runVerdict, buildHealth, db,
}));

app.use(express.json({ limit: "8mb" }));
app.use(express.static(path.join(here, "public")));

const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
  console.error(e);
  res.status(500).json({ error: String(e.message ?? e) });
});

// 押した本人。ログインしていなければ 'local' に落ちる (一人で使うとき)。
function actor(req) {
  const s = auth.sessionOf(req);
  return { userId: s?.userId ?? null, decidedBy: s?.login ?? "local" };
}

// 出自。生成モデルが書いたか、人が書いたか (要件 L4-13)。省略時は 'model'。
// 不正な値は null を返し、呼び出し側で 400 にする。
const VALID_ORIGINS = new Set(["model", "human"]);
function parseOrigin(raw) {
  if (raw === undefined || raw === null || raw === "") return "model";
  return VALID_ORIGINS.has(raw) ? raw : null;
}

/**
 * 要求本文の endpoint を接続先に解決する。無ければ既定、既定が無ければ失敗。
 * 設定に無い名前も失敗で、選べる名前を文言に並べる (docs/design-05-llm-endpoints.md の 6.1)。
 * 呼び出し側で 400 にする。
 *
 * body は要求本文そのもの (HTTP なら req.body、MCP ならツールの引数)。
 */
function parseEndpoint(body) {
  const requested = body?.endpoint;
  if (requested === undefined || requested === null || requested === "") {
    const name = endpoints.defaultName();
    if (!name) return { error: "接続先 (endpoint) を選ぶ。既定が決まっていない" };
    return { endpoint: endpoints.get(name) };
  }
  const ep = endpoints.get(String(requested));
  if (!ep) {
    const names = endpoints.list().map((e) => e.name);
    return { error: `接続先 '${requested}' は無い。選べるのは: ${names.join(", ") || "(設定なし)"}` };
  }
  return { endpoint: ep };
}

/**
 * この要求で L3 を走らせるか。useL3 が立っていて L3 が使えるときだけ、
 * 接続先を解決する。L3 を求めていない要求まで endpoint を必須にしない。
 */
function endpointForRequest(body) {
  if (!body?.useL3 || !l3Available()) return { endpoint: null };
  return parseEndpoint(body);
}

// ---- 認証 --------------------------------------------------------------

app.get("/auth/login", (req, res) => {
  if (!auth.oauthConfigured()) {
    return res.status(400).send("OAuth が未設定。JUSTIC_OAUTH_CLIENT_ID / _SECRET / JUSTIC_SESSION_SECRET を .env に入れる");
  }
  // cookie はホストごとに付く。localhost で開いて callback が 127.0.0.1 だと、
  // セッションが別の origin に付いて未ログインに見える。
  // 先に正規の origin へ寄せてから OAuth に出す。
  const canonicalHost = new URL(ORIGIN).host;
  if (req.headers.host && req.headers.host !== canonicalHost) {
    return res.redirect(`${ORIGIN}/auth/login`);
  }
  res.redirect(auth.authorizeUrl(auth.makeState()));
});

app.get("/auth/callback", wrap(async (req, res) => {
  const { code, state } = req.query;
  if (!code || !auth.checkState(String(state ?? ""))) {
    return res.status(400).send("state が合わない。やり直す");
  }
  const token = await auth.exchangeCode(String(code));
  const viewer = await auth.fetchViewer(token);
  const user = await db.upsertUser(viewer);
  // トークンは cookie の中だけ。DB には保存しない。
  auth.setSession(res, { userId: Number(user.id), login: user.login, token });
  res.redirect("/");
}));

// PAT モードのローカルセッション。これが無いと、注釈にログインを要求した時点で
// 一人運用では注釈がゼロになる (docs/design-01-measurement.md の 8.2)。
app.post("/auth/local", wrap(async (req, res) => {
  if (!auth.localSessionAvailable()) {
    return res.status(400).json({
      error: auth.oauthConfigured()
        ? "OAuth が設定済み。GitHub でログインする"
        : "JUSTIC_SESSION_SECRET が要る",
    });
  }
  const user = await db.ensureLocalUser();
  auth.setSession(res, { userId: Number(user.id), login: user.login });
  res.json({ login: user.login, userId: Number(user.id) });
}));

app.post("/auth/logout", (req, res) => { auth.clearSession(res); res.json({ ok: true }); });

/** 注釈系はセッション必須。誰が付けたか分からない注釈が測定の基準になるのを防ぐ。 */
function requireSession(req, res) {
  const s = auth.sessionOf(req);
  if (!s) {
    res.status(401).json({ error: "ログインが要る", canLocal: auth.localSessionAvailable() });
    return null;
  }
  return s;
}

app.get("/api/me", wrap(async (req, res) => {
  const s = auth.sessionOf(req);
  res.json(s ? { login: s.login, userId: s.userId } : null);
}));

// ---- レビュー ----------------------------------------------------------

/**
 * 1文書を検査して保存する。
 *
 * addedLines を渡すと PR の差分として扱う。そのとき L1 の指摘は
 * 差分の行に載ったものだけを残す。もとからあった行まで出すと、
 * その PR が持ち込んでいない指摘で画面が埋まる。
 *
 * L3 は差分では判定できない。「異常系が書かれていない」は
 * 書かれていないことの指摘なので、全文を見る必要がある。
 * 差分の外に出たものは in_diff=false を付けて残す。
 *
 * origin は文書の出自 ('model' | 'human')。学習データの正例・負例を
 * 出自で振り分ける前提になる (要件 L4-02, L4-13)。省略時は 'model'。
 *
 * endpoint は呼び出し側が解決済みの接続先 (docs/design-05-llm-endpoints.md)。
 * null なら L3 は走らせない。
 */
async function reviewOne(bodyText, { title, endpoint = null, origin = "model", sourceKind = "paste", sourceRef = null, addedLines = null }) {
  const doc = await db.upsertDocument(title, bodyText, origin);
  const wantL3 = Boolean(endpoint);
  const layers = ["L1", ...(wantL3 ? ["L3"] : [])];

  let l1 = await lintMarkdown(bodyText);
  let l1OutsideDiff = 0;
  if (addedLines) {
    const before = l1.length;
    l1 = l1.filter((f) => f.line != null && addedLines.has(f.line));
    l1OutsideDiff = before - l1.length;
    for (const f of l1) f.inDiff = true;
  }

  let l3 = null;
  const findings = [...l1];
  if (wantL3) {
    // 観点は aspects 表が正。llm.js は実行時の情報 (ruleId、プロンプト版) を持つ。
    const rows = await db.aspects().catch(() => []);
    const runtime = toRuntimeAspects(rows);
    l3 = await runL3(bodyText, { ...(runtime.length > 0 ? { aspects: runtime } : {}), endpoint });
    for (const f of l3.findings) {
      f.inDiff = addedLines ? (f.line != null && addedLines.has(f.line)) : null;
    }
    findings.push(...l3.findings);
  }

  // 1レビューを1トランザクションで書く。途中で落ちると findings が半分だけ入った
  // review が finished_at NULL で残り、集計から除外する処理に頼ることになる。
  const { review, stored } = await db.withTransaction(async (c) => {
    const review = await db.createReview(doc.id, {
      layers, l3ModelId: l3?.model ?? null,
      promptVersion: l3?.runs?.map((r) => r.promptVersion).filter(Boolean).join(",") || null,
      sourceKind, sourceRef,
    }, c);
    const stored = await db.insertFindings(review.id, findings, c);
    // 観点ごとの実行記録。失敗した観点は findings 行を作らないので、
    // これが無いと「走ったが指摘なし」と「落ちた」を区別できない。
    for (const run of l3?.runs ?? []) await db.recordAspectRun(review.id, run, c);
    await db.finishReview(review.id, c);
    return { review, stored };
  });

  return {
    reviewId: review.id,
    documentSha256: doc.sha256,
    title,
    layers,
    // どの接続先で走ったか。画面が見出しに出す (13章)
    endpoint: endpoint?.name ?? null,
    endpointExternal: endpoint?.external ?? null,
    notChecked: wantL3 ? [] : ["L3 (設計内容)"],
    droppedByEvidenceCheck: l3?.dropped ?? 0,
    l1OutsideDiff,
    l3Errors: l3?.errors ?? [],
    stopped: l3?.stopped ?? null,
    // 最初に起きた unreachable/other の失敗。複数ファイルの走査で
    // 「同じ理由が2回続いたら止める」の判定に使う (14章)
    l3Failure: l3?.failure ?? null,
    findings: stored,
  };
}

/**
 * GET /api/health の中身。HTTP からも MCP (health ツール) からも呼ぶ (4.1)。
 * session はログインしている利用者のセッション (auth.sessionOf の結果)。
 * MCP には cookie が無いので null を渡す (docs/design-06-mcp.md 4.2)。
 */
async function buildHealth(session) {
  await db.ping();
  return {
    status: 200,
    json: {
      db: "ok",
      l3: l3Available(),
      endpoints: await endpoints.describe(),
      github: {
        // ログインしていればその人のトークン、していなければ .env の PAT
        token: gh.hasToken(session?.token),
        viaLogin: Boolean(session?.token),
        oauth: auth.oauthConfigured(),
      },
      me: session ? { login: session.login, userId: session.userId } : null,
      // PAT モードでもセッションを張れるか (設計書 8.2)
      localSession: auth.localSessionAvailable(),
      aspects: ASPECTS.map((a) => ({ id: a.id, title: a.title })),
    },
  };
}

app.get("/api/health", wrap(async (req, res) => {
  const r = await buildHealth(auth.sessionOf(req));
  res.status(r.status).json(r.json);
}));

app.get("/api/stats", wrap(async (_req, res) => res.json(await db.stats())));
app.get("/api/reviews", wrap(async (_req, res) => res.json(await db.recentReviews())));

app.get("/api/reviews/:id", wrap(async (req, res) => {
  const review = await db.getReview(Number(req.params.id));
  if (!review) return res.status(404).json({ error: "not found" });
  res.json({ ...review, issues: await db.issuesForReview(review.id) });
}));

/**
 * POST /api/reviews (貼り付け経路) の中身。HTTP からも MCP (review_document ツール) からも呼ぶ (4.1)。
 * body は要求本文そのもの (req.body 相当。body.body が文書本文)。
 * token はこの経路では使わない (GitHub を呼ばないため)。他の run* と型を揃えている。
 */
async function runPasteReview(body, { token } = {}) {
  const text = String(body?.body ?? "").trim();
  if (!text) return { status: 400, json: { error: "本文が空です" } };
  const title = body?.title ? String(body.title).slice(0, 200) : null;
  const origin = parseOrigin(body?.origin);
  if (origin === null) return { status: 400, json: { error: "origin は 'model' か 'human'" } };
  const picked = endpointForRequest(body);
  if (picked.error) return { status: 400, json: { error: picked.error } };
  const result = await reviewOne(text, { title, endpoint: picked.endpoint, origin });
  // 貼り付け経路はファイルが1つなので notScanned は常に空 (14.3)
  return { status: 200, json: { ...result, notScanned: [] } };
}

app.post("/api/reviews", wrap(async (req, res) => {
  const r = await runPasteReview(req.body, { token: auth.tokenFor(req) });
  res.status(r.status).json(r.json);
}));

/**
 * POST /api/reviews/github/pr の中身。HTTP からも MCP (review_pull_request ツール) からも呼ぶ (4.1)。
 */
async function runPullRequestReview(body, { token }) {
  const ref = gh.parsePullRef(body?.ref);
  if (!ref) return { status: 400, json: { error: "PR の URL か owner/repo#番号 を渡す" } };
  const origin = parseOrigin(body?.origin);
  if (origin === null) return { status: 400, json: { error: "origin は 'model' か 'human'" } };
  const picked = endpointForRequest(body);
  if (picked.error) return { status: 400, json: { error: picked.error } };

  const pr = await gh.getPull(ref.owner, ref.repo, ref.number, { token });
  const files = await gh.getMarkdownFiles(ref.owner, ref.repo, ref.number, { headSha: pr.headSha, token });
  if (files.length === 0) {
    return { status: 200, json: { kind: "pr", pr: { ...pr, ...ref }, reviews: [], note: "この PR は Markdown を変更していない", stopped: null, notScanned: [] } };
  }

  // 接続先は1回の要求で1つ (6.1)。ファイルごとに選び直さない。
  const reviews = [];
  let stopped = null;
  let notScanned = [];
  let prevFailureKind = null;
  for (let i = 0; i < files.length; i += 1) {
    const f = files[i];
    const result = await reviewOne(f.body, {
      title: `${ref.owner}/${ref.repo}#${ref.number} ${f.path}`,
      endpoint: picked.endpoint,
      origin,
      sourceKind: "github_pr",
      sourceRef: { ...ref, head_sha: pr.headSha, path: f.path, html_url: pr.htmlUrl },
      addedLines: f.addedLines,
    });
    reviews.push(result);
    // 止める失敗が起きたら、その場で抜けて残りを notScanned に積む (14.3)。
    // 済んだレビューは捨てない
    if (result.stopped) {
      stopped = result.stopped;
      notScanned = files.slice(i + 1).map((x) => x.path);
      break;
    }
    // 同じ理由 (unreachable / other) が2回続いたら止める (14章)。
    // timeout と parse_error は数えない。失敗の無いレビューが挟まれば数え直し
    if (result.l3Failure && prevFailureKind === result.l3Failure.kind) {
      stopped = {
        reason: "backend", endpoint: picked.endpoint.name,
        message: `同じ理由で2回続いた: ${result.l3Failure.message}`,
      };
      notScanned = files.slice(i + 1).map((x) => x.path);
      break;
    }
    prevFailureKind = result.l3Failure ? result.l3Failure.kind : null;
  }
  return { status: 200, json: { kind: "pr", pr: { ...pr, ...ref }, reviews, stopped, notScanned } };
}

app.post("/api/reviews/github/pr", wrap(async (req, res) => {
  const r = await runPullRequestReview(req.body, { token: auth.tokenFor(req) });
  res.status(r.status).json(r.json);
}));

/**
 * POST /api/reviews/github/branch の中身。HTTP からも MCP (review_branch ツール) からも呼ぶ (4.1)。
 */
async function runBranchReview(body, { token }) {
  const ref = gh.parseRepoRef(body?.ref);
  if (!ref) return { status: 400, json: { error: "リポジトリの URL か owner/repo を渡す" } };
  const origin = parseOrigin(body?.origin);
  if (origin === null) return { status: 400, json: { error: "origin は 'model' か 'human'" } };
  const picked = endpointForRequest(body);
  if (picked.error) return { status: 400, json: { error: picked.error } };

  const repo = await gh.getRepo(ref.owner, ref.repo, { token });
  const branch = body?.branch || repo.defaultBranch;
  const { paths, total, truncated } = await gh.listMarkdown(ref.owner, ref.repo, branch, {
    maxFiles: Math.min(Number(body?.maxFiles ?? 10), 50),
    prefix: body?.prefix ?? "",
    token,
  });
  if (paths.length === 0) {
    return { status: 200, json: { kind: "branch", repo: { ...ref, branch }, reviews: [], note: "Markdown が無い", stopped: null, notScanned: [] } };
  }

  // 接続先は1回の要求で1つ (6.1)。ファイルごとに選び直さない。
  const reviews = [];
  let stopped = null;
  let notScanned = [];
  let prevFailureKind = null;
  for (let i = 0; i < paths.length; i += 1) {
    const p = paths[i];
    const fileBody = await gh.getFile(ref.owner, ref.repo, p, branch, { token });
    const result = await reviewOne(fileBody, {
      title: `${ref.owner}/${ref.repo}:${branch} ${p}`,
      endpoint: picked.endpoint,
      origin,
      sourceKind: "github_pr",
      sourceRef: { ...ref, ref: branch, path: p, html_url: `${repo.htmlUrl}/blob/${branch}/${p}` },
    });
    reviews.push(result);
    // 止める失敗が起きたら、その場で抜けて残りを notScanned に積む (14.3)。
    // 済んだレビューは捨てない
    if (result.stopped) {
      stopped = result.stopped;
      notScanned = paths.slice(i + 1);
      break;
    }
    // 同じ理由 (unreachable / other) が2回続いたら止める (14章)。
    // timeout と parse_error は数えない。失敗の無いレビューが挟まれば数え直し
    if (result.l3Failure && prevFailureKind === result.l3Failure.kind) {
      stopped = {
        reason: "backend", endpoint: picked.endpoint.name,
        message: `同じ理由で2回続いた: ${result.l3Failure.message}`,
      };
      notScanned = paths.slice(i + 1);
      break;
    }
    prevFailureKind = result.l3Failure ? result.l3Failure.kind : null;
  }
  // scanned は実際に走らせた件数。stopped で抜けたときは paths.length と一致しない
  return {
    status: 200,
    json: {
      kind: "branch", repo: { ...ref, branch, hasIssues: repo.hasIssues },
      scanned: reviews.length, total, truncated, reviews, stopped, notScanned,
    },
  };
}

app.post("/api/reviews/github/branch", wrap(async (req, res) => {
  const r = await runBranchReview(req.body, { token: auth.tokenFor(req) });
  res.status(r.status).json(r.json);
}));

/**
 * POST /api/findings/:id/verdict の中身。HTTP からも MCP (set_verdict ツール) からも呼ぶ (4.1)。
 * who は決めた人・記録される名前 ({userId, decidedBy})。HTTP は actor(req)、
 * MCP は固定で {userId: null, decidedBy: "mcp"} を渡す (docs/design-06-mcp.md 6.2)。
 */
async function runVerdict(findingId, body, who) {
  const verdict = body?.verdict;
  if (verdict !== "accepted" && verdict !== "rejected") {
    return { status: 400, json: { error: "verdict は accepted か rejected" } };
  }
  const row = await db.addVerdict(Number(findingId), {
    verdict,
    correctedText: body?.correctedText,
    note: body?.note,
    ...who,
  });
  return { status: 200, json: row };
}

app.post("/api/findings/:id/verdict", wrap(async (req, res) => {
  const r = await runVerdict(req.params.id, req.body, actor(req));
  res.status(r.status).json(r.json);
}));

// 採用された指摘から issue を立てる。
// 未判断のものからは立てない。LLM の出力をそのまま起票すると repo が荒れる。
app.post("/api/issues", wrap(async (req, res) => {
  const token = auth.tokenFor(req);
  if (!gh.hasToken(token)) {
    return res.status(401).json({ error: "起票には GitHub のログインが要る" });
  }
  const target = gh.parseRepoRef(req.body?.repo);
  if (!target) return res.status(400).json({ error: "repo は owner/repo で渡す" });
  const ids = (req.body?.findingIds ?? []).map(Number).filter(Number.isFinite);
  if (ids.length === 0) return res.status(400).json({ error: "findingIds が空" });

  let rows = await db.acceptedFindings(ids);
  if (rows.length === 0) return res.status(400).json({ error: "採用された指摘がない。先に採用を押す" });

  // 既に「止める」issue に載っている要素を外す。id で引くので、
  // バッチで立てたものを単件で立て直す事故が起きない。
  // 全部載っていれば立てない。一部だけなら残りで立てる。
  const resolved = await resolveIssued(target, { findings: rows }, token);
  const prev = resolved.findings[rows[0].id] ?? null;
  const fresh = rows.filter((r) => !blocksNewIssue(resolved.findings[r.id]));
  if (fresh.length === 0) return res.json({ issue: prev, deduped: true, blocked: rows.length });
  rows = fresh;

  const first = rows[0];
  const srcPath = first.source_ref?.path ?? first.document_title ?? "文書";
  const marker = rows.length === 1 ? findingMarker(target, first) : gh.issueMarker({
    owner: target.owner, repo: target.repo, path: srcPath,
    ruleId: "batch",
    evidence: rows.map((r) => r.evidence ?? r.message),   // 配列で渡す。区切りは NUL
  });

  // 指摘文をそのまま入れると一覧で読めない。最初の一文だけを切り出し、
  // 場所とルール名を添える。詳細は本文にある。
  const shortRule = (id) => String(id).split("/").pop();
  const headline = (msg) => {
    const first = String(msg).split(/[。\n]/)[0].trim();
    return first.length > 46 ? `${first.slice(0, 46)}…` : first;
  };
  const title = rows.length === 1
    ? `[${first.layer}] ${srcPath}${first.line ? ` L${first.line}` : ""}: ${headline(first.message)} (${shortRule(first.rule_id)})`
    : `[レビュー] ${srcPath}: ${rows.length}件の指摘`;

  const lines = [`\`${srcPath}\` のレビューで採用された指摘。`, ""];
  if (prev) lines.push(`以前 #${prev.number} として起票され、閉じられている。再発として立てた。`, "");
  for (const r of rows) {
    lines.push(`### ${r.line ? `L${r.line} ` : ""}${r.rule_id}`, "");
    lines.push(r.message, "");
    if (r.evidence) lines.push("> " + r.evidence.replace(/\n/g, "\n> "), "");
    if (r.corrected_text) lines.push(`修正案: ${r.corrected_text}`, "");
  }
  if (first.source_ref?.html_url) lines.push(`出典: ${first.source_ref.html_url}`, "");
  lines.push(`<!-- ${gh.MARKER_PREFIX}${marker} -->`);

  const created = await gh.createIssue(target.owner, target.repo, {
    title, body: lines.join("\n"), labels: req.body?.labels ?? [], token,
  });
  const saved = await db.recordIssue(target.owner, target.repo, {
    ...created, marker, findingIds: rows.map((r) => Number(r.id)), userId: actor(req).userId,
  });
  res.json({ issue: saved, deduped: false, from: rows.length });
}));

// ---- 未検知の記録 (docs/design-01-measurement.md) ----------------------

app.get("/api/aspects", wrap(async (_req, res) => res.json(await db.aspects())));

app.get("/api/golden-set", wrap(async (req, res) => {
  const aspectId = String(req.query.aspect ?? "D-01");
  const target = Math.min(Number(req.query.target ?? 20), 200);
  res.json(await db.goldenSet(aspectId, target));
}));

app.get("/api/documents/:id/annotations", wrap(async (req, res) => {
  const documentId = Number(req.params.id);
  const annotations = await db.listAnnotations(documentId);
  // 重複の鍵はサーバー側の値から作るので、クライアントには計算できない。
  // 押してから「もうある」と言われないよう、一覧の時点で解決しておく。
  const target = gh.parseRepoRef(req.query.repo);
  // GitHub に問い合わせるのはセッションのある人だけ。認証不要の GET で
  // .env の PAT を消費させられると、外部ページからレート制限を枯らせる。
  const token = auth.sessionOf(req)?.token ?? null;
  if (target && annotations.length) {
    const r = await resolveIssued(target, { annotations }, token);
    for (const a of annotations) {
      const hit = r.annotations[a.id];
      if (!hit) continue;
      a.issue_url = hit.html_url;
      a.issue_number = hit.number;
      a.issue_state = hit.state;
      a.issue_state_reason = hit.state_reason;
      a.issue_blocks = blocksNewIssue(hit);
    }
  }
  res.json({ annotations, completions: await db.listCompletions(documentId) });
}));

app.post("/api/documents/:id/annotations", wrap(async (req, res) => {
  const s = requireSession(req, res);
  if (!s) return;
  const { startLine, endLine, quotedText, aspectId, note } = req.body ?? {};
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine > endLine) {
    return res.status(400).json({ error: "startLine / endLine が不正" });
  }
  if (!String(quotedText ?? "").trim()) return res.status(400).json({ error: "quotedText が空" });
  res.json(await db.addAnnotation({
    documentId: Number(req.params.id),
    startLine, endLine, quotedText: String(quotedText).slice(0, 2000),
    aspectId: aspectId || null, note, userId: s.userId,
  }));
}));

// 取り消しは追記。物理削除しない (schema.sql の方針1)。
for (const action of ["retract", "restore"]) {
  app.post(`/api/annotations/:id/${action}`, wrap(async (req, res) => {
    const s = requireSession(req, res);
    if (!s) return;
    const owner = await db.annotationOwner(Number(req.params.id));
    if (!owner) return res.status(404).json({ error: "not found" });
    if (Number(owner.user_id) !== Number(s.userId)) {
      return res.status(403).json({ error: "自分が付けた注釈だけ" });
    }
    res.json(await db.annotationEvent(
      Number(req.params.id), action === "retract" ? "retracted" : "restored",
      s.userId, req.body?.note));
  }));
}

// 観点の後付け。登録時は任意にして手間を減らしている (設計書 5章)。
app.patch("/api/annotations/:id", wrap(async (req, res) => {
  const s = requireSession(req, res);
  if (!s) return;
  const row = await db.setAnnotationAspect(Number(req.params.id), req.body?.aspectId ?? null);
  if (!row) return res.status(404).json({ error: "not found" });
  res.json(row);
}));

// 全数注釈の印。注釈0件でも立てられる。
// ゼロは「システムが全部拾った」という正の情報で、recall=1.0 側の標本になる。
app.post("/api/documents/:id/completions", wrap(async (req, res) => {
  const s = requireSession(req, res);
  if (!s) return;
  const aspectId = String(req.body?.aspectId ?? "");
  if (!aspectId) return res.status(400).json({ error: "aspectId が要る" });
  res.json(await db.addCompletion(Number(req.params.id), aspectId, s.userId));
}));

const STATE_TTL_MS = 10 * 60 * 1000;
const STATE_ERROR_BACKOFF_MS = 30 * 60 * 1000;
const STATE_REFRESH_MAX = 10;

/**
 * その issue が新規の起票を止めるか。
 *
 *   open                       止める。まだ直っていない
 *   closed / not_planned       止める。**直さないと決めた指摘を蒸し返さない**
 *   closed / duplicate         止める
 *   closed / completed か不明   止めない。直ったので、再発なら立ててよい
 */
function blocksNewIssue(i) {
  if (!i) return false;
  if (i.state === "open") return true;
  return i.state_reason === "not_planned" || i.state_reason === "duplicate";
}

/**
 * 記録している状態が古いものだけ GitHub に引き直す。
 * 一覧を開くたびに全件叩くとレート制限をすぐ使い切る。
 */
async function refreshStaleStates(target, issues, token) {
  const now = Date.now();
  const stale = issues.filter((i) => {
    // 取れなかったものは間を置く。届かない issue を毎回叩かない
    if (i.state_error_at && now - new Date(i.state_error_at).getTime() < STATE_ERROR_BACKOFF_MS) return false;
    return !i.state_checked_at || now - new Date(i.state_checked_at).getTime() > STATE_TTL_MS;
  }).slice(0, STATE_REFRESH_MAX);

  // 直列に await すると、GitHub が詰まったとき GET が最大 (件数 × タイムアウト) 秒返らない
  await Promise.all(stale.map(async (i) => {
    try {
      const live = await gh.getIssue(target.owner, target.repo, i.number, { token });
      await db.updateIssueState(i.id, live);
      i.state = live.state;
      i.state_reason = live.stateReason;
    } catch (e) {
      if (e.status === 404) {
        // 消えている。止める理由が無いので、起票できる状態にする
        await db.updateIssueState(i.id, { state: "closed", stateReason: "deleted" });
        i.state = "closed"; i.state_reason = "deleted";
      } else {
        // 届かない。記録している状態のまま止めるが、時刻は残して叩き続けない
        await db.markIssueUnreachable(i.id);
      }
    }
  }));
}

/**
 * 起票済みかを解決する。
 *
 * 主: **id で引く** (github_issues.finding_ids / annotation_ids)。
 * 従: marker で引く。再走査で id が変わった同じ指摘を拾うためだけ。
 *
 * marker だけに頼ると、同じ行に出た別の指摘 (col しか違わない) が潰れ、
 * バッチ起票と単件起票で鍵が食い違って二重に立つ。
 */
async function resolveIssued(target, { findings = [], annotations = [] }, token) {
  const findingIds = findings.map((f) => Number(f.id));
  const annotationIds = annotations.map((a) => Number(a.id));

  const byRef = await db.issuesForRefs(target.owner, target.repo, { findingIds, annotationIds });

  // marker の照合は**指摘だけ**に使う。再走査すると findings は新しい id で
  // 作り直されるので、id だけでは前回の起票を辿れない。
  // 注釈は行が作り直されず id が安定しているので、marker で引く必要が無い。
  // 引くと、同じ文言を2箇所に付けた注釈が誤って同一視される。
  const markerOf = new Map();
  for (const f of findings) markerOf.set(`f${f.id}`, findingMarker(target, f));
  const byMarker = await db.issuesByMarkers(target.owner, target.repo, [...new Set(markerOf.values())]);

  await refreshStaleStates(target, [...byRef, ...byMarker], token);

  const pick = (key, id, kind) => {
    const marker = markerOf.get(key);
    const candidates = [
      ...byRef.filter((i) => (kind === "f" ? i.finding_ids : i.annotation_ids).map(Number).includes(id)),
      ...(marker ? byMarker.filter((i) => i.marker === marker) : []),
    ];
    // 止めるものがあればそれを返す。無ければ「最後に立てたもの」を参考として返す
    return candidates.find(blocksNewIssue) ?? candidates[0] ?? null;
  };

  return {
    findings: Object.fromEntries(findings.map((f) => [f.id, pick(`f${f.id}`, Number(f.id), "f")])),
    annotations: Object.fromEntries(annotations.map((a) => [a.id, pick(`a${a.id}`, Number(a.id), "a")])),
  };
}

/**
 * 起票済みかをまとめて引く。押してから「もうある」と言われないようにする。
 * 鍵はサーバー側の値から作るので、クライアントには計算できない。
 */
app.get("/api/issues/lookup", wrap(async (req, res) => {
  const target = gh.parseRepoRef(req.query.repo);
  if (!target) return res.json({ findings: {}, annotations: {} });
  const ids = String(req.query.findings ?? "").split(",").map(Number).filter(Number.isFinite);
  if (ids.length === 0) return res.json({ findings: {}, annotations: {} });

  const rows = await db.acceptedFindings(ids);
  const token = auth.sessionOf(req)?.token ?? null;
  const r = await resolveIssued(target, { findings: rows }, token);
  const out = {};
  for (const row of rows) {
    const hit = r.findings[row.id];
    if (hit) {
      out[row.id] = {
        number: hit.number, htmlUrl: hit.html_url,
        state: hit.state, stateReason: hit.state_reason,
        // 起票を止めるかどうか。closed でも not_planned なら止める
        blocks: blocksNewIssue(hit),
      };
    }
  }
  res.json({ findings: out, annotations: {} });
}));

/**
 * 指摘1件ぶんの鍵。起票側と解決側で同じものを使う。
 *
 * col を入れる。L1 の evidence は「その行の全文」なので、同じ行に出た
 * 別の指摘 (別の助詞など) が evidence まで一致し、片方を起票すると
 * もう片方が永久に起票できなくなる。col は行がずれても変わらないので、
 * 「行のずれには強く、同じ行の別指摘は区別する」を両立できる。
 */
function findingMarker(target, f) {
  const srcPath = f.source_ref?.path ?? f.document_title ?? "文書";
  return gh.issueMarker({
    owner: target.owner, repo: target.repo, path: srcPath,
    ruleId: f.rule_id,
    evidence: [String(f.col ?? ""), f.evidence ?? f.message],
  });
}

/**
 * 注釈1件ぶんの重複防止の鍵。起票側と一覧側で同じものを使う。
 *
 * 行番号は入れない。文書を編集して行がずれても同じ問題を指すため。
 * 指摘 (findings) 側も内容だけで見ているので、揃えてある。
 */
function annotationMarker(target, a) {
  const srcPath = a.source_ref?.path ?? a.document_title ?? "文書";
  return gh.issueMarker({
    owner: target.owner, repo: target.repo, path: srcPath,
    ruleId: `human/${a.aspect_id ?? "unclassified"}`,
    evidence: a.quoted_text,
  });
}

/**
 * 人手注釈から issue を立てる。
 *
 * findings 用の /api/issues とは経路を分ける。注釈は採否を持たず、
 * id の空間も違う (github_issues.finding_ids と annotation_ids)。
 * 押したときだけ立てる。登録と同時には立てない。
 */
app.post("/api/annotations/issues", wrap(async (req, res) => {
  const s = requireSession(req, res);
  if (!s) return;
  const token = auth.tokenFor(req);
  if (!gh.hasToken(token)) return res.status(401).json({ error: "起票には GitHub のトークンが要る" });

  const target = gh.parseRepoRef(req.body?.repo);
  if (!target) return res.status(400).json({ error: "repo は owner/repo で渡す" });
  const ids = (req.body?.annotationIds ?? []).map(Number).filter(Number.isFinite);
  if (ids.length === 0) return res.status(400).json({ error: "annotationIds が空" });

  let rows = await db.annotationsForIssue(ids);
  if (rows.length === 0) return res.status(400).json({ error: "対象の注釈がない (取り消し済みか)" });

  const resolved = await resolveIssued(target, { annotations: rows }, token);
  const prev = resolved.annotations[rows[0].id] ?? null;
  const fresh = rows.filter((r) => !blocksNewIssue(resolved.annotations[r.id]));
  if (fresh.length === 0) return res.json({ issue: prev, deduped: true, blocked: rows.length });
  rows = fresh;

  const first = rows[0];
  const srcPath = first.source_ref?.path ?? first.document_title ?? "文書";
  const marker = rows.length === 1 ? annotationMarker(target, first) : gh.issueMarker({
    owner: target.owner, repo: target.repo, path: srcPath,
    ruleId: "human/batch",
    evidence: rows.map((r) => r.quoted_text),   // 配列で渡す。区切りは NUL
  });

  const headline = (t) => {
    const h = String(t ?? "").split(/[。\n]/)[0].trim();
    return h.length > 46 ? `${h.slice(0, 46)}…` : h;
  };
  const title = rows.length === 1
    ? `[人手] ${srcPath} L${first.start_line}: ${headline(first.note || first.quoted_text)}`
    : `[人手] ${srcPath}: ${rows.length}件の指摘`;

  const lines = [
    `\`${srcPath}\` を読んで見つけた指摘。**システムは検出していない。**`, "",
  ];
  if (prev) lines.push(`以前 #${prev.number} として起票され、閉じられている。再発として立てた。`, "");
  for (const r of rows) {
    lines.push(`### L${r.start_line}${r.end_line !== r.start_line ? `-${r.end_line}` : ""}`
      + (r.aspect_id ? ` ${r.aspect_id} ${r.aspect_title ?? ""}` : " (観点未分類)"), "");
    lines.push("> " + r.quoted_text.replace(/\n/g, "\n> "), "");
    if (r.note) lines.push(r.note, "");
    lines.push(`— @${r.author}`, "");
  }
  if (first.source_ref?.html_url) lines.push(`出典: ${first.source_ref.html_url}`, "");
  lines.push(`<!-- ${gh.MARKER_PREFIX}${marker} -->`);

  const created = await gh.createIssue(target.owner, target.repo, {
    title, body: lines.join("\n"), labels: req.body?.labels ?? [], token,
  });
  const saved = await db.recordIssue(target.owner, target.repo, {
    ...created, marker, findingIds: [], annotationIds: rows.map((r) => Number(r.id)),
    userId: s.userId,
  });
  res.json({ issue: saved, deduped: false, from: rows.length });
}));

app.delete("/api/documents/:id/completions/:aspectId", wrap(async (req, res) => {
  const s = requireSession(req, res);
  if (!s) return;
  const row = await db.revokeCompletion(Number(req.params.id), req.params.aspectId, s.userId);
  if (!row) return res.status(404).json({ error: "自分が立てた印が無い" });
  res.json(row);
}));

// ループバックだけで待つ。ミラーリングモードの WSL では 0.0.0.0 にすると
// LAN の他の端末から届いてしまい、GitHub のトークンを持った画面が外に出る。
//
// IPv4 と IPv6 の両方で待つ。Windows 側のブラウザは localhost を ::1 から
// 先に引くので、127.0.0.1 だけだとフォールバック頼みになる。
const hosts = ["127.0.0.1", "::1"];
let ready = 0;
for (const host of hosts) {
  const server = app.listen(PORT, host, () => {
    ready += 1;
    if (ready === 1) {
      console.log(`justic  ${ORIGIN}`);
      console.log(`L3: ${l3Enabled() ? "有効" : "無効 (JUSTIC_L3=0)"}   OAuth: ${auth.oauthConfigured() ? "設定済み" : "未設定"}   .env の PAT: ${gh.envToken() ? "あり" : "なし"}`);
      const epList = endpoints.list();
      console.log(`接続先: ${epList.length ? epList.map((e) => `${e.name}${e.external ? "(外部)" : ""}`).join(", ") : "(なし)"}`);
      console.log(`MCP: /mcp`);
    }
    console.log(`  待ち受け ${host.includes(":") ? `[${host}]` : host}:${PORT}`);
  });
  server.on("error", (e) => {
    if (host === "::1" && (e.code === "EAFNOSUPPORT" || e.code === "EADDRNOTAVAIL")) {
      console.log(`  IPv6 は使えない環境のため ${host} は省略した`);
      return;
    }
    console.error(`待ち受けに失敗 ${host}:${PORT}  ${e.code ?? e.message}`);
    if (ready === 0) process.exit(1);
  });
}

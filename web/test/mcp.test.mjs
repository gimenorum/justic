// docs/design-06-mcp.md の 12章 (1〜10)。
//
// justic を子プロセスとして PORT=5183 で起動する (5181 / 5182 / 5199 は
// endpoints.test.mjs が使うため空ける)。環境は PGDATABASE=justic_test、JUSTIC_L3=0。
// JUSTIC_ENDPOINTS には local-test (external:false) と ext-test (external:true) を
// 用意するが、どちらも繋がらないポートを指す。JUSTIC_L3=0 なので L3 は実際には
// 走らず、接続先の名前の判定 (5.3) だけを確かめる。18080 / 18090 / openrouter.ai
// にも fake-llm にも要求を送らない。
//
// 試験の無い項目: review_pull_request / review_branch。実 GitHub を叩くので
// 自動試験に無い (12.1 と同じ)。HTTP の経路と同じ関数を呼ぶことはコードで確認した。

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import pg from "pg";

import http from "node:http";
import { Client } from "@modelcontextprotocol/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const NODE = process.execPath;
const JUSTIC_PORT = 5183;
const JUSTIC_ORIGIN = `http://127.0.0.1:${JUSTIC_PORT}`;
const MCP_URL = `${JUSTIC_ORIGIN}/mcp`;

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "justic-mcp-test-"));

// ---- 試験用の接続先設定 (どこにも繋がらない) -------------------------------
//
// JUSTIC_L3=0 で起動するので L3 は走らない。ここに書いた base_url へは
// 一度も要求が飛ばない (5.3 の名前の判定だけを確かめる試験のため)。
const ENDPOINTS_CONFIG = {
  default: "local-test",
  endpoints: [
    {
      name: "local-test", title: "手元 (試験用、繋がらない)",
      base_url: "http://127.0.0.1:5983/v1", model: "no-such-model", external: false,
      max_tokens: 100, temperature: 0, timeout_ms: 1000,
      thinking: { mode: "none" },
    },
    {
      name: "ext-test", title: "外部 (試験用、繋がらない)",
      base_url: "http://127.0.0.1:5984/v1", model: "no-such-model", external: true,
      max_tokens: 100, temperature: 0, timeout_ms: 1000,
      thinking: { mode: "none" },
    },
  ],
};
const endpointsConfigPath = path.join(tmpDir, "endpoints.mcp-test.json");
fs.writeFileSync(endpointsConfigPath, JSON.stringify(ENDPOINTS_CONFIG, null, 2));

// ---- DB (justic_test に直接 select してよい。試験用 DB) -------------------

const db = new pg.Pool({
  host: "/home/oosaw/justic/pgdata", port: 5433, user: "oosaw",
  database: "justic_test", max: 4,
});

async function reviewCount() {
  const { rows } = await db.query("select count(*)::int as n from reviews");
  return rows[0].n;
}

// ---- 子プロセスの起動・停止 (endpoints.test.mjs と同じ形) ------------------

function baseEnv(extra) {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LANG: process.env.LANG,
    // .env は読まない (JUSTIC_GITHUB_TOKEN 等は空のまま)。JUSTIC_* は明示したものだけ
    ...extra,
  };
}

async function waitForHealth(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) return await res.json();
    } catch (e) { lastErr = e; }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`起動しない (port ${port}): ${lastErr?.message ?? "timeout"}`);
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; resolve(null); } }, timeoutMs);
    child.once("exit", (code, signal) => {
      if (!done) { done = true; clearTimeout(timer); resolve({ code, signal }); }
    });
  });
}

/** 自分で持った PID だけを使って止める (pkill -f / pgrep -f は使わない)。 */
async function stopChild(child, label) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const check = spawnSync("ps", ["-p", String(child.pid), "-o", "pid,args", "--no-headers"], { encoding: "utf8" });
  console.log(`[test] stopping ${label} pid=${child.pid}: ${(check.stdout || "").trim() || "(already gone)"}`);
  process.kill(child.pid, "SIGTERM");
  const exited = await waitForExit(child, 4000);
  if (!exited && child.exitCode === null) {
    process.kill(child.pid, "SIGKILL");
    await waitForExit(child, 2000);
  }
}

let justic;
let client;

before(async () => {
  justic = spawn(NODE, [path.join(ROOT, "web", "server.js")], {
    cwd: path.join(ROOT, "web"),
    env: baseEnv({
      PORT: String(JUSTIC_PORT), JUSTIC_ORIGIN,
      PGHOST: "/home/oosaw/justic/pgdata", PGPORT: "5433", PGUSER: "oosaw",
      PGDATABASE: "justic_test",
      JUSTIC_L3: "0",
      JUSTIC_ENDPOINTS: endpointsConfigPath,
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  justic.stdout.on("data", (d) => console.log(`[justic] ${d}`.trimEnd()));
  justic.stderr.on("data", (d) => console.error(`[justic] ${d}`.trimEnd()));

  await waitForHealth(JUSTIC_PORT);

  client = new Client({ name: "justic-mcp-test", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(MCP_URL)));
});

after(async () => {
  await client?.close();
  await stopChild(justic, "justic");
  await db.end();
});

// ---- 1: 一覧 ---------------------------------------------------------------

test("listTools() に 8 つがその名前で並ぶ (1)", async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "get_review", "health", "list_reviews", "review_branch",
    "review_document", "review_pull_request", "set_verdict", "stats",
  ].sort());
});

// ---- 2/3: review_document (body / path) -----------------------------------

const DOUBLED_JOSHI_TEXT = "# 試験\n\n私は昨日は買い物に行った。\n";

let reviewIdFromBody;
let documentShaFromBody;

test("review_document を body で渡すと L1 の指摘が findings に入り reviewId が返る (2)", async () => {
  const r = await client.callTool({
    name: "review_document",
    arguments: { body: DOUBLED_JOSHI_TEXT, title: "本文渡し" },
  });
  assert.equal(r.isError, undefined, `isError であってはいけない: ${JSON.stringify(r)}`);
  const json = r.structuredContent;
  assert.ok(json.reviewId, "reviewId が返る");
  assert.ok(Array.isArray(json.findings) && json.findings.length > 0, "findings に L1 の指摘が入る");
  assert.ok(json.findings.some((f) => f.rule_id?.includes("no-doubled-joshi")), "no-doubled-joshi の指摘がある");
  reviewIdFromBody = json.reviewId;
  documentShaFromBody = json.documentSha256;
});

test("同じ文を一時ファイルに書いて path で渡すと同じ documentSha256、title がファイル名 (3)", async () => {
  const filePath = path.join(tmpDir, "doubled-joshi.md");
  fs.writeFileSync(filePath, DOUBLED_JOSHI_TEXT);
  const r = await client.callTool({
    name: "review_document",
    arguments: { path: filePath },
  });
  assert.equal(r.isError, undefined, `isError であってはいけない: ${JSON.stringify(r)}`);
  const json = r.structuredContent;
  assert.equal(json.documentSha256, documentShaFromBody, "同じ本文なので documentSha256 が一致する");
  assert.equal(json.title, path.basename(filePath), "title は path.basename");
});

// ---- 4: path の検査 ---------------------------------------------------------

test("path が相対パス / 存在しない / ディレクトリ → isError (4)", async () => {
  const relative = await client.callTool({
    name: "review_document", arguments: { path: "relative/path.md" },
  });
  assert.equal(relative.isError, true, "相対パスは isError");

  const missing = await client.callTool({
    name: "review_document", arguments: { path: path.join(tmpDir, "no-such-file.md") },
  });
  assert.equal(missing.isError, true, "存在しないパスは isError");

  const dir = await client.callTool({
    name: "review_document", arguments: { path: tmpDir },
  });
  assert.equal(dir.isError, true, "ディレクトリは isError");
});

test("body と path の両方 / どちらも無い → isError (5.1)", async () => {
  const both = await client.callTool({
    name: "review_document", arguments: { body: "x", path: path.join(tmpDir, "doubled-joshi.md") },
  });
  assert.equal(both.isError, true, "両方あると isError");

  const neither = await client.callTool({ name: "review_document", arguments: {} });
  assert.equal(neither.isError, true, "どちらも無いと isError");
});

// ---- 5: get_review は body を落とす、evidence はある ------------------------

test("get_review の結果に body が無く、findings[].evidence はある (5)", async () => {
  const r = await client.callTool({
    name: "get_review", arguments: { reviewId: reviewIdFromBody },
  });
  assert.equal(r.isError, undefined, `isError であってはいけない: ${JSON.stringify(r)}`);
  const json = r.structuredContent;
  assert.ok(!("body" in json), "body が結果に無い");
  assert.ok(Array.isArray(json.findings) && json.findings.length > 0);
  for (const f of json.findings) assert.ok(f.evidence, "各 findings に evidence がある");
});

test("get_review に無い id を渡すと isError (\"not found\")", async () => {
  const r = await client.callTool({ name: "get_review", arguments: { reviewId: 999999999 } });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /not found/);
});

// ---- 6: set_verdict は decided_by='mcp'、user_id は NULL -------------------

test("set_verdict のあと verdicts.decided_by = 'mcp'、user_id は NULL (6)", async () => {
  const review = await client.callTool({ name: "get_review", arguments: { reviewId: reviewIdFromBody } });
  const findingId = review.structuredContent.findings[0].id;

  const r = await client.callTool({
    name: "set_verdict",
    arguments: { findingId, verdict: "accepted", note: "mcp 試験" },
  });
  assert.equal(r.isError, undefined, `isError であってはいけない: ${JSON.stringify(r)}`);

  const { rows } = await db.query(
    "select decided_by, user_id from verdicts where finding_id = $1 order by id desc limit 1",
    [findingId],
  );
  assert.equal(rows[0].decided_by, "mcp");
  assert.equal(rows[0].user_id, null);
});

// ---- 7/8: L3 の規則 ----------------------------------------------------------

test("useL3: true で endpoint 無し → isError。reviews の件数が増えない (7)", async () => {
  const before = await reviewCount();
  const r = await client.callTool({
    name: "review_document",
    arguments: { body: "# x\n\n本文。", useL3: true },
  });
  assert.equal(r.isError, true, "endpoint 無しの useL3 は isError");
  assert.match(r.content[0].text, /endpoint を名前で指定する/);
  assert.equal(await reviewCount(), before, "reviews は増えない");
});

test("useL3: true, endpoint: 'ext-test' → isError に「画面から選ぶ」が含まれる。reviews は増えない (8)", async () => {
  const before = await reviewCount();
  const r = await client.callTool({
    name: "review_document",
    arguments: { body: "# x\n\n本文。", useL3: true, endpoint: "ext-test" },
  });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /画面から選ぶ/);
  assert.equal(await reviewCount(), before, "reviews は増えない");
});

// 「endpoint に設定に無い名前を指定した」場合は、5.3 の2番目の規則により
// そのまま runPasteReview (HTTP と共有する endpointForRequest) に渡す設計だが、
// endpointForRequest は useL3 && l3Available() のときしか parseEndpoint まで進まない。
// この試験環境は JUSTIC_L3=0 (l3Available()===false) なので、この経路は
// 「作るもの4」の確認表 (1〜10) にも無い。実運用 (JUSTIC_L3 有効) でのみ意味を持つ。

// ---- list_reviews / stats / health ------------------------------------------

test("list_reviews と stats が呼べる", async () => {
  const list = await client.callTool({ name: "list_reviews", arguments: { limit: 5 } });
  assert.equal(list.isError, undefined);
  // list_reviews の応答は配列。MCP の 2025 (レガシー) 世代の wire は
  // structuredContent が非オブジェクトのとき {result: 値} に包む
  // (node_modules/@modelcontextprotocol/server の projectCallToolResult の記述)。
  // content[0].text は包まれない生の JSON なので、そちらで検査する。
  const parsed = JSON.parse(list.content[0].text);
  assert.ok(Array.isArray(parsed), "list_reviews の中身は配列");

  const stats = await client.callTool({ name: "stats", arguments: {} });
  assert.equal(stats.isError, undefined);
  assert.ok("reviews" in stats.structuredContent);
});

test("health の結果に me と github.viaLogin が無い", async () => {
  const r = await client.callTool({ name: "health", arguments: {} });
  assert.equal(r.isError, undefined);
  const json = r.structuredContent;
  assert.ok(!("me" in json), "me が無い");
  assert.ok(!("viaLogin" in json.github), "github.viaLogin が無い");
  assert.equal(json.db, "ok");
});

// ---- 9: Host / Origin の検査 -------------------------------------------------

/**
 * fetch (undici) は Host ヘッダの上書きを禁止している (WHATWG Fetch の
 * forbidden header)。実際に送ってみると、指定した host は無視されて
 * 本物の Host (127.0.0.1:5183) のまま届き、403 ではなく別の理由 (406、
 * Accept ヘッダ不足) で失敗することを確かめた。Host を差し替えるには
 * node:http の低レベル API を使う。
 */
function rawPost(url, headers, bodyObj) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const body = JSON.stringify(bodyObj);
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname, method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body), ...headers },
    }, (res) => {
      let data = "";
      res.on("data", (d) => { data += d; });
      res.on("end", () => resolve({ status: res.statusCode, text: data }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

test("Host: evil.example の生の POST が 403 になる (9)", async () => {
  const res = await rawPost(MCP_URL, { host: "evil.example:5183", accept: "application/json, text/event-stream" },
    { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  assert.equal(res.status, 403);
});

test("Origin: http://evil.example の POST が 403 になる (9)", async () => {
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      origin: "http://evil.example",
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  assert.equal(res.status, 403);
});

// ---- 10: GET /mcp ------------------------------------------------------------

test("GET /mcp は 405 になる (10)", async () => {
  const res = await fetch(MCP_URL, { method: "GET" });
  assert.equal(res.status, 405, `SDK の実際の応答: ${res.status}`);
});

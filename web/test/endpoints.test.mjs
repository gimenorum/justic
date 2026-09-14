// docs/design-05-llm-endpoints.md の 16章。
//
// 18080 / 18090 / openrouter.ai には一切要求を送らない。
// fake-llm.js (このディレクトリ) を模擬の接続先にして justic を子プロセスで
// PORT=5181 / JUSTIC_ORIGIN=http://127.0.0.1:5181 / PGDATABASE=justic_test /
// JUSTIC_ENDPOINTS=<試験用の一時ディレクトリの設定> で起動し、
// POST /api/reviews (Origin ヘッダ付き) で確かめる。
//
// 実行: node --test web/test/endpoints.test.mjs
// 前提: justic_test データベースに db/schema.sql と db/migrations/001..011 を
//       適用済みであること (README.md の「接続先」参照)。
//
// 試験の無い項目: 「同じ理由 (unreachable / other) が2回続いたら止める」
// (docs/design-05-llm-endpoints.md の 14章、server.js の PR/ブランチ経路) は、
// 複数ファイルの走査でしか起きず、実 GitHub API を叩かずには確かめられないため
// 自動試験に無い。runL3() が返す failure と、server.js のループでの
// prevFailureKind の突き合わせは目視でのみ確認した。

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import pg from "pg";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const NODE = process.execPath;
const FAKE_LLM_PORT = 5199;
const FAKE_LLM_BASE = `http://127.0.0.1:${FAKE_LLM_PORT}/v1`;
const JUSTIC_PORT = 5181;
const JUSTIC_ORIGIN = `http://127.0.0.1:${JUSTIC_PORT}`;
const JUSTIC_BROKEN_PORT = 5182;

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "justic-endpoints-test-"));
const fakeLlmLog = path.join(tmpDir, "fake-llm.jsonl");

// ---- キーファイル -------------------------------------------------------

const GOOD_KEY = "sk-test-good-000111222";
const goodKeyPath = path.join(tmpDir, "good-key");
fs.writeFileSync(goodKeyPath, `${GOOD_KEY}\n`);
fs.chmodSync(goodKeyPath, 0o600);

const badPermKeyPath = path.join(tmpDir, "bad-perm-key");
fs.writeFileSync(badPermKeyPath, "sk-test-bad-perm\n");
fs.chmodSync(badPermKeyPath, 0o644); // わざと緩くする (5.4 の確認用)

// ---- 試験用の接続先設定 ---------------------------------------------------
//
// fake-llm.js の各 model で挙動を分ける (16.1)。external を混ぜる。

const GOOD_CONFIG = {
  default: "ep-empty",
  endpoints: [
    {
      name: "ep-ok-ext", title: "OK (外部)",
      base_url: FAKE_LLM_BASE, model: "fake-ok", external: true,
      key_file: goodKeyPath,
      max_tokens: 777, temperature: null, timeout_ms: 5000,
      thinking: { mode: "reasoning", effort: "low" },
      response_format: true,
      provider: { data_collection: "deny" },
    },
    {
      name: "ep-empty", title: "指摘なし",
      base_url: FAKE_LLM_BASE, model: "fake-empty", external: false,
      max_tokens: 333, temperature: 0, timeout_ms: 5000,
      thinking: { mode: "chat_template_kwargs" },
    },
    {
      name: "ep-length", title: "途中で切れる",
      base_url: FAKE_LLM_BASE, model: "fake-length", external: false,
      max_tokens: 222, temperature: 0, timeout_ms: 5000,
      thinking: { mode: "none" },
    },
    {
      name: "ep-error200", title: "200 だが error",
      base_url: FAKE_LLM_BASE, model: "fake-error200", external: false,
      max_tokens: 100, temperature: 0, timeout_ms: 5000,
      thinking: { mode: "none" },
    },
    {
      name: "ep-401", title: "認証エラー",
      base_url: FAKE_LLM_BASE, model: "fake-401", external: true,
      max_tokens: 100, temperature: null, timeout_ms: 5000,
      thinking: { mode: "none" },
    },
    {
      name: "ep-402", title: "残高切れ",
      base_url: FAKE_LLM_BASE, model: "fake-402", external: true,
      max_tokens: 100, temperature: null, timeout_ms: 5000,
      thinking: { mode: "none" },
    },
    {
      name: "ep-429", title: "レート制限",
      base_url: FAKE_LLM_BASE, model: "fake-429", external: false,
      max_tokens: 100, temperature: 0, timeout_ms: 5000,
      thinking: { mode: "none" },
    },
    {
      name: "ep-badkey", title: "キー権限が緩い",
      base_url: FAKE_LLM_BASE, model: "fake-ok", external: false,
      key_file: badPermKeyPath,
      max_tokens: 100, temperature: 0, timeout_ms: 5000,
      thinking: { mode: "none" },
    },
    {
      name: "ep-403", title: "モデレーションで拒否",
      base_url: FAKE_LLM_BASE, model: "fake-403", external: true,
      max_tokens: 100, temperature: null, timeout_ms: 5000,
      thinking: { mode: "none" },
    },
    {
      name: "ep-503", title: "提供元が見つからない",
      base_url: FAKE_LLM_BASE, model: "fake-503", external: false,
      max_tokens: 100, temperature: 0, timeout_ms: 5000,
      thinking: { mode: "none" },
    },
    {
      name: "ep-noexclude", title: "exclude:false",
      base_url: FAKE_LLM_BASE, model: "fake-ok", external: false,
      max_tokens: 100, temperature: 0, timeout_ms: 5000,
      thinking: { mode: "reasoning", effort: "low", exclude: false },
    },
  ],
};
const goodConfigPath = path.join(tmpDir, "endpoints.test.json");
fs.writeFileSync(goodConfigPath, JSON.stringify(GOOD_CONFIG, null, 2));

// authorization ヘッダを書いた壊れた設定 (5.5)。別ファイルにする
const BROKEN_CONFIG = {
  endpoints: [
    {
      name: "bad", base_url: FAKE_LLM_BASE, model: "fake-ok", external: false,
      max_tokens: 100, temperature: 0, timeout_ms: 5000,
      thinking: { mode: "none" },
      headers: { Authorization: "Bearer nope" }, // 大文字小文字を区別しない検査の対象
    },
  ],
};
const brokenConfigPath = path.join(tmpDir, "endpoints.broken.json");
fs.writeFileSync(brokenConfigPath, JSON.stringify(BROKEN_CONFIG, null, 2));

// ---- DB (justic_test に直接 select してよい。試験用 DB) -------------------

const db = new pg.Pool({
  host: "/home/oosaw/justic/pgdata", port: 5433, user: "oosaw",
  database: "justic_test", max: 4,
});

// ---- 子プロセスの起動・停止 -----------------------------------------------

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

/** fake-llm.js は /api/health を持たない。何か応答が返れば listen できている。 */
async function waitForListening(port, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      await fetch(`http://127.0.0.1:${port}/`);
      return;
    } catch (e) { lastErr = e; }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`起動しない (port ${port}): ${lastErr?.message ?? "timeout"}`);
}

/** child_process の終了を待つ。timeoutMs 以内に終わらなければ null。 */
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

function readFakeLog() {
  if (!fs.existsSync(fakeLlmLog)) return [];
  return fs.readFileSync(fakeLlmLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

/** 指定した model 宛の、一番最後に記録された要求。 */
function lastRequestFor(model) {
  const rows = readFakeLog().filter((r) => r.body?.model === model);
  return rows.at(-1);
}

async function postReview(port, body) {
  const res = await fetch(`http://127.0.0.1:${port}/api/reviews`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: `http://127.0.0.1:${port}` },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

async function reviewWithEndpoint(endpoint) {
  const r = await postReview(JUSTIC_PORT, {
    body: `# 設計書 (${endpoint})\n\n決済に失敗した場合の挙動は定義されていない。`,
    useL3: true, origin: "model", endpoint,
  });
  assert.equal(r.status, 200, `POST /api/reviews (${endpoint}) は 200 で返るはず。実際: ${r.status} ${JSON.stringify(r.json)}`);
  return r.json;
}

async function aspectRunRow(reviewId) {
  const { rows } = await db.query(
    `select * from review_aspects where review_id = $1 and aspect_id = 'D-01'`, [reviewId]);
  return rows[0] ?? null;
}

// ---- 起動 (共有の fake-llm + justic) -------------------------------------

let fakeLlm;
let justic;

before(async () => {
  fakeLlm = spawn(NODE, [path.join(ROOT, "web", "test", "fake-llm.js")], {
    cwd: ROOT,
    env: baseEnv({ FAKE_LLM_PORT: String(FAKE_LLM_PORT), FAKE_LLM_LOG: fakeLlmLog }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  fakeLlm.stderr.on("data", (d) => console.error(`[fake-llm] ${d}`.trimEnd()));

  justic = spawn(NODE, [path.join(ROOT, "web", "server.js")], {
    cwd: path.join(ROOT, "web"),
    env: baseEnv({
      PORT: String(JUSTIC_PORT), JUSTIC_ORIGIN,
      PGHOST: "/home/oosaw/justic/pgdata", PGPORT: "5433", PGUSER: "oosaw",
      PGDATABASE: "justic_test",
      JUSTIC_ENDPOINTS: goodConfigPath,
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  justic.stdout.on("data", (d) => console.log(`[justic] ${d}`.trimEnd()));
  justic.stderr.on("data", (d) => console.error(`[justic] ${d}`.trimEnd()));

  await waitForListening(FAKE_LLM_PORT);
  await waitForHealth(JUSTIC_PORT);
});

after(async () => {
  await stopChild(justic, "justic");
  await stopChild(fakeLlm, "fake-llm");
  await db.end();
});

// ---- 本体の確認 (16.1) ----------------------------------------------------

test("/api/health の endpoints にキーが出ない (5.5, 12.1)", async () => {
  const res = await fetch(`http://127.0.0.1:${JUSTIC_PORT}/api/health`);
  const h = await res.json();
  assert.ok(Array.isArray(h.endpoints), "endpoints が配列");
  assert.equal(h.endpoints.length, GOOD_CONFIG.endpoints.length);
  const allowed = new Set(["name", "title", "external", "model", "hasKey", "default", "provider"]);
  for (const e of h.endpoints) {
    for (const k of Object.keys(e)) assert.ok(allowed.has(k), `${k} は応答に出てはいけない項目 (${e.name})`);
    assert.equal(typeof e.hasKey, "boolean");
    assert.ok(JSON.stringify(e).indexOf(GOOD_KEY) === -1, "キーの値が応答に出ている");
  }
  const okExt = h.endpoints.find((e) => e.name === "ep-ok-ext");
  assert.equal(okExt.hasKey, true, "0600 の正しいキーは hasKey=true");
  const badKey = h.endpoints.find((e) => e.name === "ep-badkey");
  assert.equal(badKey.hasKey, false, "0644 のキーは hasKey=false");
  const noKey = h.endpoints.find((e) => e.name === "ep-empty");
  assert.equal(noKey.hasKey, false, "key_file が無ければ hasKey=false (失敗ではない)");
});

test("成功: 要求本文の項目、temperature:null は送らない、Authorization、実測 model、cost、endpoint 記録 (7.1, 7.3, 8.3, 8.6, 9, 10.2)", async () => {
  const result = await reviewWithEndpoint("ep-ok-ext");
  assert.equal(result.endpoint, "ep-ok-ext");
  assert.equal(result.endpointExternal, true);
  assert.equal(result.stopped, null);
  assert.equal(result.notScanned.length, 0);

  const sent = lastRequestFor("fake-ok");
  assert.ok(sent, "fake-llm が要求を受け取っているはず");
  assert.equal(sent.body.max_tokens, 777);
  assert.ok(!("temperature" in sent.body), "temperature:null は要求に含めない (9章)");
  assert.deepEqual(sent.body.reasoning, { effort: "low", exclude: true }, "reasoning は exclude:true を justic 側で足す (8.3)");
  assert.ok(!("chat_template_kwargs" in sent.body));
  assert.deepEqual(sent.body.response_format, { type: "json_object" }, "response_format: true → json_object (8.6)");
  assert.deepEqual(sent.body.provider, { data_collection: "deny" });
  assert.equal(sent.body.messages.length, 2);
  assert.equal(sent.body.messages[0].role, "system");
  assert.equal(sent.body.messages[1].role, "user");
  assert.equal(sent.headers.authorization, `Bearer ${GOOD_KEY}`, "Authorization がキーの1行目と一致 (5.2)");

  const row = await aspectRunRow(result.reviewId);
  assert.ok(row, "review_aspects の行がある");
  assert.equal(row.status, "ok");
  assert.equal(row.model_id, "fake-ok-served", "model_id は応答の model (実測値)。要求の model そのままではない (02 の 6.3)");
  assert.equal(row.endpoint, "ep-ok-ext");
  assert.equal(row.endpoint_external, true);
  assert.equal(row.finish_reason, "stop");
  assert.equal(Number(row.cost), 0.00087, "usage.cost が cost 列に入る");
  assert.equal(row.prompt_tokens, 321);
  assert.equal(row.completion_tokens, 45);
  assert.ok(row.usage_raw, "usage_raw に usage 全体が入る");
});

test("temperature が null でなければ送る。key_file が無ければ Authorization を送らない (5.4, 9章)", async () => {
  const result = await reviewWithEndpoint("ep-empty");
  const sent = lastRequestFor("fake-empty");
  assert.equal(sent.body.temperature, 0);
  assert.deepEqual(sent.body.chat_template_kwargs, { enable_thinking: false });
  assert.ok(!("authorization" in sent.headers), "key_file が無い接続先は Authorization を送らない");

  const row = await aspectRunRow(result.reviewId);
  assert.equal(row.status, "empty");
  assert.equal(row.endpoint, "ep-empty");
  assert.equal(row.endpoint_external, false);
});

test("finish_reason=length: JSON が読めたかに関わらず「途中で切れた」の文言になる (8.5)", async () => {
  const result = await reviewWithEndpoint("ep-length");
  const row = await aspectRunRow(result.reviewId);
  assert.equal(row.finish_reason, "length");
  assert.equal(row.status, "parse_error");
  assert.match(row.error, /max_tokens \(222\)/, "設定した max_tokens の値が文言に入る");
  assert.match(row.error, /途中で切れた/);
});

test("HTTP 200 だが本文が error → status='error'、種類 other は1回では止めない (14.1)", async () => {
  const result = await reviewWithEndpoint("ep-error200");
  const row = await aspectRunRow(result.reviewId);
  assert.equal(row.status, "error");
  assert.ok(row.error, "エラー文言が残る");
  // fake-error200 の error_type は provider_unavailable。not_found 系にも当たるので
  // 「絞りすぎている可能性」の文言が付く (7.5)
  assert.match(row.error, /絞りすぎている可能性/);
  assert.equal(result.stopped, null, "種類 other は1回では打ち切らない (2回続いたら止めるのは複数ファイルの走査だけ。14章)");
  assert.equal(row.endpoint, "ep-error200", "届いている (相手から応答が返っている) ので endpoint は残す");
});

test("403 (モデレーション) は本文の抜粋を入れず、1回で止める (14章)", async () => {
  const result = await reviewWithEndpoint("ep-403");
  assert.ok(result.stopped, "stopped が入る");
  assert.equal(result.stopped.reason, "backend");
  assert.equal(result.stopped.endpoint, "ep-403");
  assert.match(result.stopped.message, /接続先 ep-403 が本文を拒んだ/);
  assert.match(result.stopped.message, /content_policy_violation/);
  assert.ok(!result.stopped.message.includes("content flagged"), "fake-llm が返した本文の抜粋を含めない");
  const row = await aspectRunRow(result.reviewId);
  assert.equal(row.status, "error");
  assert.equal(row.endpoint, "ep-403", "403 は応答が返っているので endpoint は残す");
});

test("503 (提供元が見つからない) は文言に手当てを足すだけで、1回では止めない (14章, 7.5)", async () => {
  const result = await reviewWithEndpoint("ep-503");
  assert.equal(result.stopped, null);
  const row = await aspectRunRow(result.reviewId);
  assert.equal(row.status, "error");
  assert.match(row.error, /絞りすぎている可能性/);
});

test("thinking.exclude を設定から読む (既定 true、false も送れる)", async () => {
  await reviewWithEndpoint("ep-noexclude");
  const sent = lastRequestFor("fake-ok");
  assert.equal(sent.body.reasoning.exclude, false, "exclude:false と書いた接続先は false のまま送る");
});

test("401 → stopped.reason='backend'、済んだレビューは返る (14, 14.2, 14.3)", async () => {
  const result = await reviewWithEndpoint("ep-401");
  assert.ok(result.stopped, "stopped が入る");
  assert.equal(result.stopped.reason, "backend");
  assert.equal(result.stopped.endpoint, "ep-401");
  assert.equal(result.notScanned.length, 0, "貼り付け経路は notScanned が常に空");
  const row = await aspectRunRow(result.reviewId);
  assert.equal(row.status, "error");
  assert.match(row.error, /キーが拒否された/);
});

test("402 → stopped.reason='backend'", async () => {
  const result = await reviewWithEndpoint("ep-402");
  assert.ok(result.stopped);
  assert.equal(result.stopped.reason, "backend");
  const row = await aspectRunRow(result.reviewId);
  assert.match(row.error, /残高/);
});

test("429 → stopped.reason='rate_limit' (401/402とは別扱い)", async () => {
  const result = await reviewWithEndpoint("ep-429");
  assert.ok(result.stopped);
  assert.equal(result.stopped.reason, "rate_limit");
});

test("0644 のキーは chmod 600 の文言で拒み、LLM を1回も呼ばずに止める (5.4)", async () => {
  const beforeReq = lastRequestFor("fake-ok"); // ep-ok-ext の分がすでにある
  const result = await reviewWithEndpoint("ep-badkey");
  assert.ok(result.stopped);
  assert.equal(result.stopped.reason, "backend");
  assert.match(result.stopped.message, /chmod 600/);
  assert.match(result.stopped.message, /bad-perm-key/);
  const afterReq = lastRequestFor("fake-ok");
  assert.equal(afterReq?.at, beforeReq?.at, "fake-ok (badkey も同じ model) への要求が増えていない = 送信していない");
  const row = await aspectRunRow(result.reviewId);
  assert.equal(row.status, "error");
  assert.match(row.error, /chmod 600/);
  // 7.4: endpoint は「本文を送った先」。key_file 失敗は要求を作る前に落ちるので
  // 相手には届いていない → endpoint / endpoint_external は null (設計と食い違っていた点の是正)
  assert.equal(row.endpoint, null, "送っていないので endpoint は null");
  assert.equal(row.endpoint_external, null, "同上");
});

test("設定に無い名前は 400 で、選べる名前を並べる (6.1)", async () => {
  const r = await postReview(JUSTIC_PORT, {
    body: "# x\n\n本文", useL3: true, origin: "model", endpoint: "does-not-exist",
  });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /does-not-exist/);
  for (const name of ["ep-ok-ext", "ep-empty", "ep-401"]) {
    assert.ok(r.json.error.includes(name), `選べる名前に ${name} が並ぶ`);
  }
});

test("7.3/7.4: endpoint_external の記録と、外部に送った文書を引く問い合わせ", async () => {
  const result = await reviewWithEndpoint("ep-ok-ext"); // external: true
  const { rows } = await db.query(
    `select d.id as document_id, d.sha256, d.title,
            ra.endpoint, ra.model_id, ra.aspect_id,
            ra.started_at, r.id as review_id, r.source_kind, r.source_ref
       from review_aspects ra
       join reviews   r on r.id = ra.review_id
       join documents d on d.id = r.document_id
      where ra.endpoint_external
        and r.id = $1
      order by ra.started_at desc`,
    [result.reviewId],
  );
  assert.equal(rows.length, 1, "7.4 の問い合わせでこのレビューが引ける");
  assert.equal(rows[0].endpoint, "ep-ok-ext");
});

// ---- 起動時の検証 (別の子プロセス) ----------------------------------------

test("headers に authorization を書いた設定では起動が止まる (5.5, 17章の process.exit(1))", async () => {
  const child = spawn(NODE, [path.join(ROOT, "web", "server.js")], {
    cwd: path.join(ROOT, "web"),
    env: baseEnv({
      PORT: String(JUSTIC_BROKEN_PORT), JUSTIC_ORIGIN: `http://127.0.0.1:${JUSTIC_BROKEN_PORT}`,
      PGHOST: "/home/oosaw/justic/pgdata", PGPORT: "5433", PGUSER: "oosaw",
      PGDATABASE: "justic_test",
      JUSTIC_ENDPOINTS: brokenConfigPath,
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += d; });
  const exited = await waitForExit(child, 5000);
  if (!exited) {
    await stopChild(child, "justic (broken config, should have exited)");
    assert.fail("authorization ヘッダ入りの設定でも起動してしまった (process.exit(1) しなかった)");
  }
  assert.notEqual(exited.code, 0, "0 以外で終了するはず");
  assert.match(stderr, /authorization/, "理由に authorization が触れられている");
});

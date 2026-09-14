// 試験用の OpenAI 互換サーバー。docs/design-05-llm-endpoints.md の 16.1。
//
// node の http だけで書く。依存を増やさない (web/package.json は変えない)。
// POST /v1/chat/completions を受け、要求 (ヘッダと本文) を
// 環境変数 FAKE_LLM_LOG の JSONL に追記し、要求の model で振る舞いを変える。
//
//   FAKE_LLM_PORT   待ち受けポート (既定 5199)
//   FAKE_LLM_LOG    要求を追記するファイル (無ければ書かない)

import http from "node:http";
import fs from "node:fs";

const PORT = Number(process.env.FAKE_LLM_PORT ?? 5199);
const LOG = process.env.FAKE_LLM_LOG;

// justic の実装と数字を揃えて確かめられるよう、固定値にする。
export const USAGE = { prompt_tokens: 321, completion_tokens: 45, cost: 0.00087 };

function logRequest(headers, body) {
  if (!LOG) return;
  fs.appendFileSync(LOG, `${JSON.stringify({ at: new Date().toISOString(), headers, body })}\n`);
}

function jsonBody(res, status, obj) {
  const text = JSON.stringify(obj);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(text);
}

/** user メッセージ (本文は withLineNumbers 済み) から実在する1行を拾う。 */
function extractEvidence(messages) {
  const user = messages.find((m) => m.role === "user")?.content ?? "";
  const m = user.match(/^(\d+): (.+)$/m);
  if (!m) return { line: 1, evidence: "本文" };
  return { line: Number(m[1]), evidence: m[2].trim() };
}

const server = http.createServer((req, res) => {
  if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
    jsonBody(res, 404, { error: { message: "not found" } });
    return;
  }
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", () => {
    let body;
    try { body = JSON.parse(raw); } catch { body = {}; }
    logRequest(req.headers, body);

    const model = String(body.model ?? "");
    // 応答の model はあえて要求と違う文字列にする。「実測値を記録する」
    // (要求の model ではなく応答の model) ことを試験で見分けられるようにするため。
    const served = `${model}-served`;
    const { line, evidence } = extractEvidence(body.messages ?? []);

    if (model === "fake-ok") {
      const content = JSON.stringify({
        findings: [{ evidence, line, message: "異常系が書かれていない (fake-llm)" }],
      });
      return jsonBody(res, 200, {
        model: served,
        choices: [{ message: { content }, finish_reason: "stop" }],
        usage: USAGE,
      });
    }
    if (model === "fake-empty") {
      return jsonBody(res, 200, {
        model: served,
        choices: [{ message: { content: JSON.stringify({ findings: [] }) }, finish_reason: "stop" }],
        usage: USAGE,
      });
    }
    if (model === "fake-length") {
      // 閉じ括弧まで到達しない、途中で切れた JSON
      const content = `{"findings":[{"evidence":"${evidence.slice(0, 5)}`;
      return jsonBody(res, 200, {
        model: served,
        choices: [{ message: { content }, finish_reason: "length" }],
        usage: USAGE,
      });
    }
    if (model === "fake-error200") {
      // HTTP 200 なのに本文が error だけ (14.1)
      return jsonBody(res, 200, {
        error: { code: 500, message: "内部エラー (fake-llm)", metadata: { error_type: "provider_unavailable" } },
      });
    }
    if (model === "fake-401") {
      return jsonBody(res, 401, {
        error: { code: 401, message: "invalid api key (fake-llm)", metadata: { error_type: "authentication" } },
      });
    }
    if (model === "fake-402") {
      return jsonBody(res, 402, {
        error: { code: 402, message: "insufficient credits (fake-llm)", metadata: { error_type: "payment_required" } },
      });
    }
    if (model === "fake-429") {
      return jsonBody(res, 429, {
        error: { code: 429, message: "rate limited (fake-llm)", metadata: { error_type: "rate_limit_exceeded" } },
      });
    }
    if (model === "fake-403") {
      // モデレーションで弾かれた (14章)
      return jsonBody(res, 403, {
        error: { code: 403, message: "content flagged (fake-llm)", metadata: { error_type: "content_policy_violation" } },
      });
    }
    if (model === "fake-503") {
      // 提供元が見つからない (14章)
      return jsonBody(res, 503, {
        error: { code: 503, message: "no provider available (fake-llm)", metadata: { error_type: "provider_overloaded" } },
      });
    }
    return jsonBody(res, 404, { error: { code: 404, message: `fake-llm: unknown model '${model}'` } });
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`fake-llm listening on 127.0.0.1:${PORT}`);
});

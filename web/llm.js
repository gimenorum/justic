// L3: LLM に設計書を読ませて、1つの観点について指摘させる。
// 1プロンプトに1観点しか入れない (要件 L3-01)。
//
// これがこの道具の本体なので既定で有効。JUSTIC_L3=0 で切れる。
// 接続先は docs/design-05-llm-endpoints.md。呼び出し側 (server.js) が
// endpoints.js から解決した接続先を渡してくる。

import { readKey } from "./endpoints.js";

export const l3Enabled = () => process.env.JUSTIC_L3 !== "0";

// 観点。増やすときは1件ずつ足し、評価を通してから次に行く (要件 L3-02)。
// 実体は aspects 表 (docs/design-00-overview.md の 4.1)。ここはその写しと、
// 表に持たない実行時の情報 (ruleId、プロンプト版) を持つ。
//
// promptVersion は問いの文言を変えるたびに上げる。これが無いと
// 要件 EV-05 の「評価結果にプロンプトのバージョンを紐付けて保存する」が満たせず、
// キャッシュの鍵も作れない。
export const ASPECTS = [
  {
    id: "D-01",
    ruleId: "design/undefined-error-path",
    title: "異常系の未定義",
    promptVersion: "d01-v1",
    // 「レビューせよ」ではなく、判定できる問いの形にする (要件 L3-09)。
    question:
      "不正な入力・失敗・例外に対する振る舞いを定義しているか。" +
      "定義せずに結果だけを書いている箇所、および失敗時の扱いに触れていない処理の記述を挙げよ。",
  },
];

const RUNTIME = Object.fromEntries(ASPECTS.map((a) => [a.id, a]));

/** aspects 表の行を実行時の形に写す。表に無い観点は無視する。 */
export function toRuntimeAspects(rows) {
  return rows
    .filter((r) => RUNTIME[r.id])
    .map((r) => ({ ...RUNTIME[r.id], title: r.title, question: r.question }));
}

const SYSTEM = `あなたは日本語の設計書をレビューする。観点は1つだけで、それ以外は見ない。

出力は JSON のみ。次の形に厳密に従う。
{"findings":[{"evidence":"原文からの引用","line":<行番号>,"message":"何が定義されていないか"}]}

規則:
- evidence は原文に現れる文字列をそのまま写す。要約や言い換えをしない。
- 該当がなければ {"findings":[]} を返す。無理に指摘を作らない。
- message は指摘の内容だけを書く。前置きと結びを書かない。`;

function withLineNumbers(text) {
  return text.split("\n").map((l, i) => `${i + 1}: ${l}`).join("\n");
}

// 引用が原文に無い finding は捨てる (要件 L3-05)。幻覚をここで落とす。
function verifyEvidence(text, evidence) {
  if (!evidence) return false;
  const norm = (s) => s.replace(/\s+/g, "");
  return norm(text).includes(norm(evidence));
}

/** 接続先の thinking 設定から、要求に足す項目を作る (8.3)。 */
function thinkingFields(thinking) {
  if (!thinking || thinking.mode === "none") return {};
  if (thinking.mode === "chat_template_kwargs") return { chat_template_kwargs: { enable_thinking: false } };
  // exclude は設定から読む。既定 true (思考の本文を応答に載せない)
  if (thinking.mode === "reasoning") return { reasoning: { effort: thinking.effort, exclude: thinking.exclude ?? true } };
  return {};
}

function llmError(kind, message) {
  const err = new Error(message);
  err.kind = kind;
  return err;
}

/**
 * 失敗の種類を決める。error.metadata.error_type があればそれを優先し、
 * 無ければ HTTP のステータスで決める (14章)。文言に接続先の名前を入れ、
 * キーと要求ヘッダは入れない。応答本文は先頭200文字まで (5.5)。
 *
 * モデレーションで弾かれた (403 / content_policy_violation / refusal) は
 * 種類 refused にし、本文の抜粋は入れず理由の名前だけ残す。
 * 提供元が見つからない (404 / 503 / not_found / provider_overloaded /
 * provider_unavailable) は種類は other のままで、文言に手当てを足す。
 */
function classifyError(errorObj, status, endpoint, rawText) {
  const type = errorObj?.metadata?.error_type;
  let kind;
  if (type === "authentication") kind = "auth";
  else if (type === "payment_required") kind = "payment";
  else if (type === "rate_limit_exceeded") kind = "rate_limit";
  else if (type === "content_policy_violation" || type === "refusal") kind = "refused";
  else if (status === 401) kind = "auth";
  else if (status === 402) kind = "payment";
  else if (status === 429) kind = "rate_limit";
  else if (status === 403) kind = "refused";
  else kind = "other";

  const notFound = type === "not_found" || type === "provider_overloaded" || type === "provider_unavailable"
    || status === 404 || status === 503;

  const snippet = String(rawText ?? "").slice(0, 200);
  let message;
  if (kind === "auth") message = `接続先 ${endpoint.name} のキーが拒否された (${status}): ${snippet}`;
  else if (kind === "payment") message = `接続先 ${endpoint.name}: 残高が足りない (${status}): ${snippet}`;
  else if (kind === "rate_limit") message = `接続先 ${endpoint.name}: レート制限 (${status}): ${snippet}`;
  else if (kind === "refused") message = `接続先 ${endpoint.name} が本文を拒んだ (${type ?? status})`;
  else if (status === 200) message = `接続先 ${endpoint.name}: 200 で返ったが本文に error がある: ${snippet}`;
  else message = `接続先 ${endpoint.name} の応答が失敗 (${status}): ${snippet}`;
  if (notFound) message += "。provider の指定で絞りすぎている可能性がある (設計 7.5)";
  return llmError(kind, message);
}

/**
 * 1回の呼び出し。第2引数に接続先を取る (docs/design-05-llm-endpoints.md の 3.2)。
 *
 * キーは呼び出しのたびに読み直す (5.2)。読めなければ、ここで
 * (実際には要求を送る前に) 失敗する。種類 key_file の Error のまま外へ投げる。
 */
async function chat(messages, endpoint) {
  // 5.4: 権限が緩い・ファイルが無い・1行目が空はここで拒む。LLM は1回も呼ばない。
  const key = await readKey(endpoint);

  const body = {
    ...(endpoint.model ? { model: endpoint.model } : {}),
    messages,
    max_tokens: endpoint.max_tokens,
    ...(endpoint.temperature !== null ? { temperature: endpoint.temperature } : {}),
    ...thinkingFields(endpoint.thinking),
    ...(endpoint.response_format ? { response_format: { type: "json_object" } } : {}),
    ...(endpoint.provider ? { provider: endpoint.provider } : {}),
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), endpoint.timeout_ms);
  let res;
  try {
    res = await fetch(`${endpoint.base_url}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(key ? { authorization: `Bearer ${key}` } : {}),
        ...endpoint.headers,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    // サーバーが起きていないのが一番ありがちなので、そう読める文にする。
    if (e.name === "AbortError") {
      throw llmError("timeout", `${endpoint.timeout_ms / 1000}秒で応答が無い (接続先 ${endpoint.name})`);
    }
    if (e.cause?.code === "ECONNREFUSED" || /fetch failed/i.test(e.message)) {
      throw llmError("unreachable", `推論サーバーに繋がらない (接続先 ${endpoint.name}、${endpoint.base_url})。起動しているか確認する`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }

  const rawText = await res.text().catch(() => "");
  let json = null;
  try { json = JSON.parse(rawText); } catch { /* JSON でない応答 */ }

  // 14.1: 200 でも本文に error があれば失敗として扱う
  if (json?.error) throw classifyError(json.error, res.status, endpoint, rawText);
  if (!res.ok) throw classifyError(json?.error ?? null, res.status, endpoint, rawText);

  return {
    content: json?.choices?.[0]?.message?.content ?? "",
    model: json?.model ?? null,
    finishReason: json?.choices?.[0]?.finish_reason ?? null,
    usage: json?.usage ?? null,
  };
}

/**
 * 壊れた JSON と正当な「該当なし」を区別する。
 * どちらも [] を返すと、要件 L3-06 の空配列と失敗が同じ結果になり、
 * 画面には「指摘なし」とだけ出る。観点を増やすほど黙って消える確率が上がる。
 */
function parseFindings(raw) {
  // ```json で包んでくることがある。中身だけ取る。
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = (fenced ? fenced[1] : raw).trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end < 0) return { ok: false, reason: "JSON が見つからない", findings: [] };
  try {
    const parsed = JSON.parse(body.slice(start, end + 1));
    if (!Array.isArray(parsed.findings)) {
      return { ok: false, reason: "findings が配列でない", findings: [] };
    }
    return { ok: true, findings: parsed.findings };
  } catch (e) {
    return { ok: false, reason: `JSON として読めない: ${String(e.message).slice(0, 80)}`, findings: [] };
  }
}

/**
 * 1つの観点を1接続先に対して走らせる。
 *
 * finishReason が 'length' なら、JSON が読めたかに関わらず「途中で切れた」を
 * 別の文言で返す (8.5)。この関数自体は chat() の失敗を捕まえない。
 * 呼び出し側 (runL3) が観点ごとに捕まえる (元の構造のまま)。
 */
export async function reviewAspect(text, aspect, endpoint) {
  const startedAt = new Date();
  const { content: raw, model, finishReason, usage } = await chat([
    { role: "system", content: SYSTEM },
    // 本文を先に置く。並び順を固定してプロンプトキャッシュを効かせる (要件 L3-07)。
    { role: "user", content: `# 設計書\n\n${withLineNumbers(text)}\n\n# 観点\n\n${aspect.question}` },
  ], endpoint);

  const usageFields = {
    promptTokens: usage?.prompt_tokens ?? null,
    completionTokens: usage?.completion_tokens ?? null,
    cost: usage?.cost ?? null,
    usageRaw: usage ?? null,
  };
  const common = {
    aspect: aspect.id, promptVersion: aspect.promptVersion,
    startedAt, finishedAt: new Date(),
    endpoint: endpoint.name, endpointExternal: endpoint.external,
    finishReason, modelId: model, ...usageFields,
  };

  if (finishReason === "length") {
    return {
      findings: [], dropped: 0,
      status: "parse_error",
      error: `出力が max_tokens (${endpoint.max_tokens}) に達して途中で切れた`,
      ...common,
    };
  }

  const parsed = parseFindings(raw);
  const kept = [];
  let dropped = 0;
  for (const f of parsed.findings) {
    if (!verifyEvidence(text, f.evidence)) { dropped += 1; continue; }
    kept.push({
      ruleId: aspect.ruleId,
      aspectId: aspect.id,
      layer: "L3",
      severity: "info", // L3 は blocking しない (要件9章)
      line: Number.isInteger(f.line) ? f.line : null,
      col: null, endLine: null, endCol: null,
      message: String(f.message ?? "").trim(),
      evidence: String(f.evidence).trim().slice(0, 500),
      suggestion: null,
      confidence: null,
      exposure: "ranked",
    });
  }
  return {
    findings: kept, dropped,
    status: parsed.ok ? (kept.length > 0 ? "ok" : "empty") : "parse_error",
    error: parsed.ok ? null : parsed.reason,
    ...common,
  };
}

/**
 * 観点をまとめて走らせる。接続先は1回の要求で1つ (6.1)。
 *
 * 失敗の種類が auth / payment / rate_limit / key_file / refused (モデレーションで
 * 弾かれた) なら、そこで打ち切り、残りの観点を skipped にして stopped を返す。
 * 429 は rate_limit、他の4つは backend にまとめる (14章)。それ以外はいままでどおり
 * 観点ごとに error / timeout / parse_error として続ける。
 *
 * endpoint / endpointExternal は「本文を送った先」(7.4)。key_file と unreachable は
 * 要求を送っていない (相手に届いていない) ので null にする。timeout と other は
 * 届いているので接続先の名前を残す。
 *
 * failure には、このレビューで最初に起きた種類 unreachable か other の失敗を残す。
 * 呼び出し側 (server.js) が複数ファイルの走査で「同じ理由が2回続いたら止める」
 * (14章) の判定に使う。timeout と parse_error は数えない。
 */
export async function runL3(text, { aspects = ASPECTS, endpoint } = {}) {
  const results = [];
  let stopped = null;
  for (const a of aspects) {
    if (stopped) {
      results.push({
        aspect: a.id, status: "skipped", findings: [], dropped: 0,
        error: null, promptVersion: a.promptVersion,
        startedAt: null, finishedAt: null,
        endpoint: null, endpointExternal: null, finishReason: null, modelId: null,
        promptTokens: null, completionTokens: null, cost: null, usageRaw: null,
        _kind: null,
      });
      continue;
    }
    const startedAt = new Date();
    try {
      results.push({ ...(await reviewAspect(text, a, endpoint)), _kind: null });
    } catch (e) {
      const msg = String(e.message ?? e);
      const kind = e.kind ?? (/応答が無い/.test(msg) ? "timeout" : "other");
      // 要求が相手に届いたか。key_file は要求を作る前に落ち、unreachable は
      // 繋がらないので、どちらも「本文を送った先」が無い
      const delivered = kind !== "key_file" && kind !== "unreachable";
      results.push({
        findings: [], dropped: 0, aspect: a.id,
        status: kind === "timeout" ? "timeout" : "error",
        error: msg, promptVersion: a.promptVersion,
        startedAt, finishedAt: new Date(),
        endpoint: delivered ? endpoint.name : null,
        endpointExternal: delivered ? endpoint.external : null,
        finishReason: null, modelId: null,
        promptTokens: null, completionTokens: null, cost: null, usageRaw: null,
        _kind: kind,
      });
      if (kind === "auth" || kind === "payment" || kind === "rate_limit" || kind === "key_file" || kind === "refused") {
        stopped = {
          reason: kind === "rate_limit" ? "rate_limit" : "backend",
          endpoint: endpoint.name,
          message: msg,
        };
      }
    }
  }
  // このレビューで最初に起きた unreachable か other の失敗。無ければ null
  const failed = results.find((r) => r._kind === "unreachable" || r._kind === "other");
  return {
    findings: results.flatMap((r) => r.findings),
    dropped: results.reduce((n, r) => n + r.dropped, 0),
    // parse_error も errors に積む。「指摘なし」と混同させない
    errors: results.filter((r) => r.error).map((r) => `${r.aspect}: ${r.error}`),
    runs: results.map((r) => ({
      aspectId: r.aspect, status: r.status, findingsN: r.findings.length,
      modelId: r.modelId ?? null, promptVersion: r.promptVersion,
      error: r.error, startedAt: r.startedAt, finishedAt: r.finishedAt,
      endpoint: r.endpoint, endpointExternal: r.endpointExternal,
      finishReason: r.finishReason, promptTokens: r.promptTokens,
      completionTokens: r.completionTokens, cost: r.cost, usageRaw: r.usageRaw,
    })),
    // 最初に実際に答えたモデル (実測値)。無ければ null (02 の 6.3、'(サーバー既定)' は書かない)
    model: results.find((r) => r.modelId)?.modelId ?? null,
    stopped,
    failure: failed ? { kind: failed._kind, message: failed.error } : null,
  };
}

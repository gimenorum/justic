// L3: LLM に設計書を読ませて、1つの観点について指摘させる。
// 1プロンプトに1観点しか入れない (要件 L3-01)。
//
// これがこの道具の本体なので既定で有効。JUSTIC_L3=0 で切れる。
// 推論サーバーが居なければ L1 の結果だけを返し、理由を画面に出す。

const BASE_URL = process.env.JUSTIC_BASE_URL ?? "http://127.0.0.1:18080/v1";
const API_KEY = process.env.JUSTIC_API_KEY ?? "";
const MODEL = process.env.JUSTIC_MODEL ?? "";
const TIMEOUT_MS = Number(process.env.JUSTIC_L3_TIMEOUT_MS ?? 120000);

export const l3Enabled = () => process.env.JUSTIC_L3 !== "0";

// 観点。増やすときは1件ずつ足し、評価を通してから次に行く (要件 L3-02)。
export const ASPECTS = [
  {
    id: "D-01",
    ruleId: "design/undefined-error-path",
    title: "異常系の未定義",
    // 「レビューせよ」ではなく、判定できる問いの形にする (要件 L3-09)。
    question:
      "不正な入力・失敗・例外に対する振る舞いを定義しているか。" +
      "定義せずに結果だけを書いている箇所、および失敗時の扱いに触れていない処理の記述を挙げよ。",
  },
];

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

async function chat(messages) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(API_KEY ? { authorization: `Bearer ${API_KEY}` } : {}),
      },
      body: JSON.stringify({
        model: MODEL || undefined,
        messages,
        temperature: 0,
        max_tokens: 2000,
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`${res.status} ${await res.text().catch(() => "")}`.slice(0, 200));
    const json = await res.json();
    return json.choices?.[0]?.message?.content ?? "";
  } catch (e) {
    // サーバーが起きていないのが一番ありがちなので、そう読める文にする。
    if (e.name === "AbortError") throw new Error(`${TIMEOUT_MS / 1000}秒で応答が無い (${BASE_URL})`);
    if (e.cause?.code === "ECONNREFUSED" || /fetch failed/i.test(e.message)) {
      throw new Error(`推論サーバーに繋がらない (${BASE_URL})。起動しているか確認する`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function parseFindings(raw) {
  // ```json で包んでくることがある。中身だけ取る。
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = (fenced ? fenced[1] : raw).trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end < 0) return [];
  try {
    const parsed = JSON.parse(body.slice(start, end + 1));
    return Array.isArray(parsed.findings) ? parsed.findings : [];
  } catch {
    return [];
  }
}

export async function reviewAspect(text, aspect) {
  const raw = await chat([
    { role: "system", content: SYSTEM },
    // 本文を先に置く。並び順を固定してプロンプトキャッシュを効かせる (要件 L3-07)。
    { role: "user", content: `# 設計書\n\n${withLineNumbers(text)}\n\n# 観点\n\n${aspect.question}` },
  ]);

  const kept = [];
  let dropped = 0;
  for (const f of parseFindings(raw)) {
    if (!verifyEvidence(text, f.evidence)) { dropped += 1; continue; }
    kept.push({
      ruleId: aspect.ruleId,
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
  return { findings: kept, dropped, aspect: aspect.id };
}

export async function runL3(text, { aspects = ASPECTS } = {}) {
  const results = [];
  // 観点ごとに独立したパス。まとめて1回で聞かない。
  for (const a of aspects) {
    try {
      results.push(await reviewAspect(text, a));
    } catch (e) {
      results.push({ findings: [], dropped: 0, aspect: a.id, error: String(e.message ?? e) });
    }
  }
  return {
    findings: results.flatMap((r) => r.findings),
    dropped: results.reduce((n, r) => n + r.dropped, 0),
    errors: results.filter((r) => r.error).map((r) => `${r.aspect}: ${r.error}`),
    model: MODEL || "(サーバー既定)",
  };
}

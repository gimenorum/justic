// LLM の接続先。docs/design-05-llm-endpoints.md。
//
// 設定ファイル (~/.config/justic/endpoints.json、既定) を起動時に1回だけ読む。
// キーファイルは呼び出しのたびに読み直す (5.2)。
//
// キーの値はここから外に出さない。ログにもエラーにも応答にも書かない (5.5)。

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const NAME_RE = /^[a-z0-9_-]{1,32}$/;
const THINKING_MODES = new Set(["chat_template_kwargs", "reasoning", "none"]);
// 4.3: base_url がこの並びに無いのに external:false なら書き間違いの疑い (7.3)。
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
// 4.3 いまの環境変数との関係。設定ファイルがあるときは無視する対象 (「この3つ」)。
// JUSTIC_L3_TIMEOUT_MS はこの警告の対象に含めない。設計書の文言どおり
const ENV_FALLBACK_VARS = ["JUSTIC_BASE_URL", "JUSTIC_MODEL", "JUSTIC_API_KEY"];

const STATE = { list: [], default: null, path: null, fromFile: false };

function expandHome(p) {
  if (!p) return p;
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function resolveConfigPath() {
  const envPath = process.env.JUSTIC_ENDPOINTS;
  const raw = envPath && envPath.trim() ? envPath.trim() : "~/.config/justic/endpoints.json";
  return expandHome(raw);
}

function stripTrailingSlash(url) {
  return url.replace(/\/+$/, "");
}

/** 設定ファイルが無いときの、環境変数からの1件 (4.3)。 */
function buildLocalFromEnv() {
  return {
    name: "local",
    title: "手元のルーター",
    base_url: stripTrailingSlash(process.env.JUSTIC_BASE_URL ?? "http://127.0.0.1:18080/v1"),
    model: process.env.JUSTIC_MODEL ?? "",
    external: false,
    key_file: null,
    // キーは環境変数の値をそのまま使い、ファイルは読まない (4.3)。
    _envKey: process.env.JUSTIC_API_KEY ?? "",
    max_tokens: 4000,
    temperature: 0,
    timeout_ms: Number(process.env.JUSTIC_L3_TIMEOUT_MS ?? 120000),
    thinking: { mode: "chat_template_kwargs" },
    response_format: false,
    provider: null,
    headers: {},
  };
}

/** 1件の接続先を検証する。壊れていれば errors に文言を積み、正常なら true を返す。 */
function validateEndpoint(raw, idx, errors) {
  const tag = (msg) => errors.push(`endpoints[${idx}]${raw && typeof raw.name === "string" ? ` (${raw.name})` : ""}: ${msg}`);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    tag("オブジェクトでない");
    return false;
  }
  let ok = true;
  if (typeof raw.name !== "string" || !NAME_RE.test(raw.name)) {
    tag("name は ^[a-z0-9_-]{1,32}$ に一致する文字列が必須"); ok = false;
  }
  if (typeof raw.base_url !== "string" || !raw.base_url) {
    tag("base_url は必須の文字列"); ok = false;
  }
  if (typeof raw.external !== "boolean") {
    tag("external は必須の真偽値"); ok = false;
  }
  if (!Number.isInteger(raw.max_tokens)) {
    tag("max_tokens は必須の整数"); ok = false;
  }
  if (!("temperature" in raw) || (raw.temperature !== null && typeof raw.temperature !== "number")) {
    tag("temperature は必須。数値か null"); ok = false;
  }
  if (!Number.isInteger(raw.timeout_ms)) {
    tag("timeout_ms は必須の整数"); ok = false;
  }
  if (typeof raw.thinking !== "object" || raw.thinking === null || Array.isArray(raw.thinking)) {
    tag("thinking は必須のオブジェクト"); ok = false;
  } else if (!THINKING_MODES.has(raw.thinking.mode)) {
    tag("thinking.mode は chat_template_kwargs | reasoning | none のどれか"); ok = false;
  } else if (raw.thinking.mode === "reasoning" && !raw.thinking.effort) {
    tag("thinking.effort は thinking.mode が reasoning のとき必須"); ok = false;
  }
  if (raw.title !== undefined && typeof raw.title !== "string") { tag("title は文字列"); ok = false; }
  if (raw.model !== undefined && typeof raw.model !== "string") { tag("model は文字列"); ok = false; }
  if (raw.key_file !== undefined && raw.key_file !== null && typeof raw.key_file !== "string") {
    tag("key_file は文字列"); ok = false;
  }
  if (raw.response_format !== undefined && typeof raw.response_format !== "boolean") {
    tag("response_format は真偽値"); ok = false;
  }
  if (raw.provider !== undefined && raw.provider !== null
      && (typeof raw.provider !== "object" || Array.isArray(raw.provider))) {
    tag("provider はオブジェクト"); ok = false;
  }
  if (raw.headers !== undefined) {
    if (typeof raw.headers !== "object" || raw.headers === null || Array.isArray(raw.headers)) {
      tag("headers はオブジェクト"); ok = false;
    } else if (Object.keys(raw.headers).some((k) => k.toLowerCase() === "authorization")) {
      // 5.5: 設定にキーを書く抜け道を1つ潰す。ここは必ず起動を止める
      tag("headers に authorization は書けない (5.5)"); ok = false;
    }
  }
  return ok;
}

function normalizeEndpoint(raw) {
  return {
    name: raw.name,
    title: raw.title || raw.name,
    base_url: stripTrailingSlash(raw.base_url),
    model: raw.model ?? "",
    external: raw.external,
    key_file: raw.key_file ? expandHome(raw.key_file) : null,
    max_tokens: raw.max_tokens,
    temperature: raw.temperature,
    timeout_ms: raw.timeout_ms,
    thinking: raw.thinking,
    response_format: raw.response_format ?? false,
    provider: raw.provider ?? null,
    headers: raw.headers ?? {},
  };
}

/** base_url がループバックでないのに external:false と書いてあれば警告 (7.3)。止めない。 */
function warnLoopbackMismatch(list) {
  for (const e of list) {
    let hostname;
    try { hostname = new URL(e.base_url).hostname; } catch { continue; }
    if (!e.external && !LOOPBACK_HOSTS.has(hostname)) {
      console.log(
        `接続先 ${e.name}: base_url (${e.base_url}) はループバックでないのに external:false になっている。書き間違いでなければ無視してよい (R-22)`,
      );
    }
  }
}

/**
 * 起動時に1回読む。読み込み・検証に失敗したら Error を投げる。
 * 呼び出し側 (server.js) はこれを捕まえて理由を出し、process.exit(1) する。
 */
export function init() {
  const file = resolveConfigPath();
  STATE.path = file;

  if (!fs.existsSync(file)) {
    STATE.fromFile = false;
    const local = buildLocalFromEnv();
    STATE.list = [local];
    STATE.default = local.external ? null : local.name;
    warnLoopbackMismatch(STATE.list);
    return;
  }

  STATE.fromFile = true;
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    throw new Error(`${file} が読めない: ${e.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    // 4.4: JSON が壊れていれば起動を止める
    throw new Error(`${file} の JSON が壊れている: ${e.message}`);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${file}: トップレベルはオブジェクトである必要がある`);
  }
  if (!Array.isArray(parsed.endpoints)) {
    throw new Error(`${file}: endpoints は配列である必要がある`);
  }

  const errors = [];
  if (parsed.default !== undefined && parsed.default !== null && typeof parsed.default !== "string") {
    errors.push("default は文字列");
  }
  parsed.endpoints.forEach((raw, i) => validateEndpoint(raw, i, errors));

  // 名前の重複
  const names = parsed.endpoints
    .map((e) => (e && typeof e.name === "string" ? e.name : null))
    .filter(Boolean);
  const seen = new Set();
  for (const n of names) {
    if (seen.has(n)) errors.push(`接続先名 '${n}' が重複している`);
    seen.add(n);
  }

  if (errors.length) {
    throw new Error(`${file} の検証に失敗:\n  - ${errors.join("\n  - ")}`);
  }

  const list = parsed.endpoints.map((raw) => normalizeEndpoint(raw));

  let def = parsed.default || null;
  if (def) {
    if (!list.some((e) => e.name === def)) {
      // 設計書の表に無いケース。default が宙に浮いたまま動かすと、
      // 「既定が無い」のか「既定が壊れている」のか画面から区別できないため止める
      throw new Error(`${file}: default '${def}' に一致する接続先が無い`);
    }
  } else if (list.length > 0) {
    const nonExternal = list.filter((e) => !e.external);
    if (nonExternal.length === 1) def = nonExternal[0].name;
  }

  STATE.list = list;
  STATE.default = list.length > 0 ? def : null;

  if (STATE.fromFile) {
    const leftover = ENV_FALLBACK_VARS.filter((k) => process.env[k] !== undefined && process.env[k] !== "");
    if (leftover.length) {
      console.log(`${leftover.join(" / ")} は設定ファイル (${file}) があるため効いていない (4.3)`);
    }
  }

  warnLoopbackMismatch(list);
}

/** 読み込んだ接続先の一覧 (キーは含まない)。 */
export function list() {
  return STATE.list;
}

/** 名前で1件引く。無ければ undefined。 */
export function get(name) {
  return STATE.list.find((e) => e.name === name);
}

/** 既定の接続先名。決まっていなければ null (4.4)。 */
export function defaultName() {
  return STATE.default;
}

/** 診断用。設定ファイルの解決済みパス。 */
export function configPath() {
  return STATE.path;
}

/**
 * key_file を読む。呼び出しのたびに読み直す (5.2)。
 * key_file が設定されていない接続先は null を返す (失敗ではない)。
 * 権限が緩い・ファイルが無い・1行目が空のときは、種類 'key_file' の Error を投げる (5.4)。
 */
export async function readKey(endpoint) {
  if (Object.prototype.hasOwnProperty.call(endpoint, "_envKey")) {
    const v = endpoint._envKey;
    return v ? v : null;
  }
  if (!endpoint.key_file) return null;
  const p = endpoint.key_file;

  let stat;
  try {
    stat = await fsp.stat(p);
  } catch {
    const err = new Error(`接続先 ${endpoint.name} のキーファイルが無い: ${p}`);
    err.kind = "key_file";
    throw err;
  }
  // group か other に読み権限があれば拒む。警告ではなく拒否 (5.4)
  if ((stat.mode & 0o077) !== 0) {
    const err = new Error(`接続先 ${endpoint.name} のキーファイルの権限が緩い。chmod 600 ${p} で直す`);
    err.kind = "key_file";
    throw err;
  }
  const text = await fsp.readFile(p, "utf8");
  const firstLine = (text.split("\n")[0] ?? "").trim();
  if (!firstLine) {
    const err = new Error(`接続先 ${endpoint.name} のキーファイルの1行目が空: ${p}`);
    err.kind = "key_file";
    throw err;
  }
  return firstLine;
}

/**
 * /api/health 用の一覧。キー・パス・長さは返さない。hasKey は真偽値だけ (5.5、12.1)。
 */
export async function describe() {
  const def = STATE.default;
  const out = [];
  for (const e of STATE.list) {
    let hasKey = false;
    try {
      hasKey = Boolean(await readKey(e));
    } catch {
      hasKey = false;
    }
    out.push({
      name: e.name,
      title: e.title,
      external: e.external,
      model: e.model,
      hasKey,
      default: e.name === def,
      ...(e.provider ? { provider: e.provider } : {}),
    });
  }
  return out;
}

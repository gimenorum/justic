// GitHub OAuth。利用者ごとのトークンで GitHub を叩く。
//
// トークンは DB に置かない。AES-256-GCM で暗号化した httpOnly cookie に入れて
// ブラウザに持たせる。DB の控えが漏れても資格情報は出ない。
//
// 必要な環境変数 (.env):
//   JUSTIC_OAUTH_CLIENT_ID
//   JUSTIC_OAUTH_CLIENT_SECRET
//   JUSTIC_SESSION_SECRET      cookie の暗号鍵。openssl rand -hex 32
//
// OAuth App は利用者が GitHub 上で作る。Authorization callback URL は
//   http://127.0.0.1:5180/auth/callback

import crypto from "node:crypto";

const COOKIE = "justic_session";
const MAX_AGE_S = 60 * 60 * 12;

export const oauthConfigured = () =>
  Boolean(process.env.JUSTIC_OAUTH_CLIENT_ID && process.env.JUSTIC_OAUTH_CLIENT_SECRET && process.env.JUSTIC_SESSION_SECRET);

function key() {
  const secret = process.env.JUSTIC_SESSION_SECRET;
  if (!secret) throw new Error("JUSTIC_SESSION_SECRET が無い");
  return crypto.createHash("sha256").update(secret, "utf8").digest();
}

function seal(payload) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
}

function open(value) {
  try {
    const raw = Buffer.from(value, "base64url");
    const decipher = crypto.createDecipheriv("aes-256-gcm", key(), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    const json = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
    const payload = JSON.parse(json);
    return payload.exp > Date.now() / 1000 ? payload : null;
  } catch {
    return null; // 鍵を替えた、期限切れ、改竄。いずれも未ログイン扱い
  }
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function sessionOf(req) {
  const raw = parseCookies(req.headers.cookie)[COOKIE];
  return raw ? open(raw) : null;
}

function setSession(res, payload) {
  const value = seal({ ...payload, exp: Math.floor(Date.now() / 1000) + MAX_AGE_S });
  // secure は付けない。127.0.0.1 は http で開くため。
  // 外に出すときは https にしたうえで Secure を足す。
  res.setHeader("set-cookie", `${COOKIE}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${MAX_AGE_S}`);
}

export function clearSession(res) {
  res.setHeader("set-cookie", `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}

/** 利用者のトークンを優先し、無ければ .env の PAT に落ちる (一人で使うとき用)。 */
export function tokenFor(req) {
  return sessionOf(req)?.token ?? process.env.JUSTIC_GITHUB_TOKEN ?? null;
}

export function authorizeUrl(state) {
  const params = new URLSearchParams({
    client_id: process.env.JUSTIC_OAUTH_CLIENT_ID,
    // repo は private の読み取りと issue の作成に要る。公開だけなら public_repo で足りる。
    scope: process.env.JUSTIC_OAUTH_SCOPE ?? "repo",
    state,
  });
  return `https://github.com/login/oauth/authorize?${params}`;
}

export async function exchangeCode(code) {
  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      client_id: process.env.JUSTIC_OAUTH_CLIENT_ID,
      client_secret: process.env.JUSTIC_OAUTH_CLIENT_SECRET,
      code,
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error || !json.access_token) {
    throw new Error(json.error_description ?? json.error ?? `GitHub ${res.status}`);
  }
  return json.access_token;
}

export async function fetchViewer(token) {
  const res = await fetch("https://api.github.com/user", {
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "justic" },
  });
  if (!res.ok) throw new Error(`GitHub /user ${res.status}`);
  const u = await res.json();
  return { githubId: u.id, login: u.login, name: u.name, avatarUrl: u.avatar_url };
}

// state は CSRF 対策。署名して cookie に置かず、鍵で封をして往復させる。
export const makeState = () => seal({ n: crypto.randomBytes(8).toString("hex"), exp: Math.floor(Date.now() / 1000) + 600 });
export const checkState = (s) => Boolean(open(s));

export { setSession };

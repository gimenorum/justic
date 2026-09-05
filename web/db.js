import crypto from "node:crypto";
import pg from "pg";

// TCP を開けていないので Unix ソケットで繋ぐ。host にディレクトリを渡す。
const pool = new pg.Pool({
  host: process.env.PGHOST ?? "/home/oosaw/justic/pgdata",
  port: Number(process.env.PGPORT ?? 5433),
  user: process.env.PGUSER ?? "oosaw",
  database: process.env.PGDATABASE ?? "justic",
  max: 4,
});

export const sha256 = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");

export async function upsertDocument(title, body) {
  const digest = sha256(body);
  // 同じ本文を二度入れない。再レビューしても文書は1行のまま。
  const { rows } = await pool.query(
    `insert into documents (sha256, title, body) values ($1, $2, $3)
     on conflict (sha256) do update set title = coalesce(excluded.title, documents.title)
     returning id, sha256, created_at`,
    [digest, title || null, body],
  );
  return rows[0];
}

export async function createReview(documentId, { profile, layers, l3ModelId, promptVersion, classifierRun }) {
  const { rows } = await pool.query(
    `insert into reviews (document_id, profile, layers, l3_model_id, prompt_version, classifier_run)
     values ($1, $2, $3, $4, $5, $6) returning id, started_at`,
    [documentId, profile ?? "default", layers, l3ModelId ?? null, promptVersion ?? null, classifierRun ?? null],
  );
  return rows[0];
}

export async function insertFindings(reviewId, findings) {
  if (findings.length === 0) return [];
  const out = [];
  for (const f of findings) {
    const { rows } = await pool.query(
      `insert into findings
         (review_id, rule_id, layer, severity, line, col, end_line, end_col,
          message, evidence, suggestion, confidence, exposure, shown_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning *`,
      [
        reviewId, f.ruleId, f.layer, f.severity,
        f.line ?? null, f.col ?? null, f.endLine ?? null, f.endCol ?? null,
        f.message, f.evidence ?? null, f.suggestion ?? null, f.confidence ?? null,
        f.exposure, f.exposure === "hidden" ? null : new Date(),
      ],
    );
    out.push(rows[0]);
  }
  return out;
}

export async function finishReview(reviewId) {
  await pool.query(`update reviews set finished_at = now() where id = $1`, [reviewId]);
}

// 採否は追記のみ。押し直しても前の行は消さない。
export async function addVerdict(findingId, { verdict, correctedText, note, decidedBy }) {
  const { rows } = await pool.query(
    `insert into verdicts (finding_id, verdict, corrected_text, note, decided_by)
     values ($1, $2, $3, $4, $5) returning *`,
    [findingId, verdict, correctedText || null, note || null, decidedBy || "local"],
  );
  return rows[0];
}

export async function getReview(reviewId) {
  const { rows: reviews } = await pool.query(
    `select r.*, d.title, d.body, d.sha256 as document_sha256
     from reviews r join documents d on d.id = r.document_id where r.id = $1`,
    [reviewId],
  );
  if (reviews.length === 0) return null;
  // 出していないもの (hidden) は画面にも出さない。
  const { rows: findings } = await pool.query(
    `select f.*, v.verdict, v.corrected_text, v.decided_at
     from findings f left join current_verdicts v on v.finding_id = f.id
     where f.review_id = $1 and f.exposure <> 'hidden'
     order by case f.severity when 'error' then 0 when 'warn' then 1 else 2 end,
              f.line nulls last, f.id`,
    [reviewId],
  );
  return { ...reviews[0], findings };
}

export async function recentReviews(limit = 20) {
  const { rows } = await pool.query(
    `select r.id, r.started_at, r.layers, d.title, d.sha256 as document_sha256,
            count(f.id) filter (where f.exposure <> 'hidden')        as shown,
            count(v.finding_id) filter (where v.verdict='accepted')  as accepted,
            count(v.finding_id) filter (where v.verdict='rejected')  as rejected
     from reviews r
     join documents d on d.id = r.document_id
     left join findings f on f.review_id = r.id
     left join current_verdicts v on v.finding_id = f.id
     group by r.id, d.title, d.sha256
     order by r.started_at desc limit $1`,
    [limit],
  );
  return rows;
}

export async function stats() {
  const { rows } = await pool.query(
    `select
       (select count(*) from documents) as documents,
       (select count(*) from reviews)   as reviews,
       (select count(*) from findings where exposure <> 'hidden') as shown,
       (select count(*) from current_verdicts where verdict='accepted') as accepted,
       (select count(*) from current_verdicts where verdict='rejected') as rejected`,
  );
  return rows[0];
}

export async function ping() {
  await pool.query("select 1");
}

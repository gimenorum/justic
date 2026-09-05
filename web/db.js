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

export async function createReview(documentId, { profile, layers, l3ModelId, promptVersion, classifierRun, sourceKind, sourceRef }) {
  const { rows } = await pool.query(
    `insert into reviews (document_id, profile, layers, l3_model_id, prompt_version, classifier_run, source_kind, source_ref)
     values ($1, $2, $3, $4, $5, $6, $7, $8) returning id, started_at`,
    [documentId, profile ?? "default", layers, l3ModelId ?? null, promptVersion ?? null, classifierRun ?? null,
     sourceKind ?? "paste", sourceRef ? JSON.stringify(sourceRef) : null],
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
          message, evidence, suggestion, confidence, exposure, shown_at, in_diff)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) returning *`,
      [
        reviewId, f.ruleId, f.layer, f.severity,
        f.line ?? null, f.col ?? null, f.endLine ?? null, f.endCol ?? null,
        f.message, f.evidence ?? null, f.suggestion ?? null, f.confidence ?? null,
        f.exposure, f.exposure === "hidden" ? null : new Date(), f.inDiff ?? null,
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

/** 起票の対象。採用されたものだけを返す。未判断や却下は起票しない。 */
export async function acceptedFindings(findingIds) {
  const { rows } = await pool.query(
    `select f.id, f.rule_id, f.layer, f.severity, f.line, f.message, f.evidence, f.in_diff,
            v.corrected_text, r.source_kind, r.source_ref, d.title as document_title
     from findings f
     join current_verdicts v on v.finding_id = f.id and v.verdict = 'accepted'
     join reviews r   on r.id = f.review_id
     join documents d on d.id = r.document_id
     where f.id = any($1::bigint[])
     order by f.line nulls last, f.id`,
    [findingIds],
  );
  return rows;
}

export async function findIssue(owner, repo, marker) {
  const { rows } = await pool.query(
    `select * from github_issues where owner = $1 and repo = $2 and marker = $3`,
    [owner, repo, marker],
  );
  return rows[0] ?? null;
}

export async function recordIssue(owner, repo, { number, htmlUrl, title, marker, findingIds }) {
  const { rows } = await pool.query(
    `insert into github_issues (owner, repo, number, html_url, title, marker, finding_ids)
     values ($1,$2,$3,$4,$5,$6,$7)
     on conflict (owner, repo, marker) do nothing
     returning *`,
    [owner, repo, number, htmlUrl, title, marker, findingIds],
  );
  return rows[0] ?? (await findIssue(owner, repo, marker));
}

export async function issuesForReview(reviewId) {
  const { rows } = await pool.query(
    `select distinct i.* from github_issues i
     join findings f on f.id = any(i.finding_ids)
     where f.review_id = $1 order by i.created_at desc`,
    [reviewId],
  );
  return rows;
}

export async function ping() {
  await pool.query("select 1");
}

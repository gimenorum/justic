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

/**
 * 1レビューを1トランザクションで書く。
 * 途中で落ちると findings が半分だけ入った review が finished_at NULL で残り、
 * 集計から除外する処理に頼ることになる。
 */
export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const out = await fn(client);
    await client.query("commit");
    return out;
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

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

export async function createReview(documentId, { profile, layers, l3ModelId, promptVersion, classifierRun, sourceKind, sourceRef }, client = pool) {
  const { rows } = await client.query(
    `insert into reviews (document_id, profile, layers, l3_model_id, prompt_version, classifier_run, source_kind, source_ref)
     values ($1, $2, $3, $4, $5, $6, $7, $8) returning id, started_at`,
    [documentId, profile ?? "default", layers, l3ModelId ?? null, promptVersion ?? null, classifierRun ?? null,
     sourceKind ?? "paste", sourceRef ? JSON.stringify(sourceRef) : null],
  );
  return rows[0];
}

export async function insertFindings(reviewId, findings, client = pool) {
  if (findings.length === 0) return [];
  const out = [];
  for (const f of findings) {
    const { rows } = await client.query(
      `insert into findings
         (review_id, rule_id, layer, severity, line, col, end_line, end_col,
          message, evidence, suggestion, confidence, exposure, shown_at, in_diff, aspect_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) returning *`,
      [
        reviewId, f.ruleId, f.layer, f.severity,
        f.line ?? null, f.col ?? null, f.endLine ?? null, f.endCol ?? null,
        f.message, f.evidence ?? null, f.suggestion ?? null, f.confidence ?? null,
        f.exposure, f.exposure === "hidden" ? null : new Date(), f.inDiff ?? null,
        f.aspectId ?? null,
      ],
    );
    out.push(rows[0]);
  }
  return out;
}

/**
 * 観点ごとの実行記録。findings の有無と独立に残す。
 * 失敗した観点は findings 行を作らないので、これが無いと
 * 「走ったが指摘が無かった」と「走らせたが落ちた」を区別できない。
 */
export async function recordAspectRun(reviewId, r, client = pool) {
  await client.query(
    `insert into review_aspects
       (review_id, aspect_id, status, findings_n, model_id, prompt_version, error, started_at, finished_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     on conflict (review_id, aspect_id) do update
       set status = excluded.status, findings_n = excluded.findings_n,
           error = excluded.error, finished_at = excluded.finished_at`,
    [reviewId, r.aspectId, r.status, r.findingsN ?? 0, r.modelId ?? null,
     r.promptVersion ?? null, r.error ?? null, r.startedAt ?? null, r.finishedAt ?? null],
  );
}

export async function aspects() {
  const { rows } = await pool.query(
    `select * from aspects where retired_at is null order by id`);
  return rows;
}

export async function finishReview(reviewId, client = pool) {
  await client.query(`update reviews set finished_at = now() where id = $1`, [reviewId]);
}

export async function upsertUser({ githubId, login, name, avatarUrl }) {
  const { rows } = await pool.query(
    `insert into users (github_id, login, name, avatar_url)
     values ($1, $2, $3, $4)
     on conflict (github_id) do update
       set login = excluded.login, name = excluded.name,
           avatar_url = excluded.avatar_url, last_seen_at = now()
     returning id, github_id, login, name, avatar_url`,
    [githubId, login, name ?? null, avatarUrl ?? null],
  );
  return rows[0];
}

// 採否は追記のみ。押し直しても前の行は消さない。
export async function addVerdict(findingId, { verdict, correctedText, note, decidedBy, userId }) {
  const { rows } = await pool.query(
    `insert into verdicts (finding_id, verdict, corrected_text, note, decided_by, user_id)
     values ($1, $2, $3, $4, $5, $6) returning *`,
    [findingId, verdict, correctedText || null, note || null, decidedBy || "local", userId ?? null],
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
  // 走った観点。指摘0件の意味を読ませるために要る。
  // 再読み込みで消えないよう、POST の応答ではなくここから返す。
  const { rows: aspectRuns } = await pool.query(
    `select ra.*, a.title from review_aspects ra
     join aspects a on a.id = ra.aspect_id
     where ra.review_id = $1 order by ra.aspect_id`,
    [reviewId],
  );
  return { ...reviews[0], findings, aspectRuns };
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
       (select count(*) from current_verdicts where verdict='rejected') as rejected,
       -- 沈黙を可視化する。ゼロに近ければ未検知の記録が使われていない (設計書 4.4)
       (select count(*) from live_annotations) as annotations,
       (select count(distinct document_id) from annotation_completions
         where revoked_at is null) as completed_documents`,
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

/** 鍵をまとめて引く。押す前に「もう立っている」を出すために要る。 */
export async function findIssuesByMarkers(owner, repo, markers) {
  if (!markers.length) return new Map();
  const { rows } = await pool.query(
    `select marker, number, html_url from github_issues
     where owner = $1 and repo = $2 and marker = any($3::text[])`,
    [owner, repo, markers]);
  return new Map(rows.map((r) => [r.marker, r]));
}

export async function findIssue(owner, repo, marker) {
  const { rows } = await pool.query(
    `select * from github_issues where owner = $1 and repo = $2 and marker = $3`,
    [owner, repo, marker],
  );
  return rows[0] ?? null;
}

export async function recordIssue(owner, repo, { number, htmlUrl, title, marker, findingIds, annotationIds, userId }) {
  const { rows } = await pool.query(
    `insert into github_issues
       (owner, repo, number, html_url, title, marker, finding_ids, annotation_ids, user_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     on conflict (owner, repo, marker) do nothing
     returning *`,
    [owner, repo, number, htmlUrl, title, marker, findingIds ?? [], annotationIds ?? [], userId ?? null],
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

// ---- 未検知の記録 (docs/design-01-measurement.md) ----------------------

/** PAT モード用の擬似利用者。無いと一人運用で注釈がゼロになる (設計書 8.2)。 */
export async function ensureLocalUser() {
  const { rows } = await pool.query(
    `insert into users (github_id, login, name) values (0, 'local', 'ローカル')
     on conflict (github_id) do update set last_seen_at = now()
     returning id, login`);
  return rows[0];
}

export async function addAnnotation({ documentId, startLine, endLine, quotedText, aspectId, note, userId }) {
  return withTransaction(async (c) => {
    const { rows } = await c.query(
      `insert into human_annotations
         (document_id, start_line, end_line, quoted_text, aspect_id, note, user_id)
       values ($1,$2,$3,$4,$5,$6,$7) returning *`,
      [documentId, startLine, endLine, quotedText, aspectId || null, note || null, userId],
    );
    // 登録時に必ず created を入れる。入れる実装と入れない実装が混ざると
    // 「履歴が残る」が半分しか成立しない (設計書 6.3)。
    await c.query(
      `insert into human_annotation_events (annotation_id, action, user_id) values ($1,'created',$2)`,
      [rows[0].id, userId]);
    return rows[0];
  });
}

export async function annotationEvent(annotationId, action, userId, note) {
  const { rows } = await pool.query(
    `insert into human_annotation_events (annotation_id, action, user_id, note)
     values ($1,$2,$3,$4) returning *`,
    [annotationId, action, userId, note || null]);
  return rows[0];
}

export async function annotationOwner(annotationId) {
  const { rows } = await pool.query(
    `select user_id, document_id from human_annotations where id = $1`, [annotationId]);
  return rows[0] ?? null;
}

export async function setAnnotationAspect(annotationId, aspectId) {
  const { rows } = await pool.query(
    `update human_annotations set aspect_id = $2 where id = $1 returning *`,
    [annotationId, aspectId]);
  return rows[0] ?? null;
}

export async function listAnnotations(documentId) {
  const { rows } = await pool.query(
    `select a.id, a.document_id, a.start_line, a.end_line, a.quoted_text,
            a.aspect_id, a.note, a.created_at, u.login as author,
            (l.id is null) as retracted,
            i.html_url as issue_url, i.number as issue_number,
            d.title as document_title,
            -- 鍵の計算に要る。同じ文書の最後に走ったレビューの出どころ
            (select r.source_ref from reviews r
              where r.document_id = a.document_id and r.source_ref is not null
              order by r.started_at desc limit 1) as source_ref
     from human_annotations a
     join users u on u.id = a.user_id
     join documents d on d.id = a.document_id
     left join live_annotations l on l.id = a.id
     left join lateral (
       select gi.html_url, gi.number from github_issues gi
       where a.id = any(gi.annotation_ids) order by gi.created_at desc limit 1
     ) i on true
     where a.document_id = $1
     order by a.start_line, a.id`,
    [documentId]);
  return rows;
}

/**
 * 起票の対象になる注釈。取り消されたものは返さない。
 *
 * findings 用の acceptedFindings は verdicts を内部結合しているので使えない。
 * 注釈は採否を持たない (システムが出していないため)。
 */
export async function annotationsForIssue(annotationIds) {
  const { rows } = await pool.query(
    `select a.id, a.document_id, a.start_line, a.end_line, a.quoted_text,
            a.aspect_id, a.note, u.login as author,
            asp.title as aspect_title,
            d.title as document_title,
            -- 出どころ。同じ文書に複数のレビューがあるので、最後に走ったものを見る
            (select r.source_ref from reviews r
              where r.document_id = a.document_id and r.source_ref is not null
              order by r.started_at desc limit 1) as source_ref
     from live_annotations a
     join users u      on u.id = a.user_id
     join documents d  on d.id = a.document_id
     left join aspects asp on asp.id = a.aspect_id
     where a.id = any($1::bigint[])
     order by a.document_id, a.start_line, a.id`,
    [annotationIds],
  );
  return rows;
}

export async function addCompletion(documentId, aspectId, userId) {
  const { rows } = await pool.query(
    `insert into annotation_completions (document_id, aspect_id, user_id)
     values ($1,$2,$3)
     on conflict (document_id, aspect_id, user_id) do update set revoked_at = null
     returning *`,
    [documentId, aspectId, userId]);
  return rows[0];
}

export async function revokeCompletion(documentId, aspectId, userId) {
  const { rows } = await pool.query(
    `update annotation_completions set revoked_at = now()
     where document_id = $1 and aspect_id = $2 and user_id = $3 returning *`,
    [documentId, aspectId, userId]);
  return rows[0] ?? null;
}

export async function listCompletions(documentId) {
  const { rows } = await pool.query(
    `select c.aspect_id, c.completed_at, c.revoked_at, u.login as author
     from annotation_completions c join users u on u.id = c.user_id
     where c.document_id = $1 order by c.aspect_id`,
    [documentId]);
  return rows;
}

/** ゴールデンセットの進み具合。終わりが見えないと作業は始まらない (設計書 4.1)。 */
export async function goldenSet(aspectId = "D-01", target = 20) {
  const { rows } = await pool.query(
    `select d.id, d.title, d.sha256, d.created_at,
            count(distinct a.id) filter (where a.id is not null) as annotations,
            bool_or(c.id is not null and c.revoked_at is null)   as completed
     from documents d
     left join live_annotations a on a.document_id = d.id
     left join annotation_completions c on c.document_id = d.id and c.aspect_id = $1
     group by d.id
     order by completed asc, d.created_at desc
     limit 200`,
    [aspectId]);
  const done = rows.filter((r) => r.completed).length;
  return { aspectId, target, done, remaining: Math.max(0, target - done), documents: rows };
}

export async function ping() {
  await pool.query("select 1");
}

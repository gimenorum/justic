import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";

import * as db from "./db.js";
import * as gh from "./github.js";
import { lintMarkdown } from "./lint.js";
import { l3Enabled, runL3, ASPECTS } from "./llm.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT ?? 5180);

app.use(express.json({ limit: "8mb" }));
app.use(express.static(path.join(here, "public")));

const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
  console.error(e);
  res.status(500).json({ error: String(e.message ?? e) });
});

/**
 * 1文書を検査して保存する。
 *
 * addedLines を渡すと PR の差分として扱う。そのとき L1 の指摘は
 * 差分の行に載ったものだけを残す。もとからあった行まで出すと、
 * その PR が持ち込んでいない指摘で画面が埋まる。
 *
 * L3 は差分では判定できない。「異常系が書かれていない」は
 * 書かれていないことの指摘なので、全文を見る必要がある。
 * 差分の外に出たものは in_diff=false を付けて残す。
 */
async function reviewOne(bodyText, { title, useL3, sourceKind = "paste", sourceRef = null, addedLines = null }) {
  const doc = await db.upsertDocument(title, bodyText);
  const wantL3 = Boolean(useL3) && l3Enabled();
  const layers = ["L1", ...(wantL3 ? ["L3"] : [])];

  let l1 = await lintMarkdown(bodyText);
  let l1OutsideDiff = 0;
  if (addedLines) {
    const before = l1.length;
    l1 = l1.filter((f) => f.line != null && addedLines.has(f.line));
    l1OutsideDiff = before - l1.length;
    for (const f of l1) f.inDiff = true;
  }

  let l3 = null;
  const findings = [...l1];
  if (wantL3) {
    l3 = await runL3(bodyText);
    for (const f of l3.findings) {
      f.inDiff = addedLines ? (f.line != null && addedLines.has(f.line)) : null;
    }
    findings.push(...l3.findings);
  }

  const review = await db.createReview(doc.id, { layers, l3ModelId: l3?.model ?? null, sourceKind, sourceRef });
  const stored = await db.insertFindings(review.id, findings);
  await db.finishReview(review.id);

  return {
    reviewId: review.id,
    documentSha256: doc.sha256,
    title,
    layers,
    notChecked: wantL3 ? [] : ["L3 (設計内容)"],
    droppedByEvidenceCheck: l3?.dropped ?? 0,
    l1OutsideDiff,
    l3Errors: l3?.errors ?? [],
    findings: stored,
  };
}

app.get("/api/health", wrap(async (_req, res) => {
  await db.ping();
  res.json({
    db: "ok",
    l3: l3Enabled(),
    github: { token: gh.hasToken() },
    aspects: ASPECTS.map((a) => ({ id: a.id, title: a.title })),
  });
}));

app.get("/api/stats", wrap(async (_req, res) => res.json(await db.stats())));
app.get("/api/reviews", wrap(async (_req, res) => res.json(await db.recentReviews())));

app.get("/api/reviews/:id", wrap(async (req, res) => {
  const review = await db.getReview(Number(req.params.id));
  if (!review) return res.status(404).json({ error: "not found" });
  res.json({ ...review, issues: await db.issuesForReview(review.id) });
}));

app.post("/api/reviews", wrap(async (req, res) => {
  const body = String(req.body?.body ?? "").trim();
  if (!body) return res.status(400).json({ error: "本文が空です" });
  const title = req.body?.title ? String(req.body.title).slice(0, 200) : null;
  res.json(await reviewOne(body, { title, useL3: req.body?.useL3 }));
}));

// PR の差分をレビューする。
app.post("/api/reviews/github/pr", wrap(async (req, res) => {
  const ref = gh.parsePullRef(req.body?.ref);
  if (!ref) return res.status(400).json({ error: "PR の URL か owner/repo#番号 を渡す" });

  const pr = await gh.getPull(ref.owner, ref.repo, ref.number);
  const files = await gh.getMarkdownFiles(ref.owner, ref.repo, ref.number, { headSha: pr.headSha });
  if (files.length === 0) {
    return res.json({ kind: "pr", pr, reviews: [], note: "この PR は Markdown を変更していない" });
  }

  const reviews = [];
  for (const f of files) {
    reviews.push(await reviewOne(f.body, {
      title: `${ref.owner}/${ref.repo}#${ref.number} ${f.path}`,
      useL3: req.body?.useL3,
      sourceKind: "github_pr",
      sourceRef: { ...ref, head_sha: pr.headSha, path: f.path, html_url: pr.htmlUrl },
      addedLines: f.addedLines,
    }));
  }
  res.json({ kind: "pr", pr: { ...pr, ...ref }, reviews });
}));

// デフォルトブランチを走査する。差分ではないので全文が対象。
app.post("/api/reviews/github/branch", wrap(async (req, res) => {
  const ref = gh.parseRepoRef(req.body?.ref);
  if (!ref) return res.status(400).json({ error: "リポジトリの URL か owner/repo を渡す" });

  const repo = await gh.getRepo(ref.owner, ref.repo);
  const branch = req.body?.branch || repo.defaultBranch;
  const { paths, total, truncated } = await gh.listMarkdown(ref.owner, ref.repo, branch, {
    maxFiles: Math.min(Number(req.body?.maxFiles ?? 10), 50),
    prefix: req.body?.prefix ?? "",
  });
  if (paths.length === 0) return res.json({ kind: "branch", repo: { ...ref, branch }, reviews: [], note: "Markdown が無い" });

  const reviews = [];
  for (const p of paths) {
    const body = await gh.getFile(ref.owner, ref.repo, p, branch);
    reviews.push(await reviewOne(body, {
      title: `${ref.owner}/${ref.repo}:${branch} ${p}`,
      useL3: req.body?.useL3,
      sourceKind: "github_pr",
      sourceRef: { ...ref, ref: branch, path: p, html_url: `${repo.htmlUrl}/blob/${branch}/${p}` },
    }));
  }
  res.json({
    kind: "branch",
    repo: { ...ref, branch, hasIssues: repo.hasIssues },
    scanned: paths.length, total, truncated,
    reviews,
  });
}));

app.post("/api/findings/:id/verdict", wrap(async (req, res) => {
  const verdict = req.body?.verdict;
  if (verdict !== "accepted" && verdict !== "rejected") {
    return res.status(400).json({ error: "verdict は accepted か rejected" });
  }
  const row = await db.addVerdict(Number(req.params.id), {
    verdict,
    correctedText: req.body?.correctedText,
    note: req.body?.note,
    decidedBy: req.body?.decidedBy ?? "local",
  });
  res.json(row);
}));

// 採用された指摘から issue を立てる。
// 未判断のものからは立てない。LLM の出力をそのまま起票すると repo が荒れる。
app.post("/api/issues", wrap(async (req, res) => {
  if (!gh.hasToken()) return res.status(400).json({ error: "起票には JUSTIC_GITHUB_TOKEN が要る (issues: write)" });
  const target = gh.parseRepoRef(req.body?.repo);
  if (!target) return res.status(400).json({ error: "repo は owner/repo で渡す" });
  const ids = (req.body?.findingIds ?? []).map(Number).filter(Number.isFinite);
  if (ids.length === 0) return res.status(400).json({ error: "findingIds が空" });

  const rows = await db.acceptedFindings(ids);
  if (rows.length === 0) {
    return res.status(400).json({ error: "採用された指摘がない。先に採用を押す" });
  }

  const first = rows[0];
  const srcPath = first.source_ref?.path ?? first.document_title ?? "文書";
  const marker = gh.issueMarker({
    owner: target.owner, repo: target.repo, path: srcPath,
    ruleId: rows.length === 1 ? first.rule_id : "batch",
    evidence: rows.map((r) => r.evidence ?? r.message).join("\n"),
  });

  const existing = await db.findIssue(target.owner, target.repo, marker);
  if (existing) return res.json({ issue: existing, deduped: true });

  const title = rows.length === 1
    ? `[${first.layer}] ${srcPath}: ${first.message.split("\n")[0].slice(0, 80)}`
    : `[レビュー] ${srcPath}: ${rows.length}件の指摘`;

  const lines = [`\`${srcPath}\` のレビューで採用された指摘。`, ""];
  for (const r of rows) {
    lines.push(`### ${r.line ? `L${r.line} ` : ""}${r.rule_id}`, "");
    lines.push(r.message, "");
    if (r.evidence) lines.push("> " + r.evidence.replace(/\n/g, "\n> "), "");
    if (r.corrected_text) lines.push(`修正案: ${r.corrected_text}`, "");
  }
  if (first.source_ref?.html_url) lines.push(`出典: ${first.source_ref.html_url}`, "");
  lines.push(`<!-- ${gh.MARKER_PREFIX}${marker} -->`);

  const created = await gh.createIssue(target.owner, target.repo, {
    title, body: lines.join("\n"), labels: req.body?.labels ?? [],
  });
  const saved = await db.recordIssue(target.owner, target.repo, {
    ...created, marker, findingIds: rows.map((r) => Number(r.id)),
  });
  res.json({ issue: saved, deduped: false, from: rows.length });
}));

app.listen(PORT, "127.0.0.1", () => {
  console.log(`justic  http://127.0.0.1:${PORT}`);
  console.log(`L3: ${l3Enabled() ? "有効" : "無効 (JUSTIC_L3=1)"}   GitHub token: ${gh.hasToken() ? "あり" : "なし"}`);
});

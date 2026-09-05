import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";

import * as db from "./db.js";
import { lintMarkdown } from "./lint.js";
import { l3Enabled, runL3, ASPECTS } from "./llm.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT ?? 5180);

app.use(express.json({ limit: "4mb" }));
app.use(express.static(path.join(here, "public")));

const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
  console.error(e);
  res.status(500).json({ error: String(e.message ?? e) });
});

app.get("/api/health", wrap(async (_req, res) => {
  await db.ping();
  res.json({ db: "ok", l3: l3Enabled(), aspects: ASPECTS.map((a) => ({ id: a.id, title: a.title })) });
}));

app.get("/api/stats", wrap(async (_req, res) => res.json(await db.stats())));

app.get("/api/reviews", wrap(async (_req, res) => res.json(await db.recentReviews())));

app.post("/api/reviews", wrap(async (req, res) => {
  const body = String(req.body?.body ?? "").trim();
  if (!body) return res.status(400).json({ error: "本文が空です" });
  const title = req.body?.title ? String(req.body.title).slice(0, 200) : null;
  const wantL3 = Boolean(req.body?.useL3) && l3Enabled();

  const doc = await db.upsertDocument(title, body);
  const layers = ["L1", ...(wantL3 ? ["L3"] : [])];

  const findings = await lintMarkdown(body);
  let l3 = null;
  if (wantL3) {
    l3 = await runL3(body);
    findings.push(...l3.findings);
  }

  const review = await db.createReview(doc.id, { layers, l3ModelId: l3?.model ?? null });
  const stored = await db.insertFindings(review.id, findings);
  await db.finishReview(review.id);

  res.json({
    reviewId: review.id,
    documentSha256: doc.sha256,
    layers,
    // どこまで検査したかを返す (要件 API-09)。L1 だけ通った状態を「レビュー済み」と読ませない。
    notChecked: wantL3 ? [] : ["L3 (設計内容)"],
    droppedByEvidenceCheck: l3?.dropped ?? 0,
    l3Errors: l3?.errors ?? [],
    findings: stored,
  });
}));

app.get("/api/reviews/:id", wrap(async (req, res) => {
  const review = await db.getReview(Number(req.params.id));
  if (!review) return res.status(404).json({ error: "not found" });
  res.json(review);
}));

// 採否。押されたものだけが記録される。閉じただけのものは学習データに入らない。
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

app.listen(PORT, "127.0.0.1", () => {
  console.log(`justic  http://127.0.0.1:${PORT}`);
  console.log(`L3 (設計内容の観点パス): ${l3Enabled() ? "有効" : "無効 (JUSTIC_L3=1 で有効)"}`);
});

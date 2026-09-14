// web/mcp.js — MCP (Model Context Protocol) の入口。docs/design-06-mcp.md。
//
// justic のプロセスが Streamable HTTP で /mcp を受ける。別プロセスは作らない (3.2)。
// セッションは持たない。要求ごとに McpServer を作って捨てる (3.2、8.3)。
//
// ツールは HTTP の経路と同じ関数 (server.js から渡される api) を呼ぶ (4.1)。
// justic に溜まった文書の本文は返さない (5.2)。L3 は endpoint を名前で指定した
// ときだけ走り、外部 (external:true) の接続先は拒む (5.3)。

import fsp from "node:fs/promises";
import path from "node:path";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import * as z from "zod/v4";

import * as gh from "./github.js";
import * as endpoints from "./endpoints.js";

// 8 MiB (8388608 バイト)。express.json({limit:"8mb"}) の上限と揃える (5.1)。
const MAX_PATH_BYTES = 8 * 1024 * 1024;

const READ_ONLY = { readOnlyHint: true };
// 追記だけで消さない (05 と同じ考え方)。「壊す」操作はここには無い
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false };

function ok(json) {
  return { content: [{ type: "text", text: JSON.stringify(json) }], structuredContent: json };
}

function fail(message) {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** run* の {status, json} を MCP の結果に変える (4.1)。transform は成功時だけ効く。 */
function fromRun(r, transform = (j) => j) {
  return r.status === 200 ? ok(transform(r.json)) : fail(r.json.error);
}

/** review_pull_request / review_branch の応答から findings を落として件数だけ残す (4.4)。 */
function dropFindings(json) {
  return {
    ...json,
    reviews: (json.reviews ?? []).map(({ findings, ...rest }) => ({
      ...rest, findingCount: findings?.length ?? 0,
    })),
  };
}

/**
 * useL3 のときだけ効く追加の規則 (5.3)。問題が無ければ null を返す。
 *
 * - endpoint が無い → 拒む。05 の parseEndpoint の既定 (defaultName) には落とさない
 * - endpoint が external:true の接続先 → 拒む。文言に外部でない名前を並べる
 * - endpoint が設定に無い名前 → ここでは判定しない。run* に渡し、HTTP と同じ
 *   400 の文言 (「接続先 '...' は無い。選べるのは: ...」) を isError にする
 */
function checkL3Rule(useL3, endpointName) {
  if (!useL3) return null;
  const nonExternalNames = () => {
    const names = endpoints.list().filter((e) => !e.external).map((e) => e.name);
    return names.join(", ") || "(設定なし)";
  };
  if (endpointName === undefined || endpointName === null || endpointName === "") {
    return `useL3 のときは endpoint を名前で指定する。選べるのは: ${nonExternalNames()}`;
  }
  const ep = endpoints.get(String(endpointName));
  if (ep && ep.external) {
    return `外部の接続先 '${endpointName}' は画面から選ぶ。MCP からは ${nonExternalNames()} を選べる`;
  }
  return null;
}

/**
 * MCP ハンドラを組み立てる。api は server.js から渡す、
 * HTTP の経路と共有する関数と db の束 (4.1)。
 */
export function mcpHandler(api) {
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: "justic", version: "0.1.0" });

    server.registerTool("health", {
      title: "健康状態",
      description: "DB・L3・接続先・GitHub トークンの有無を返す。セッションの項目 (me、github.viaLogin) は無い。",
      annotations: READ_ONLY,
    }, async () => {
      const r = await api.buildHealth(null);
      const { me, github, ...rest } = r.json;
      const { viaLogin, ...githubRest } = github;
      return ok({ ...rest, github: githubRest });
    });

    server.registerTool("stats", {
      title: "全体の集計",
      description: "文書・レビュー・指摘・採否・注釈の件数。",
      annotations: READ_ONLY,
    }, async () => ok(await api.db.stats()));

    server.registerTool("list_reviews", {
      title: "レビューの一覧",
      description: "最近のレビューを新しい順に返す。本文は含まない。",
      inputSchema: z.object({
        limit: z.number().int().min(1).max(100).default(20).describe("件数 (1〜100、既定 20)"),
      }),
      annotations: READ_ONLY,
    }, async ({ limit }) => ok(await api.db.recentReviews(limit)));

    server.registerTool("get_review", {
      title: "レビューを 1 件取る",
      description: "指摘 (findings) と紐づく issue を返す。文書の本文 (body) は返さない。指摘の evidence (該当行、300文字まで) は返す。",
      inputSchema: z.object({
        // reviews.id は bigint (bigserial)。pg はこれを JS の数値でなく文字列で返すので
        // (Number.MAX_SAFE_INTEGER を超える値の精度落ちを避けるため)、review_document /
        // list_reviews が返す reviewId も文字列になる。呼び出し側がそれをそのまま
        // 渡し直せるよう、数値と数字文字列の両方を受ける。
        reviewId: z.coerce.number().int().positive().describe("レビューの id"),
      }),
      annotations: READ_ONLY,
    }, async ({ reviewId }) => {
      const review = await api.db.getReview(reviewId);
      if (!review) return fail("not found");
      const { body, ...rest } = review;
      const issues = await api.db.issuesForReview(review.id);
      return ok({ ...rest, issues });
    });

    server.registerTool("review_document", {
      title: "文書をレビューする",
      description: "貼り付け経路 (POST /api/reviews) と同じ検査をする。body の代わりに path でも受け、その場合はレビューの本文をこのツール呼び出しの引数として書き出さずに済む。",
      inputSchema: z.object({
        title: z.string().max(200).optional().describe("見出し。省略時は path のときファイル名、body のときは無し (null)"),
        body: z.string().optional().describe("文書の本文。path と排他 (どちらか一方だけ)"),
        path: z.string().optional().describe("絶対パス。justic のプロセスがそのファイルを読む。body と排他 (どちらか一方だけ)。8 MiB まで、UTF-8"),
        origin: z.enum(["model", "human"]).optional().describe("文書の出自。既定 model"),
        useL3: z.boolean().default(false).describe("設計内容の検査 (L3) も走らせるか。既定 false (L1 だけ)"),
        endpoint: z.string().optional().describe("useL3 のとき必須。名前で指定する。外部 (external:true) の接続先は選べない"),
      }),
      annotations: WRITE,
    }, async (args) => {
      const hasBody = args.body !== undefined;
      const hasPath = args.path !== undefined;
      if (hasBody === hasPath) {
        return fail("body か path のどちらか一方だけを渡す");
      }

      let text;
      let title = args.title ?? null;
      if (hasPath) {
        const p = args.path;
        if (!path.isAbsolute(p)) return fail(`path は絶対パスに限る: ${p}`);
        let stat;
        try {
          stat = await fsp.stat(p);
        } catch {
          return fail(`path が存在しない: ${p}`);
        }
        if (!stat.isFile()) return fail(`path は通常ファイルでない: ${p}`);
        if (stat.size > MAX_PATH_BYTES) return fail(`path が大きすぎる (8 MiB まで): ${p}`);
        text = await fsp.readFile(p, "utf8");
        if (title === null) title = path.basename(p);
      } else {
        text = args.body;
      }

      const problem = checkL3Rule(args.useL3, args.endpoint);
      if (problem) return fail(problem);

      const r = await api.runPasteReview(
        { title, body: text, origin: args.origin, useL3: args.useL3, endpoint: args.endpoint },
        { token: gh.envToken() },
      );
      return fromRun(r);
    });

    server.registerTool("review_pull_request", {
      title: "PR をレビューする",
      description: "GitHub の PR が変更した Markdown をすべて検査する (POST /api/reviews/github/pr と同じ)。応答はファイルごとの findings を落とし、件数 (findingCount) だけを返す。指摘の本体は get_review に reviewId を渡して取る (25,000 トークンの応答上限に当たらないため)。",
      inputSchema: z.object({
        ref: z.string().describe("PR の URL か owner/repo#番号"),
        origin: z.enum(["model", "human"]).optional().describe("文書の出自。既定 model"),
        useL3: z.boolean().default(false).describe("設計内容の検査 (L3) も走らせるか。既定 false"),
        endpoint: z.string().optional().describe("useL3 のとき必須。名前で指定する。外部の接続先は選べない"),
      }),
      annotations: WRITE,
    }, async (args) => {
      const problem = checkL3Rule(args.useL3, args.endpoint);
      if (problem) return fail(problem);
      const r = await api.runPullRequestReview(args, { token: gh.envToken() });
      return fromRun(r, dropFindings);
    });

    server.registerTool("review_branch", {
      title: "ブランチをレビューする",
      description: "リポジトリ (省略時は既定ブランチ) の Markdown を検査する (POST /api/reviews/github/branch と同じ)。応答はファイルごとの findings を落とし、件数 (findingCount) だけを返す。指摘の本体は get_review に reviewId を渡して取る。",
      inputSchema: z.object({
        ref: z.string().describe("リポジトリの URL か owner/repo"),
        branch: z.string().optional().describe("省略時は既定ブランチ"),
        prefix: z.string().optional().describe("このパスで始まるファイルだけ検査する"),
        maxFiles: z.number().int().min(1).max(50).default(10).describe("最大ファイル数 (1〜50、既定 10)"),
        origin: z.enum(["model", "human"]).optional().describe("文書の出自。既定 model"),
        useL3: z.boolean().default(false).describe("設計内容の検査 (L3) も走らせるか。既定 false"),
        endpoint: z.string().optional().describe("useL3 のとき必須。名前で指定する。外部の接続先は選べない"),
      }),
      annotations: WRITE,
    }, async (args) => {
      const problem = checkL3Rule(args.useL3, args.endpoint);
      if (problem) return fail(problem);
      const r = await api.runBranchReview(args, { token: gh.envToken() });
      return fromRun(r, dropFindings);
    });

    server.registerTool("set_verdict", {
      title: "指摘の採否を押す",
      description: "採用 (accepted) か却下 (rejected) を記録する (POST /api/findings/:id/verdict と同じ)。decided_by は 'mcp' で記録される (6.2)。",
      inputSchema: z.object({
        // findings.id も bigint。get_review の findings[].id は文字列で返るので
        // reviewId と同じ理由で数値・数字文字列の両方を受ける
        findingId: z.coerce.number().int().positive().describe("指摘の id"),
        verdict: z.enum(["accepted", "rejected"]),
        note: z.string().optional(),
        correctedText: z.string().optional(),
      }),
      annotations: WRITE,
    }, async ({ findingId, verdict, note, correctedText }) => {
      const r = await api.runVerdict(
        findingId, { verdict, note, correctedText }, { decidedBy: "mcp", userId: null },
      );
      return fromRun(r);
    });

    return server;
  });

  return toNodeHandler(handler);
}

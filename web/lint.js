// L1: textlint。決定的に取れるものだけを見る。
//
// dict5 / dict6 の allows を空にしてあるので (.textlintrc.json)、
// 「バリデーションを行う」のようなカタカナのサ変名詞も検出する。既定では通ってしまう。

import { fileURLToPath } from "node:url";
import path from "node:path";
import { createLinter, loadTextlintrc } from "textlint";

const here = path.dirname(fileURLToPath(import.meta.url));
const configFilePath = path.join(here, ".textlintrc.json");

let linterPromise = null;

// プロファイルの切り替えは configFilePath の差し替えで行う (要件 L1-06)。
function getLinter(configPath = configFilePath) {
  if (!linterPromise) {
    linterPromise = loadTextlintrc({ configFilePath: configPath }).then((descriptor) =>
      createLinter({ descriptor }),
    );
  }
  return linterPromise;
}

// textlint の severity: 1=warning, 2=error, 3=info
const SEVERITY = { 1: "warn", 2: "error", 3: "info" };

export async function lintMarkdown(text, { configPath } = {}) {
  const linter = await getLinter(configPath);
  const result = await linter.lintText(text, "document.md");
  const lines = text.split("\n");

  return (result.messages ?? []).map((m) => {
    const ruleId = m.ruleId ?? "unknown";
    return {
      ruleId: `style/${ruleId}`,
      layer: "L1",
      // ここで出るのは全部が文体の指摘なので blocking しない (要件9章)。
      // error で止めてよいのは L1-04 の構造チェックと L2 だけ。
      severity: SEVERITY[m.severity] === "info" ? "info" : "warn",
      line: m.loc?.start?.line ?? m.line ?? null,
      col: m.loc?.start?.column ?? m.column ?? null,
      endLine: m.loc?.end?.line ?? null,
      endCol: m.loc?.end?.column ?? null,
      message: m.message,
      evidence: lines[(m.loc?.start?.line ?? m.line ?? 1) - 1]?.trim()?.slice(0, 300) ?? null,
      suggestion: null,
      confidence: null,
      // 決定的な層なので常に出す。抽選の対象にしない。
      exposure: "ranked",
    };
  });
}

export async function lintAvailable() {
  try {
    await getLinter();
    return true;
  } catch {
    return false;
  }
}

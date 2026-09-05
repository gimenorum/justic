const $ = (id) => document.getElementById(id);
const api = async (path, opts) => {
  const res = await fetch(path, opts);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? res.statusText);
  return json;
};

const SAMPLE = `# 決済API 設計書

## 概要

決済処理を行うAPIを提供する。クライアントからのリクエストを受け取り、
外部の決済ゲートウェイに転送することが可能です。

httpリクエストのJSONに不備があると、プロセスは黙って壊れる。

## 非機能

このシステムは革命的なアーキテクチャを採用しており、非常に高速に動作します。
`;

let mode = "paste";
let state = { reviews: [], issueRepo: null, health: {} };

// ---- 表示 -------------------------------------------------------------

function allFindings() {
  return state.reviews.flatMap((r) => r.findings);
}

function renderCounts() {
  const all = allFindings();
  const acc = all.filter((f) => f.verdict === "accepted").length;
  const rej = all.filter((f) => f.verdict === "rejected").length;
  $("counts").textContent = all.length
    ? `${all.length}件  採用 ${acc} / 却下 ${rej} / 未判断 ${all.length - acc - rej}`
    : "";
}

function findingCard(f, review) {
  const el = document.createElement("div");
  el.className = "card" + (f.verdict ? ` done-${f.verdict}` : "");
  const ruleId = f.rule_id ?? f.ruleId ?? "";
  const inDiff = f.in_diff;

  el.innerHTML = `
    <div class="meta">
      <span class="badge ${f.severity}">${f.severity}</span>
      <span class="layer">${f.layer}</span>
      <span>${f.line ? "L" + f.line : ""}</span>
      ${inDiff === false ? '<span class="outdiff">差分の外</span>' : ""}
      <span class="rule">${ruleId}</span>
    </div>
    <p class="msg"></p>
    ${f.evidence ? '<div class="evidence"></div>' : ""}
  `;
  el.querySelector(".msg").textContent = f.message;
  if (f.evidence) el.querySelector(".evidence").textContent = f.evidence;

  if (f.verdict) {
    const v = document.createElement("div");
    v.className = "verdict";
    v.textContent = `${f.verdict === "accepted" ? "採用" : "却下"}済み。押し直すと訂正として追記される。`;
    el.appendChild(v);
  }

  const row = document.createElement("div");
  row.className = "row";
  const fix = document.createElement("input");
  fix.placeholder = "修正後の文 (採用時、任意)";
  fix.value = f.corrected_text ?? "";
  const accept = Object.assign(document.createElement("button"), { textContent: "採用" });
  const reject = Object.assign(document.createElement("button"), { textContent: "却下", className: "ghost" });

  const send = async (verdict) => {
    accept.disabled = reject.disabled = true;
    try {
      await api(`/api/findings/${f.id}/verdict`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ verdict, correctedText: verdict === "accepted" ? fix.value : null }),
      });
      f.verdict = verdict;
      f.corrected_text = verdict === "accepted" ? fix.value : null;
      render();
      refreshStats();
    } catch (e) {
      alert(`保存できなかった: ${e.message}`);
      accept.disabled = reject.disabled = false;
    }
  };
  accept.onclick = () => send("accepted");
  reject.onclick = () => send("rejected");
  row.append(fix, accept, reject);

  if (f.verdict === "accepted" && state.health.github?.token) {
    const issue = Object.assign(document.createElement("button"), { textContent: "issue にする", className: "ghost" });
    issue.onclick = () => createIssue([f.id], issue, review);
    row.appendChild(issue);
  }
  el.appendChild(row);
  return el;
}

function reviewBlock(r) {
  const wrap = document.createElement("div");
  wrap.className = "review";

  const head = document.createElement("div");
  head.className = "review-head";
  const accepted = r.findings.filter((f) => f.verdict === "accepted");
  head.innerHTML = `<span class="rtitle"></span><span class="rmeta">${r.findings.length}件</span>`;
  head.querySelector(".rtitle").textContent = r.title ?? `review ${r.reviewId}`;

  if (accepted.length > 0 && state.health.github?.token) {
    const bulk = Object.assign(document.createElement("button"), {
      textContent: `採用${accepted.length}件を issue に`, className: "ghost small",
    });
    bulk.onclick = () => createIssue(accepted.map((f) => f.id), bulk, r);
    head.appendChild(bulk);
  }
  wrap.appendChild(head);

  if (r.issueUrl) {
    const a = document.createElement("a");
    a.href = r.issueUrl; a.target = "_blank"; a.className = "issue-link";
    a.textContent = `起票済み → ${r.issueUrl.split("/").pop()}`;
    wrap.appendChild(a);
  }

  if (r.findings.length === 0) {
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent = "指摘なし。";
    wrap.appendChild(p);
  } else {
    for (const f of r.findings) wrap.appendChild(findingCard(f, r));
  }
  return wrap;
}

function render() {
  const box = $("results");
  box.innerHTML = "";
  if (state.reviews.length === 0) {
    box.innerHTML = '<p class="empty">左で対象を選んで「検査する」を押す。</p>';
  } else {
    for (const r of state.reviews) box.appendChild(reviewBlock(r));
  }
  renderCounts();
}

async function createIssue(findingIds, button, review) {
  const repo = ($("issueRepo").value || state.issueRepo || "").trim();
  if (!repo) { alert("起票先の owner/repo を入れる"); $("issueRepo").focus(); return; }
  button.disabled = true;
  const label = button.textContent;
  button.textContent = "起票中…";
  try {
    const r = await api("/api/issues", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo, findingIds }),
    });
    review.issueUrl = r.issue.html_url;
    render();
    if (r.deduped) alert("同じ指摘の issue が既にある。新しくは立てなかった。");
  } catch (e) {
    alert(`起票できなかった: ${e.message}`);
    button.disabled = false;
    button.textContent = label;
  }
}

// ---- 入力 -------------------------------------------------------------

for (const tab of document.querySelectorAll(".tab")) {
  tab.onclick = () => {
    mode = tab.dataset.mode;
    for (const t of document.querySelectorAll(".tab")) t.classList.toggle("on", t === tab);
    for (const m of document.querySelectorAll(".mode")) m.hidden = m.dataset.mode !== mode;
    $("issuePanel").hidden = mode === "paste";
  };
}

$("sample").onclick = () => { $("title").value = "決済API 設計書"; $("body").value = SAMPLE; };

const ENDPOINTS = {
  paste: () => ({ url: "/api/reviews", body: { title: $("title").value, body: $("body").value.trim() } }),
  pr: () => ({ url: "/api/reviews/github/pr", body: { ref: $("prRef").value.trim() } }),
  branch: () => ({
    url: "/api/reviews/github/branch",
    body: { ref: $("repoRef").value.trim(), prefix: $("prefix").value.trim(), maxFiles: Number($("maxFiles").value) },
  }),
};

$("run").onclick = async () => {
  const { url, body } = ENDPOINTS[mode]();
  if (!body.body && !body.ref) { $("runState").textContent = "対象が空"; return; }
  body.useL3 = $("useL3").checked;

  $("run").disabled = true;
  $("runState").textContent = "検査中…";
  $("notice").hidden = true;
  try {
    const r = await api(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const reviews = r.reviews ?? [r];
    state.reviews = reviews;

    // 起票先の既定を、いま見ているリポジトリに合わせる。
    const src = r.pr ?? r.repo;
    if (src?.owner) {
      state.issueRepo = `${src.owner}/${src.repo}`;
      if (!$("issueRepo").value) $("issueRepo").value = state.issueRepo;
    }

    const notes = [];
    const notChecked = reviews.some((x) => x.notChecked?.length);
    if (notChecked) notes.push("未検査: L3 (設計内容)。文体が通っても設計の妥当性は見ていない。");
    const outside = reviews.reduce((n, x) => n + (x.l1OutsideDiff ?? 0), 0);
    if (outside) notes.push(`差分の外にある文体指摘 ${outside}件は出していない (この PR が持ち込んだものではない)。`);
    const dropped = reviews.reduce((n, x) => n + (x.droppedByEvidenceCheck ?? 0), 0);
    if (dropped) notes.push(`引用が原文に無い指摘を ${dropped}件破棄した。`);
    if (r.truncated) notes.push("リポジトリが大きく、一覧が途中で切れている。prefix で絞る。");
    if (r.note) notes.push(r.note);
    const errs = reviews.flatMap((x) => x.l3Errors ?? []);
    if (errs.length) notes.push(`L3 でエラー: ${errs.join(" / ")}`);
    $("notice").hidden = notes.length === 0;
    $("notice").textContent = notes.join("  ");

    $("runState").textContent = r.kind === "branch"
      ? `${r.repo.branch} を走査。${r.scanned}/${r.total} ファイル`
      : r.kind === "pr" ? `PR #${r.pr.number} ${reviews.length}ファイル` : `検査した層: ${reviews[0]?.layers?.join(" + ") ?? ""}`;
    render();
    refreshStats();
  } catch (e) {
    $("runState").textContent = `失敗: ${e.message}`;
  } finally {
    $("run").disabled = false;
  }
};

async function refreshStats() {
  try {
    const s = await api("/api/stats");
    $("stats").innerHTML = [
      ["文書", s.documents], ["レビュー", s.reviews], ["提示した指摘", s.shown],
      ["採用", s.accepted], ["却下", s.rejected],
    ].map(([k, v]) => `${k} <b>${v}</b>`).join("");
  } catch { /* 統計が出ないだけ */ }
}

function renderAccount(h) {
  const box = $("account");
  box.innerHTML = "";
  if (h.me) {
    const who = document.createElement("span");
    who.className = "who";
    who.textContent = `@${h.me.login}`;
    const out = Object.assign(document.createElement("button"), { textContent: "ログアウト", className: "ghost small" });
    out.onclick = async () => { await fetch("/auth/logout", { method: "POST" }); location.reload(); };
    box.append(who, out);
    return;
  }
  if (h.github.oauth) {
    const a = document.createElement("a");
    a.href = "/auth/login";
    a.className = "login";
    a.textContent = "GitHub でログイン";
    box.appendChild(a);
    if (h.github.token) {
      const note = document.createElement("span");
      note.className = "who";
      note.textContent = ".env の PAT で動作中";
      box.appendChild(note);
    }
  } else {
    const note = document.createElement("span");
    note.className = "who";
    note.textContent = h.github.token ? ".env の PAT で動作中 (一人用)" : "GitHub 未接続";
    box.appendChild(note);
  }
}

(async () => {
  try {
    state.health = await api("/api/health");
    const h = state.health;
    renderAccount(h);
    $("health").textContent =
      `DB ${h.db} / L3 ${h.l3 ? "有効" : "無効"} / GitHub ${h.github.viaLogin ? "ログイン中" : h.github.token ? ".env の PAT" : "未接続"} / 観点 ${h.aspects.map((a) => a.id).join(", ")}`;
    $("useL3").disabled = !h.l3;
    if (!h.l3) $("useL3").parentElement.title = "JUSTIC_L3=1 で有効になる";
    if (!h.github.token) $("issueRepo").placeholder = "GitHub にログインすると起票できる";
  } catch (e) {
    $("health").textContent = `接続できない: ${e.message}`;
  }
  refreshStats();
})();

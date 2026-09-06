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
      await refreshIssued();
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
    const known = state.issuedFindings?.[f.id];
    if (known && known.state !== "closed") {
      // 押す前に分かるようにする。押してから「もうある」と言われない
      const link = document.createElement("a");
      link.href = known.htmlUrl; link.target = "_blank"; link.className = "issue-link";
      link.textContent = `起票済み #${known.number}`;
      row.appendChild(link);
    } else {
      if (known) {
        // 閉じている = 一度直された。再発として立て直せる
        const link = document.createElement("a");
        link.href = known.htmlUrl; link.target = "_blank"; link.className = "issue-link";
        link.textContent = `#${known.number} は解決済み`;
        row.appendChild(link);
      }
      const issue = Object.assign(document.createElement("button"), {
        textContent: known ? "再発として起票" : "issue にする", className: "ghost",
      });
      issue.onclick = () => createIssue([f.id], issue, review);
      row.appendChild(issue);
    }
  }
  el.appendChild(row);
  return el;
}

// ---- 本文の表示と注釈 --------------------------------------------------
//
// 見落としの登録は、システムの指摘を判断している最中に、同じ画面で取る。
// 別画面に移らせるとそこで止まる (docs/design-01-measurement.md の 4.3)。

async function annotationPanel(reviewId) {
  const panel = document.createElement("div");
  panel.className = "annot-panel";
  panel.innerHTML = '<div class="annot-head"><span class="grow">読み込み中…</span></div>';

  const full = await api(`/api/reviews/${reviewId}`);
  const docId = full.document_id;
  let data = await api(`/api/documents/${docId}/annotations${issueRepoQuery()}`);
  const aspectId = state.health.aspects?.[0]?.id ?? "D-01";
  const lines = String(full.body ?? "").split("\n");
  const findingLines = new Set(full.findings.map((f) => f.line).filter(Boolean));
  let sel = null;   // {start, end}

  // 骨格は一度だけ作る。クリックのたびに作り直すと、本文のスクロール位置も
  // 入力中の文字も消える。更新は必要な部分だけ差し替える。
  panel.innerHTML = "";
  const head = document.createElement("div");
  head.className = "annot-head";
  const runs = document.createElement("div");
  runs.className = "aspect-runs";
  const body = document.createElement("div");
  body.className = "annot-body";
  const bar = document.createElement("div");
  bar.className = "annot-list";
  bar.hidden = true;
  const list = document.createElement("div");
  list.className = "annot-list";
  panel.append(head, runs, body, bar, list);

  // ---- 選択の帯。入力欄は作り直さない (打ちかけが消えるため) ----
  const quote = document.createElement("div");
  quote.className = "annot-item";
  const note = Object.assign(document.createElement("input"), { placeholder: "何が問題か (任意)" });
  const add = Object.assign(document.createElement("button"), { textContent: "ここが問題", className: "primary small" });
  const clear = Object.assign(document.createElement("button"), { textContent: "選択解除", className: "ghost small" });
  const row = document.createElement("div");
  row.className = "row";
  row.append(note, add, clear);
  bar.append(quote, row);

  clear.onclick = () => { sel = null; paintSelection(); };
  add.onclick = async () => {
    if (!sel) return;
    add.disabled = true;
    try {
      await api(`/api/documents/${docId}/annotations`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          startLine: sel.start, endLine: sel.end,
          quotedText: lines.slice(sel.start - 1, sel.end).join("\n"),
          note: note.value,
        }),
      });
      sel = null;
      note.value = "";
      data = await api(`/api/documents/${docId}/annotations${issueRepoQuery()}`);
      paintSelection(); paintMarks(); renderList(); renderHead(); refreshStats();
    } catch (e) { alert(needLogin(e)); }
    add.disabled = false;
  };

  // ---- 本文。行の要素は一度だけ作る ----
  const lineEls = lines.map((text, i) => {
    const n = i + 1;
    const el = document.createElement("div");
    el.className = "ln";
    el.innerHTML = '<span class="num"></span><span class="txt"></span>';
    el.querySelector(".num").textContent = n;
    el.querySelector(".txt").textContent = text || " ";
    el.onclick = (ev) => {
      // 本文をドラッグして選んでいる最中は行選択を変えない。
      // 変えてしまうと、問題文を引用のためになぞって選ぶことができない。
      const picked = window.getSelection();
      if (picked && !picked.isCollapsed && picked.toString().trim()) return;
      // 既に選んでいる行を押し直したときは、入力を初期化しない
      if (!ev.shiftKey && sel && n >= sel.start && n <= sel.end) return;
      sel = ev.shiftKey && sel
        ? { start: Math.min(sel.start, n), end: Math.max(sel.end, n) }
        : { start: n, end: n };
      paintSelection();
    };
    body.appendChild(el);
    return el;
  });

  // ---- 差分更新 ----
  function paintSelection() {
    lineEls.forEach((el, i) => {
      const n = i + 1;
      el.classList.toggle("sel", Boolean(sel) && n >= sel.start && n <= sel.end);
    });
    bar.hidden = !sel;
    if (sel) {
      const text = lines.slice(sel.start - 1, sel.end).join(" / ").trim();
      quote.textContent = `L${sel.start}-${sel.end}  ${text.slice(0, 90)}`;
    }
  }

  function paintMarks() {
    const annotLines = new Set();
    for (const a of data.annotations.filter((a) => !a.retracted)) {
      for (let i = a.start_line; i <= a.end_line; i += 1) annotLines.add(i);
    }
    lineEls.forEach((el, i) => {
      el.classList.toggle("has-annot", annotLines.has(i + 1));
      el.classList.toggle("has-finding", findingLines.has(i + 1));
    });
  }

  function renderHead() {
    const done = data.completions.some((c) => c.aspect_id === aspectId && !c.revoked_at);
    head.innerHTML = `<span class="grow">本文 ${lines.length} 行
      <span class="who">行をクリックで選択、Shift+クリックで範囲。本文はなぞって引用できる</span></span>`;
    const mark = Object.assign(document.createElement("button"), {
      textContent: done ? `✓ ${aspectId} は全部見た` : `${aspectId} を全部見た`,
      className: done ? "small" : "ghost small",
    });
    mark.title = "注釈が0件でも押せる。ゼロは「システムが全部拾った」という記録になる";
    mark.onclick = async () => {
      try {
        if (done) {
          await fetch(`/api/documents/${docId}/completions/${aspectId}`, { method: "DELETE" });
        } else {
          await api(`/api/documents/${docId}/completions`, {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ aspectId }),
          });
        }
        data = await api(`/api/documents/${docId}/annotations${issueRepoQuery()}`);
        renderHead(); refreshStats();
      } catch (e) { alert(needLogin(e)); }
    };
    head.appendChild(mark);
  }

  function renderList() {
    list.innerHTML = "";
    list.hidden = data.annotations.length === 0;
    for (const a of data.annotations) {
      const item = document.createElement("div");
      item.className = "annot-item" + (a.retracted ? " gone" : "");
      item.innerHTML = `<span>L${a.start_line}-${a.end_line}</span>
        <span class="q"></span><span>${a.aspect_id ?? "未分類"} / @${a.author}</span>`;
      item.querySelector(".q").textContent = (a.note || a.quoted_text).slice(0, 60);
      // 一覧から本文の該当行へ飛ぶ。押しても本文の先頭には戻らない
      item.querySelector(".q").style.cursor = "pointer";
      item.querySelector(".q").onclick = () => {
        lineEls[a.start_line - 1]?.scrollIntoView({ block: "center", behavior: "smooth" });
      };
      // 起票は押したときだけ。登録と同時には立てない。
      if (a.issue_url) {
        const link = document.createElement("a");
        link.href = a.issue_url; link.target = "_blank"; link.className = "issue-link";
        link.textContent = a.issue_state === "closed" ? `#${a.issue_number} 解決済み` : `#${a.issue_number}`;
        item.appendChild(link);
      }
      if ((!a.issue_url || a.issue_state === "closed") && !a.retracted && state.health.github?.token) {
        const mk = Object.assign(document.createElement("button"), {
          textContent: a.issue_state === "closed" ? "再発として起票" : "issue にする",
          className: "ghost small",
        });
        mk.onclick = async () => {
          const repo = ($("issueRepo").value || state.issueRepo || "").trim();
          if (!repo) { alert("起票先の owner/repo を入れる"); $("issueRepo").focus(); return; }
          mk.disabled = true; mk.textContent = "起票中…";
          try {
            const r = await api("/api/annotations/issues", {
              method: "POST", headers: { "content-type": "application/json" },
              body: JSON.stringify({ repo, annotationIds: [a.id] }),
            });
            if (r.deduped) alert("同じ指摘の issue が既にある。新しくは立てなかった。");
            data = await api(`/api/documents/${docId}/annotations${issueRepoQuery()}`);
            renderList();
          } catch (e) {
            alert(`起票できなかった: ${e.message}`);
            mk.disabled = false; mk.textContent = "issue にする";
          }
        };
        item.appendChild(mk);
      }

      const undo = Object.assign(document.createElement("button"), {
        textContent: a.retracted ? "戻す" : "取消", className: "ghost small",
      });
      undo.onclick = async () => {
        try {
          await api(`/api/annotations/${a.id}/${a.retracted ? "restore" : "retract"}`,
            { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
          data = await api(`/api/documents/${docId}/annotations${issueRepoQuery()}`);
          paintMarks(); renderList(); refreshStats();
        } catch (e) { alert(needLogin(e)); }
      };
      item.appendChild(undo);
      list.appendChild(item);
    }
  }

  runs.hidden = !full.aspectRuns?.length;
  if (full.aspectRuns?.length) {
    runs.innerHTML = "走った観点: " + full.aspectRuns.map((r) =>
      `<span class="st-${r.status}">${r.aspect_id} ${r.status}${r.error ? " — " + r.error.slice(0, 40) : ""}</span>`
    ).join(" / ");
  }
  renderHead(); paintMarks(); renderList(); paintSelection();
  return panel;
}

// 起票先。押す前に重複を解決するため、一覧の取得時にも渡す。
function issueRepoQuery() {
  const repo = ($("issueRepo")?.value || state.issueRepo || "").trim();
  return repo ? `?repo=${encodeURIComponent(repo)}` : "";
}

const needLogin = (e) =>
  /ログインが要る/.test(e.message)
    ? "注釈にはログインが要ります。ヘッダからログインして下さい。"
    : `保存できなかった: ${e.message}`;

function reviewBlock(r) {
  const wrap = document.createElement("div");
  wrap.className = "review";

  const head = document.createElement("div");
  head.className = "review-head";
  const accepted = r.findings.filter((f) => f.verdict === "accepted");
  head.innerHTML = `<span class="rtitle"></span><span class="rmeta">${r.findings.length}件</span>`;
  head.querySelector(".rtitle").textContent = r.title ?? `review ${r.reviewId}`;

  // 見落としを登録する。R-04 (使われなければ recall が永久に測れない) への手当て。
  const annot = Object.assign(document.createElement("button"), {
    textContent: "本文と注釈", className: "ghost small",
  });
  annot.onclick = async () => {
    const existing = wrap.querySelector(".annot-panel");
    if (existing) { existing.remove(); return; }
    annot.disabled = true;
    try {
      wrap.insertBefore(await annotationPanel(r.reviewId), wrap.children[1] ?? null);
    } catch (e) { alert(`開けなかった: ${e.message}`); }
    annot.disabled = false;
  };
  head.appendChild(annot);

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

/** 採用済みの指摘について、起票済みかを引いて表示に反映する。 */
async function refreshIssued() {
  const repo = ($("issueRepo")?.value || state.issueRepo || "").trim();
  const ids = allFindings().filter((f) => f.verdict === "accepted").map((f) => f.id);
  if (!repo || ids.length === 0) { state.issuedFindings = {}; return; }
  try {
    const r = await api(`/api/issues/lookup?repo=${encodeURIComponent(repo)}&findings=${ids.join(",")}`);
    state.issuedFindings = r.findings ?? {};
  } catch { state.issuedFindings = {}; }
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
    if (notChecked) notes.push("未検査: 設計チェック (LLM)。文体が通っても設計の妥当性は見ていない。");
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

    await refreshIssued();
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
      // 沈黙の可視化。ゼロに近ければ未検知の記録が使われていない (設計書 4.4)
      ["注釈", s.annotations], ["全数注釈済み", s.completed_documents],
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
  } else if (h.localSession) {
    // OAuth 未設定でも注釈は付けられるようにする。
    // ログインを要求したまま手段が無いと、一人運用で注釈がゼロになる (設計書 8.2)。
    const btn = Object.assign(document.createElement("button"), {
      textContent: "この機械のセッションで入る", className: "ghost small",
    });
    btn.onclick = async () => {
      try { await api("/auth/local", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }); location.reload(); }
      catch (e) { alert(e.message); }
    };
    box.appendChild(btn);
    const note = document.createElement("span");
    note.className = "who";
    note.textContent = h.github.token ? ".env の PAT で動作中" : "GitHub 未接続";
    box.appendChild(note);
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
    if (!h.l3) { $("useL3").checked = false; $("useL3").parentElement.title = "JUSTIC_L3=0 で切ってある"; }
    if (!h.github.token) $("issueRepo").placeholder = "GitHub にログインすると起票できる";
  } catch (e) {
    $("health").textContent = `接続できない: ${e.message}`;
  }
  refreshStats();
})();

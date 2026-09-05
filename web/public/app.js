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

## 処理の流れ

1. リクエストを受け取る
2. 決済ゲートウェイに転送する
3. 結果を返す

httpリクエストのJSONに不備があると、プロセスは黙って壊れる。

## 非機能

このシステムは革命的なアーキテクチャを採用しており、非常に高速に動作します。
`;

let state = { findings: [], reviewId: null };

async function refreshStats() {
  try {
    const s = await api("/api/stats");
    $("stats").innerHTML = [
      ["文書", s.documents], ["レビュー", s.reviews], ["提示した指摘", s.shown],
      ["採用", s.accepted], ["却下", s.rejected],
    ].map(([k, v]) => `${k} <b>${v}</b>`).join("");
  } catch { /* 統計が出ないだけなので黙って続ける */ }
}

function renderCounts() {
  const decided = state.findings.filter((f) => f.verdict).length;
  const acc = state.findings.filter((f) => f.verdict === "accepted").length;
  const rej = state.findings.filter((f) => f.verdict === "rejected").length;
  const undecided = state.findings.length - decided;
  $("counts").textContent = state.findings.length
    ? `${state.findings.length}件  採用 ${acc} / 却下 ${rej} / 未判断 ${undecided}`
    : "";
}

function card(f) {
  const el = document.createElement("div");
  el.className = "card" + (f.verdict ? ` done-${f.verdict}` : "");

  const loc = f.line ? `L${f.line}` : "";
  el.innerHTML = `
    <div class="meta">
      <span class="badge ${f.severity}">${f.severity}</span>
      <span class="layer">${f.layer}</span>
      <span>${loc}</span>
      <span class="rule">${f.rule_id ?? f.ruleId ?? ""}</span>
    </div>
    <p class="msg"></p>
    ${f.evidence ? '<div class="evidence"></div>' : ""}
  `;
  el.querySelector(".msg").textContent = f.message;
  if (f.evidence) el.querySelector(".evidence").textContent = f.evidence;

  if (f.verdict) {
    const v = document.createElement("div");
    v.className = "verdict";
    v.innerHTML = `<b>${f.verdict === "accepted" ? "採用" : "却下"}</b> 済み。押し直すと訂正として追記される。`;
    el.appendChild(v);
  }

  const row = document.createElement("div");
  row.className = "row";
  const fix = document.createElement("input");
  fix.placeholder = "修正後の文 (採用時、任意)";
  fix.value = f.corrected_text ?? "";
  const accept = document.createElement("button");
  accept.textContent = "採用";
  const reject = document.createElement("button");
  reject.textContent = "却下";
  reject.className = "ghost";

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
  el.appendChild(row);
  return el;
}

function render() {
  const box = $("findings");
  box.innerHTML = "";
  if (state.findings.length === 0) {
    box.innerHTML = '<p class="empty">指摘なし。該当がなければ空で返る。</p>';
  } else {
    for (const f of state.findings) box.appendChild(card(f));
  }
  renderCounts();
}

$("sample").onclick = () => {
  $("title").value = "決済API 設計書";
  $("body").value = SAMPLE;
};

$("run").onclick = async () => {
  const body = $("body").value.trim();
  if (!body) return;
  $("run").disabled = true;
  $("runState").textContent = "検査中…";
  try {
    const r = await api("/api/reviews", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: $("title").value, body, useL3: $("useL3").checked }),
    });
    state = { findings: r.findings, reviewId: r.reviewId };

    const notes = [];
    if (r.notChecked?.length) notes.push(`未検査: ${r.notChecked.join("、")}。文体が通っても設計の妥当性は見ていない。`);
    if (r.droppedByEvidenceCheck) notes.push(`引用が原文に無い指摘を ${r.droppedByEvidenceCheck} 件破棄した。`);
    if (r.l3Errors?.length) notes.push(`L3 でエラー: ${r.l3Errors.join(" / ")}`);
    $("notice").hidden = notes.length === 0;
    $("notice").textContent = notes.join("  ");

    $("runState").textContent = `検査した層: ${r.layers.join(" + ")}`;
    render();
    refreshStats();
  } catch (e) {
    $("runState").textContent = `失敗: ${e.message}`;
  } finally {
    $("run").disabled = false;
  }
};

(async () => {
  try {
    const h = await api("/api/health");
    $("health").textContent = `DB ${h.db} / L3 ${h.l3 ? "有効" : "無効"} / 観点 ${h.aspects.map((a) => a.id).join(", ")}`;
    $("useL3").disabled = !h.l3;
    if (!h.l3) $("useL3").parentElement.title = "JUSTIC_L3=1 で有効になる";
  } catch (e) {
    $("health").textContent = `接続できない: ${e.message}`;
  }
  refreshStats();
})();

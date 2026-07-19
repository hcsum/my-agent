#!/usr/bin/env node
// Render backlink-master.csv into a single-file HTML board.
// Usage: node build-board.mjs [--open]

import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../../..");
const CSV = resolve(repo, "notes/projects/backlink-master.csv");
const OUT = resolve(repo, "notes/projects/backlink-board.html");

const META = ["website", "difficulty", "AS", "DR", "note", "example_source"];

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim()));
}

const raw = parseCsv(readFileSync(CSV, "utf8"));
const header = raw[0];
// `difficulty: dead` = tried and rejected. Such rows stay in the CSV purely so
// prospecting keeps deduping them out of new candidate lists; never show them.
const DEAD = "dead";
// Each project owns two columns: `<project>` (status) and `<project>_detail`.
const projects = header.filter((h) => !META.includes(h) && !h.endsWith("_detail"));
const records = raw.slice(1)
  .map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? "").trim()])))
  .filter((r) => r.difficulty !== DEAD);

const data = records.map((r) => ({
  website: r.website,
  difficulty: r.difficulty || "",
  dr: r.DR ? Number(r.DR) : null,
  note: r.note || "",
  status: Object.fromEntries(projects.map((p) => [p, r[p] || ""])),
  detail: Object.fromEntries(projects.map((p) => [p, r[`${p}_detail`] || ""])),
}));

// "tier" = on how many projects this domain has a *live* link. Only `live`
// counts — parked/reviewing/unverified are explicitly not proof it works.
for (const d of data) d.tier = projects.filter((p) => d.status[p] === "live").length;
// Sub-page targets (contain "/") aren't separate sites; gaps are tracked per real project.
const mainProjects = projects.filter((p) => !p.includes("/"));

const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

const html = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Backlink Board</title>
<style>
:root{--bg:#fbfaf8;--fg:#1c1b19;--muted:#6f6a63;--line:#e6e2db;--card:#fff;--acc:#b4552d;--ok:#3f7d4e}
@media(prefers-color-scheme:dark){:root{--bg:#161513;--fg:#eceae6;--muted:#968f86;--line:#2e2c28;--card:#1e1d1a;--acc:#e08a5d;--ok:#7fb98d}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 ui-sans-serif,-apple-system,"PingFang SC",system-ui,sans-serif}
header{position:sticky;top:0;background:var(--bg);border-bottom:1px solid var(--line);padding:14px 20px;z-index:5}
h1{margin:0 0 10px;font-size:17px;font-weight:650;letter-spacing:-.01em}
.tabs{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px}
.tab{border:1px solid var(--line);background:var(--card);color:var(--muted);padding:5px 11px;border-radius:99px;cursor:pointer;font-size:13px}
.tab[aria-selected=true]{background:var(--acc);border-color:var(--acc);color:#fff}
.bar{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
input[type=search]{flex:1;min-width:180px;padding:7px 11px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--fg);font-size:14px}
label.chk{font-size:13px;color:var(--muted);display:flex;gap:5px;align-items:center;cursor:pointer;user-select:none}
.prog{height:5px;background:var(--line);border-radius:99px;overflow:hidden;margin-top:10px}
.prog>i{display:block;height:100%;background:var(--ok)}
.count{font-size:12.5px;color:var(--muted);margin-top:7px}
main{padding:16px 20px 64px;display:grid;gap:9px;max-width:920px}
.row{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:11px 13px}
.row.done{opacity:.42}
.top{display:flex;gap:9px;align-items:baseline;flex-wrap:wrap}
.site{font-weight:600;font-size:15px;text-decoration:none;color:var(--fg)}
.site:hover{color:var(--acc)}
.dr{font-size:12px;color:var(--muted);font-variant-numeric:tabular-nums}
.tag{font-size:11px;padding:1px 7px;border-radius:99px;border:1px solid var(--line);color:var(--muted)}
.tag.hard{color:var(--acc);border-color:var(--acc)}
.tag.ok{color:var(--ok);border-color:var(--ok)}
.note{margin-top:7px;font-size:13px;color:var(--muted);white-space:pre-wrap;word-break:break-word}
.note.clip{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;cursor:pointer}
.empty{color:var(--muted);font-size:14px;padding:20px 0}
select{padding:6px 9px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--fg);font-size:13px}
.tab.gap[aria-selected=true]{background:var(--ok);border-color:var(--ok)}
.need{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}
.need a{font-size:12px;padding:2px 9px;border-radius:99px;border:1px dashed var(--acc);color:var(--acc);text-decoration:none}
.need a:hover{background:var(--acc);color:#fff;border-style:solid}
.tier{font-size:11px;color:var(--ok);font-weight:600}
</style></head><body>
<header>
  <h1>Backlink Board</h1>
  <div class="tabs" id="tabs"></div>
  <div class="bar">
    <input type="search" id="q" placeholder="搜索域名 / note…">
    <select id="tier">
      <option value="2">✅ 已验证（≥2 个项目发成功过）</option>
      <option value="1">🟡 用过一次（≥1 个项目）</option>
      <option value="0">全部（含从未发过的）</option>
    </select>
    <label class="chk"><input type="checkbox" id="showDone"> 显示已完成</label>
    <label class="chk"><input type="checkbox" id="easyOnly" checked> 只看 easy</label>
  </div>
  <div class="prog"><i id="bar"></i></div>
  <div class="count" id="count"></div>
</header>
<main id="list"></main>
<script>
const DATA=${JSON.stringify(data)};
const PROJECTS=${JSON.stringify(projects)};
const MAIN=${JSON.stringify(mainProjects)};
const GAP="__gap__";
let cur=GAP;
const $=(id)=>document.getElementById(id);
const esc=s=>String(s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));

$("tabs").innerHTML=\`<button class="tab gap" data-p="\${GAP}">🎯 补齐缺口</button>\`
  +PROJECTS.map(p=>\`<button class="tab" data-p="\${p}">\${p}</button>\`).join("");
$("tabs").onclick=e=>{const p=e.target.dataset.p;if(p){cur=p;render();}};
["q","showDone","easyOnly","tier"].forEach(id=>$(id).addEventListener("input",render));

function render(){
  [...$("tabs").children].forEach(b=>b.setAttribute("aria-selected",b.dataset.p===cur));
  const q=$("q").value.toLowerCase().trim();
  const minTier=+$("tier").value;
  const easyOnly=$("easyOnly").checked;
  $("showDone").parentElement.style.display=cur===GAP?"none":"";

  let all=DATA.filter(d=>d.tier>=minTier)
    .filter(d=>!q||d.website.toLowerCase().includes(q)||d.note.toLowerCase().includes(q));
  if(easyOnly) all=all.filter(d=>d.difficulty!=="hard");

  if(cur===GAP){
    // Every (proven domain × project with no live link yet) = one unit of work.
    // parked/reviewing are excluded — they're blocked or already in flight.
    const list=all.map(d=>({d,need:MAIN.filter(p=>d.status[p]!=="live")})).filter(x=>x.need.length);
    // Sort by how much is actionable right now, not by raw gap count.
    const open=x=>x.need.filter(p=>!x.d.status[p]).length;
    list.sort((a,b)=>open(b)-open(a)||b.d.tier-a.d.tier||(b.d.dr??-1)-(a.d.dr??-1));
    const total=all.length*MAIN.length;
    const live=total-list.reduce((n,x)=>n+x.need.length,0);
    const actionable=list.reduce((n,x)=>n+open(x),0);
    $("bar").style.width=(total?Math.round(live/total*100):0)+"%";
    $("count").textContent=\`\${all.length} 个域名 × \${MAIN.length} 个项目 = \${total} 个位置｜✅ live \${live}｜👉 现在能发 \${actionable}｜其余是卡住/审核中\`;
    $("list").innerHTML=list.length?list.map(x=>card(x.d,x.need)).join(""):'<div class="empty">这一档已经全部补齐了 🎉 换到下一档。</div>';
    return;
  }

  const done=all.filter(d=>d.status[cur]);
  const list=all.filter(d=>$("showDone").checked||!d.status[cur])
    .sort((a,b)=>(!!a.status[cur]-!!b.status[cur])||b.tier-a.tier||(b.dr??-1)-(a.dr??-1));
  const pct=all.length?Math.round(done.length/all.length*100):0;
  $("bar").style.width=pct+"%";
  $("count").textContent=\`\${cur} — 已发 \${done.length} / \${all.length}（\${pct}%），待办 \${list.filter(d=>!d.status[cur]).length}\`;
  $("list").innerHTML=list.length?list.map(d=>card(d)).join(""):'<div class="empty">没有匹配项。</div>';
}

const LABEL={live:"✅ live",reviewing:"🟡 审核中",parked:"⛔ 卡住",unverified:"❓ 待核实",nolink:"⚠️ 发了但没链接"};

function card(d,need){
  const st=cur===GAP?"":d.status[cur];
  // Live links on other projects double as the how-to reference for this domain.
  const evidence=PROJECTS.filter(p=>p!==cur&&d.status[p]==="live"&&d.detail[p])
    .map(p=>\`<a class="tag ok" href="\${esc(d.detail[p])}" target="_blank" rel="noopener">\${esc(p.split("/")[0])} ↗</a>\`).join(" ");
  const link=st==="live"&&d.detail[cur]?d.detail[cur]:"https://"+d.website;
  const why=st&&st!=="live"&&d.detail[cur]?\`<div class="note">\${LABEL[st]||st}：\${esc(d.detail[cur])}</div>\`:"";
  return \`<div class="row \${st==="live"?"done":""}">
    <div class="top">
      <a class="site" href="\${esc(link)}" target="_blank" rel="noopener">\${esc(d.website)}</a>
      \${d.dr!=null?\`<span class="dr">DR \${d.dr}</span>\`:""}
      \${d.tier>=2?\`<span class="tier">✅ 验证 \${d.tier}×</span>\`:d.tier===1?'<span class="tier" style="color:var(--muted)">🟡 live 1×</span>':""}
      \${d.difficulty==="hard"?'<span class="tag hard">hard</span>':""}
      \${st?\`<span class="tag \${st==="live"?"ok":st==="parked"?"hard":""}">\${LABEL[st]||st}</span>\`:""}
      \${evidence}
    </div>
    \${need?\`<div class="need">还差：\${need.map(p=>{
      const s=d.status[p];
      return s?\`<span class="tag \${s==="parked"?"hard":""}">\${esc(p.split("/")[0])} \${LABEL[s]||s}</span>\`
              :\`<a href="\${esc(link)}" target="_blank" rel="noopener">\${esc(p)}</a>\`;
    }).join("")}</div>\`:""}
    \${why}
    \${d.note?\`<div class="note clip" onclick="this.classList.toggle('clip')">\${esc(d.note)}</div>\`:""}
  </div>\`;
}
render();
</script></body></html>`;

writeFileSync(OUT, html);
console.log(`wrote ${OUT} (${data.length} targets, ${projects.length} projects)`);
if (process.argv.includes("--open")) execFileSync("open", [OUT]);

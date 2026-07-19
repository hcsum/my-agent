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

const META = ["website", "difficulty", "follow", "gsc", "AS", "DR", "note", "example_source"];

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
  // The one axis DR/AS can't express: does the link actually pass anything.
  // dofollow > nofollow (still worth referral + profile diversity) > noindex (worthless).
  follow: r.follow || "",
  // Date Google Search Console itself reported a link from this domain, on any
  // project. The only first-hand evidence there is — Semrush and `site:` both
  // gave wrong answers on 2026-07-19 where GSC did not. Outranks `follow`.
  gsc: r.gsc || "",
  dr: r.DR ? Number(r.DR) : null,
  note: r.note || "",
  // Baseline admission needs *both* kill switches checked, and `follow` only
  // covers the anchor's rel. A page-level `<meta name="robots">` overrides every
  // anchor on it — f6s.com is dofollow-looking, GSC-confirmed, and `noindex`.
  // The note is where that check gets written down, so its presence is the flag.
  robotsChecked: /robots/i.test(r.note || ""),
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
.tag.gsc{background:var(--ok);color:#fff;border-color:var(--ok)}
.tag.mine{background:var(--acc);color:#fff;border-color:var(--acc);text-decoration:none;font-weight:600}
.note{margin-top:7px;font-size:13px;color:var(--muted);white-space:pre-wrap;word-break:break-word}
.note.clip{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;cursor:pointer}
.empty{color:var(--muted);font-size:14px;padding:20px 0}
select{padding:6px 9px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--fg);font-size:13px}
.tab.gap[aria-selected=true]{background:var(--ok);border-color:var(--ok)}
.need{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}
.need a{font-size:12px;padding:2px 9px;border-radius:99px;border:1px dashed var(--acc);color:var(--acc);text-decoration:none}
.need a:hover{background:var(--acc);color:#fff;border-style:solid}
.tier{font-size:11px;color:var(--ok);font-weight:600}
.tab.core[aria-selected=true]{background:var(--fg);border-color:var(--fg);color:var(--bg)}
.seg{display:inline-flex;border:1px solid var(--line);border-radius:8px;overflow:hidden}
.seg button{border:0;background:var(--card);color:var(--muted);padding:6px 12px;font-size:13px;cursor:pointer}
.seg button+button{border-left:1px solid var(--line)}
.seg button.on{background:var(--acc);color:#fff}
h2.grp{margin:14px 0 2px;font-size:13px;font-weight:650;color:var(--muted);display:flex;gap:8px;align-items:center}
h2.grp:first-child{margin-top:0}
h2.grp span{font-weight:400;font-size:12px;opacity:.7}
</style></head><body>
<header>
  <h1>Backlink Board</h1>
  <div class="tabs" id="scopes"></div>
  <div class="tabs" id="tabs"></div>
  <div class="bar">
    <input type="search" id="q" placeholder="搜索域名 / note…">
    <select id="tier">
      <option value="2">✅ 已验证（≥2 个项目发成功过）</option>
      <option value="1">🟡 用过一次（≥1 个项目）</option>
      <option value="0" selected>全部（含从未发过的）</option>
    </select>
    <span class="seg" id="seg">
      <button data-v="todo" class="on">待发</button><button data-v="done">已发</button><button data-v="all">全部</button>
    </span>
    <label class="chk"><input type="checkbox" id="easyOnly"> 只看 easy</label>
  </div>
  <div class="prog"><i id="bar"></i></div>
  <div class="count" id="count"></div>
</header>
<main id="list"></main>
<script>
const DATA=${JSON.stringify(data)};
const PROJECTS=${JSON.stringify(projects)};
const MAIN=${JSON.stringify(mainProjects)};
const GAP="__gap__",CORE="__core__";
const CORELABEL={dofollow:"✅ dofollow + 可索引 — 主力，按 DR 从高到低",nofollow:"🟡 nofollow — 页面能被索引，有引荐流量，顺手做别排前面",noindex:"❌ 整页 noindex — 不传权重也没引荐流量","":"⬜ rel 未核实 — 去页面上看一眼补上"};
// Three INDEPENDENT filters that compose, not three separate pages. Picking a
// project used to swap the whole view and drop you out of the baseline list,
// which is why it never read as a funnel:
//   1. scope — which set of domains        (保底名单 / 全部域名 / 补齐缺口)
//   2. proj  — whose worklist              (全部项目 / one project)
//   3. view  — 待发 / 已发 / 全部
const ALL="__all__",ALLPROJ="__allproj__";
let scope=CORE,proj=ALLPROJ,view="todo";
const $=(id)=>document.getElementById(id);
const esc=s=>String(s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));

$("scopes").innerHTML=\`<button class="tab core" data-s="\${CORE}">🏆 保底名单</button>\`
  +\`<button class="tab" data-s="\${ALL}">📋 全部域名</button>\`
  +\`<button class="tab gap" data-s="\${GAP}">🎯 补齐缺口</button>\`;
$("scopes").onclick=e=>{const s=e.target.dataset.s;if(!s)return;scope=s;
  // The gap view is explicitly about *proven* domains; the other scopes are
  // worklists and must never hide work behind a filter.
  $("tier").value=s===GAP?"2":"0";
  $("easyOnly").checked=s===GAP;
  render();};

$("tabs").innerHTML=\`<button class="tab" data-p="\${ALLPROJ}">全部项目</button>\`
  +PROJECTS.map(p=>\`<button class="tab" data-p="\${p}">\${p}</button>\`).join("");
$("tabs").onclick=e=>{const p=e.target.dataset.p;if(!p)return;proj=p;render();};

$("seg").onclick=e=>{const v=e.target.dataset.v;if(!v)return;view=v;
  [...$("seg").children].forEach(b=>b.classList.toggle("on",b.dataset.v===v));render();};
["q","easyOnly","tier"].forEach(id=>$(id).addEventListener("input",render));

// Baseline admission = what we verified on the page ourselves: the anchor passes
// value (dofollow, or nofollow for referral) AND the page is indexable (robots
// checked, not noindex). GSC confirmation is a bonus badge, NOT the gate -
// gating on it required a domain to already be placed *and* reported, so no new
// target could ever enter the list a brand-new project is meant to be handed.
// Absence from GSC is absence of evidence: wox.cc has 3 Semrush links, 0 in GSC.
const WORTH=["dofollow","nofollow"];
const inCore=d=>WORTH.includes(d.follow)&&d.robotsChecked;

function render(){
  [...$("scopes").children].forEach(b=>b.setAttribute("aria-selected",b.dataset.s===scope));
  [...$("tabs").children].forEach(b=>b.setAttribute("aria-selected",b.dataset.p===proj));
  const q=$("q").value.toLowerCase().trim();
  const easyOnly=$("easyOnly").checked;
  // The baseline list is a fixed, hand-vetted set — the generic filters would
  // silently shrink it, which is exactly the "list I can't trust" problem.
  // NOT parentElement for #tier — it sits directly in .bar, so that hides the
  // whole toolbar. Only #easyOnly needs its wrapping <label> hidden.
  $("tier").style.display=scope===CORE?"none":"";
  $("easyOnly").parentElement.style.display=scope===CORE?"none":"";

  // --- Level 1: scope ---
  let pool=DATA.filter(d=>!q||d.website.toLowerCase().includes(q)||d.note.toLowerCase().includes(q));
  if(scope===CORE) pool=pool.filter(inCore);
  else{
    pool=pool.filter(d=>d.tier>=+$("tier").value);
    if(easyOnly) pool=pool.filter(d=>d.difficulty!=="hard");
    // 补齐缺口 = domains already proven on ≥2 projects that some project still lacks.
    if(scope===GAP) pool=pool.filter(d=>MAIN.some(p=>d.status[p]!=="live"));
  }

  // --- Level 2: project ---
  const one=proj!==ALLPROJ;
  const scoped=one?[proj]:MAIN;
  const isDone=d=>scoped.every(p=>d.status[p]==="live");
  const need=d=>scoped.filter(p=>d.status[p]!=="live");

  // Progress counts slots (domain × project), and only dofollow ones — padding
  // the denominator with nofollow targets overstates real coverage.
  const scored=pool.filter(d=>scope!==CORE||d.follow==="dofollow");
  const total=scored.length*scoped.length;
  const live=scored.reduce((n,d)=>n+scoped.filter(p=>d.status[p]==="live").length,0);
  $("bar").style.width=(total?Math.round(live/total*100):0)+"%";
  const extra=pool.length-scored.length;
  const who=one?proj:\`\${scoped.length} 个项目\`;
  $("count").textContent=\`\${scope===CORE?"🏆 保底名单":scope===GAP?"🎯 补齐缺口":"📋 全部域名"}\`
    +\` · \${who} — \${scored.length} 个域名\${one?"":\` × \${scoped.length}\`} = \${total} 个位置\`
    +\`｜✅ 已发 \${live}｜还差 \${total-live}\`
    +(extra?\`（另有 \${extra} 个 nofollow，顺手做，不计进度）\`:"")
    +(scope===CORE?"。准入 = 自己在页面上验过 rel 和 robots 都过关。🔎 徽章 = Google 也报过。":"");

  // --- Level 3: 待发 / 已发 / 全部 ---
  const list=pool.filter(d=>view==="all"||(view==="done"?isDone(d):!isDone(d)));

  const GROUPS=scope===CORE?[["dofollow",CORELABEL.dofollow],["nofollow",CORELABEL.nofollow]]
    :[["dofollow",CORELABEL.dofollow],["nofollow",CORELABEL.nofollow],
      ["","其他（未核实 follow 状态，机会型）"],["noindex",CORELABEL.noindex]];
  $("list").innerHTML=GROUPS.map(([k,label])=>{
    const g=list.filter(d=>(d.follow||"")===k);
    if(!g.length) return "";
    // Actionable (never attempted) before blocked (parked/reviewing); DR breaks ties.
    const open=d=>need(d).filter(p=>!d.status[p]).length;
    g.sort((a,b)=>open(b)-open(a)||b.tier-a.tier||(b.dr??-1)-(a.dr??-1));
    return \`<h2 class="grp">\${label}<span>\${g.length}</span></h2>\`
      +g.map(d=>card(d,need(d))).join("");
  }).join("")||\`<div class="empty">\${view==="todo"?"这一档已经全部发完了 🎉":"没有匹配项。"}</div>\`;
}

const LABEL={live:"✅ live",reviewing:"🟡 审核中",parked:"⛔ 卡住",unverified:"❓ 待核实",nolink:"⚠️ 发了但没链接"};

// Which project a card is "about". A project tab sets it directly; the baseline
// view sets it via its own picker. GAP and 全部项目 have no single subject.
function lens(){return proj===ALLPROJ?null:proj;}

function card(d,need){
  const f=lens();
  const st=f?d.status[f]:"";
  // Live links on other projects double as the how-to reference for this domain.
  // The current project's own link must come first and be marked, otherwise the
  // done view shows only *other* projects and reads as "mine is missing".
  const self=st==="live"&&d.detail[f]
    ?\`<a class="tag mine" href="\${esc(d.detail[f])}" target="_blank" rel="noopener">\${esc(f.split("/")[0])} ↗ 本项目</a>\`:"";
  const evidence=self+" "+PROJECTS.filter(p=>p!==f&&d.status[p]==="live"&&d.detail[p])
    .map(p=>\`<a class="tag ok" href="\${esc(d.detail[p])}" target="_blank" rel="noopener">\${esc(p.split("/")[0])} ↗</a>\`).join(" ");
  const link=st==="live"&&d.detail[f]?d.detail[f]:"https://"+d.website;
  const why=st&&st!=="live"&&d.detail[f]?\`<div class="note">\${LABEL[st]||st}：\${esc(d.detail[f])}</div>\`:"";
  return \`<div class="row \${st==="live"&&view!=="done"?"done":""}">
    <div class="top">
      <a class="site" href="\${esc(link)}" target="_blank" rel="noopener">\${esc(d.website)}</a>
      \${d.gsc?\`<span class="tag gsc" title="Google Search Console 自己报告过来自这个域名的链接（\${esc(d.gsc)}）">🔎 GSC 确认</span>\`:""}
      \${d.dr!=null?\`<span class="dr">DR \${d.dr}</span>\`:""}
      \${d.tier>=2?\`<span class="tier">✅ 验证 \${d.tier}×</span>\`:d.tier===1?'<span class="tier" style="color:var(--muted)">🟡 live 1×</span>':""}
      \${d.difficulty==="hard"?'<span class="tag hard">hard</span>':""}
      \${st?\`<span class="tag \${st==="live"?"ok":st==="parked"?"hard":""}">\${LABEL[st]||st}</span>\`:""}
      \${evidence}
    </div>
    \${need&&need.length?\`<div class="need">还差：\${need.map(p=>{
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

#!/usr/bin/env node
// Render backlink-master.json into a single-file HTML board.
// Usage: node build-board.mjs [--open]

import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../../..");
const JSON_PATH = resolve(repo, "notes/projects/site-backlinks/backlink-master.json");
const OUT = resolve(repo, "notes/projects/site-backlinks/backlink-board.html");

function readMaster() {
  const parsed = JSON.parse(readFileSync(JSON_PATH, "utf8"));
  if (Array.isArray(parsed)) return { projects: inferProjects(parsed), websites: parsed };
  return parsed;
}

function inferProjects(websites) {
  return [...new Set(websites.flatMap((site) => (site.placements || []).map((p) => p.project)))];
}

const master = readMaster();
const projects = master.projects || inferProjects(master.websites || []);
const campaigns = master.campaigns || [];
// Rejected rows stay in the master for dedup/provenance, but the board is a work surface.
const records = (master.websites || []).filter((r) => r.decision?.status !== "rejected");

const data = records.map((r) => ({
  website: r.website,
  decision: r.decision?.status || "needs_review",
  reason: r.decision?.reason || "",
  typePrimary: r.type?.primary || "",
  typeSurface: r.type?.surface || "",
  pricingModel: r.pricing?.model || "",
  pricingPaid: r.pricing?.requires_payment ?? "",
  pricingNote: r.pricing?.note || "",
  linkRel: r.link?.rel || "",
  linkRobots: r.link?.robots || "",
  linkChecked: r.link?.robots_checked_at || r.link?.rel_checked_at || "",
  // Date Google Search Console itself reported a link from this domain, on any
  // project. The only first-hand evidence there is — Semrush and `site:` both
  // gave wrong answers on 2026-07-19 where GSC did not. Outranks `follow`.
  gsc: r.gsc?.seen_at || "",
  dr: r.authority?.dr ?? null,
  note: r.note || "",
  status: Object.fromEntries(projects.map((p) => [p, placementFor(r, p).status || ""])),
  detail: Object.fromEntries(projects.map((p) => [p, placementFor(r, p).url || placementFor(r, p).detail || ""])),
  indexStatus: Object.fromEntries(projects.map((p) => [p, placementFor(r, p).index?.status || ""])),
  indexChecked: Object.fromEntries(projects.map((p) => [p, placementFor(r, p).index?.checked_at || ""])),
  indexSource: Object.fromEntries(projects.map((p) => [p, placementFor(r, p).index?.source || ""])),
}));

function placementFor(site, project) {
  return (site.placements || []).find((placement) => placement.project === project) || {};
}

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
.campaign{border:1px solid var(--line);background:var(--card);border-radius:10px;padding:13px}
.campaign h2{margin:0;font-size:15px}
.campaignHead{display:flex;gap:10px;align-items:baseline;justify-content:space-between;flex-wrap:wrap;margin-bottom:10px}
.campaignMeta{font-size:12px;color:var(--muted)}
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
a.tag{text-decoration:none;cursor:pointer}
a.tag:hover{border-color:var(--acc);color:var(--acc)}
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
    <input type="search" id="q" placeholder="搜索域名 / reason / note…">
    <select id="tier">
      <option value="2">✅ 已验证（≥2 个项目发成功过）</option>
      <option value="1">🟡 用过一次（≥1 个项目）</option>
      <option value="0" selected>全部（含从未发过的）</option>
    </select>
    <span class="seg" id="seg">
      <button data-v="todo" class="on">待发</button><button data-v="done">已发</button><button data-v="all">全部</button>
    </span>
  </div>
  <div class="prog"><i id="bar"></i></div>
  <div class="count" id="count"></div>
</header>
<main id="list"></main>
<script>
const DATA=${JSON.stringify(data)};
const PROJECTS=${JSON.stringify(projects)};
const CAMPAIGNS=${JSON.stringify(campaigns)};
const MAIN=${JSON.stringify(mainProjects)};
const CAMPAIGN="__campaign__",GAP="__gap__",CORE="__core__";
const CORELABEL={dofollow:"✅ dofollow + 可索引 — 主力，按 DR 从高到低",nofollow:"🟡 nofollow + 可索引 — 次级目标","":"⬜ 待复查 — 先确认 rel / robots / 是否要做"};
// Three INDEPENDENT filters that compose, not three separate pages. Picking a
// project used to swap the whole view and drop you out of the baseline list,
// which is why it never read as a funnel:
//   1. scope — which set of domains        (保底名单 / 全部域名 / 补齐缺口)
//   2. proj  — whose worklist              (全部项目 / one project)
//   3. view  — 待发 / 已发 / 全部
const ALL="__all__",ALLPROJ="__allproj__";
let scope=CAMPAIGNS.length?CAMPAIGN:CORE,proj=ALLPROJ,view="todo";
const $=(id)=>document.getElementById(id);
const esc=s=>String(s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const SCOPE_TO_QUERY={[CAMPAIGN]:"campaign",[CORE]:"core",[ALL]:"all",[GAP]:"gap"};
const QUERY_TO_SCOPE={campaign:CAMPAIGN,core:CORE,all:ALL,gap:GAP};

$("scopes").innerHTML=(CAMPAIGNS.length?\`<button class="tab core" data-s="\${CAMPAIGN}">🎯 本轮目标</button>\`:"")
  +\`<button class="tab core" data-s="\${CORE}">🏆 保底名单</button>\`
  +\`<button class="tab" data-s="\${ALL}">📋 全部域名</button>\`
  +\`<button class="tab gap" data-s="\${GAP}">🎯 补齐缺口</button>\`;
$("scopes").onclick=e=>{const s=e.target.dataset.s;if(!s)return;scope=s;
  // The gap view is explicitly about *proven* domains; the other scopes are
  // worklists and must never hide work behind a filter.
  $("tier").value=s===GAP?"2":"0";
  render();};

$("tabs").innerHTML=\`<button class="tab" data-p="\${ALLPROJ}">全部项目</button>\`
  +PROJECTS.map(p=>\`<button class="tab" data-p="\${p}">\${p}</button>\`).join("");
$("tabs").onclick=e=>{const p=e.target.dataset.p;if(!p)return;proj=p;render();};

$("seg").onclick=e=>{const v=e.target.dataset.v;if(!v)return;view=v;
  [...$("seg").children].forEach(b=>b.classList.toggle("on",b.dataset.v===v));render();};
["q","tier"].forEach(id=>$(id).addEventListener("input",render));

function loadStateFromUrl(){
  const params=new URLSearchParams(location.search);
  scope=QUERY_TO_SCOPE[params.get("scope")]||(CAMPAIGNS.length?CAMPAIGN:CORE);
  const project=params.get("project");
  proj=project&&(project===ALLPROJ||PROJECTS.includes(project))?project:ALLPROJ;
  const nextView=params.get("view");
  view=["todo","done","all"].includes(nextView)?nextView:"todo";
  $("q").value=params.get("q")||"";
  $("tier").value=params.has("tier")?params.get("tier"):(scope===GAP?"2":"0");
  [...$("seg").children].forEach(b=>b.classList.toggle("on",b.dataset.v===view));
}

function saveStateToUrl(){
  const params=new URLSearchParams();
  if(scope!==CORE) params.set("scope",SCOPE_TO_QUERY[scope]);
  if(proj!==ALLPROJ) params.set("project",proj);
  if(view!=="todo") params.set("view",view);
  const q=$("q").value.trim();
  if(q) params.set("q",q);
  if(scope!==CORE){
    if($("tier").value!=="0") params.set("tier",$("tier").value);
  }
  const query=params.toString();
  const next=location.pathname+(query?"?"+query:"")+location.hash;
  if(next!==location.pathname+location.search+location.hash) history.replaceState(null,"",next);
}

// Baseline admission = what we verified on the page ourselves: the anchor passes
// value (dofollow, or nofollow for referral) AND the page is indexable (robots
// checked, not noindex). GSC confirmation is a bonus badge, NOT the gate -
// gating on it required a domain to already be placed *and* reported, so no new
// target could ever enter the list a brand-new project is meant to be handed.
// Absence from GSC is absence of evidence: wox.cc has 3 Semrush links, 0 in GSC.
const WORTH=["dofollow","nofollow"];
const inCore=d=>d.decision==="active"&&WORTH.includes(d.linkRel)&&d.linkRobots==="indexable";
const campaignLabel=p=>p==="onethingatatime.app"?"OneThing":p==="perlerbeadpatterns.org"?"PerlerBeads":p.split(".")[0];

function render(){
  saveStateToUrl();
  [...$("scopes").children].forEach(b=>b.setAttribute("aria-selected",b.dataset.s===scope));
  [...$("tabs").children].forEach(b=>b.setAttribute("aria-selected",b.dataset.p===proj));
  const q=$("q").value.toLowerCase().trim();
  // The baseline list is a fixed, hand-vetted set — the generic filters would
  // silently shrink it, which is exactly the "list I can't trust" problem.
  $("tier").style.display=scope===CORE||scope===CAMPAIGN?"none":"";

  // --- Level 1: scope ---
  let pool=DATA.filter(d=>!q||d.website.toLowerCase().includes(q)||d.reason.toLowerCase().includes(q)||d.note.toLowerCase().includes(q));
  if(scope===CAMPAIGN){
    renderCampaign(pool);
    return;
  }
  if(scope===CORE) pool=pool.filter(inCore);
  else{
    pool=pool.filter(d=>d.tier>=+$("tier").value);
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
  const scored=pool.filter(d=>scope!==CORE||d.linkRel==="dofollow");
  const total=scored.length*scoped.length;
  const live=scored.reduce((n,d)=>n+scoped.filter(p=>d.status[p]==="live").length,0);
  $("bar").style.width=(total?Math.round(live/total*100):0)+"%";
  const extra=pool.length-scored.length;
  // Say how many domains, then how far each project has got. The slot arithmetic
  // ("15 × 3 = 45 个位置") is noise - nobody acts on the product.
  const done=p=>scored.filter(d=>d.status[p]==="live").length;
  const open=p=>scored.filter(d=>!d.status[p]).length;
  const pending=p=>scored.filter(d=>d.status[p]&&d.status[p]!=="live").length;
  $("count").textContent=\`\${scope===CORE?"🏆 保底名单":scope===GAP?"🎯 补齐缺口":"📋 全部域名"} \${scored.length} 个域名\`
    +(extra?\`（另有 \${extra} 个 nofollow，顺手做）\`:"")+"｜"
    +(one?\`\${proj} 已发 \${live}，待发 \${open(proj)}\${pending(proj)?\`，审核中 \${pending(proj)}\`:""}\`
        :MAIN.map(p=>\`\${p.split(".")[0]} \${done(p)}\`).join(" · "));

  // --- Level 3: 待发 / 已发 / 全部 ---
  const list=pool.filter(d=>view==="all"||(view==="done"?isDone(d):!isDone(d)));

  const GROUPS=scope===CORE?[["dofollow",CORELABEL.dofollow],["nofollow",CORELABEL.nofollow]]
    :[["dofollow",CORELABEL.dofollow],["nofollow",CORELABEL.nofollow],["",CORELABEL[""]]];
  $("list").innerHTML=GROUPS.map(([k,label])=>{
    const g=list.filter(d=>(d.linkRel||"")===k);
    if(!g.length) return "";
    // Actionable (never attempted) before blocked (parked/reviewing); DR breaks ties.
    const open=d=>need(d).filter(p=>!d.status[p]).length;
    g.sort((a,b)=>open(b)-open(a)||b.tier-a.tier||(b.dr??-1)-(a.dr??-1));
    return \`<h2 class="grp">\${label}<span>\${g.length}</span></h2>\`
      +g.map(d=>card(d,need(d))).join("");
  }).join("")||\`<div class="empty">\${view==="todo"?"这一档已经全部发完了 🎉":"没有匹配项。"}</div>\`;
}

function renderCampaign(pool){
  const eligible=pool.filter(inCore);
  const blocks=CAMPAIGNS.filter(c=>c.status==="active").map(c=>{
    const project=c.project;
    const target=c.target_live||5;
    const live=eligible.filter(d=>d.status[project]==="live");
    const todo=eligible.filter(d=>d.status[project]!=="live");
    const pending=todo.filter(d=>d.status[project]&&d.status[project]!=="live");
    const open=todo.filter(d=>!d.status[project]);
    const needCount=Math.max(0,target-live.length);
    const picks=needCount
      ? open.sort((a,b)=>(b.linkRel==="dofollow")-(a.linkRel==="dofollow")||b.tier-a.tier||(b.dr??-1)-(a.dr??-1)).slice(0,needCount)
      : [];
    return \`<section class="campaign">
      <div class="campaignHead">
        <h2>\${esc(campaignLabel(project))} <span class="campaignMeta">\${live.length}/\${target} active live</span></h2>
        <span class="campaignMeta">还差 \${Math.max(0,target-live.length)}；候选 \${open.length}；审核中 \${pending.length}</span>
      </div>
      \${picks.length?picks.map(d=>card(d,[project])).join(""):\`<div class="empty">这个项目当前已经达到 \${target} 个 active live；后续只需要补 index 或做更高质量替换。</div>\`}
    </section>\`;
  });
  const total=CAMPAIGNS.filter(c=>c.status==="active").reduce((n,c)=>n+(c.target_live||5),0);
  const liveCount=CAMPAIGNS.filter(c=>c.status==="active").reduce((n,c)=>n+Math.min(c.target_live||5,eligible.filter(d=>d.status[c.project]==="live").length),0);
  $("bar").style.width=(total?Math.round(liveCount/total*100):0)+"%";
  $("count").textContent=\`🎯 本轮目标｜\${liveCount}/\${total} active live；只显示每个项目下一批可发候选\`;
  $("list").innerHTML=blocks.join("")||'<div class="empty">没有 active campaign。</div>';
}

const LABEL={live:"✅ live",reviewing:"🟡 审核中",parked:"⛔ 卡住",unverified:"❓ 待核实",nolink:"⚠️ 发了但没链接"};
const INDEX_LABEL={indexed:"Google indexed",not_found:"site: 未发现",gsc_seen:"GSC seen",unverified:"未查收录"};
const DECISION_LABEL={active:"做",needs_review:"待复查",rejected:"不做"};
const ROBOTS_LABEL={indexable:"indexable",noindex:"noindex",blocked:"blocked",unknown:"robots unknown","":"robots unknown"};
const PRICING_LABEL={free:"免费",paid:"付费",reciprocal:"互链",credits:"积分",freemium:"免费+付费"};

// Which project a card is "about". A project tab sets it directly; the baseline
// view sets it via its own picker. GAP and 全部项目 have no single subject.
function lens(){return proj===ALLPROJ?null:proj;}

function card(d,need){
  const f=lens();
  const st=f?d.status[f]:"";
  const openNeed=(need||[]).filter(p=>!d.status[p]);
  const pendingNeed=(need||[]).filter(p=>d.status[p]);
  // Live links on other projects double as the how-to reference for this domain.
  // The current project's own link must come first and be marked, otherwise the
  // done view shows only *other* projects and reads as "mine is missing".
  const self=st==="live"&&d.detail[f]
    ?\`<a class="tag mine" href="\${esc(d.detail[f])}" target="_blank" rel="noopener">\${esc(f.split("/")[0])} ↗ 本项目</a>\`:"";
  const idxStatus=f?d.indexStatus[f]:"";
  const indexBadge=idxStatus
    ?\`<span class="tag \${idxStatus==="indexed"||idxStatus==="gsc_seen"?"ok":""}" title="\${esc(d.indexSource[f]||"")} \${esc(d.indexChecked[f]||"")}">\${INDEX_LABEL[idxStatus]||esc(idxStatus)}</span>\`
    :"";
  const decisionBadge=\`<span class="tag \${d.decision==="active"?"ok":""}" title="\${esc(d.reason)}">\${DECISION_LABEL[d.decision]||esc(d.decision)}</span>\`;
  const relBadge=d.linkRel?\`<span class="tag \${d.linkRel==="dofollow"?"ok":""}" title="\${esc(d.linkChecked)}">rel: \${esc(d.linkRel)}</span>\`:"";
  const robotsBadge=d.linkRobots?\`<span class="tag \${d.linkRobots==="indexable"?"ok":"hard"}" title="\${esc(d.linkChecked)}">\${ROBOTS_LABEL[d.linkRobots]||esc(d.linkRobots)}</span>\`:"";
  const typeText=[d.typePrimary,d.typeSurface].filter(v=>v&&v!=="unknown").join(" / ");
  const typeBadge=typeText?\`<span class="tag">\${esc(typeText)}</span>\`:"";
  const pricingText=d.pricingModel&&d.pricingModel!=="unknown"?(PRICING_LABEL[d.pricingModel]||d.pricingModel):"";
  const pricingBadge=pricingText?\`<span class="tag">\${esc(pricingText)}</span>\`:"";
  const evidence=self+" "+PROJECTS.filter(p=>p!==f&&d.status[p]==="live"&&d.detail[p])
    .map(p=>\`<a class="tag ok" href="\${esc(d.detail[p])}" target="_blank" rel="noopener">\${esc(p.split("/")[0])} ↗</a>\`).join(" ");
  const link=st==="live"&&d.detail[f]?d.detail[f]:"https://"+d.website;
  const why=st&&st!=="live"&&d.detail[f]?\`<div class="note">\${LABEL[st]||st}：\${esc(d.detail[f])}</div>\`:"";
  return \`<div class="row \${st==="live"&&view!=="done"?"done":""}">
    <div class="top">
      <a class="site" href="\${esc(link)}" target="_blank" rel="noopener">\${esc(d.website)}</a>
      \${decisionBadge}
      \${typeBadge}
      \${pricingBadge}
      \${d.gsc?\`<span class="tag gsc" title="Google Search Console 自己报告过来自这个域名的链接（\${esc(d.gsc)}）">🔎 GSC 确认</span>\`:""}
      \${indexBadge}
      \${relBadge}
      \${robotsBadge}
      \${d.dr!=null?\`<span class="dr">DR \${d.dr}</span>\`:""}
      \${d.tier>=2?\`<span class="tier">✅ 验证 \${d.tier}×</span>\`:d.tier===1?'<span class="tier" style="color:var(--muted)">🟡 live 1×</span>':""}
      \${evidence}
    </div>
    \${openNeed.length?\`<div class="need">还差：\${openNeed.map(p=>\`<a href="\${esc(link)}" target="_blank" rel="noopener">\${esc(p)}</a>\`).join("")}</div>\`:""}
    \${pendingNeed.length?\`<div class="need">审核中：\${pendingNeed.map(p=>{
      const s=d.status[p], u=d.detail[p], label=\`\${esc(p.split("/")[0])} \${LABEL[s]||s}\`;
      return u
        ?\`<a class="tag \${s==="parked"?"hard":""}" href="\${esc(u)}" target="_blank" rel="noopener" title="打开审核页">\${label} ↗</a>\`
        :\`<span class="tag \${s==="parked"?"hard":""}">\${label}</span>\`;
    }).join("")}</div>\`:""}
    \${why}
    \${d.note?\`<div class="note clip" onclick="this.classList.toggle('clip')">\${esc(d.note)}</div>\`:""}
  </div>\`;
}
loadStateFromUrl();
render();
</script></body></html>`;

writeFileSync(OUT, html);
console.log(`wrote ${OUT} (${data.length} targets, ${projects.length} projects)`);
if (process.argv.includes("--open")) execFileSync("open", [OUT]);

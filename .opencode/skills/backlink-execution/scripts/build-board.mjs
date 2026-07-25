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
// Rejected rows ship to the board too, but the client hides them unless you
// search — otherwise "所有项目都别再出现" would be a one-way door with no way to
// find the domain again and undo it.
const records = master.websites || [];

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
  // Date Google Search Console reported this referring domain. This proves
  // Googlebot discovered the link, not that the placement page is indexed or
  // passing meaningful ranking signal.
  gsc: r.gsc?.seen_at || "",
  dr: r.authority?.dr ?? null,
  note: r.note || "",
  status: Object.fromEntries(projects.map((p) => [p, placementFor(r, p).status || ""])),
  detail: Object.fromEntries(projects.map((p) => [p, placementFor(r, p).url || placementFor(r, p).detail || ""])),
  campaignId: Object.fromEntries(projects.map((p) => [p, placementFor(r, p).campaign_id || ""])),
  submittedAt: Object.fromEntries(projects.map((p) => [p, placementFor(r, p).submitted_at || ""])),
  // Why the user gave up on this pairing, written on the board when they hit 发不了.
  blockedReason: Object.fromEntries(projects.map((p) => [p, placementFor(r, p).reason || ""])),
  blockedAt: Object.fromEntries(projects.map((p) => [p, placementFor(r, p).blocked_at || ""])),
  followUpAt: Object.fromEntries(projects.map((p) => [p, placementFor(r, p).follow_up_at || ""])),
  indexStatus: Object.fromEntries(projects.map((p) => [p, placementFor(r, p).index?.status || ""])),
  indexChecked: Object.fromEntries(projects.map((p) => [p, placementFor(r, p).index?.checked_at || ""])),
  indexSource: Object.fromEntries(projects.map((p) => [p, placementFor(r, p).index?.source || ""])),
}));

function placementFor(site, project) {
  return (site.placements || []).find((placement) => placement.project === project) || {};
}

// "tier" = on how many projects this domain has already been used. This is a
// placement-attempt signal; Google indexing stays on the separate index axis.
const placedStatus = (status) => ["submitted", "reviewing", "verified", "live"].includes(status);
for (const d of data) d.tier = projects.filter((p) => placedStatus(d.status[p])).length;
// Sub-page targets (contain "/") aren't separate sites; gaps are tracked per real project.
const mainProjects = projects.filter((p) => !p.includes("/"));

const html = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Backlink Board</title>
<style>
:root{--bg:#fbfaf8;--fg:#1c1b19;--muted:#6f6a63;--faint:#9a948c;--line:#e6e2db;--card:#fff;--acc:#b4552d;--ok:#3f7d4e}
@media(prefers-color-scheme:dark){:root{--bg:#161513;--fg:#eceae6;--muted:#968f86;--faint:#8a8279;--line:#2e2c28;--card:#1e1d1a;--acc:#e08a5d;--ok:#7fb98d}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 ui-sans-serif,-apple-system,"PingFang SC",system-ui,sans-serif}

/* ── header: three flat controls, no cross-product of filters ────────── */
header{position:sticky;top:0;background:var(--bg);border-bottom:1px solid var(--line);padding:12px 20px 10px;z-index:5}
.hrow{display:flex;gap:10px;align-items:center;flex-wrap:wrap;max-width:920px}
.hrow+.hrow{margin-top:9px}
h1{margin:0;font-size:15px;font-weight:650;letter-spacing:-.01em;white-space:nowrap}
.seg{display:inline-flex;border:1px solid var(--line);border-radius:8px;overflow:hidden;background:var(--card)}
.seg button{border:0;background:transparent;color:var(--muted);padding:6px 13px;font-size:13px;cursor:pointer;white-space:nowrap}
.seg button+button{border-left:1px solid var(--line)}
.seg button.on{background:var(--acc);color:#fff}
.tabs{display:flex;gap:5px;flex-wrap:wrap}
.tab{border:1px solid var(--line);background:var(--card);color:var(--muted);padding:4px 11px;border-radius:99px;cursor:pointer;font-size:13px}
.tab[aria-selected=true]{background:var(--fg);border-color:var(--fg);color:var(--bg)}
input[type=search]{flex:1;min-width:150px;padding:6px 11px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--fg);font-size:14px}
.prog{height:4px;background:var(--line);border-radius:99px;overflow:hidden;margin-top:10px;max-width:920px}
.prog>i{display:block;height:100%;background:var(--ok);transition:width .2s}
.count{font-size:12.5px;color:var(--muted);margin-top:7px;max-width:920px}

/* ── list ─────────────────────────────────────────────────────────────── */
main{padding:14px 20px 64px;display:grid;gap:7px;max-width:920px}
h2.grp{margin:12px 0 1px;font-size:12.5px;font-weight:650;color:var(--muted);display:flex;gap:7px;align-items:center}
h2.grp:first-child{margin-top:0}
h2.grp span{font-weight:400;opacity:.65;font-variant-numeric:tabular-nums}
h2.grp a{color:inherit;text-decoration:none;cursor:pointer}
h2.grp a:hover{color:var(--acc)}
.empty{color:var(--muted);font-size:14px;padding:18px 0}

.row{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 13px}
.top{display:flex;gap:9px;align-items:baseline}
.site{font-weight:600;font-size:15px;text-decoration:none;color:var(--fg);word-break:break-all}
.site:hover{color:var(--acc)}
.dr{font-size:12px;color:var(--faint);font-variant-numeric:tabular-nums}
.spacer{flex:1}
/* One state chip per card, right-aligned. Everything else is plain text. */
.chip{font-size:11.5px;padding:1px 8px;border-radius:99px;border:1px solid var(--line);color:var(--muted);white-space:nowrap}
.chip.ok{color:var(--ok);border-color:var(--ok)}
.chip.warn{color:var(--acc);border-color:var(--acc)}
/* Meta replaces the old badge pile: one muted line, dot-separated. */
.meta{margin-top:3px;font-size:12.5px;color:var(--faint);display:flex;gap:6px;flex-wrap:wrap;align-items:baseline}
.meta i{font-style:normal}
.meta i+i:before{content:"·";margin-right:6px;color:var(--line)}
.meta .flag{color:var(--acc)}
.meta .good{color:var(--ok)}
.act{margin-top:7px;font-size:12.5px;color:var(--muted);display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.act a{font-size:12px;padding:1px 9px;border-radius:99px;text-decoration:none;border:1px dashed var(--acc);color:var(--acc)}
.act a:hover{background:var(--acc);color:#fff;border-style:solid}
.act a.ref{border:1px solid var(--line);color:var(--muted);border-style:solid}
.act a.ref:hover{background:transparent;border-color:var(--acc);color:var(--acc)}
.note{margin-top:6px;font-size:12.5px;color:var(--faint);white-space:pre-wrap;word-break:break-word}
.note.clip{display:-webkit-box;-webkit-line-clamp:1;-webkit-box-orient:vertical;overflow:hidden;cursor:pointer}

/* ── the one write path: mark a placement done ───────────────────────── */
.edit{margin-top:8px;display:flex;gap:7px;align-items:center}
.edit .check{display:flex;align-items:center;gap:5px;font-size:13px;color:var(--fg);white-space:nowrap}
.edit .check input{margin:0}
.edit .placementUrl{flex:1;min-width:160px;padding:6px 9px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg);font-size:13px}
.edit button{border:1px solid var(--ok);background:var(--ok);color:#fff;padding:6px 11px;border-radius:8px;font-size:13px;cursor:pointer;white-space:nowrap}
.edit button:disabled{opacity:.55;cursor:wait}
.edit button.ghost{background:transparent;border-color:var(--line);color:var(--muted)}
.edit button.ghost:hover{border-color:var(--acc);color:var(--acc)}
.editMsg{font-size:12px;color:var(--muted)}
/* 发不了: hidden until asked for, so the common path stays a checkbox + save. */
.block{margin-top:7px;display:none;gap:7px;align-items:center;flex-wrap:wrap}
.block.open{display:flex}
.block .reason{flex:1;min-width:200px;padding:6px 9px;border:1px solid var(--acc);border-radius:8px;background:var(--bg);color:var(--fg);font-size:13px}
.block .scopes{display:flex;gap:10px;flex-wrap:wrap}
.block .scope{display:flex;align-items:center;gap:4px;font-size:12.5px;color:var(--muted);white-space:nowrap;cursor:pointer}
.block .scope input{margin:0}
.block button{border:1px solid var(--acc);background:var(--acc);color:#fff;padding:6px 11px;border-radius:8px;font-size:13px;cursor:pointer;white-space:nowrap}
.block button.ghost{background:transparent;color:var(--muted);border-color:var(--line)}
.blocked{margin-top:6px;font-size:12.5px;color:var(--acc)}

/* ── campaign block ───────────────────────────────────────────────────── */
.campaign{display:grid;gap:7px;margin-bottom:18px}
.campaignHead{display:flex;gap:10px;align-items:baseline;justify-content:space-between;flex-wrap:wrap;border-bottom:1px solid var(--line);padding-bottom:6px}
.campaignHead h2{margin:0;font-size:14px;font-weight:650}
.campaignMeta{font-size:12px;color:var(--faint)}
/* "no picks" has two causes and they need opposite reactions — quota met is a
   win, an empty pool is a restock order. Never render them the same way. */
.stall{border:1px dashed var(--acc);border-radius:10px;padding:12px 13px;font-size:13.5px;color:var(--fg);line-height:1.75}
.stall b{color:var(--acc)}
.stall .sub{display:block;font-size:12.5px;color:var(--faint)}
.stall .next{display:block;font-size:12.5px;color:var(--acc);margin-top:4px}
</style></head><body>
<header>
  <div class="hrow">
    <h1>Backlink Board</h1>
    <span class="seg" id="view">
      <button data-v="today">今天发</button><button data-v="pool">候选池</button><button data-v="done">已发过</button>
    </span>
    <input type="search" id="q" placeholder="搜域名 / reason / note…">
  </div>
  <div class="hrow"><div class="tabs" id="tabs"></div></div>
  <div class="prog"><i id="bar"></i></div>
  <div class="count" id="count"></div>
</header>
<main id="list"></main>
<script>
const DATA=${JSON.stringify(data)};
const PROJECTS=${JSON.stringify(projects)};
const CAMPAIGNS=${JSON.stringify(campaigns)};
const MAIN=${JSON.stringify(mainProjects)};
const ALLPROJ="__allproj__";

// Two axes only, and they never fight each other:
//   proj — whose worklist        (全部项目 / one project)
//   view — 今天发 / 候选池 / 已发过
// The old board had four filter groups (scope × project × tier × 待发/已发)
// whose cross-product hid work in ways nobody could predict. Everything the
// tier/gap filters used to express is now expressed by sort order instead.
let proj=ALLPROJ, view=CAMPAIGNS.some(c=>c.status==="active")?"today":"pool";
// Collapsed sections at the bottom of 候选池. Their headers stay visible with a
// count, so a deferred "要钱" target is never silently forgotten.
const open={defer:false,raw:false};

const $=(id)=>document.getElementById(id);
const esc=s=>String(s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const EDITABLE=location.protocol.startsWith("http")&&["127.0.0.1","localhost"].includes(location.hostname);

// Worth placing = the anchor passes value (dofollow, or nofollow for referral)
// AND the page allows indexing. GSC is crawler-discovery evidence only: it can
// report links from pages Google crawled but refused to keep in the index.
const WORTH=["dofollow","nofollow"];
const placedStatus=status=>["submitted","reviewing","verified","live"].includes(status);
const vetted=d=>d.decision==="active"&&WORTH.includes(d.linkRel)&&d.linkRobots==="indexable";
const short=p=>p.split("/")[0].split(".")[0];

$("tabs").innerHTML=\`<button class="tab" data-p="\${ALLPROJ}">全部项目</button>\`
  +PROJECTS.map(p=>\`<button class="tab" data-p="\${p}">\${esc(p)}</button>\`).join("");
$("tabs").onclick=e=>{const p=e.target.dataset.p;if(!p)return;proj=p;render();};
$("view").onclick=e=>{const v=e.target.dataset.v;if(!v)return;view=v;render();};
$("q").addEventListener("input",render);
document.addEventListener("click",e=>{
  const key=e.target.dataset&&e.target.dataset.toggle;
  if(key){e.preventDefault();open[key]=!open[key];render();}
});

function loadStateFromUrl(){
  const params=new URLSearchParams(location.search);
  const p=params.get("project");
  proj=p&&(p===ALLPROJ||PROJECTS.includes(p))?p:ALLPROJ;
  const v=params.get("view");
  view=["today","pool","done"].includes(v)?v:(CAMPAIGNS.some(c=>c.status==="active")?"today":"pool");
  open.raw=params.get("raw")==="1";
  open.defer=params.get("defer")==="1";
  $("q").value=params.get("q")||"";
}

function saveStateToUrl(){
  const params=new URLSearchParams();
  if(proj!==ALLPROJ) params.set("project",proj);
  params.set("view",view);
  if(open.raw) params.set("raw","1");
  if(open.defer) params.set("defer","1");
  const q=$("q").value.trim();
  if(q) params.set("q",q);
  const next=location.pathname+"?"+params.toString()+location.hash;
  if(next!==location.pathname+location.search+location.hash) history.replaceState(null,"",next);
}

function render(){
  saveStateToUrl();
  [...$("tabs").children].forEach(b=>b.setAttribute("aria-selected",b.dataset.p===proj));
  [...$("view").children].forEach(b=>b.classList.toggle("on",b.dataset.v===view));
  const q=$("q").value.toLowerCase().trim();
  // Rejected domains are out of the worklist, but searchable — that's the only
  // way back from a 所有项目都别再出现 you regret.
  const pool=DATA.filter(d=>q
    ?(d.website.toLowerCase().includes(q)||d.reason.toLowerCase().includes(q)||d.note.toLowerCase().includes(q))
    :d.decision!=="rejected");
  if(view==="today") return renderToday(pool);
  renderList(pool);
}

// Quota met vs. pool exhausted. The old board printed "已发完 🎉" for both,
// which read as a win at exactly the moment the list needed restocking.
function emptyState(pool,project,target,left,doneNow){
  if(left===0) return \`<div class="empty">本轮 \${target} 个已发完 🎉 — 让 agent 开下一轮</div>\`;
  const placedEver=pool.filter(d=>vetted(d)&&placedStatus(d.status[project])).length;
  const parked=pool.filter(d=>d.status[project]==="parked").length;
  const deferred=pool.filter(d=>d.decision==="deferred").length;
  const unvetted=pool.filter(d=>d.decision!=="rejected"&&d.decision!=="deferred"&&!d.linkRel&&!d.status[project]).length;
  return \`<div class="stall">
    <b>候选见底</b> — 还差 \${left} 个，但这个项目已经没有可直接做的目标了。
    <span class="sub">名单里 \${placedEver} 个全发过了 · 发不了 \${parked} · 暂缓 \${deferred} · 未复查 \${unvetted}</span>
    <span class="next">→ 补货：让 agent 从这 \${unvetted} 个未复查域名里查出 rel / robots，够格的才进名单；查不出就去跑一轮 prospecting 找新竞品外链</span>
  </div>\`;
}

// ── 今天发 ───────────────────────────────────────────────────────────────
// Only shows what to do next: per active campaign, the top N never-attempted
// targets. No filters apply here beyond search and the project tab.
function renderToday(pool){
  const eligible=pool.filter(vetted);
  const active=CAMPAIGNS.filter(c=>c.status==="active"&&(proj===ALLPROJ||c.project===proj));
  const blocks=active.map(c=>{
    const project=c.project, id=c.id||project, target=c.target_live||5;
    const doneNow=eligible.filter(d=>placedStatus(d.status[project])&&d.campaignId[project]===id);
    const ready=eligible.filter(d=>!d.status[project]);
    const review=pool.filter(d=>d.decision==="needs_review"&&!d.status[project]&&WORTH.includes(d.linkRel));
    const left=Math.max(0,target-doneNow.length);
    const rank=items=>items.sort((a,b)=>(b.linkRel==="dofollow")-(a.linkRel==="dofollow")||b.tier-a.tier||(b.dr??-1)-(a.dr??-1));
    const picks=rank(ready).concat(rank(review)).slice(0,left);
    return \`<section class="campaign">
      <div class="campaignHead">
        <h2>\${esc(short(project))} — 还差 \${left}</h2>
        <span class="campaignMeta">本轮 \${doneNow.length}/\${target}｜可直接做 \${ready.length}｜待复查 \${review.length}</span>
      </div>
      \${picks.length?picks.map(d=>card(d,[project])).join(""):emptyState(pool,project,target,left,doneNow.length)}
    </section>\`;
  });
  const target=active.reduce((n,c)=>n+(c.target_live||5),0);
  const done=active.reduce((n,c)=>{const id=c.id||c.project;
    return n+Math.min(c.target_live||5,eligible.filter(d=>placedStatus(d.status[c.project])&&d.campaignId[c.project]===id).length);},0);
  $("bar").style.width=(target?Math.round(done/target*100):0)+"%";
  $("count").textContent=\`本轮目标 \${done}/\${target}｜只列没发过的候选，发完在卡片上勾「已发」\`;
  $("list").innerHTML=blocks.join("")||'<div class="empty">没有 active campaign。到候选池自己挑。</div>';
}

// ── 候选池 / 已发过 ──────────────────────────────────────────────────────
function renderList(pool){
  const scoped=proj!==ALLPROJ?[proj]:MAIN;
  const placedAll=d=>scoped.every(p=>placedStatus(d.status[p]));
  const need=d=>scoped.filter(p=>!placedStatus(d.status[p]));
  const list=pool.filter(d=>view==="done"?scoped.some(p=>placedStatus(d.status[p])):!placedAll(d));

  const scored=pool.filter(d=>vetted(d)&&d.linkRel==="dofollow");
  const placed=scored.reduce((n,d)=>n+scoped.filter(p=>placedStatus(d.status[p])).length,0);
  const total=scored.length*scoped.length;
  $("bar").style.width=(total?Math.round(placed/total*100):0)+"%";
  $("count").textContent=proj!==ALLPROJ
    ?\`\${proj}｜dofollow 名单 \${scored.length} 个，已发 \${scored.filter(d=>placedStatus(d.status[proj])).length}\`
    :\`dofollow 名单 \${scored.length} 个｜\${MAIN.map(p=>\`\${short(p)} \${scored.filter(d=>placedStatus(d.status[p])).length}\`).join(" · ")}\`;

  // Vetted first (that's the worklist), unchecked domains folded away — they are
  // prospecting backlog, not something to act on today.
  const deferred=d=>d.decision==="deferred";
  const groups=[
    ["dofollow","✅ dofollow + 可索引",d=>vetted(d)&&d.linkRel==="dofollow"],
    ["nofollow","🟡 nofollow + 可索引",d=>vetted(d)&&d.linkRel==="nofollow"],
    ["other","⚠️ 已复查但有问题",d=>!vetted(d)&&!deferred(d)&&d.linkRel],
  ];
  // Never-attempted before blocked; then reuse-proven; then DR.
  const openCount=d=>need(d).filter(p=>!d.status[p]).length;
  const rank=g=>g.sort((a,b)=>openCount(b)-openCount(a)||b.tier-a.tier||(b.dr??-1)-(a.dr??-1));
  let html=groups.map(([k,label,test])=>{
    const g=rank(list.filter(test));
    if(!g.length) return "";
    return \`<h2 class="grp">\${label}<span>\${g.length}</span></h2>\`+g.map(d=>card(d,need(d))).join("");
  }).join("");
  // Folded tails: still counted in the header so they don't vanish from mind.
  const fold=(key,label,items)=>{
    if(!items.length) return "";
    let out=\`<h2 class="grp"><a href="#" data-toggle="\${key}">\${open[key]?"▾":"▸"} \${label}</a><span>\${items.length}</span></h2>\`;
    if(open[key]) out+=items.map(d=>card(d,need(d))).join("");
    return out;
  };
  html+=fold("defer","⏸ 暂缓 — 要钱 / 有门槛，钱到位或条件变了再回来看",rank(list.filter(deferred)));
  html+=fold("raw","未复查（先查 rel / robots 再谈）",list.filter(d=>!deferred(d)&&!d.linkRel).sort((a,b)=>(b.dr??-1)-(a.dr??-1)));
  $("list").innerHTML=html||\`<div class="empty">\${view==="done"?"还没有已发记录。":"没有匹配项。"}</div>\`;
}

// ── card ─────────────────────────────────────────────────────────────────
const LABEL={submitted:"已提交",verified:"已验证",live:"已验证",reviewing:"审核中",parked:"发不了",unverified:"待核实",nolink:"发了但没链接"};
const INDEX_LABEL={indexed:"已收录",not_found:"site: 未发现",gsc_seen:"GSC 发现",unverified:"待查收录"};
const TYPE_LABEL={profile:"profile",ugc_article:"投稿",startup_directory:"创业目录",product_directory:"产品目录",blog_comment:"博客评论",review_site:"评测站",docs_or_wiki:"文档/wiki",forum:"论坛",social:"社交",ai_directory:"AI 目录"};
const PRICING_LABEL={free:"免费",paid:"付费",reciprocal:"互链",credits:"积分",freemium:"免费+付费",free_with_paid_upgrade:"免费+付费"};

// Which project a card is "about". A project tab sets it directly; campaign
// cards pass exactly one project, so they stay editable under 全部项目.
function lens(need){return proj!==ALLPROJ?proj:((need||[]).length===1?need[0]:null);}

function card(d,need){
  const f=lens(need);
  const st=f?d.status[f]:"";
  const isPlaced=placedStatus(st);
  const openNeed=(need||[]).filter(p=>!placedStatus(d.status[p]));

  const isRejected=d.decision==="rejected";
  const isDeferred=d.decision==="deferred";

  // ONE chip, right-aligned: the state of this card for the project in focus.
  let chip="";
  if(isRejected){
    chip=\`<span class="chip warn" title="\${esc(d.reason)}">⛔ 所有项目已排除</span>\`;
  }else if(isDeferred){
    chip=\`<span class="chip" title="\${esc(d.reason)}">⏸ 暂缓</span>\`;
  }else if(f&&isPlaced){
    const idx=d.indexStatus[f];
    chip=\`<span class="chip ok" title="\${esc(d.submittedAt[f]||"")}">✓ 已发\${idx&&idx!=="unverified"?"｜"+INDEX_LABEL[idx]:""}</span>\`;
  }else if(f&&st){
    chip=\`<span class="chip warn" title="\${esc(d.detail[f]||"")}">\${LABEL[st]||esc(st)}</span>\`;
  }else if(!f&&d.tier){
    chip=\`<span class="chip">已发 \${d.tier} 个项目</span>\`;
  }

  // Everything that used to be a badge is now one muted, dot-separated line.
  const meta=[];
  if(d.decision==="needs_review") meta.push('<i class="flag">待复查</i>');
  const type=TYPE_LABEL[d.typePrimary]||(d.typePrimary&&d.typePrimary!=="unknown"?d.typePrimary:"");
  if(type) meta.push(\`<i>\${esc(type)}</i>\`);
  const price=PRICING_LABEL[d.pricingModel];
  if(price) meta.push(\`<i class="\${d.pricingModel==="paid"?"flag":""}">\${price}</i>\`);
  if(d.linkRel) meta.push(\`<i class="\${d.linkRel==="dofollow"?"good":""}">\${d.linkRel}</i>\`);
  if(d.linkRobots&&d.linkRobots!=="indexable") meta.push(\`<i class="flag">\${esc(d.linkRobots)}</i>\`);
  if(d.gsc) meta.push(\`<i class="good" title="GSC 报告过来自这个域名的链接（\${esc(d.gsc)}）；只说明 Googlebot 发现过，不等于已收录">GSC 发现</i>\`);
  if(f&&d.tier) meta.push(\`<i>已用 \${d.tier}×</i>\`);

  // Placed links on other projects double as the how-to reference for this domain.
  const refs=PROJECTS.filter(p=>p!==f&&placedStatus(d.status[p])&&d.detail[p])
    .map(p=>\`<a class="ref" href="\${esc(d.detail[p])}" target="_blank" rel="noopener">\${esc(short(p))} ↗</a>\`).join("");
  const self=f&&isPlaced&&d.detail[f]
    ?\`<a class="ref" href="\${esc(d.detail[f])}" target="_blank" rel="noopener">本项目链接 ↗</a>\`:"";
  const act=[];
  if(!f&&openNeed.length) act.push(\`<span>还差</span>\`+openNeed.map(p=>\`<a href="https://\${esc(d.website)}" target="_blank" rel="noopener">\${esc(short(p))}</a>\`).join(""));
  if(self||refs) act.push((self||"")+(refs?\`<span>参考</span>\`+refs:""));

  const link=isPlaced&&d.detail[f]?d.detail[f]:"https://"+d.website;
  const isBlocked=f&&st==="parked";
  const marked=isRejected||isDeferred;
  const blockedNote=isRejected
    ?\`<div class="blocked">⛔ 所有项目已排除：\${esc(d.reason||"没写理由")}</div>\`
    :isDeferred
      ?\`<div class="blocked">⏸ 暂缓：\${esc(d.reason||"没写理由")}</div>\`
      :isBlocked&&d.blockedReason[f]
        ?\`<div class="blocked">⛔ 发不了：\${esc(d.blockedReason[f])}\${d.blockedAt[f]?\`（\${esc(d.blockedAt[f])}）\`:""}</div>\`:"";
  const edit=f&&EDITABLE?\`<form class="edit" data-website="\${esc(d.website)}" data-project="\${esc(f)}" onsubmit="return savePlacement(event)">
      <label class="check"><input name="submitted" type="checkbox" \${isPlaced?"checked":""}> 已发</label>
      <input class="placementUrl" type="text" value="\${esc(d.detail[f]||"")}" placeholder="外链 URL（可选）">
      <button type="submit">保存</button>
      <button type="button" class="ghost" onclick="toggleBlock(this)">\${isBlocked||marked?"改理由":"发不了"}</button>
      \${isBlocked||marked?'<button type="button" class="ghost" onclick="clearBlock(this)">恢复</button>':""}
      <span class="editMsg"></span>
    </form>
    <form class="block" data-website="\${esc(d.website)}" data-project="\${esc(f)}" onsubmit="return saveBlock(event)">
      <input class="reason" type="text" value="\${esc(marked?d.reason:d.blockedReason[f]||"")}" placeholder="为什么发不了？（要写，两周后你会忘）">
      <div class="scopes">
        <label class="scope"><input name="scope" type="radio" value="project" \${!marked?"checked":""}> 只这个项目不发</label>
        <label class="scope"><input name="scope" type="radio" value="defer" \${isDeferred?"checked":""}> 所有项目暂缓（要钱 / 有门槛）</label>
        <label class="scope"><input name="scope" type="radio" value="site" \${isRejected?"checked":""}> 所有项目排除（这站不行）</label>
      </div>
      <button type="submit">确认</button>
      <span class="editMsg"></span>
    </form>\`:"";

  return \`<div class="row">
    <div class="top">
      <a class="site" href="\${esc(link)}" target="_blank" rel="noopener">\${esc(d.website)}</a>
      \${d.dr!=null?\`<span class="dr">DR \${d.dr}</span>\`:""}
      <span class="spacer"></span>\${chip}
    </div>
    \${meta.length?\`<div class="meta">\${meta.join("")}</div>\`:""}
    \${act.length?\`<div class="act">\${act.join(" ")}</div>\`:""}
    \${blockedNote}
    \${edit}
    \${d.note?\`<div class="note clip" onclick="this.classList.toggle('clip')">\${esc(d.note)}</div>\`:""}
  </div>\`;
}

// Single write path for both forms: POST, then reload so the card re-renders
// from the rebuilt board rather than from guessed local state.
async function post(form,endpoint,body){
  const buttons=[...form.querySelectorAll("button")];
  const msg=form.querySelector(".editMsg");
  buttons.forEach(b=>b.disabled=true);
  msg.textContent="保存中…";
  try{
    const res=await fetch(endpoint,{method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify({website:form.dataset.website,project:form.dataset.project,...body})});
    const json=await res.json().catch(()=>({}));
    if(!res.ok) throw new Error(json.error||"保存失败");
    msg.textContent="已保存";
    location.reload();
  }catch(err){
    msg.textContent=err.message||"保存失败";
    buttons.forEach(b=>b.disabled=false);
  }
  return false;
}

function savePlacement(event){
  event.preventDefault();
  const form=event.currentTarget;
  return post(form,"/api/placements",{
    url:form.querySelector(".placementUrl").value.trim(),
    submitted:form.elements.submitted.checked
  });
}

function toggleBlock(button){
  const block=button.closest(".row").querySelector(".block");
  block.classList.toggle("open");
  if(block.classList.contains("open")) block.querySelector(".reason").focus();
}

function saveBlock(event){
  event.preventDefault();
  const form=event.currentTarget;
  return post(form,"/api/blocked",{
    reason:form.querySelector(".reason").value.trim(),
    scope:form.querySelector("input[name=scope]:checked").value
  });
}

function clearBlock(button){
  const form=button.closest(".row").querySelector(".block");
  return post(form,"/api/blocked",{clear:true});
}
loadStateFromUrl();
render();
</script></body></html>`;

writeFileSync(OUT, html);
console.log(`wrote ${OUT} (${data.length} targets, ${projects.length} projects)`);
if (process.argv.includes("--open")) execFileSync("open", [OUT]);

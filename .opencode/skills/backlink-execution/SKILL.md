---
name: backlink-execution
description: Execute live backlink placements from the backlink master JSON, and audit/vet the baseline list for real dofollow + indexing. Use when the user asks to do backlink building, build backlinks, work through backlink targets, register or submit a target site, create live listings/posts/profiles/comments, handle real submission flows, run a campaign round, or verify/clean/audit which baseline targets are genuinely dofollow and indexed (GSC/`site:`) and promote/demote them. User-led: propose candidates and wait for the user to pick before placing. Only use this after targets already exist in the master. Not for competitor export parsing, candidate generation, or triage; use `backlink-prospecting` for that.
---

Build real backlink placements from an existing target list. This skill owns execution, not prospecting.

## Posture: User-Led, Quality Over Quantity

Two standing rules from the user override the "just work through the list" instinct:

- **The user drives; you propose.** Do not autonomously start placing links. Surface a shortlist of candidates with your reasoning, and wait for the user to pick before you touch any flow. Login, registration, and verification are the user's to do anyway, so a run that starts without them is a run that stalls. Propose → user picks → you execute the parts you can → hand the auth/verify step back.
- **The goal is a trustworthy baseline, not volume.** Success is not "N more links placed." It is *high-quality resources that genuinely pass value and are genuinely indexed, distilled into the baseline list*. A placement whose indexing you cannot confirm is not a win — do not chase count with links you can't verify Google will keep.

**The dofollow/nofollow boundary (user's rule):** finish the dofollow targets first. Touch nofollow only with spare capacity left over, and **never prioritize it** — never place a nofollow link to pad the count. Cheap-and-fast is not a reason to do anything.

**The user's word settles verification (user's rule).** When the user says a placement is live / passed / already verified, take it as verified — do **not** re-open the page in a browser to confirm. Skip straight to the write-back and regenerate the board. Only run the browser `/eval` check yourself when the status is unconfirmed and *nobody* has told you the outcome.

## What This Skill Does

Your effort goes to exactly three things. Everything else is a hand-off.

1. **Figure out how to get the backlink** — determine the site's real link surface (article body, comment author URL, profile, listing, signature) before touching any flow.
2. **Fill the forms** — fill the straightforward fields of submission/listing/post forms and prepare the content.
3. **Record and update the master JSON** — after every target, write the result back: the live URL on success, the reusable site know-how that makes the *next* project's placement on this same site faster, and, when a target is not doable, the concrete reason why. See [Write-Back Discipline](#write-back-discipline).

Placement is one of two modes. The other is **[Audit Mode](#audit-mode-vetting-the-baseline)** — vetting and cleaning the baseline list itself — and it is a first-class use of this skill, not an afterthought.

**Hand off to the user, do not spend tokens on it:** login, registration, account creation, OAuth / "sign in with Google", email/SMS verification, password-reset, captcha, and any other auth or anti-bot gate. Do not fight controlled-input forms, password-strength rules, or login walls yourself — the moment a step needs an account or human verification, stop and ask the user to do that one step, then continue. Logging in is cheap for the user and expensive for you.

## Goal

- Grow and keep honest a baseline of resources proven to be **dofollow + actually indexed** — that is the deliverable, not a placement count.
- Turn a user-chosen target into either a live placement or a clearly logged blocker.
- Keep the master JSON accurate after every target, not in a batch at the end.
- Avoid wasting time on dead sites, broken flows, mailbox gates, captchas, login walls, and high-friction form fields — and on placements whose indexing you cannot confirm.

## Division Of Labour: You Own The JSON, The User Owns The Dashboard

```
notes/projects/site-backlinks/backlink-master.json     ← source of truth. You own it.
  ↓  node .opencode/skills/backlink-execution/scripts/build-board.mjs [--open]
notes/projects/site-backlinks/backlink-board.html      ← what the user opens. Generated.
  ↑  node .opencode/skills/backlink-execution/scripts/serve-board.mjs   (writable, 127.0.0.1:8787)
```

**The user does not read or edit the JSON.** He works from the board; when he marks a placement 已发 on the localhost dashboard, `serve-board.mjs` writes the JSON for him. Everything else in that file — link verification, index status, decisions, types, pricing, notes, campaigns — is yours to maintain. Never ask him to edit JSON, and never hand him a JSON snippet as a report; report in prose and show him the board.

The board bakes the data in as a JSON literal, so **it does not update on its own**. Regenerate it at the end of every run that touched the JSON, and tell the user it is refreshed. A stale board is worse than no board — it is what caused the user to distrust this list in the first place.

**`backlink-master.export.csv` is not the source of truth.** It is an optional flat view for human inspection, produced by `export-master-csv.mjs`. Do not regenerate or commit it as part of normal runs; only when the user explicitly asks for a spreadsheet.

**What the dashboard writes when the user ticks 已发:** `placements[].status = "submitted"`, `index.status = "unverified"`, `submitted_at` = today, and `campaign_id` = the project's active campaign. It never sets `link.rel`, `link.robots`, or `index.status: indexed` — those are yours, and they are the whole point of the audit pass.

**What it writes when the user hits 发不了** (he tried, it didn't work — a reason is mandatory, the API rejects an empty one):

| scope | writes | effect |
|---|---|---|
| 只这个项目不发 (default) | `placements[].status = "parked"` + `reason` + `blocked_at` | drops out of 今天发 for that project only; stays available to the others |
| 所有项目暂缓 | `decision.status = "deferred"` + `reason` + `decided_at` | out of the worklist for every project, but parked in a **visible collapsed 暂缓 group** in 候选池 with a live count |
| 所有项目排除 | `decision.status = "rejected"` + `reason` + `decided_at` | leaves the board entirely, for every project |

`deferred` and `rejected` both stash the prior status in `decision.was` / `was_reason`, and both are reversible from the board's 恢复 button. Flipping 暂缓 → 排除 does **not** overwrite that stash, so the original `active` still survives two hops.

**`deferred` exists because "要钱" is not "dead".** Paywalls, credit systems, and threshold gates ("must have 100 users") are decisions postponed until the budget or the condition changes — burying them in `rejected` is how a perfectly good DR-69 target gets lost forever. Use `rejected` only when the site is genuinely unusable: registration closed, dead domain, submit flow broken, no real link surface. When triaging one yourself, apply the same split.

A `rejected` domain is hidden from the worklist but still **searchable** — typing the domain in the search box brings it back with its reason so the user can undo. That is the only path back; do not "clean up" `rejected` rows out of the JSON.

**These reasons are field evidence, and they are yours to act on.** A `parked` reason like "需要登录" is a hand-off you can clear. "要 $29 才能提交" is a `pricing` fact the user recorded in prose — structure it (`pricing.model`, `requires_payment`, `note`) on your next pass so it never has to be rediscovered by hand. "注册关闭了" is an audit finding for `note`. Read all of them at the start of an execution run so you don't propose a target he already bounced off.

## The Data Model

`backlink-master.json` (`schema_version: 2`):

```jsonc
{
  "schema_version": 2,
  "updated_at": "2026-07-25",
  "projects": ["perlerbeadpatterns.org", "onethingatatime.app", ...],
  "campaigns": [ { "id": "...", "project": "...", "target_live": 5, "status": "active", "started_at": "..." } ],
  "websites": [ { /* one object per domain, see below */ } ]
}
```

A `websites[]` entry:

```jsonc
{
  "website": "promoteproject.com",              // registrable domain, no scheme, no www
  "decision": { "status": "active", "reason": "...", "decided_at": "2026-07-25" },
  "type":     { "primary": "startup_directory", "surface": "listing" },
  "pricing":  { "model": "credits", "requires_payment": false, "note": "..." },
  "link":     { "rel": "dofollow", "rel_checked_at": "...", "robots": "indexable", "robots_checked_at": "..." },
  "authority":{ "dr": 69, "as": 52 },
  "gsc":      { "seen_at": "2026-07-19", "scope": "everland.cc" },
  "note": "...",                                 // durable prose, the run's memory
  "example_source": "https://...",               // how a competitor got a link here
  "placements": [
    { "project": "perlerbeadpatterns.org", "status": "live", "url": "https://...",
      "campaign_id": "...", "submitted_at": "2026-07-25",
      "index": { "status": "indexed", "checked_at": "2026-07-25", "source": "site" } }
  ]
}
```

**Four orthogonal axes. Never collapse them** — collapsing them is what corrupted the old CSV.

| axis | field | scope | answers |
|---|---|---|---|
| **Decision** | `decision.status` | site | do we work this site at all? |
| **Link value** | `link.rel` + `link.robots` | site (but see the page-level caveat) | does a link here pass anything? |
| **Placement** | `placements[].status` | site × project | did *this project* get a link on it? |
| **Indexing** | `placements[].index.status` | site × project | did Google actually keep the page? |

### `decision.status`

| value | meaning |
|---|---|
| `active` | vetted and worth working. Board shows 做. |
| `needs_review` | in the pool but link value / indexability not established. Board shows 待复查. This is the default for anything freshly promoted from prospecting. |
| `deferred` | **not now, not never**: a real target behind a price or a threshold (paid submission, credit wall, "must have N users"). Out of the worklist, kept in the board's collapsed 暂缓 group with its reason and a visible count. Revisit when the budget or the condition changes. |
| `rejected` | never attempt again: no link surface, ban-prone network, `noindex`, dead registration, or the user vetoed it. Board hides it entirely. |

**A paywall is `deferred`, not `rejected`.** The difference is whether *money or time* could change the answer. Collapsing paid targets into `rejected` silently destroys good inventory — `startupfa.st` is DR 69 and asks $29; that is a purchasing decision for the user, not a verdict for you to make.

**Never delete a rejected entry — set `decision.status = "rejected"` instead.** `backlink-prospecting` dedups new candidate lists against this file, so a deleted domain comes back as a fresh candidate and the user re-spends time or money on a site they already ruled out. Always record *why* in `decision.reason` with `decided_at`.

A plain login wall is **not** `rejected` — that is a per-project `parked` hand-off on an otherwise fine site.

### `link.rel` / `link.robots` — link value

These two replace the old `follow` column, and splitting them matters: they are **two independent kill switches** and the second one is easy to miss.

| `link.rel` | meaning |
|---|---|
| `dofollow` | anchor carries no `nofollow` / `sponsored` / `ugc`. The real targets. |
| `nofollow` | anchor is nofollow — still worth referral traffic, discovery, and link-profile diversity (an all-dofollow profile is itself unnatural). Only with spare capacity after dofollow is exhausted; never ahead of dofollow, never to pad the count. |
| *(absent)* | never verified. Usable opportunistically, not part of the guarantee. |

`noopener` / `noreferrer` are harmless security attributes and do **not** kill a link — treat them as `dofollow`.

| `link.robots` | meaning |
|---|---|
| `indexable` | no `noindex` on the placement page. No robots meta at all also means `indexable`. |
| `noindex` | page-level `noindex` overrides every anchor on the page: no PageRank *and* no referral traffic, since nobody can find it. Usually a free-tier limit sold as a paid upgrade (`linktr.ee`, `jimdofree.com` — DR92 and worthless). |
| `blocked` | robots.txt / WAF prevents crawling. |
| *(absent)* | unverified. |

Always stamp `rel_checked_at` / `robots_checked_at`. A claim without a date is a claim to re-check.

**Verify both in a real browser via `web-access`, not with `curl`.** Load the page, then read the robots meta and every anchor's `rel` in one `/eval`:

```js
(()=>{const r=document.querySelector("meta[name=robots i]");
const doms=["<target domain>","<legacy/redirect domain>"];
const hits=[...document.querySelectorAll("a[href]")]
  .filter(a=>doms.some(d=>a.href.includes(d)))
  .map(a=>a.getAttribute("rel")||"DOFOLLOW");
return JSON.stringify({robots:r?r.content:"none",rels:[...new Set(hits)],n:hits.length})})()
```

`curl` produces **false results in both directions** and cost a full audit cycle on 2026-07-19:
- WAF/Cloudflare returns a 403 challenge page whose own meta is `noindex,nofollow` — `whizolosophy.com`, `proofreadanywhere.com`, and `sites.williams.edu` all looked dead this way and were fine (Cloudflare needs ~10s to clear, so wait before reading the DOM);
- client-rendered listings (`startupfa.st`) show no links at all in raw HTML;
- and `curl` alone never reveals the anchor `rel`, which is where two "dofollow" notes turned out to be plain wrong.

Check the **actual placement URL**, not the site root — they differ (a Substack homepage and its posts carry different tags). Include any **legacy domain that 301s to the project** in the match list (`declutterspace.net` → `declutteryourhome.net`), or a real link reads as missing.

**`rel` is a property of the page, not the site**, even though the schema stores it at site level. One site can serve different `rel` on different routes: `startupfa.st/startup/<slug>` (the current Dashboard flow) is dofollow while `startupfa.st/projects/<slug>` (the older route, where declutter and everland still live) is nofollow. Record *which route* was verified in `note`; a bare site-level "nofollow" wrote off a DR69 dofollow surface for weeks.

Useful prior: **WordPress stamps `rel="ugc external nofollow"` on comment-author links by default**, so blog-comment placements are nearly always `nofollow` regardless of how authoritative the host — a `.edu` comment link is still nofollow. Non-WordPress boards (Japanese open BBS/diary CGI, older forum software) are where comment surfaces still come out dofollow.

### `placements[].status` — the per-project outcome

| value | `url` holds | meaning |
|---|---|---|
| `live` | the live URL | the target URL renders as a real clickable `<a href>`, not plain text. Verified success. |
| `submitted` | submission/profile URL, if any | the user (or you) posted it; written by the dashboard when he ticks 已发. Counts toward a campaign round. |
| `reviewing` | submission URL, if any | legacy alias of `submitted`, still counted as posted. Don't write new ones. |
| `parked` | the blocker | blocked on a manual step the user can clear: `needs login`, `check email to verify`, `weekly limit reached`, `captcha needs user`. |
| `nolink` | the page URL | the placement went through but yields no usable clickable backlink (link stripped, or the surface is plain-text). Nothing more to attempt. |
| `unverified` | — | recorded as placed by an older run with no URL to prove it. Needs a check, do not trust it. |
| *(no entry)* | — | never attempted for this project. This is what the board's gap view offers as actionable work. |

Only `live` / `submitted` count as posted. `parked` is **not** a placement — treating it as one is exactly how a previous version of this list reported never-placed targets as proven ones.

### `placements[].index` — did Google keep it?

A separate axis from placement, and the reason the old list was untrustworthy: a `live` row proves *we* posted, not that Google kept the page.

| `index.status` | meaning |
|---|---|
| `indexed` | the placement URL is in Google's index. `source: "site"` for a `site:` check. |
| `not_found` | `site:` found nothing. **Weak negative only** — never conclude "worthless" from this alone. |
| `gsc_seen` | GSC reported the link. Crawler discovery, *not* proof the page is indexed. |
| `unverified` | posted, never checked. What the dashboard sets on 已发. |

Always stamp `checked_at` and `source`.

### `gsc`

`gsc.seen_at` = the date Google Search Console itself reported a link from this domain, on any project (`gsc.scope` names which). It is the only first-hand evidence Google saw the link, and it outranks Semrush and `site:` — both gave wrong answers on 2026-07-19 where GSC did not.

**But GSC confirmation is not a quality signal and must never be the baseline gate.** GSC reports who links to you; it does not filter by `rel` or `robots`. `f6s.com` is GSC-confirmed *and* `noindex` *and* `nofollow` — worthless on both axes. Admission to the baseline is `link.rel` + `link.robots` verified by us; `gsc` is a bonus badge on top.

The inverse also holds: **absence from GSC is not evidence of absence.** GSC samples and lags — `wox.cc` has 3 links in a Semrush export and zero GSC rows. Never demote a target for missing from GSC.

Its real second use: **recovering placements that were never recorded.** A domain appearing in GSC with no entry in the master is almost always "placed but not written down", not an automatic listing — that is how `mossai.org` and `aigcsoft.site` were recovered.

## The Baseline List (保底名单)

The board's 候选池 view leads with the baseline: the small, hand-vetted set of targets worth placing on **every** project, present and future. It exists because raw count is worthless: a 2026-07-19 audit found a whole free-blog farm (`blogsmine`, `activoblog`, `azzablog`, and six siblings) had been banned or wiped, taking ~18 "placements" with it. The user's rule: **10–20 targets that genuinely hold, rather than a long list that rots.**

**It is not a column — it is computed.** `build-board.mjs` admits an entry when:

```js
decision.status === "active" && ["dofollow","nofollow"].includes(link.rel) && link.robots === "indexable"
```

So promoting a target into the baseline means doing the verification work, not setting a flag. Ranking is just `rel` (dofollow first) then `DR` descending — do not reintroduce a quality/priority grade on top; authority is `authority.dr`.

Beyond those three fields, a genuine baseline target should also be:

1. **A durable host** — a real company, institution, or platform. Any free-subdomain blog network with a captcha-farm signup flow is disqualified on sight; that is the exact footprint that just died.
2. **Proven live at least once**, with a URL in a `placements[]` entry.
3. **Repeatable** — a new project can get the same placement without new payment or a one-off relationship.

**Only two outcomes are genuinely worthless: `noindex`, and getting banned.** Everything else carries some value, so nofollow is a *priority* signal, never a rejection — do not `reject` a working nofollow target.

When a new project launches, the baseline is the pool to propose from — surface the dofollow-and-indexed targets and let the user pick, rather than autonomously sweeping the list. When a baseline target turns out to be dead or banned, do not silently drop it: set `decision.status = "rejected"`, clear `link.rel`, and say so, because the guarantee is only as good as its last audit.

## Campaigns (本轮目标)

`campaigns[]` drives the board's 今天发 view (the default whenever any campaign is `active`): a per-project round with a `target_live` quota.

```jsonc
{ "id": "perlerbeadpatterns.org-2026-07-25", "project": "perlerbeadpatterns.org",
  "target_live": 5, "status": "active", "started_at": "2026-07-25" }
```

- The board counts a campaign target met when a baseline-eligible domain has a **posted** placement (`live` / `submitted` / `reviewing`) carrying that `campaign_id`. `serve-board.mjs` stamps `campaign_id` automatically from the project's active campaign — you rarely set it by hand.
- **Completion means "posted", not "indexed".** Do not hold a campaign open waiting on Google; index verification is a separate pass on its own cadence.
- Open a new campaign when the user starts a fresh round: append an entry with today's date, and set the previous one for that project to `status: "done"`. Only one `active` campaign per project.
- `submitted_at` is the local date the placement was confirmed posted. Never ask the user to pick a follow-up window.

## Audit Mode: Vetting The Baseline

Placing new links is only half the job; keeping the baseline **true** is the other half, and often the more valuable one. Entries marked `active` that were never re-checked, or `noindex` pages still counted as baseline, are exactly the rot that made the user distrust the list. Run this mode when the user asks to clean/verify/audit the list, and by default before proposing a fresh placement sweep.

The audit loop, per `active` / `needs_review` target:

1. **Re-verify `rel` + `robots`** on the actual live placement URL, in a real browser via `web-access` — the `/eval` snippet above. Sites silently change `rel` and robots policy. Update `link.*` and both `*_checked_at` stamps.
2. **Confirm it is actually indexed.** dofollow is worthless if Google never kept the page. Write the result to `placements[].index` with `checked_at` and `source`. GSC is the strongest evidence; `site:<placement-url>` is the fallback, and its negatives are weak.
3. **Promote or demote:**
   - dofollow/nofollow **and** `indexable` → `decision.status = "active"`. This is the real baseline.
   - dofollow but no indexing evidence → keep `active` but record `index.status` honestly; do not present it as guaranteed.
   - `noindex`, or nofollow that was recorded as dofollow → correct `link.*`; a `noindex` target does not belong in the guarantee even at DR92.
   - paid wall / credit gate / threshold → `decision.status = "deferred"` with the price in the reason, plus structured `pricing.*`. Not `rejected`.
   - dead site / banned network / no link surface → `decision.status = "rejected"` with a reason.
4. **Write back per target** (never batch) and regenerate the board.

The output of an audit is a shorter, truer baseline the user can rely on — that is the win, even when zero new links get placed.

## Before You Start

- Read `notes/projects/my-projects.md` before filling forms so you use the right project URL, description, category, logo, and anchor direction.
- Check the target's `example_source` first. If present, inspect that example to understand how the backlink was actually obtained on that site before attempting your own placement.
- If `example_source` is empty, first determine the site's real link path yourself: article body, comment author URL, profile, listing, forum signature, or something else. Do not jump straight into registration or submission before you know which surface can actually produce the backlink.

## Execution Rules

- Work one target at a time.
- Once the user has chosen a target, prefer the smallest viable placement that gets a *dofollow, indexable* link live: profile, listing, comment, simple post, then heavier article workflows only when needed. "Smallest" is about effort for a link worth having — it is never a licence to place a low-value link just because it is quick.
- Treat "how do links come out of this site?" as a required preflight question, not an optional curiosity.
- Every article or post must use genuinely unique content. Do not reuse the same copy across Web2.0 or blog platforms.
- For blog posts and comments, a plain-text URL does not count as a backlink. The placement must render as a real clickable link such as an actual `<a href>` in the visible body before you can count it.
- If one account or site property can legitimately host placements for multiple user projects, reuse it instead of forcing separate accounts. In shared-account cases, prefer a generic username, display name, and blog/profile identity rather than one tied to a single project domain.
- Fill the straightforward fields yourself: username, title, URL, short description, obvious category, logo upload, simple bio, and other low-ambiguity inputs.
- For complex submission forms, do the straightforward prep yourself and leave difficult, ambiguous, or high-friction fields for the user to complete.
- Do not guess through unclear editorial or business-detail fields just to finish the form.

## Stop And Hand Off

- If a target needs login, registration, account creation, or "sign in with Google"/OAuth, stop and ask the user to log in before you go further. Do not attempt to register or authenticate yourself, and do not burn turns fighting password rules or controlled login forms.
- If progress depends on checking email for signup, activation, verification, or password reset, stop and ask the user to do that step. Do not attempt mailbox handling yourself.
- If you see captcha or other anti-bot measures, stop and hand that step to the user instead of repeatedly trying to brute-force it.
- If the UI is hard to navigate, stop and inform the user instead of burning time on trial-and-error clicking.
- If a form requires payment, phone or SMS verification, subjective business details you cannot verify, or another high-friction final step, fill what is obvious and hand the rest to the user.
- When handing a step to the user, be precise about what page you reached, what you already filled, and the exact next action they need to take.

## Write-Back Discipline

Update `backlink-master.json` after **each** target attempt — never batch it to the end of the run. One target = one write-back, then regenerate the board.

**Edit it as JSON, not as text.** Hand-editing risks breaking the file the dashboard also writes to. Read → mutate → write with the same formatting `serve-board.mjs` uses, so diffs stay clean:

```js
// node -e '...' or a throwaway script under the scratchpad
const p = "notes/projects/site-backlinks/backlink-master.json";
const m = JSON.parse(fs.readFileSync(p, "utf8"));
const site = m.websites.find((s) => s.website === "example.com");
// ...mutate site.link / site.decision / site.placements / site.note...
m.updated_at = "<today>";
fs.writeFileSync(p, JSON.stringify(m, null, 2) + "\n");
```

Then: `node .opencode/skills/backlink-execution/scripts/build-board.mjs`.

**Never race the dashboard.** If `serve-board.mjs` is running and the user may be ticking boxes, re-read the file immediately before you mutate it — don't hold a parsed copy across a long browser session and write it back stale.

Adding a new project means appending to `projects[]`; the board and the export pick it up automatically with no code change.

**Record link quality in `link.*`, always** — both `rel` and `robots`, with dates. A high-DR target that fails either one (cal.com DR92 nofollow anchor; jimdofree.com DR92 `noindex, nofollow` page) looks like the best row on the board while passing no PageRank at all. Without this the user keeps being drawn back to it.

### What goes in `note`

`note` is the durable memory of the run: prose that makes the *next* attempt (a new project on the same site, or a re-visit of a blocker) cheap instead of a rediscovery. Structured facts belong in their fields — `note` carries what has no field.

**The link path (so it is never re-derived).** Which surface produced the link — listing, profile, comment author URL, article body, signature — and the exact submit route or page to reach it, including *which route* the `rel` was verified on. This is the single most reusable fact.

**Reusable site-specific experience.** Anything that made this site awkward and will recur:
- account used (which login/email) and whether it can be reused across projects;
- the resolved value of any high-friction field (required category, market, business-type, captcha behavior, the exact password rule that was rejected);
- form quirks and traps — controlled inputs that fight value-setting, steps that only save on an explicit "Next"/"Save", a wizard that drops uploads on back-navigation, a field that silently clobbers another;
- whether the link lands on a lower-authority subdomain;
- moderation/expiry: review queue and typical approval time, or a hard auto-delete deadline (convert to an absolute date).

**Why it is not doable (when it is not).** For a `rejected` site or a `parked` project, state the concrete blocker: "registration requires SMS", "submission is paid ($X)", "page is auto-generated, no real link", "captcha on submit — needs user", "login wall — user must sign in first". The short version also goes in `decision.reason`.

Write `note` as terse, factual prose a future run can act on directly — not a narrative of what you tried. When a site's know-how is rich enough to be worth a fuller writeup, also capture it as a `web-access` site-pattern (`references/site-patterns/{domain}.md`) and point to it from the `note`.

## Output

- Report each target on all four axes: `decision`, link value (`rel` + `robots`), the per-project placement status with its URL, and index status.
- Include any user hand-off step that is still blocking progress.
- Regenerate the board (`node .opencode/skills/backlink-execution/scripts/build-board.mjs`) and say so, so the user knows what he opens is current.
- Report in prose against the board — never paste JSON at the user.

## Scripts

All under `.opencode/skills/backlink-execution/scripts/`.

- `build-board.mjs [--open]` — regenerate `backlink-board.html` from the JSON. **Run after any JSON change.**
- `serve-board.mjs [--port=8787]` — serve the board at `http://127.0.0.1:8787/` with a write API, so the user can record outcomes himself: `POST /api/placements` (已发) and `POST /api/blocked` (发不了 / 恢复). Both write the JSON and rebuild the board on save. Start this when the user wants to work through targets.
- `promote-candidates.mjs <competitor> [--dry]` — append triaged keepers from `backlink-candidates-<competitor>.csv` into the master as `needs_review` entries, skipping domains already present. Owned by the `backlink-prospecting` flow; lives here because it writes the master.
- `export-master-csv.mjs` — flatten the JSON to `backlink-master.export.csv`. **Only on explicit request**; not part of a normal run.
- `migrate-master.mjs` — one-shot 2026-07-19 CSV schema migration. Kept for provenance; do not re-run.

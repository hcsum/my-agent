---
name: backlink-execution
description: Execute live backlink placements from an existing target CSV. Use when the user asks to do backlink building, build backlinks, work through a backlink candidates CSV, register or submit a target site, create live listings/posts/profiles/comments, or handle real submission flows on target sites. Only use this after targets already exist in CSV. Not for competitor export parsing, candidate generation, or `difficulty` triage; use `backlink-prospecting` for that.
---

Build real backlink placements from an existing target list. This skill owns execution, not prospecting.

## What This Skill Does

Your effort goes to exactly three things. Everything else is a hand-off.

1. **Figure out how to get the backlink** — determine the site's real link surface (article body, comment author URL, profile, listing, signature) before touching any flow.
2. **Fill the forms** — fill the straightforward fields of submission/listing/post forms and prepare the content.
3. **Record and update the backlink list** — after every target, write the result back to the tracking CSV: the live URL on success, the reusable site know-how that makes the *next* project's placement on this same site faster, and, when a target is not doable, the concrete reason why. See [CSV Discipline](#csv-discipline).

**Hand off to the user, do not spend tokens on it:** login, registration, account creation, OAuth / "sign in with Google", email/SMS verification, password-reset, captcha, and any other auth or anti-bot gate. Do not fight controlled-input forms, password-strength rules, or login walls yourself — the moment a step needs an account or human verification, stop and ask the user to do that one step, then continue. Logging in is cheap for the user and expensive for you.

## Goal

- Turn each target into either a live placement or a clearly logged blocker.
- Keep the tracking CSV accurate after every target, not in a batch at the end.
- Avoid wasting time on dead sites, broken flows, mailbox gates, captchas, login walls, and high-friction form fields.

## The Board Is The User's View

The user works from `notes/projects/site-backlinks/backlink-board.html`, not from the raw CSV. The CSV stays the source of truth; the board is a generated read-only view of it.

```
notes/projects/site-backlinks/backlink-master.csv          ← source of truth, you edit this
  ↓  node .opencode/skills/backlink-execution/scripts/build-board.mjs [--open]
notes/projects/site-backlinks/backlink-board.html          ← what the user actually opens
```

The board bakes the CSV in as a JSON literal, so **it does not update on its own**. Regenerate it at the end of every run that touched the CSV, and tell the user it is refreshed. A stale board is worse than no board — it is what caused the user to distrust this list in the first place.

The board's default view is **🏆 保底名单** — see below. The second tab, **🎯 补齐缺口**, is the wider opportunistic view: domains proven `live` on ≥2 projects, showing which projects still have no live link. That ranking only works if statuses are accurate, which is why the write-back rules below are strict.

## The Baseline List (`follow`)

The `follow` column marks the small, hand-vetted set of targets worth placing on **every** project, present and future. It exists because raw count is worthless: a 2026-07-19 audit found a whole free-blog farm (`blogsmine`, `activoblog`, `azzablog`, and six siblings) had been banned or wiped, taking ~18 "placements" with it. The user's rule: **10–20 targets that genuinely hold, rather than a long list that rots.**

The column carries **only** what `AS` / `DR` cannot already express — whether the link passes anything. Do not reintroduce a quality/priority grade on top of it; authority is `DR`, effort is `difficulty`, and ranking is just `follow` then `DR` descending.

| `follow` | meaning |
|---|---|
| `dofollow` | anchor has no `nofollow`/`sponsored`/`ugc`, page is indexable. The real targets. |
| `nofollow` | anchor is nofollow but **the page is indexed** — still worth referral traffic, discovery, and link-profile diversity (an all-dofollow profile is itself unnatural). Do the cheap ones; never ahead of dofollow. |
| `noindex` | page-level `noindex`: no PageRank *and* no referral traffic, since nobody can find the page. Usually a free-tier limit sold as a paid upgrade (`linktr.ee`, `jimdofree.com`). |
| *(empty)* | follow status never verified. Usable opportunistically, not part of the guarantee. |

**Only two outcomes are genuinely worthless: `noindex`, and getting banned.** Everything else carries some value, so nofollow is a *priority* signal, never a rejection — do not mark a working nofollow target `dead`. Reserve `dead` for no link surface at all, a paid wall, a ban-prone network, or a user veto.

Useful prior: **WordPress stamps `rel="ugc external nofollow"` on comment-author links by default**, so blog-comment placements are nearly always `nofollow` regardless of how authoritative the host — a `.edu` comment link is still nofollow. Non-WordPress boards (Japanese open BBS/diary CGI, older forum software) are where comment surfaces still come out dofollow.

To qualify as `dofollow`, a target must meet **all** of:

1. **dofollow *and* indexable** — both verified, with the date. Two independent kill switches, and the second one is easy to miss:
   - the anchor's own `rel` (`nofollow` / `sponsored` / `ugc` kill it; `noopener` / `noreferrer` are harmless security attributes and do **not**);
   - the **page-level** `<meta name="robots">`. A `noindex` or `nofollow` there overrides every anchor on the page. Free tiers of hosted platforms routinely ship `noindex, nofollow` and sell indexing as a paid feature — `linktr.ee` and `jimdofree.com` (DR92!) both did exactly this, and both looked like perfect targets until the meta tag was checked on 2026-07-19.

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

   Check the **actual placement URL**, not the site root — they differ (a Substack homepage and its posts carry different tags). No `robots` meta at all means indexable, which is fine. Include any **legacy domain that 301s to the project** in the match list (`declutterspace.net` → `declutteryourhome.net`), or a real link reads as missing.
2. **Durable host** — a real company, institution, or platform. Any free-subdomain blog network with a captcha-farm signup flow is disqualified on sight; that is the exact footprint that just died.
3. **Proven live at least once**, with a URL in `<project>_detail`.
4. **Repeatable** — a new project can get the same placement without new payment or a one-off relationship.

When a new project launches, running it through the whole baseline list is the default first action — that is what the list is for. When a baseline target turns out to be dead or banned, do not silently drop it: set `difficulty=dead`, clear `follow`, and say so, because the guarantee is only as good as its last audit.

## Before You Start

- Confirm which tracking file drives the run: usually `notes/projects/site-backlinks/backlink-master.csv`, sometimes a project-specific candidates CSV.
- Read `notes/projects/my-projects.md` before filling forms so you use the right project URL, description, category, logo, and anchor direction.
- Check the target row's `example_source` first. If it is present, inspect that example to understand how the backlink was actually obtained on that site before attempting your own placement.
- If `example_source` is empty, first determine the site's real link path yourself: article body, comment author URL, profile, listing, forum signature, or something else. Do not jump straight into registration or submission before you know which surface can actually produce the backlink.

## Execution Rules

- Work one target at a time.
- Prefer the smallest viable placement that gets the link live: profile, listing, comment, simple post, then heavier article workflows only when needed.
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

## Status: Two Separate Axes

Status lives in **two different columns**. Never collapse them — in particular, never write `done` / `reviewing` / `parked` into `difficulty`.

**`difficulty` — site-level, project-agnostic.** How hard it is to get a link out of this site, or that it is off the list for good. A durable property of the *site*: identical for every project and does **not** change when one project gets its link. Prospecting seeds it (`easy` / `hard`); execution refines it. Pick the tightest fit:
  - `easy` — low-friction, largely self-serve: blog comments, directory/nav submissions, GitBook/docs-style PR links, open profile fields
  - `hard` — a real link surface exists but placement is non-trivial: live user interaction (captcha on submit, hidden form needs a click trigger, Blogger-style popup, reCAPTCHA v2), registration + moderation, or an editorial/outreach pitch; doable next run, often with the user present
  - `dead` — never attempt again, for either of two reasons: (a) not actionable — dead site, paid wall, auto-generated page, genuinely no link surface even after login; or (b) the user tried it and rejected it as not worth the money or effort. A plain login wall is **not** `dead` — that is a per-project `parked` hand-off on an `easy`/`hard` site.

**Never delete a rejected row — set `difficulty=dead` instead.** `backlink-prospecting` dedups new candidate lists against this file, so a deleted domain comes back as a fresh candidate and the user re-spends time or money on a site they already ruled out. The board hides `dead` rows entirely, so marking it is indistinguishable from deleting it from the user's side. Always record *why* in `note`, with the date and who decided.

**Per-project columns — the outcome for one project on this site.** Each project owns **two** columns: `<project>` holds the status, `<project>_detail` holds the URL or the reason. Never put a URL, a reason, or a comma-bearing sentence in the status column — that is what corrupted this file before.

| `<project>` | `<project>_detail` | meaning |
|---|---|---|
| `live` | the live URL | the target URL renders as a real clickable `<a href>`, not plain text. The normal success case, and the only status that counts as a placement. |
| `reviewing` | submission/profile URL, if any | submitted, awaiting moderation/approval |
| `parked` | the blocker | blocked on a manual step the user can clear: `needs login`, `check email to verify`, `weekly limit reached`, `captcha needs user`. Unblocks once the user acts. |
| `nolink` | the page URL | the placement went through but yields no usable clickable backlink (link stripped, or surface is plain-text). Nothing more to attempt. |
| `unverified` | — | recorded as placed by an older run with no URL to prove it. Needs a check, do not trust it. |
| *(empty)* | — | never attempted for this project. This is what the board's gap view offers as actionable work. |

Only `live` counts. `parked` and `reviewing` are **not** placements — treating them as such is exactly how a previous version of this list reported never-placed targets as proven ones.

If the site is inaccessible, the submission path is dead, or the flow is clearly broken, set `difficulty=dead` immediately and move on. Always record the concrete blocker reason in `note` so the next run does not rediscover it from scratch.

## CSV Discipline

Update the tracking CSV after **each** target attempt — never batch it to the end of the run. One target = one write-back. The `note` column is the durable memory of the run: it is what makes the *next* attempt (a new project on the same site, or a re-visit of a blocker) cheap instead of a rediscovery.

For `notes/projects/site-backlinks/backlink-master.csv`, the per-project outcome goes in that project's **status + `_detail` pair** — see [Status: Two Separate Axes](#status-two-separate-axes). The `difficulty` column stays site-level (`easy` / `hard` / `dead`) and is never overwritten with a project's outcome. A site can be live for one project and still open for another.

Adding a new project means adding two columns, `<project>` and `<project>_detail`; the board picks them up automatically with no code change.

**Record link quality in `note`, always.** Whether a placement is worth anything comes down to two things, and both go stale — sites change their `rel` and their robots policy without warning. Record **both**, with the verification date and who checked:

1. the anchor's observed `rel` — dofollow vs nofollow;
2. the page's `<meta name="robots">` on the live placement URL — see the check in [The Baseline List](#the-baseline-list-follow).

A high-DR target that fails either one (cal.com DR92 nofollow anchor; jimdofree.com DR92 `noindex, nofollow` page) looks like the best row on the board while passing no PageRank at all. Without this note the user keeps being drawn back to it.

What to put in `note`, every time:

**The link path (so it is never re-derived).** Which surface produced the link — listing, profile, comment author URL, article body, signature — and the exact submit route or page to reach it. This is the single most reusable fact: a new project on the same site can skip the entire "how do links come out of this site?" preflight.

**Reusable site-specific experience.** Anything that made this site awkward and will recur for the next project:
- account used (which login/email) and whether the account can be reused across projects;
- the resolved value of any high-friction field (required category, market, business-type, captcha behavior, the exact password rule that was rejected);
- form quirks and traps — controlled inputs that fight value-setting, steps that only save on an explicit "Next"/"Save", a wizard that drops uploads on back-navigation, a field that silently clobbers another;
- link quality: dofollow vs nofollow (and the observed `rel`), and whether the link is on a lower-authority subdomain;
- moderation/expiry: review queue and typical approval time, or a hard auto-delete deadline (convert to an absolute date).

**Why it is not doable (when it is not).** For a site-level `no` / `hard`, or a project-level `parked`, state the concrete blocker so the next run does not rediscover it from scratch: e.g. "registration requires SMS", "submission is paid ($X)", "page is auto-generated, no real link", "captcha on submit — needs user", "login wall — user must sign in first". Pair the reason with the right value from [Status: Two Separate Axes](#status-two-separate-axes).

Write `note` as terse, factual prose a future run can act on directly — not a narrative of what you tried. When a site's know-how is rich enough to be worth a fuller writeup, also capture it as a `web-access` site-pattern (`references/site-patterns/{domain}.md`) and point to it from the `note`.

## Output

- Report each target on both axes: the site `difficulty` (`easy` / `hard` / `dead`) and the per-project outcome (`live` / `reviewing` / `parked` / `nolink`) with its `_detail`.
- Include the live placement URL when available, and the observed `rel` (dofollow/nofollow).
- Include any user hand-off step that is still blocking progress.
- Regenerate the board (`node .opencode/skills/backlink-execution/scripts/build-board.mjs`) and say so, so the user knows what they open is current.

## Scripts

- `scripts/build-board.mjs` — regenerate `backlink-board.html` from the CSV. Run after any CSV change. `--open` also opens it.
- `scripts/migrate-master.mjs` — one-shot migration that split the old single-column-per-project schema into status + `_detail` (run 2026-07-19). Kept for provenance; do not re-run.

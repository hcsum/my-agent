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

## Before You Start

- Confirm which tracking file drives the run: usually `notes/projects/backlink-master.csv`, sometimes a project-specific candidates CSV.
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

**`difficulty` — site-level, project-agnostic.** How hard it is to get a link out of this site (or that it turned out to have none). A durable property of the *site*: identical for every project and does **not** change when one project gets its link. Prospecting seeds it (`easy` / `hard`); execution refines it and may set `no` when a listed target turns out dead. Pick the tightest fit:
  - `easy` — low-friction, largely self-serve: blog comments, directory/nav submissions, GitBook/docs-style PR links, open profile fields
  - `hard` — a real link surface exists but placement is non-trivial: live user interaction (captcha on submit, hidden form needs a click trigger, Blogger-style popup, reCAPTCHA v2), registration + moderation, or an editorial/outreach pitch; doable next run, often with the user present
  - `no` — discovered at execution time to be not actionable: dead site, paid wall, auto-generated page, web2.0 blog cluster, or genuinely no link surface even after login. A plain login wall is **not** `no` — that is a per-project `parked` hand-off on an `easy`/`hard` site. (Prospecting never assigns `no`; it drops worthless rows instead.)

**Per-project column — the outcome for one project on this site.** Each project has its own column; a site can be live for one project and untouched for another. Write that project's status here as `<status>, <detail>` (quote the cell since it contains a comma):
  - a bare live `<url>` — **done, with link**: the target URL renders as a real clickable `<a href>`, not plain text. The normal success case.
  - `done, no link` — the placement went through but the site yields no usable clickable backlink (link stripped, or the surface is plain-text/no-href). Nothing more to attempt for this project.
  - `reviewing, <url>` — **submitted, awaiting moderation/approval**. Include the submission or profile URL when there is one; otherwise just `reviewing`.
  - `parked, <reason>` — blocked on a manual step the user can clear, e.g. `parked, needs login`, `parked, check email to verify`, `parked, user must complete <field>`. Will unblock once the user acts.

If the site is inaccessible, the submission path is dead, or the flow is clearly broken, set `difficulty=no` immediately and move on. Always record the concrete blocker reason in `note` so the next run does not rediscover it from scratch.

## CSV Discipline

Update the tracking CSV after **each** target attempt — never batch it to the end of the run. One target = one write-back. The `note` column is the durable memory of the run: it is what makes the *next* attempt (a new project on the same site, or a re-visit of a blocker) cheap instead of a rediscovery.

For `notes/projects/backlink-master.csv`, the per-project status goes in that project's own column (`done` with the live URL / `done, no link` / `reviewing, <url>` / `parked, <reason>` — see [Status: Two Separate Axes](#status-two-separate-axes)). The `difficulty` column stays site-level (`easy` / `hard` / `no`) and is never overwritten with a project's outcome. A site can be live for one project and still open for another.

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

- Report each target on both axes: the site `difficulty` (`easy` / `hard` / `no`) and the per-project outcome (`done` with URL / `done, no link` / `reviewing` / `parked` with reason).
- Include the live placement URL when available.
- Include any user hand-off step that is still blocking progress.

---
name: site-analytics
description: Query the user's own GA4 and GSC data for launched sites. Use when checking whether a project/page/tool is getting traffic, events, downloads, organic clicks, countries, channels, or Search Console performance, especially questions like “有人在用吗”, “traffic 怎么样”, “查 GA/GSC”, or “某页面有没有转化”.
---

Use this skill to answer product/SEO usage questions from the user's first-party analytics.

## Workflow

- Read `notes/credentials/google-analytics-data-api.md` to identify the site, GA4 property ID, and credential JSON paths.
- Prefer GA4 for usage behavior: page views, users, sessions, engagement, channels, countries, and instrumented events.
- Use GSC when the question is about organic search demand, queries, clicks, impressions, CTR, or ranking.
- Use the bundled script for GA4 queries instead of re-writing OAuth code each time.
- If Google APIs time out, ensure Node fetch uses the local proxy by relying on `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY`; the script already installs `EnvHttpProxyAgent`.
- A single credential serves both GA4 and GSC: `onething-ga-reader@...` (see the credentials doc). If it returns `PERMISSION_DENIED` on one property, that property is missing access — do not fall back to other keys.

## GA4 Helper

Run from the repo root:

```bash
.opencode/skills/site-analytics/scripts/ga4-report.mjs --site perlerbeadpatterns.org --path /pattern-maker
```

Common options:

- `--site <domain>`: required unless `--property-id` is provided.
- `--property-id <id>`: GA4 property ID override.
- `--path <substring>`: filter by `pagePath`, e.g. `/pattern-maker`.
- `--days <n>`: default `28`; also reports `--recent-days`, default `7`.
- `--events <csv>`: custom event list; default covers known pattern maker/editor events and downloads.
- `--json`: emit raw JSON only.

## GSC Helper

Run from the repo root:

```bash
.opencode/skills/site-analytics/scripts/gsc-report.mjs --site perlerbeadpatterns.org --page /pattern-maker
```

Common options:

- `--site <domain>`: required unless `--site-url` is provided.
- `--site-url <url>`: Search Console property override, e.g. `sc-domain:example.com` or `https://example.com/`.
- `--page <substring>`: filter Search Console page dimension by URL substring.
- `--query <substring>`: filter Search Console query dimension by substring.
- `--days <n>`: default `28`; end date defaults to yesterday.
- `--dimensions <csv>`: default `page,query`; examples: `page`, `query`, `country,device`.
- `--search-type <web|image|video|news>`: default `web`.
- `--json`: emit raw JSON only.

## Interpretation Rules

- Separate all-site events from page-filtered events. A `download_pdf` event is only attributable to a page if the report includes `pagePath` filtering.
- Treat parameter-change events as strong evidence of interactive use; downloads are stronger but rarer.
- If upload/convert events are not instrumented, state that GA cannot directly count image uploads/conversions.
- Mention the date window and path filter in the answer.
- Keep the conclusion short unless the user asks for detailed tables.

## Credentials

- Do not print credential JSON or tokens.
- It is fine to read local credential files already documented in `notes/credentials/google-analytics-data-api.md`.
- Do not modify GA/GSC permissions unless the user explicitly asks.

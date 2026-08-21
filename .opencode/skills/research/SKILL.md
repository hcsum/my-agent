---
name: research
description: Investigate an open-ended question across the web by orchestrating multi-source search and reading the actual pages. Use whenever the user wants to find out how people use / feel about / discuss something, gather opinions or real-world patterns, survey a topic, or asks to "research X", "调研 X", "看看大家怎么用/怎么看 X". Not for SEO/keyword research (use the SEO skills) or single-fact lookups (search directly).
---

# Research

Run open-ended investigation across the web for the user. The job is to find what real people say and do about a topic, by spreading across sources, iterating on queries, and **reading the actual pages** — not by trusting search-result previews.

This skill orchestrates; the actual networking is done through other skills. Load them as needed:

- **Google** — general web, articles, forums, threads → use `web-access`
- **Reddit** — community discussion, firsthand experience → use `web-access` when discovered or likely relevant
- **X** — live sentiment, fast-moving takes → use `x-search` when discovered or likely relevant
- **Other public sources** — GitHub Issues/Discussions, HN, forums, review sites, app stores, official communities, YouTube comments, Stack Exchange, Product Hunt, docs/blog comments → use `web-access` as appropriate

## Goal

- Surface the strongest real-world signal on the question: how people actually use it, what they like/hate, recurring patterns, disagreements.
- Base every conclusion on **content read from inside the source page/post**, with citations.
- Be honest about signal strength; say when evidence is thin rather than inflating it.

## Method

Core search-query discipline: go broad→narrow (add one modifier at a time), rewrite weak/empty/off-target queries instead of stopping (try aliases, abbreviations, alternate wording, common misspellings; do multiple rounds), and stop once the answer is clear or signal quality is established. On top of that:

1. **Start broad, then narrow.** Open with the core entity/topic in plain terms. Only add modifiers once you see what the broad pass returns. Don't open with a hyper-specific query unless the user already gave a narrow target.
2. **Discover platforms dynamically.** Start with broad Google/open-web discovery, then follow where real users actually appear. Reddit and X are often high-density sources, but they are not mandatory defaults; GitHub, HN, review sites, app stores, official communities, forums, and vertical communities may be better depending on the topic.
3. **Iterate, don't give up.** Weak/empty/off-target results mean rewrite the query, not stop. Try aliases, abbreviations, alternate wording, common misspellings, X-native forms (hashtags, handles) before lowering confidence.
4. **Adapt source weight to the topic, without assuming what the topic is.** The question can be about anything — a product, a person, a place, a health or money or life decision, a cultural trend, a how-to, a controversy. Let the topic decide where the richest signal lives: some questions live in long-form articles, some in lived experience and community threads, some in real-time reaction, some in issue trackers or reviews. Probe several source types, then dig deeper where the signal actually is. Make no default assumption that a topic is technical or any other domain.
5. **Actively look for disconfirming evidence.** For products, tools, and decisions, search at least one negative/alternative angle when feasible: `complaint`, `not worth it`, `cancel`, `refund`, `alternative`, `vs`, `problem`, `broken`, `migrated from/to`. If negative evidence is absent or thin, say that instead of implying there is none.

## Click-in discipline (core rule)

Search-result surfaces are **only a candidate list**, never a source of conclusions:

- Google SERP snippets, the Reddit search/subreddit listing, and the X search stream are entry points. They tell you what to open, nothing more.
- **Open each promising result and read the real content**: enter the Reddit post and read the OP body + top comments; open the article and read the body; open the X post and read the full thread + notable replies; for non-trivial Google hits, click through to the page.
- **Never** quote, summarize, or draw a conclusion from a title, snippet, or list preview alone.
- Be **selective about what you open** so this stays affordable: from each listing, pick the few most relevant/highest-signal items, then read those in full. This selectivity is the same broad→narrow move — cast wide to find candidates, go deep on the best.
- Don't guess sub-page URLs. Get URLs by reading or clicking elements on the page (per the `web-access` rule), not by constructing them.

## Evidence tiers

Keep a lightweight internal ledger while researching. Do not expose the ledger unless useful; use it to avoid overclaiming.

- **Full evidence**: you opened and read the actual source with enough context to summarize the main post/article/thread and relevant replies or surrounding material. Can support broader claims about that source.
- **Limited evidence**: you fully read one post, comment, review, issue, or page section, but not the whole surrounding discussion. Can support that user's/page's specific experience, not community consensus.
- **Lead only**: search snippets, list previews, truncated content, reposts, low-context ratings, quoted summaries, or inaccessible pages. Use only to find better sources, keywords, platforms, or product names; do not use as conclusion evidence.

When writing conclusions, match the claim to the evidence tier: a single limited review can show one user's experience; it cannot prove what most users think.

## Lightweight ledger

For each source you actually rely on, keep these points mentally or in scratch notes:

- source URL and source type
- evidence tier: full / limited / lead only
- what it directly supports
- what it cannot support
- whether it is firsthand, secondhand, promotional, duplicated, or unclear
- visible engagement or date when relevant

## Signal quality

- Prefer firsthand experience and concrete examples over reposted framing or summaries.
- Treat many near-identical posts/articles as one repeated claim, not independent confirmation.
- On X, weigh engagement as rough signal; don't build broad conclusions on a handful of low-engagement posts unless the user asked for early/niche signal.
- Separate product/vendor claims from user evidence. Official docs, landing pages, and marketing copy can prove positioning and features; they do not prove user demand, satisfaction, or willingness to pay.
- State limitations explicitly: thin signal, one-sided sources, mostly derivative content.

## Output

Leave the exact format to your judgment — fit it to the question. Whatever the shape, it must:

- synthesize themes and patterns rather than dump a list of links
- group overlapping findings under one conclusion instead of repeating per source
- cite the specific posts/articles/threads you actually read
- make signal strength and any limitations visible
- follow the project reply-language rules (default 简体中文; keep English quotes, titles, product names, identifiers untranslated)

## Avoid

- concluding from SERP/listing previews without opening the page
- opening everything indiscriminately and burning tokens — select first, then go deep
- starting with long over-specified queries
- giving up after one weak query instead of rewriting it
- leaning on a single source when the others were never tried
- counting near-duplicate content as multiple independent signals
- dumping raw results with no synthesis

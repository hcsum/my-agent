# My Agent

## What's in here

- **Skills** — a set of custom skills under `.opencode/skills/` that encode my workflows (see below)
- **Gmail bridge** — an Opencode SDK integration that lets me send instructions by email and receive results back; the bridge also handles scheduled tasks
- **Memory** — long-term memory via [mem0](https://github.com/mem0ai/mem0), plus `notes/` (see below)
- **Notes** — a _separate_ private git repo, checked out into `notes/`, that the agent and I maintain together. It holds my personal data, the agent's memory layers, research results, todos, and the LLM wiki. It's deliberately kept out of this repo: this repo is code and instructions; `notes/` is the data those instructions operate on. Its internal layout and rules live in `notes/AGENTS.md`.
- **LLM Wiki** — an accumulating knowledge base the agent reads from and writes to over time

## Why a central repo

Most of my active context lives here, not in the target repos. Research findings, ongoing work, project notes, prior experience — it's all in the `notes/` repo, checked out alongside the skills that know how to read and write it. I've found myself starting almost every new task from this repo first, even when the actual code lives elsewhere, because the context is here and the skills know how to use it.

## Some of the skills I find myself using the most

**`web-access`** — a fork of the original with multi-browser support added. I can tell the agent to use my main browser (so it inherits my login sessions), a dedicated research browser, or a cloud browser (Browserbase). This one is the backbone of most other skills.

**`morning-report`** — pulls a daily briefing from my favorite news sources and a portfolio check. Runs on a schedule and lands in my inbox.

**`research`** — open-ended topic investigation: the agent plans a search strategy, reads actual pages, and synthesizes a structured report instead of just returning search snippets.

**`grill-me`** — interview mode. I describe a plan and the agent stress-tests it with relentless follow-up questions, walking down every branch of the decision tree and offering a recommended answer for each one.

**`backlink-prospecting` + `backlink-execution`** — a two-phase SEO backlink pipeline: prospect candidates from competitor exports, triage what's doable, then execute live submissions. Split so I can review targets before anything goes live.

**`llm-wiki`** — ingest a URL, file, or directory into a persistent knowledge base. Future sessions can query it. Useful for accumulating domain knowledge that would otherwise get lost between conversations.

**`mentor`** — keeps a running todo list in `notes/todos.md`. I tell it what I'm working on or what just finished, and it keeps the list honest.

**`x-home-feed` + `x-search`** — read my X Following feed or search X for a topic, without opening the app.

**`check-keyword` + `use-semrush` + `use-ahrefs` + `serp-inspection`** — a loose SEO toolkit. Each skill wraps a tool or workflow: keyword potential, domain/keyword metrics, SERP weakness analysis.

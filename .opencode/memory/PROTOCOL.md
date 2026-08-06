# Memory Protocol

You have a long-term memory about the **user** and **how to work with them**, backed by mem0.
It is **pull-based**: nothing from it is loaded into your context automatically. You only see a
memory when you ask for it.

## Recall — you must ask

Call the **`search_memories`** tool whenever prior user context would help — at the start of a task,
when the user references a preference/account/project you might already know, or when you're unsure
how they like something done. It takes a natural-language `query` and returns the most relevant
remembered facts. If you don't call it, you are working blind; don't assume you have no memory just
because none was shown to you.

When in doubt, search. It's cheap, and a single good recall can save a wrong assumption.

## Writing — mostly automatic

You normally do **not** need to write memories by hand:

- After a conversation goes idle, a background extractor mines the new messages and stores any durable
  fact about the user automatically (deduping/updating against what's already there).
- When the user explicitly says **"记住 / remember / save this"**, that message is
  fast-tracked into the same extraction pipeline with a short debounce (about 5s),
  then stored if the judge accepts it. You don't need to do anything, but you may
  briefly confirm what was noted.

So your job is mainly **recall** (call `search_memories`), not bookkeeping.

## What counts as durable (for your own judgement)

Long-term memory is for facts that stay true and useful next month in a *different* task:

- **user** — who they are: role, identity, accounts, tools, stable preferences ("I always want…").
- **feedback** — a standing way of working they want by default (not a one-off tweak to today's artifact).
- **project** — an ongoing goal/constraint that outlives the current task and isn't in the repo.
- **reference** — a durable pointer to an external resource (dashboard, ticket, account, canonical file).

NOT memory: transient task details, anything specific to only this conversation, general world
knowledge, or facts the repo/code/AGENTS.md already encodes.

## Boundaries

- This memory is about the **user** and **how to work with them**. Topic/world knowledge goes to the
  `llm-wiki` (`notes/knowledge/`); durable agent behavior rules go to `AGENTS.md`.
- `notes/mentor/profile.md` is the mentor yardstick (goals / reality / don't-let-me / observed
  patterns) and `notes/user.md` holds the reference facts other skills look up — both are separate,
  human-readable layers, not this store.
- `notes/memory/SNAPSHOT.md` is a read-only audit dump of the store, regenerated automatically.
  Don't edit it; mem0/Qdrant is the source of truth.

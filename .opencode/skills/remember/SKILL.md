---
name: remember
description: Maintain notes/memory/ — durable operational facts and context the *agent itself* needs across sessions (not the user's own copy-for-later, that's the `brain-dump` skill). Use when the user says 记住/别忘了/下次记得/remember (that)/don't forget, or when you notice a fact worth carrying forward that isn't already covered by todos.md or the LLM wiki (a server's connection command, an account's quirky rule, a standing operational agreement). Also use it to recall: when a task touches a topic already recorded here, or the user asks 还记得/do you remember/之前记的, read the matching file before answering.
---

Maintain the agent's own durable memory under `notes/memory/`: operational facts and context that make you behave correctly next time, organized by topic, dated, and re-surfaced when relevant.

## Goal

- Keep memory topic-organized and dated so it compounds instead of turning into a pile.
- Route writes to the right place: this skill is for facts *you* (the agent) need later, not content the user wants to reread — see Boundary below.
- Make recall automatic when a topic is already known, not something the user has to ask for by name.

## Directory model

- `notes/memory/index.md`: one row per topic — slug, one-line summary, `created`, `touched`, `last_recalled`. Read this first; it's the entry point for both modes.
- `notes/memory/<topic-slug>.md`: one file per topic, kebab-case filename. YAML frontmatter (`created`, `touched`, `last_recalled`) followed by dated `## YYYY-MM-DD` sections.

## Modes

### Remember (write)

1. Pick a short kebab-case topic slug for what's being recorded.
2. Check `index.md` for a matching or overlapping topic first — this doubles as a recall pass and prevents duplicate files. Reuse the existing file if one fits; only create a new one if it genuinely doesn't.
3. Append a `## YYYY-MM-DD` section to the topic file. Stay close to what was actually said or observed; add just enough surrounding context (why it matters, when it applies) that a future session with zero memory of this conversation can use it correctly.
4. Update the file's frontmatter: set `created` only if the file is new, always bump `touched` to today.
5. Update `index.md`: bump `touched`, refresh the one-line summary if it changed meaningfully, add a new row if the file is new.
6. Commit: `git -C notes add -A && git -C notes commit -m "memory: <slug> ..."` — same revertible-commit discipline as the `todos` skill's `todos.md` edits.

### Recall (read)

Trigger on: an explicit ask ("还记得...", "do you remember...", "之前记的..."), or the current task clearly touching a topic that's already in `index.md`. Don't scan memory on every turn — only when a topic is plausibly already known.

1. Read `index.md`, find the matching topic file(s).
2. Read the file and use its content in the reply or decision — cite which memory file it came from if you say what you recalled.
3. Update that file's frontmatter `last_recalled` to today and commit (batch multiple recalls from the same turn into one commit).

## Boundary — who is this for

Ask "is this a fact for the user to reread, or a fact I need to operate correctly next time?"

- **User-facing** ("记一下 / mark down / jot", saving a reply verbatim): not this skill — use the `brain-dump` skill instead, destination `notes/brain-dump/`.
- **Agent-facing** ("记住 / 别忘了 / 下次记得 / remember that", an operational fact you'll need later): this skill, destination `notes/memory/`.
- **Not this skill either**: open tasks belong in `notes/todos.md` (via the mentor plugin's `todos` skill); external/world knowledge belongs in the LLM wiki (via `llm-wiki`); there's a separate, currently-**disabled** mem0 auto-extraction memory system (`docs/memory-feature-design.md`, `.opencode/memory/`) — don't resurrect or wire into that mechanism to implement this skill.
- When it's genuinely unclear who the content is for, ask rather than guessing.

## File format

```markdown
---
created: 2026-07-03
touched: 2026-07-03
last_recalled:
---

## 2026-07-03
<what to remember, plus the minimal context needed to use it correctly later>
```

`index.md` is a markdown table: `slug | summary | created | touched | last_recalled`.

## Output

- Remember: report which topic file was created or updated and what changed.
- Recall: answer using the recalled content, and say which memory file it came from.

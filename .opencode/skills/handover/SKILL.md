---
name: handover
description: Summarize the current conversation into a handover — key points, decisions, state, and next steps — for the user or a next session to pick up. Use when the user says handover / 交接 / 总结一下当前 / 做个 handover / hand off, or asks to wrap up where things stand. Summarizes the part the user names, or the whole current context by default. Output always goes to the clipboard; write a file only when the user explicitly asks for one. This is a running-context handover — for saving a reply verbatim use `brain-dump`, for durable agent facts use `remember`.
---

Turn the current conversation into a handover: a tight brief of what was decided, where things stand, and what to do next — so the user or a fresh session can continue without re-reading the whole thread.

## Scope

- If the user names a part ("handover just the email thread", "总结架构那段"), summarize only that.
- Otherwise summarize the current context as a whole.
- This is a *lossy, structured* handover, not a verbatim copy — capture what matters to continue, drop the chatter.

## What to capture

Include only the sections that apply; omit empty ones — don't pad.

- **Goal / task** — what we're trying to do, in one or two lines.
- **Decisions made** — what was settled and, briefly, why (so it isn't re-litigated).
- **Current state** — what's done, what's in flight.
- **Next steps** — concrete, ordered, actionable.
- **Open questions / blockers** — what still needs a decision or is waiting on something.
- **References** — file paths, URLs, commands, identifiers needed to act.

Keep it dense and skimmable. Prefer short bullets over prose. Keep code identifiers, paths, tickers, and proper nouns in original form.

## Output destination

**Always the clipboard.** Never write a file unless the user explicitly asks for one (or names a path) — no matter how long, multi-part, or "durable-looking" the handover is. Don't offer a file either.

- **Clipboard**: pipe the handover text to `pbcopy` (macOS). Report that it's on the clipboard plus a one-line description of what was copied.
- **File** (only on explicit request): default under `tmp/` at the project root (gitignored — not committed) with a short kebab-case name like `handover-<topic>-YYYY-MM-DD.md`, unless the user gives a path. Create `tmp/` if it doesn't exist. Report the path.

## Output

- State where the handover went (clipboard or file path) and a one-line summary of what it covers.

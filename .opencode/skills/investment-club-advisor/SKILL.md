---
name: investment-club-advisor
description: Decode a 韭俱乐部 (investment club) report — weekly 周度纪要 or daily 早报/晚报/盘中技术分析, pasted as images or text — and turn it into concrete investment advice mapped onto the user's actual holdings. Use whenever the user feeds a club report, a market 周报/日报, or a technical-analysis screenshot and wants it understood and/or wants advice on what it means for his portfolio. Not for general market news (use morning-report) or SEO/keyword research.
---

Turn a 韭俱乐部 report into two things the user can act on: a faithful **解读** (decode) of what the report says, and **投资建议** that maps the club's view onto his real positions. The club holds an investor-education license and never gives buy/sell calls; the user wants you to close that gap — give him concrete, reasoned decision-support, while making clear the final call is his.

## Inputs every run

- **The report** — images or text. Identify the type first: weekly (周度纪要, header like `周度0621`) vs daily (早报/晚报/盘中技术分析). Type drives depth (see below).
- **Holdings** — read `notes/my-files/investment-portfolio.md` (US brokerage + China fund account, with per-fund sector/holding breakdown). Always re-read it; the user updates it.
- **思路 ledger** — read `notes/my-files/investment-club/投资思路-心法笔记.md` at the start of every run: the accumulated cross-report reasoning framework the user and agent refine over time. Carry its principles into the current advice, and when a run produces a genuinely new/upgraded insight (not a one-off snapshot), append a dated entry or revise an existing one.
- **Club framework** — the four background docs in `notes/my-files/investment-club/` (`会员权益及配置思路.md` = 四档配置 + Joe 的资产配置表, `俱乐部新手食用指南.md` = 右侧/左侧 + 四档框架, `盘中技术分析速览使用方法.md`, `祖训.md` = trading discipline). Read them the first time you run, or when a term/rule needs grounding. Don't re-read every run once you know them.
- **The user's reality** (`notes/user.md`): between jobs, income matters, has savings but wants no zero-income state. Weight advice toward this risk reality — do NOT just mirror the club's aggressive 投机 tier.

## Step 1 — Decode (always)

- **Expand every acronym/ticker with its Chinese full name** on first mention (PCE→个人消费支出物价指数, MU→Micron 美光, M7→美股七巨头, etc.). This is a hard rule the user enforces.
- Resolve slang against `notes/my-files/investment-club/黑话词典.md`. If a term isn't there and you're confident, decode it and **append it to the dictionary** (with date). If you're unsure, use `web-access` to look it up.
- **Use `web-access` to stay current**: the report is dated and references live events (Fed moves, geopolitics, IPOs, data releases). Verify the current state of anything load-bearing rather than relying on training data. Confirm against primary sources where it matters.
- **Flag what you still can't resolve.** After searching, list any term/event you couldn't confirm in a `仍未定 / 待消息` section. Never silently guess.

## Step 2 — 解读 depth by report type

- **Weekly (周报):** produce the full 解读 and save it to `notes/my-files/investment-club/周报-MMDD-解读.md`. Follow the structure in `references/templates.md`. **Do not compress the two most operational parts**: the full event calendar (every dated event, names/acronyms expanded) and the 模拟组合 four-tier picks (every 板块 in both accounts with its annotation) + the 6 usage notes. Past failure mode was collapsing these to one line — don't.
- **Daily (早报/晚报/盘中):** lighter. Write a delta against the standing weekly framework — what changed in 节奏/资金/板块强弱, which 右侧抱团 板块 were added or dropped. Club rule: when a daily contradicts the latest weekly, **以日报为准**. Save only if it carries real new signal; otherwise fold it straight into the advice.

## Step 3 — 投资建议 (the deliverable the user wants)

Map the club's view onto his actual holdings and give concrete advice. Save to `notes/my-files/investment-club/YYYY-MM-DD-<主题>建议.md` (e.g. `2026-06-25-美股配置与MU财报前建议.md`). Follow the advice structure in `references/templates.md`. It must contain:

1. **当前持仓与俱乐部路线的距离** — where his book sits vs the club's current main line (e.g. 中光韩存美费半). Name it plainly: 站错边 / 站得不深 / 已对齐 / 过度激进.
2. **四档对照** — slot his real holdings into 现金管理 / 防守 / 进攻配置 / 进攻波段 / 进攻投机, with rough weights.
3. **具体调整建议** — actionable, not vague: concrete tickers/funds, direction (加/减/换/不动), and sizing intent. A/股 and 港美 are two separate books — never sum them across currencies (club note #1).
4. **风险提示 / 执行原则** — invoke relevant 祖训 discipline (追高毁一生、卖飞永赚、心慌就减仓、遇事不决走一半) and the user's income-reality constraint. Always state the call is his.

Give real advice — the user explicitly wants it. But ground every recommendation in either the report, the holdings, or the framework; flag uncertainty instead of false confidence.

## Output & housekeeping

- Reply in 简体中文. Keep tickers, English product/term names, and code identifiers in original form.
- After writing files in `notes/`, commit and push (per `notes/CLAUDE.md`).
- If the user asks to receive this on a cadence, it fits the scheduler — but a report has to be fed in each time, so this is normally user-driven, not auto-scheduled.

## References

- `notes/my-files/investment-club/黑话词典.md` — club slang + acronym dictionary (lives with the other club materials in `notes/`). Read it during decode; extend it when you confirm a new term.
- `references/templates.md` — the 解读 structure and the 投资建议 structure.

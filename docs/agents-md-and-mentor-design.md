# AGENTS.md 精简 & Mentor skill vs. mindset 架构

> 记录两件事的**理论依据**，而不仅是结论：
> 1. 为什么把根 `AGENTS.md` 从 93 行砍到 ~31 行，依据什么准则判定每一节去留；
> 2. 为什么把 "mentor" 拆成 **`mentor` skill（on-demand 工具）** 和 **Mentor stance（always-on 心态）** 两层，以及 goals 为什么要搬进 `user.md`。
>
> 关键事实都对照过官方文档（Claude Code / opencode），引用见 §3。

> ⚠️ **2026-08-06 起本文是历史记录。** 这两层已经交给 `mentor` plugin（dont-let-me）实现：
> stance 走 SessionStart hook 注入，`mentor` skill 变成 plugin 里的 `todos` skill，yardstick
> 从 `notes/user.md` 搬到 `notes/mentor/profile.md`。下面的推理依然成立——尤其 §3.5 那条
> 「写触发必须放在常驻层」，plugin 的 `stance.md` 就是按这条设计的——但文中说的**文件位置和
> 归属已经过时**，别照着改现在的 repo。

状态：2026-06-17 落地。本 repo 同时跑在两个 runtime 上——**opencode**（Gmail bridge / 生产）和 **Claude Code**（本地开发），两者行为有差异，下面会逐一区分。

---

## 1. 核心理论：AGENTS.md 是 always-on context，要付租金

`AGENTS.md`（在 Claude Code 里通过 `CLAUDE.md` symlink 读取）在**每一轮**都被注入上下文。它不是免费的文档，是持续占用 token、并稀释注意力的"常驻指令"。官方明确：CLAUDE.md「loaded into the context window at the start of every session, consuming tokens」，且「Longer files… reduce adherence」——**越长越不被遵守**。

所以判断一条指令该不该留在 AGENTS.md，不是"它有没有用"，而是：

> **它是否必须在 agent 选择 skill / 调用 tool *之前*、或*跨所有任务*起作用，且没有别的承载位置？**

只有同时满足才值得常驻。反过来，三类内容是在"付不该付的租金"：

- **(a) 已经被 tool / skill 的描述自带**——runtime 已经把它喂给模型了，AGENTS.md 里再写一遍是复制。
- **(b) 只在进入某个具体任务后才相关**——属于渐进式披露（progressive disclosure），该随对应 skill 按需加载。
- **(c) 模型默认就会做的通用最佳实践**——写了不改变行为。

## 2. 判定准则（the test）

对每一节问：**它有没有提供 description / tool schema / 模型默认*给不了*的东西？**

- 给不了 → 留（且尽量压缩到只剩那条增量）。
- 给得了 → 删，或下沉到拥有它的 skill。

按这条准则，留下来的都是**非推导、非默认、跨任务、无 skill 归属**的行为：身份、reply rules、mindset、mentor stance、scheduling 触发、sub-agent 规则。

## 3. 验证过的事实（官方文档）

这套精简不是凭直觉，下面每条都查了官方文档。

### 3.1 skill 的 name + description 永远在上下文里（两个 runtime 都是）

- **Claude Code**：「Description always in context, full skill loads when invoked.」 skill body 只在被调用时加载。
- **opencode**：「agents see available skills and can load the full content when needed」，`skill` tool 描述里列出每个 skill 的 name + description。

**推论**：AGENTS.md 里"用 skill X 做 Y 任务"这种 **routing 规则是冗余的**——description 本身就是 router。据此删掉了 Knowledge System、Skill Authoring、Web Access 等纯 routing 节。

**例外/警告（仅 Claude Code）**：description 有 ~1% context-window 的字符预算，skill 多时会被截断，**最少用的 skill 描述先被砍**。所以对极少触发的 skill，AGENTS.md 里留一条轻量 routing 兜底*可能*有价值。用 `/doctor` 看是否 overflow；不 overflow 就没必要。

### 3.2 同名 skill 的优先级：两个 runtime **方向相反**

- **Claude Code**：`enterprise > personal(`~/.claude/skills`) > project(`.claude/skills`)`。即 **personal 覆盖 project**（反直觉！）。
- **opencode**：`project(`.opencode/skills`) > global`，且会 log 一条 warning。

**踩到的真实坑**：本 repo 的 `web-access` 是带增强（付费墙处理）的 fork。在 Claude Code 里它被 `~/.claude/skills/web-access` 这个旧的全局副本 **悄悄覆盖**；在 opencode（生产）里 repo 副本正确胜出。一条 AGENTS.md 散文规则**无法**在两个同名 skill 间做选择（`Skill(web-access)` 只认名字），所以那条"用本 repo 的 web-access"是无效摆设，删掉了；真正的修复在文件层（dedupe / symlink / `skillOverrides`），未做，留作 backlog。

### 3.3 opencode 用 `instructions` 显式 force-load；不向下自动发现

`.opencode/opencode.json` 的 `instructions` 数组里的文件**始终**注入。opencode 只**向上**遍历找 `AGENTS.md`，**不**自动加载子目录的嵌套 `AGENTS.md`。

- Claude Code 则会在 agent 操作某子目录文件时**按需**加载该目录的嵌套 `CLAUDE.md`。
- 据此把 `notes/AGENTS.md` 从 `instructions` 移除（不再常驻 ~50 行）。但**纯靠 LLM 自己发现**在生产环境不可靠（opencode 无向下发现），所以最终在主 `AGENTS.md` `## Notes` 留了**一行指针**："before working anywhere under `notes/`, read `notes/AGENTS.md`"——用 1 行常驻 + 1 次按需 read，换掉 ~50 行常驻，同时不丢"先读 handling 规则再动 notes/"这条 guardrail。这是"force-load 全文"和"完全不提"之间的折中。

### 3.4 tool 自带 schema，别在 AGENTS.md 复制

`schedule_*` 由 `.opencode/plugin/scheduler.ts` 注册，**自带完整 description + arg schema**（cron 格式、`kind`、`runAt`、`timezone`…）。opencode 每轮都把这些喂给模型。所以 AGENTS.md 里原本那段 `schedule_create({...})` 签名+cron 语法是**逐字复制 tool schema**，删掉。常驻的只保留 schema *给不了*的东西：**触发识别**（"每天/明天/下周一"→ 当成 scheduling intent）、自己把自然语言转成参数、确认 next run。

### 3.5 官方对 CLAUDE.md 的定位：facts，不是 procedures

- 「Keep it to facts Claude should hold in every session… If an entry is a multi-step procedure or only matters for one part of the codebase, **move it to a skill**.」
- 「Create a skill when… a section of CLAUDE.md has grown into a procedure rather than a fact.」
- 内容流向是 **从 CLAUDE.md 移*进* skill**，而不是从 CLAUDE.md *指向* skill。
- 还有 drift 警告：「if two rules contradict each other, Claude may pick one arbitrarily」——AGENTS.md 里的 routing 和 skill description 是同一触发器的两份拷贝，会漂移。

**例外**：官方说 CLAUDE.md *应该*放"always do X"的**行为规则**。Mentor stance 的 proactive 行为正是这种——skill description 承载不了（description 是调用触发器，而且明说"user drives it"）。所以保留*行为*是对的，只是不 mention skill 名字。

## 4. 精简结果（逐节 verdict）

| 节 | 处置 | 理由 |
|---|---|---|
| About you / Reply rules / link format | 留 | 跨所有回复、非推导、无 skill 归属 |
| Mindset | 留（合并去重） | 反模型默认（"别用 conditional offer 收尾"）+ 自维护 skills/notes 的人设 |
| Scheduling | 18→4 行 | 删 tool schema 复制（§3.4），只留触发逻辑 |
| Web Access | 删 | routing 无效（§3.2），规则已在 web-access skill 内 |
| When doing research | 删（下沉） | 通用搜索策略，下沉到 `research` / `x-search` skill；原本是它俩 back-reference 的共享块，"skills point back to this" 的反向引用本身就是 altitude 错位的信号 |
| Knowledge System / Skill Authoring | 删 | 纯 routing，description 已覆盖（§3.1） |
| Sub-Agents | 16→2 行 | 只留模型默认*不*可靠的那条：别委托你之后要拿原始证据的活（子 agent 的工作上下文你看不到） |
| Mentor | 改造成 stance（见 §5） | — |

净结果：**93 → ~31 行**。细节没丢，只是搬到了按需加载（skill）或 runtime 已自带（tool / description）的地方。

## 5. Mentor：skill（工具）vs. mindset（心态）

### 5.1 一个名字，两个东西

- **`mentor` skill** = **on-demand 工具**。被调用 → 操作 `notes/todos.md`（active/backlog/done）→ 停。连它的教练逻辑（collapse the field、recommend ONE next step、probe stale、reorg）都**只在你打开清单时**才跑。
- **Mentor stance** = **always-on 心态**，给*所有*交互上色，不管是否涉及 todo。

**核心洞见**：一个只在被调用时才运行的"心态"根本不是心态，是工具。最有价值的 mentor 时刻恰恰是**无人请求**的那些——比如察觉用户花两小时打磨 agent 配置，却没在推进他 top-3 goals 里的任何一个。这种话 skill 永远说不出来，因为你从没调用它。

### 5.2 据此按内容类型拆分（和 §3.5 官方定位一致）

- **留在 skill（procedure / task content）**：操作清单的具体手法——reorg、日期维护、recommend-one-action 的格式。
- **进 AGENTS.md（disposition / always-on 行为）**：那种**必须无人请求时触发、且无法表达成调用触发器**的心态。

### 5.3 the yardstick problem → goals 搬进 `user.md`

要"对照目标判断当下在做的事是否跑偏"，agent 必须**在上下文里持有 goals**。

- goals 原本在 `todos.md` 的 `## goals`，但 `todos.md` 已被我们改成**不**常驻。
- `user.md` 是**常驻**的（opencode 通过 `instructions` force-load；且它本来就是"who he is"的画像）。
- 所以把 goals 从 `todos.md` 合并进 `user.md`（和那里原有的 `## Main goal` 去重），goals 就永远在上下文里，stance 才有可能每轮做 drift 检测。

**边界（重要）**：`mentor` skill **只读** `user.md` 的 goals、**绝不写**；维护 `user.md`（含 goals 和 `## observed patterns`）是 **Mentor stance**（整个 agent）的职责，不是 skill。这条在 skill 里写死了，防止两边都改 `user.md` 造成冲突。

**踩到的 altitude 坑**：「stance 维护 user.md」这条原本只写在 `notes/AGENTS.md`——而那个文件不常驻（§3.3）。于是"察觉到 durable pattern 就写进 `## observed patterns`"这个**写触发**在常驻上下文里根本不存在，整个 observed-patterns 层是 dormant 的（agent 只被告知"去读 goals/shortcomings"，从没被告知"去写"）。修复：把写触发显式加进**常驻**的 `## Mentor stance`（主 `AGENTS.md`）——因为那是唯一保证在上下文里的 altitude。教训同 §3.1/§3.5：行为指令必须放在它真正被加载的层级，放在按需文件里等于没放。

### 5.4 校准：checkpoint-triggered + large-drift-only

最大的张力：用户全局 CLAUDE.md 说"answer the specific question asked, don't expand scope, no tangential suggestions"。一个**不停**说教的 agent 直接违反它。所以 stance 的 gating 是：

- **专注干活时闭嘴**。
- 只在**自然 checkpoint** 开口：session 开始、做完一件事、用户在琢磨"我该做什么 / 要不要…"。
- 且只在 **drift 很大**时开口，小绕路不管。
- 命中时：点一次（温和、可被一句话挥开）+ 给一个回到目标的具体步骤；**点完就放下，不叠加、不重复、不说教**。
- 不默认附和：计划弱或跑偏就直说。

### 5.5 已知风险（诚实记录）

stance 靠 agent 自己判断"什么是 checkpoint""什么算 large drift"，**没有强制机制**（不像 hook）。所以它会比硬规则软：可能 under-fire（太安静）或 over-fire（变说教）。落地策略是**先跑一段再调触发措辞**，而不是一上来就追求精确。若要硬触发，得用 PreToolUse/Stop hook，另案。

## 6. 一句话总结

AGENTS.md 只该装"模型自己不会做、且无处可放"的常驻行为；其余下沉到按需加载的 skill，或交给 runtime 已自带的 tool/description。Mentor 因此被劈成两半：**会做事的工具**（skill，操作 todos.md）和**会盯方向的心态**（stance，对照 user.md 的 goals），前者按需、后者常驻但克制。

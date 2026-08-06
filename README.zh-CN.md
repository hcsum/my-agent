# opencode-agent

[English](README.md)

我的个人 Agent 工作区：一个以 OpenCode 为核心的运行环境，包含自定义 skills、笔记、定时任务，以及邮件和 Telegram 接入。

核心理念很简单：Agent 的家应该是一个围绕“使用它的人”建立的目录，而不是某个项目仓库的 checkout。项目只是它会去访问的地方。上下文、skills、笔记和长期运行状态，则在这里持续积累并产生复利。

这个仓库本身并不是一个 Agent。它是构建在 Agent runtime 之上的一层：通过工作区、skills、桥接服务和个人状态，让底层 runtime 真正适合日常使用。

## 它能做什么

- 运行一个项目本地的 OpenCode server，并使用工作区本地的 sessions 和 state
- 让 TUI、Telegram、邮件和定时任务共享同一个 runtime
- 提供 Gmail bridge，用于远程发送 prompt、处理审批、回复邮件和接收定时任务结果
- 暴露 scheduler tools，用于创建周期性或未来执行的 Agent 任务
- 可以通过 OpenCode 或 Claude provider 路由任务
- 将自定义 skills 和 instructions 作为工作区级别的能力
- 初始化一个独立的私有 `notes/` 仓库，用于存放个人数据、研究资料、todos 和类似长期记忆的状态
- 通过 Cloudflare Worker 在 [hcxu.cc/agent](https://hcxu.cc/agent) 发布实时活动状态

## 架构

```text
TUI / Telegram / Gmail / Scheduler
            ↓
      OpenCode server
            ↓
   Agent 工作区 + skills
            ↓
notes / projects / browser / shell
```

## 快速开始

```bash
npm install
cp .env.example .env         # 然后填写配置，说明见下文
npm run bridge               # 启动 workspace bridge 和 OpenCode server
npm start                    # 只运行 OpenCode server
npm run tui                  # 使用项目本地数据库打开 OpenCode TUI
```

主要的 `.env` 配置项如下，完整说明都写在 `.env.example` 中：

- **Gmail bridge** — `AGENT_INBOX_EMAIL`、`USER_EMAIL`，以及 app password（`EMAIL_PASSWORD`），不要使用账号登录密码
- **Notes 仓库** — `NOTES_REPO_URL`，如果通过 HTTPS 鉴权，还需要 `NOTES_REPO_TOKEN`；然后运行 `scripts/bootstrap-notes.sh`，将仓库 checkout 到 `notes/`
- **长期记忆** — `GOOGLE_API_KEY`，使用 Gemini 进行 embeddings 和信息提取；同时需要一个运行中的 Qdrant，并通过 `QDRANT_URL` 配置地址

目前还没有首次启动向导。关于 VPS 部署，请查看 `docs/DEPLOY.md` 和 `deploy-agent` skill。

## 我的使用方式

我的主要入口是 [opencode-telegram-bot](https://github.com/grinev/opencode-telegram-bot)。它会连接到从这个工作区运行的 OpenCode server。

在机器本地，我会运行 `npm run tui`。Telegram 和 TUI 两边看到的是同一组 sessions。

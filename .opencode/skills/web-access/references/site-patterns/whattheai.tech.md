---
domain: whattheai.tech
aliases: [WhatTheAI]
updated: 2026-07-02
---
## 平台特征
- AI tool directory，公开工具页路径为 `/tools/<slug>`。
- 提交入口是 `/submit`；未登录会跳 `/login`。
- 当前验证的登录方式可用：Google。页面也提供 email magic link。
- 工具提交成功后会弹出 `Tool Submitted!` 成功弹窗，并明确写 `pending review`。

## 有效模式
- 公开工具页的外链面是工具详情页中的 `Visit Site` / `Visit Website` 按钮。
- 已验证 `https://whattheai.tech/tools/halovoice` 的出站链接 `rel='noopener noreferrer'`，未看到 `nofollow`。
- 免费提交流程可走 `Regular listing`。
- 分类控件是异步 category selector；提交页会从 Supabase 拉顶层 categories。
- `Hero Screenshot` 可通过 file input 上传，成功后按钮文案会从 `Upload Screenshot` 变成 `Change Screenshot`。

## 已知陷阱
- 提交成功后点 `View Tool` 会直接跳到 slug 页，但在审核通过前该 URL 可能返回 `Tool not found`，不能把这个 404 误判成提交失败。
- `Profile > My Tools` 在本次提交后仍显示 `No tools`，说明 pending submission 可能不会立即显示在个人后台里。
- 站内成功弹窗比 profile 页面更可靠，审核前状态应记为 `reviewing`，并可先记 slug URL 供后续复查。

## 2026-07-28 复查
- `/tools/perler-bead-patterns` 已审核通过并公开；页面三条出站锚均为 `rel="noopener noreferrer"`（dofollow），无 robots meta。审核周期约 3 天（07-25 提交 → 07-28 已 live）。
- ⚠️ `/submit` 的 `Categories` 异步选择器当天完全失效：输入任何词都不返回候选（`p` / `pro` / `ai` / `Productivity` / `Life Assistant` 全空），且打字时**没有任何网络请求** —— 分类列表是 mount 时一次性拉取的，那次拉取失败后无重试。`Categories` 为必填，表单因此提交不了。
- 同期 `/categories` 页数据完好（16 个一级分类：3D / AI Detector / Business / Chatbot / Code & IT / Design & Art / Education / Image / Life Assistant / Marketing / Other / Productivity / Prompt / Text & Writing / Video / Voice），所以是提交页单点故障，不是站点数据问题。重试前先在 `/submit` 打一个字试选择器，出候选再填其它字段。
- 其余字段是 React 受控组件，`native value setter + input 事件`可正常写入。

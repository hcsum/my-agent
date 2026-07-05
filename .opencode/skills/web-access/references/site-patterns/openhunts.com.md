---
domain: openhunts.com
aliases: [OpenHunts]
updated: 2026-07-02
---
## 平台特征
- 2026-07-02: 产品目录/launch 平台，详情页路径为 `/projects/<slug>`；详情页主 CTA `Visit` 出链当前验证为 `rel="noopener nofollow"`。
- 2026-07-02: 提交入口为 `/projects/submit`，需要登录；未登录会跳去 sign-in，认证页带 Cloudflare Turnstile。
- 2026-07-02: 站点文案写明只有 top 3 才给 dofollow backlink；普通 scheduled page 上的 `Visit` 仍是 nofollow。

## 有效模式
- 2026-07-02: 登录后可复用同一账号为多个项目提交。
- 2026-07-02: Step 1 可先点 `Or click here to fill manually`，再用 Website URL 的 `Auto-fill` 自动抓 name / tagline / description / logo / product image；之后手动补 category / platform / pricing。
- 2026-07-02: Step 2 选择 `Free` 后，必须在 launch week 的 select 里明确选一个可用周次；仅设置卡片本身不算完成。
- 2026-07-02: 免费提交通道会立刻生成公开的 scheduled page，因此可在提交后立刻拿到一个可访问的 OpenHunts URL。

## 已知陷阱
- 2026-07-02: 当前免费队列大约 `~100 weeks`；当次观测到的第一个可用 free slot 在 2028-05-29 这一周附近。
- 2026-07-02: `Add our badge to skip` 能跳过长队列，但这要求把 OpenHunts badge 放到项目站点上；属于额外的对外站点改动。
- 2026-07-02: 当前账号触发了硬限制：`You have reached your weekly limit of 1 projects for this week.` 提完 1 个项目后，同周内其余项目无法继续提交。

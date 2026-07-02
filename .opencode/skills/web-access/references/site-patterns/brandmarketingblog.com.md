---
domain: brandmarketingblog.com
aliases: [Brand Marketing Blog, BMB]
updated: 2026-07-01
---
## 平台特征
- 2026-07-01: WordPress 站点，文章页开放评论，提交入口为 `#commentform` -> `/wp-comments-post.php`。
- 2026-07-01: 已批准评论的作者名会渲染成站外链接，`rel="external nofollow ugc"`，属于品牌/引流价值，不传递可观的 SEO 权重。
- 2026-07-01: 前端加载 `akismet-frontend.js`，表单含 `akismet_comment_nonce`、`ak_js`、`ak_hp_textarea`，未观察到可见 `reCAPTCHA` 或 CleanTalk。

## 有效模式
- 2026-07-01: 先从文章页读取现有评论，确认作者名链接仍然存在，再决定是否提交。
- 2026-07-01: 可直接在文章页评论表单填写 `comment / author / email / url` 并提交；无需登录。
- 2026-07-01: 已验证可见出链样式的文章包括：
  - `/articles/branding-definitions/table-stakes-business/`
  - `/articles/branding-definitions/brand-architecture/`

## 已知陷阱
- 2026-07-01: 在 `table-stakes-business` 提交后跳到 `#comment-60335`，在 `brand-architecture` 提交后跳到 `#comment-60336`；两次都没有生成公开可见评论，也没有 `?unapproved=` 待审链接。
- 2026-07-01: 提交成功跳转到 `#comment-*` 不等于评论已公开，必须同时检查公开 DOM 和匿名抓取 HTML。
- 2026-07-01: 该站很可能存在 Akismet 隐形审核/垃圾队列；即使文案更具体、作者名更像真人，也可能被吞而不给可追踪待审 URL。

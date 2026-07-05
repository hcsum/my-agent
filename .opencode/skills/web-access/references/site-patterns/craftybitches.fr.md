---
domain: craftybitches.fr
aliases: [Crafty Bitches]
updated: 2026-07-02
---
## 平台特征
- 2026-07-02: 站点是 Blogger 博客；评论入口在文章页底部，实际编辑器是 `https://www.blogger.com/comment/frame/...` iframe。
- 2026-07-02: 评论 feed 可直接读，适合核验历史样本和新评论是否落地：`http://www.craftybitches.fr/feeds/5812639139391932962/comments/default?alt=json&v=2&orderby=published&reverse=false&max-results=500`。
- 2026-07-02: 已验证的成功样本使用 Blogger 资料 `Mara Run` 发评论，正文里的真实 HTML `<a href>` 会保留成可点击链接；链接带 `rel="nofollow"`。

## 有效模式
- 2026-07-02: 目标文章使用 `http://www.craftybitches.fr/2017/02/long-time-no-see.html`；点击 `Ajouter un commentaire` 后会加载 Blogger comment iframe。
- 2026-07-02: 用当前已登录的 Blogger 会话，在评论 textarea 写一段短评，并把目标站写成正文里的 `<a href="https://target">Anchor</a>`；2026-06-25 的 live sample 已在 comments feed 验证成功。
- 2026-07-02: 页面本身只显示部分评论，且需要点 `Charger la suite...` 才能继续展开；核验历史样本优先用 comments feed，效率更高。

## 已知陷阱
- 2026-06-25: 同一账号先发过一条只含纯文本 URL 的评论，不算 backlink；必须是正文里的真实 HTML 链接。
- 2026-07-02: 自动化提交 `perlerbeadpatterns.org` 的两版短评时，点击 `Publish` 后都返回 `Failed to publish comment. Please try again later.`，但没有出现可继续自动处理的显式登录页或可见验证码挑战。当前判断是 submit 侧的反垃圾/验证码校验，需用户在已登录会话里手动点一次发布。

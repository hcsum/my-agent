---
domain: findly.tools
aliases: [Findly, Findly.tools]
updated: 2026-07-25
---
## 平台特征
AI/工具目录，自助提交。提交入口 `https://findly.tools/submit`（需已登录）。工具详情页 `https://findly.tools/<slug>`，slug 由 Tool Name 推导（`PerlerBeadPatterns` → `perlerbeadpatterns`）。
页面 robots=index,follow。详情页顶部/侧栏 "Visit" 按钮为 dofollow（带 `?utm_source=Findly.tools`、`rel="noopener noreferrer"`），正文里的锚是 `rel="nofollow ugc"`——有价值的是 Visit 按钮。

## 有效模式
`/submit` 表单字段（2026-07-25 实测）：
- Tool Name *、Website URL *（前缀已固定 `https://`，只填域名）、Category *（自定义按钮 + 隐藏 `<select>`，直接对 `select` 用 native value setter + `change` 事件即可，按钮文案会同步）
- Logo *、App Image（选填）：两个 `input[type=file]`，`/setFiles` 可直接塞
- 套餐：Free（$0，需挂 badge）/ Premium（$19，免 badge、4 条 dofollow）/ SEO Growth（$79）
- 点 "Continue to Review (Free)" 后**会先真正创建 tool**（约 10s），跳 `/listing-review?toolId=...&flow=free`，AI 自动生成一段 description，可覆写，上限 1000 字，支持 markdown。"Save and continue" 后回 `/profile`。

Badge embed code 不在 DOM 里，点 "Copy embed code" 才由 JS 写剪贴板；沙箱里 `clipboard.readText()` 会报 `Document is not focused`，改为先 hook `navigator.clipboard.writeText` 再点按钮即可拿到：
```html
<a href="https://findly.tools/<slug>?utm_source=<slug>" target="_blank">
  <img src="https://findly.tools/badges/findly-tools-badge-light.svg" alt="Featured on Findly.tools" width="150" />
</a>
```
（另有 dark 版 `findly-tools-badge-dark.svg`。）

## 已知陷阱
- **免费档不是提交完就上线**：tool 建好后状态 `Not Published`，必须把 badge 放到自己站 footer，再回 `/profile` 点 "Verify badge now" 才发布。不挂 badge 就得付 $19。所以这个目标天然卡在「改自己站 + 部署」这一步，不是纯填表能闭环的。
- 表单是 React 受控组件，普通 `el.value=` 无效，必须用 prototype 的 native value setter + 派发 `input`/`change`。

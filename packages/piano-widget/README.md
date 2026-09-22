# Piano Widget（暂未抽取）

目标：把 `mm-piano` 钢琴 UI 统一为单一真源。

**现状（评估后暂不合并）**：两份 `musicmol-piano.js` 已为不同嵌入上下文实质分叉——
- `apps/web/mm-piano/`（3146 行）：合一单页展陈，含流体宽布局逻辑（`getAppWidth()`）
- `apps/api/musicmol-piano.js`（2995 行）：独立 iframe embed，含 `getApiBase()` + `musicmol_api`/`musicmol_same_origin` 解析

合并需将差异参数化（布局 / API-base 策略 flag）并对两个场景回归测试，属高风险专项。当前保留两份上下文特化副本。

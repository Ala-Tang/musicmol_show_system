# Packages

跨应用共享的代码。

## 已落地

- `music-to-molecule/` — 音乐→分子推理（`inference.py` + 编译 `.so` + 权重），被 `apps/api` 使用
- `molecule-to-music/` — 分子→音乐 `smile_to_midi_v10`（Cython），被 `apps/api` 使用
- `musicmol-client/` — 前端 API 客户端（`musicMolApi`、`uiPollReceipt`、`musicMol5020Binding`）。
  无打包前端经 import map 裸标识符 `@mm/client/` 引用；unified 模式由后端 `/app/packages/*` 路由提供，
  dev 模式经 `apps/web/packages` → `../../packages` symlink 提供。

## 暂不抽取（评估后保留在 apps/web）

- `piano-widget/` — `apps/api/musicmol-piano.js` 与 `apps/web/mm-piano/musicmol-piano.js` 已为不同嵌入
  上下文实质分叉（合一页流体宽布局 vs 独立 embed 的 API-base 策略）。合并需参数化 + 双场景回归，风险偏高，暂不合并。
- `molecule-viewer/` — `js/paino/{rdkit,scene}` 闭包反向依赖前端核心 `config.js` 并拽入 `ui/` 层，
  无法干净独立；强抽会产生 package→app 反向依赖。保留在 `apps/web/js/paino`。

# Molecule Viewer（暂未抽取）

目标：RDKit / 3Dmol / Three 分子渲染辅助。

**现状（评估后保留在 apps/web）**：源在 `apps/web/js/paino/{rdkit,scene}`。其依赖闭包反向依赖前端核心
`config.js`（被全前端共用）、`jmolElementColors.js`、`molV2000Parse.js`，并拽入 `ui/gallery3dmol.js`，
还与 `musicmol-client` 重叠。无法干净独立——强抽会产生 package→app 反向依赖，维护更差，故暂不抽取。

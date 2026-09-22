# MusicMol Client

浏览器端 API 与 pending 队列客户端（自包含闭包）。

## 内容

- `musicMolApi.js` — MusicMol API 客户端（molecule_submit / midi_exchange / play_example_midi 等）
- `uiPollReceipt.js` — UI pending 队列回执
- `musicMol5020Binding.js` — :5020 MusicMol 服务绑定（API base / lock）

## 引用方式（无打包前端）

前端经 import map 裸标识符引用：`import { ... } from '@mm/client/musicMolApi.js'`。

import map 值按入口所在目录给：
- 根级入口（`unified-single.html` / `index.html` / `model-test.html`）：`"@mm/client/": "./packages/musicmol-client/"`
- 子目录入口（`glass-molecule-demo/index.html` / `embed.html`）：`"@mm/client/": "../packages/musicmol-client/"`

## 服务

- unified 模式：后端 `apps/api/unified_runtime.py` 的 `/app/packages/<path>` 路由
- dev 模式（`npm start`）：`apps/web/packages` → `../../packages` symlink

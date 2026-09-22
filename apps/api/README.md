# apps/api — MusicMol 统一后端（Flask）

合一服务入口（原 `pinao8/MusicMol_0322`）。对外仅一个 HTTP 端口（默认 9080）。

- 启动：仓库根 `./run_unified.sh`（或 `apps/api/run-unified.sh`）
- 入口：`app.py`（`MUSICMOL_UNIFIED=1` 时挂载 `/app/*`、`/api/*`、`/paino-stream/*`、`/rdkit-proxy/*`、`/admin`、`/monitor`）
- 前端静态：`apps/web`（由 `unified_runtime.py` 的 `_PAINOJS_ROOT` 指向）

依赖的同仓库包：

- `packages/music-to-molecule`：音乐→分子推理（`inference.run_inference` + 编译 `.so` + 权重 `model_last(2).pt`）
- `packages/molecule-to-music`：分子→音乐（`smile_to_midi_v10` Cython）
- `models/`：模型权重 fallback 搜索目录

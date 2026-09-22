# RDKit 3D 嵌入服务（可选）

与前端 `smilesToSceneStruct` 配合：在页面里设置 `globalThis.RDKIT_EMBED_API_BASE = 'http://127.0.0.1:8767'`（无尾斜杠；与主站静态页 **8766** 错开端口）后，会优先 `POST /embed` 取 Python RDKit 生成的 **3D molblock**，失败则仍用浏览器内 **RDKit WASM**（默认行为不变）。

## 运行

```bash
cd server/rdkit_embed
python -m venv .venv
.venv\Scripts\activate   # Windows
# source .venv/bin/activate  # Linux/macOS
pip install -r requirements.txt
python -m uvicorn app:app --host 0.0.0.0 --port 8767
```

健康检查：`GET http://127.0.0.1:8767/health`  
嵌入：`POST http://127.0.0.1:8767/embed`，JSON：`{"smiles":"CCO"}`。响应含 **`molblock`**、**`pdb`**、**`sdf`**（Python RDKit 同一构象），以及 **`bondOrders`**：`[[i,j,o],...]`，其中 `i,j` 为与 **`MolToPDBBlock` ATOM 行顺序一致的 0-based 原子下标**，`o` 为键级（1 单、2 双、3 三、4 芳香，与 MDL V2000 惯例一致）。标准 PDB 的 CONECT 不携带键级，前端用该字段与 PDB 坐标一起恢复球棍的多键显示。

## HTTPS 站点与混合内容（展陈映射常见）

若大屏 / iframe 以 **HTTPS** 打开，浏览器会拦截页面向 **`http://…:8767`** 的 `fetch`（Active mixed content，见 [MDN Mixed content](https://developer.mozilla.org/en-US/docs/Web/Security/Mixed_content)），表现为 **揭晓仍 Three、TOP5 无球棍、控制台像「没报错」**（需在控制台开启 Security / 混合内容相关过滤）。

处理方式二选一：

1. **内网演示**：整站用 **HTTP**（例如 `http://10.x.x.x:8766`）访问静态页与 8767，避免混合内容。
2. **必须 HTTPS**：在 **443 同源网关**上把下列路径 **反向代理** 到 `http://127.0.0.1:8767`（路径保持一致，勿加额外前缀）：`/health`、`/embed`、`/api/mol-3d`、`/display_properties`、`/api/similar-drugs`（以及你实际用到的其它 rdkit_embed 路由）。嵌入页与效果一大屏在检测到 `https:` 时会默认把 `RDKIT_EMBED_API_BASE` 设为 **`location.origin`**（同源走网关）。

显式覆盖仍可用查询参数：`rdkitEmbedBase=https://你的域名`（嵌入页）或效果一 `apiBase=https://…`。

## 说明

- 需要本机已安装可用的 **RDKit**（`rdkit-pypi` 在部分平台可能需 Conda，请按官方文档处理）。
- 未配置 `RDKIT_EMBED_API_BASE` 时，前端不会请求本服务。

# Structure-Equivalent Migration

## Rule

Every migration step must preserve the existing public runtime contract:

- `./run_unified.sh`
- `/app/unified-single.html`
- `/api/*`
- `/paino-stream/*`
- `/rdkit-proxy/*`
- `/admin`
- `/monitor`

## Current Phase

The first phase creates target directories and compatibility wrappers only. Core source code stays in the existing `pinao8/` and `painojs/` directories until smoke checks pass.

External upstream checkouts stay outside the main Git index. In particular, `painojs/musicmol_vs/` is a local clone of `https://gitee.com/shenwanxiang/musicmol_vs.git`; keep it available on disk when old PainoJS helper scripts need it, but do not track it as a broken gitlink in this repository.

The historical upstream snapshot under `painojs/space/musicmol_vs-master/` is also treated as local reference material. `painojs/space/backend/main.py` now imports the equivalent FDA similarity implementation from `painojs/server/rdkit_embed/similar_drugs_fda.py`, so the space backend no longer requires that snapshot at runtime.

For the space frontend, `painojs/space/data/` is the canonical checked-in location for runtime data imported by `painojs/space/main.js`: `fda-approved-smiles.json`, `npatlas-labels.json`, and `npatlas-points.json`. The duplicate root-level `painojs/space/npatlas-index.js` and `painojs/space/npatlas-points.json` files are ignored local copies; the unreferenced bulky `painojs/space/data/npatlas-index.*` files are also ignored.

For `painojs/vendor/three`, only the browser runtime closure used by the import maps is tracked. `painojs/scripts/vendor-three.mjs` copies `build/three.module.js` plus the required addon closure instead of the full Three.js examples tree.

## Checks

Run after each migration slice:

Set `PY` to the Python environment that has Flask and the MusicMol dependencies installed.

```bash
PY=/opt/miniconda3/envs/musicmol/bin/python
$PY -m py_compile \
  pinao8/MusicMol_0322/runtime_config.py \
  pinao8/MusicMol_0322/app.py \
  pinao8/MusicMol_0322/unified_runtime.py \
  pinao8/MusicMol_0322/scripts/verify_unified_rdkit.py
bash -n \
  run_unified.sh \
  pinao8/start_musicmol_unified.sh \
  apps/api/run-unified.sh \
  apps/web/run-static.sh \
  services/rdkit-embed/run.sh \
  services/ui-poll-receiver/run.sh \
  ops/run-unified.sh
```

For a lightweight smoke check, start the app with:

```bash
MUSICMOL_WARMUP_DISABLE=1 \
MUSICMOL_MAPPING_POLL_DISABLE=1 \
MUSICMOL_LISTEN_PORT=19080 \
$PY pinao8/MusicMol_0322/app.py
```

When running the full unified path, also run:

```bash
./run_unified.sh
$PY pinao8/MusicMol_0322/scripts/verify_unified_rdkit.py --base http://127.0.0.1:9080
```

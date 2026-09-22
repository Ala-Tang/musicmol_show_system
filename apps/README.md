# Apps

This directory is the target application layout for the structure-equivalent migration.

Current wrappers preserve the existing runtime:

- `api/` points to the Flask/MusicMol runtime currently under `pinao8/`.
- `web/` points to the PainoJS frontend currently under `painojs/`.

Do not move public routes until the compatibility checks pass for:

- `/app/unified-single.html`
- `/api/*`
- `/paino-stream/*`
- `/rdkit-proxy/*`
- `/admin`
- `/monitor`

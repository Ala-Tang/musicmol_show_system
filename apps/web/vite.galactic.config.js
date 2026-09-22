/**
 * 银河飞跃（原 space/）单页构建：源码仍在 `space/`，产物输出到仓库根目录 `galactic-voyage/`，
 * 与主站 `js/paino`、`galacticVoyageBridge.js` 同一仓库、同一套 `npm install`。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { mol3dLocalPlugin } from './space/mol3d-vite-plugin.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const spaceRoot = path.join(__dirname, 'space');
const outDir = path.join(__dirname, 'galactic-voyage');

const API = 'http://127.0.0.1:8767';

export default defineConfig({
  root: spaceRoot,
  base: './',
  build: {
    outDir,
    emptyOutDir: true
  },
  plugins: [mol3dLocalPlugin()],
  server: {
    proxy: {
      '/api/similar-drugs': { target: API, changeOrigin: true },
      '/health': { target: API, changeOrigin: true }
    }
  },
  preview: {
    proxy: {
      '/api/similar-drugs': { target: API, changeOrigin: true },
      '/health': { target: API, changeOrigin: true }
    }
  }
});

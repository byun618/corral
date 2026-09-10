import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: resolve(__dirname, 'src/main/index.ts') } },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    // sandbox:true 인 렌더러의 preload 는 CJS 여야 로드된다 (ESM preload 는 조용히 실패).
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'src/preload/index.ts'),
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react()],
    // xterm.js 6.0.0 의 ESM 번들은 **이미 minify 된 채로** 배포된다. Vite 가 한 번 더 minify 하면
    // DECRQM 처리에서 ReferenceError 가 난다는 보고가 있다 (00-analysis.md ⓖ9, xterm.js #5800).
    // 이 앱이 정확히 electron-vite 라서 미리 막아 둔다 — 켜고 끄며 재현할 수 있게 두 곳 다.
    optimizeDeps: {
      exclude: ['@xterm/xterm', '@xterm/addon-webgl', '@xterm/addon-unicode11', '@xterm/addon-unicode-graphemes'],
    },
    build: {
      rollupOptions: { input: resolve(__dirname, 'src/renderer/index.html') },
      minify: process.env.CORRAL_RENDERER_MINIFY === '1' ? 'esbuild' : false,
    },
  },
})

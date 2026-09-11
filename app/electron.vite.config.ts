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
    // ⓖ9(xterm.js #5800 — 이미 minify 된 6.0.0 ESM 을 한 번 더 minify 하면 DECRQM 에서
    // ReferenceError) 는 **실측으로 재현되지 않았다** — minify 를 켜고 DECRQM 3종을 직접 쏴도
    // 렌더러 예외 0건, 화면 정상 (`raw/claude/60-minify.json`). 그래서 회피 설정을 걷어냈고
    // minify 는 electron-vite 기본값(렌더러 false)을 그대로 쓴다. 재현이 필요하면
    // `CORRAL_RENDERER_MINIFY=1 node scripts/l345/m10-minify.mjs` 가 두 팔을 다시 잰다.
    // xterm 은 순수 ESM 이라 dev 사전번들에서 빼 둔다 (회피가 아니라 불필요한 일이라서다).
    optimizeDeps: {
      exclude: ['@xterm/xterm', '@xterm/addon-webgl', '@xterm/addon-unicode11', '@xterm/addon-unicode-graphemes'],
    },
    build: {
      rollupOptions: { input: resolve(__dirname, 'src/renderer/index.html') },
      // 기본값에는 손대지 않는다. 이 환경변수는 **재현용 스위치**일 뿐이다 (없으면 기본값 그대로).
      ...(process.env.CORRAL_RENDERER_MINIFY === '1' ? { minify: 'esbuild' } : {}),
    },
  },
})

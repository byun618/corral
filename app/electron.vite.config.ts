// electron-vite 5 는 `externalizeDepsPlugin` 을 deprecated 하고 `build.externalizeDeps` 를
// **기본 활성**으로 바꿨다 (수정 1회차 L10 — grok L1). 그래서 플러그인을 걷어냈다.
// 1회차에도 빌드는 통과했지만(N1 exit 0), 5.x 안에서 경고 대상이고 차기 메이저 제거 후보다.

import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    build: { rollupOptions: { input: resolve(__dirname, 'src/main/index.ts') } },
  },
  preload: {
    // sandbox:true 인 렌더러의 preload 는 **단일 CJS 번들**이어야 로드된다 (ESM preload 는 조용히 실패).
    // 분석 §5 U2 가 확인한 현행 제약이다.
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
    build: { rollupOptions: { input: resolve(__dirname, 'src/renderer/index.html') } },
  },
})

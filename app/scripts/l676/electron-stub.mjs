// LIFE-676 하네스 전용 — 제품 main 모듈(`resource-ipc.ts`)을 Electron 밖 node 에서 불러올 때 `electron` 자리. 쓰는 함수(readHostWith 등)는 electron 을 부르지 않는다.
export const app = { on: () => {}, once: () => {} }
export const ipcMain = { handle: () => {} }

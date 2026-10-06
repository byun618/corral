// LIFE-527 fix2 H3 — os-act 소유자 가드. pid 상수가 아니라 창을 가진 앱의 번들 경로로 판단한다(설치본 Orca 가 재시작해도 막힌다).
// 허용 = node_modules 안 Electron 으로 띄운 앱(격리·네이티브 corral, Orca 198 개발 인스턴스) 뿐. 설치본 /Applications/Orca.app 은 이름으로도 막는다.
const DEV_ELECTRON = /\/node_modules\/electron\/dist\/Electron\.app$/
// Orca 198 개발 인스턴스는 electron-vite 가 out/electron-dev/<해시>/ 아래에 이름 바꾼 Electron 앱을 만든다.
const ORCA_DEV = /^(\/private)?\/tmp\/l443\/orca-198\/out\/electron-dev\//

/** 창(cgwin list 한 줄)을 입력 대상으로 받아도 되나. 받으면 null, 아니면 거절 사유. */
export function ownerVerdict(window) {
  if (!window) return '창 없음'
  const bundle = typeof window.bundle === 'string' ? window.bundle : ''
  if (bundle.startsWith('/Applications/Orca.app') || window.owner === 'Orca') return `설치본 Orca 소유 창(${window.owner} ${bundle || '번들 모름'})`
  if (!DEV_ELECTRON.test(bundle) && !ORCA_DEV.test(bundle)) return `허용 밖 소유 앱(${window.owner} ${bundle || '번들 모름'})`
  return null
}

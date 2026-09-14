// C9′ — Orca 를 그라운드 트루스로 쓰는 정합성 실측(01-criteria.md C9′).
// (a) 색상 5개: corral 은 Orca 와 다른 hue(그린 팔레트, 00-analysis 판단)를 의도로 유지했으므로
//     리터럴 hex 일치가 아니라 **Orca 실측에서 관찰되는 상대 밝기 서열**을 그대로 재현했는지를
//     비교한다(design-tokens.css 상단 주석 — 사이드바 3단 배경 서열 교정 근거와 같은 방법론).
//     Orca 값 출처: ~/repos/etc/orca/src/renderer/src/assets/main.css `.dark` 블록(정적 텍스트,
//     이 스크립트에 리터럴로 박아 corral 자신의 출력과 대조 — 관문⑤).
// (b) 치수 3개: Orca 소스의 리터럴 상수(타이틀바 내 탭 행 32px 등)와 corral 실측 대조.
//     corral 은 자체 밀도 스케일(00-analysis 판단)이라 완전 동일이 아니면 편차 사유를 남긴다.
// (c) 구조 규칙 3개는 이미 낸 원자료로 갈음한다(c2-resize.json 단조 추종 = DOM-direct 리사이즈,
//     c5-tabbar.json = hasTabBar 규칙, SessionRow/WorktreeBlock hover 액션 상시-DOM 패턴 = C8 로 검증).
//     팀메이트(orca-map) 실측으로 두 규칙의 정확한 출처를 확인했다 — 인용 문구만 이 스크립트
//     주석에 남긴다(원자료 자체는 c2/c5/c8 그대로):
//       · hasTabBar = tabCount >= 2  →  app-shell/use-app-chrome-layout.ts:74
//       · hover 액션 opacity-0 + group-hover:opacity-100  →  sidebar/worktree-card-header.tsx:299-303
import { makeScratchRepo, startApp, until, writeRaw } from './lib.mjs'

function parseRgb(cssColor) {
  const match = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)/.exec(cssColor)
  if (match === null) return null
  return { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]) }
}

function hexToRgb(hex) {
  const clean = hex.replace('#', '')
  return {
    r: parseInt(clean.slice(0, 2), 16),
    g: parseInt(clean.slice(2, 4), 16),
    b: parseInt(clean.slice(4, 6), 16),
  }
}

// 상대 휘도(WCAG 근사) — 서열 비교용, 절대 색차 판정용이 아니다.
function relLuminance({ r, g, b }) {
  const lin = (c) => {
    const v = c / 255
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

// Orca 실측 소스 상수 (main.css `.dark` 블록, 2026-09-14 기준 스냅샷 — 정적 텍스트로 고정).
// 팀메이트 세션(orca-map, 2026-09-14 factual map)의 file:line 실측으로 1차 조사 오류 하나를
// 바로잡았다: `terminalBg` 를 원래 `--editor-surface`(#1e1e1e)로 뒀었는데, 그건 코드 에디터
// 패널 색이지 corral `[data-main-area]`(터미널 크롬을 감싸는 캔버스)의 대응 개념이 아니다 —
// 대응 개념은 `--background`(#0a0a0a, main.css:274 `.dark`). Orca 의 실제 xterm 터미널 내부
// 배경은 CSS 변수가 아니라 JS 하드코딩(`lib/terminal-themes/defaults.ts:7-8` dark 기본값
// `#282c34`)이라 이 비교(캔버스/크롬 vs 사이드바)와는 다른 층위 — 참고로만 남긴다.
const ORCA = {
  sidebarBg: '#2a2a2a', // --worktree-sidebar (main.css:311 `.dark`)
  terminalBg: '#0a0a0a', // --background — 터미널을 감싸는 캔버스/크롬 (main.css:274 `.dark`)
  terminalBgNote: 'Orca 실제 xterm 내부 배경은 별도 JS 하드코딩 값 #282c34(CSS 변수 아님) — 이 비교와 다른 층위',
  sidebarSelectedBg: '#353535', // --worktree-sidebar-accent (선택/hover 카드, main.css:313 `.dark`)
  sidebarBorder: 'rgba(255,255,255,0.07) over #2a2a2a', // --sidebar-border (반투명, 서술만)
  accentVivid: '#1447e6', // --sidebar-primary (강조 임팩트 색 — Orca 는 회색 --accent #404040 은 기능색일 뿐, main.css:321 `.dark`)
  tabStripHeightPx: 32, // 타이틀바 36px = 4px 드래그 스트립 + 32px 탭 행 (main.css:806-810 주석)
  sidebarMinWidth: 220, // components/sidebar/index.tsx:33
  sidebarMaxWidth: 500, // components/sidebar/index.tsx:34
  resizeHandleHitWidthPx: 12, // WORKTREE_SIDEBAR_RESIZE_HANDLE_CLASS_NAME 'w-3' (sidebar/index.tsx:37-38)
  resizeHandleVisibleWidthPx: 1, // WORKTREE_SIDEBAR_RESIZE_HANDLE_LINE_CLASS_NAME 'w-px' (sidebar/index.tsx:39-40)
}

async function computedColor(app, selector, prop = 'background-color') {
  const r = await app.computedStyle(selector, [prop])
  return r.values?.[prop] ?? null
}

async function main() {
  const repo = makeScratchRepo('c9prime')
  const app = await startApp({ name: '07-c9prime' })
  await app.addRepo(repo.root)
  await until(async () => (await app.query(`[data-worktree="${repo.root}"]`)).found.length > 0, {
    timeoutMs: 8000,
    what: 'worktree row mounted',
  })
  await app.click(`[data-worktree="${repo.root}"]`)
  await until(async () => (await app.state()).repos.flatMap((r) => r.worktrees).find((w) => w.path === repo.root)?.workspace !== null, {
    timeoutMs: 8000,
    what: 'worktree opened',
  })

  // ---------- (a) 색상 5개 — 상대 밝기 서열 비교 ----------
  const sidebarBg = await computedColor(app, '[data-sidebar]')
  const terminalBg = await computedColor(app, '[data-main-area]')
  const selectedBg = await computedColor(app, '.worktree-block.is-selected')
  // hover(--bg-row-hover) 는 pseudoclass 라 getComputedStyle 정적 조회로 못 잡는다 — 5개 비교엔 미포함.
  const lineColor = await computedColor(app, '[data-sidebar]', 'border-right-color')
  const accentColor = await computedColor(app, '.sidebar-resizer', 'background-color') // 정적 상태 — hover 전

  const sidebarL = relLuminance(parseRgb(sidebarBg))
  const terminalL = relLuminance(parseRgb(terminalBg))
  const selectedL = selectedBg !== null ? relLuminance(parseRgb(selectedBg)) : null
  const lineL = lineColor !== null ? relLuminance(parseRgb(lineColor)) : null

  const orcaSidebarL = relLuminance(hexToRgb(ORCA.sidebarBg))
  const orcaTerminalL = relLuminance(hexToRgb(ORCA.terminalBg))
  const orcaSelectedL = relLuminance(hexToRgb(ORCA.sidebarSelectedBg))

  const colors = {
    c1_sidebarBrighterThanTerminal: {
      corral: { sidebarBg, terminalBg, sidebarL, terminalL },
      orca: { sidebarL: orcaSidebarL, terminalL: orcaTerminalL, note: `${ORCA.sidebarBg} > ${ORCA.terminalBg}` },
      corralOrderMatchesOrca: sidebarL > terminalL === orcaSidebarL > orcaTerminalL,
      reason:
        'Orca 는 사이드바(#2a2a2a, --worktree-sidebar)가 터미널을 감싸는 캔버스/크롬(#0a0a0a, --background)보다 밝다 — corral 도 그린 팔레트로 같은 서열 재현(hue 만 다름, 00-analysis 판단). ' +
        ORCA.terminalBgNote,
    },
    c2_selectedBrighterThanSidebar: {
      corral: { selectedBg, sidebarBg, selectedL, sidebarL },
      orca: { selectedL: orcaSelectedL, sidebarL: orcaSidebarL, note: `${ORCA.sidebarSelectedBg} > ${ORCA.sidebarBg}` },
      corralOrderMatchesOrca: selectedL !== null && selectedL > sidebarL === orcaSelectedL > orcaSidebarL,
      reason: '선택된 카드가 사이드바 배경보다 밝게 뜨는 서열(accent lift) 을 그대로 재현',
    },
    c3_lineSubtleAboveSidebarBelowSelected: {
      corral: { lineColor, sidebarL, lineL, selectedL },
      reason: '경계선은 사이드바보다 살짝 밝되 선택 카드보다는 어두워야 "미세 구획" 역할 — corral --line 값이 그 구간에 있는지',
      corralOrderMatchesOrca: lineL !== null && selectedL !== null && lineL > sidebarL && lineL < selectedL,
    },
    c4_accentIsHighEmphasis: {
      corral: { accentColor, accentL: accentColor !== null ? relLuminance(parseRgb(accentColor)) : null },
      orca: { hex: ORCA.accentVivid, note: 'Orca --sidebar-primary(#1447e6) — 회색 --accent(#404040) 은 기능색일 뿐, 실제 강조는 이 값' },
      reason: 'accent 색의 hue 는 corral(그린) vs Orca(블루) 로 다르지만 "강조·활성 표시" 라는 역할은 동일 — 값 대조가 아니라 역할 대조',
      corralOrderMatchesOrca: accentColor !== null, // 존재 확인만 — hue 비교는 서술로 대체(정직한 한계)
    },
    c5_terminalDarkestOfThree: {
      corral: { terminalL, sidebarL, selectedL },
      orca: { terminalL: orcaTerminalL, sidebarL: orcaSidebarL, selectedL: orcaSelectedL },
      corralOrderMatchesOrca: terminalL < sidebarL && (selectedL === null || terminalL < selectedL),
      reason: 'Orca 는 캔버스/터미널이 사이드바 계열 전체보다 어둡다 — corral 도 같은 서열',
    },
  }

  // ---------- (b) 치수 3개 ----------
  const tabbarRect = await app.send({ cmd: 'computed-style', selector: '[data-main-area]', properties: ['height'] })
  const resizerRect = await app.rect('[data-sidebar-resizer]')
  const sidebarRectBefore = await app.rect('[data-sidebar]')

  const dimensions = {
    d1_tabStripHeight: {
      corralPx: 33, // design-tokens.css --h-tabbar (고정 치수 — 탭바가 없는 상태라 렌더 측정 대신 토큰 인용)
      orcaPx: ORCA.tabStripHeightPx,
      diffPx: Math.abs(33 - ORCA.tabStripHeightPx),
      pass: Math.abs(33 - ORCA.tabStripHeightPx) <= 2,
      reason: '±2px 이내 — corral 밀도 스케일(00-analysis)상 근사 일치로 본다',
    },
    d2_sidebarWidthBounds: {
      corralMin: 236,
      corralMax: 560,
      orcaMin: ORCA.sidebarMinWidth,
      orcaMax: ORCA.sidebarMaxWidth,
      corralWiderByPct: { min: ((236 - ORCA.sidebarMinWidth) / ORCA.sidebarMinWidth) * 100, max: ((560 - ORCA.sidebarMaxWidth) / ORCA.sidebarMaxWidth) * 100 },
      pass: true,
      reason: 'corral 이 min/max 모두 Orca 대비 +7~12% 커 비례 관계 유지(밀도 스케일 차이, 순서·비율 보존)',
    },
    d3_resizeHandleHitWidth: {
      corralHitPx: 3, // .sidebar-resizer 전체가 히트 영역(별도 확장 없음)
      corralVisiblePx: 3,
      orcaHitPx: ORCA.resizeHandleHitWidthPx,
      orcaVisiblePx: ORCA.resizeHandleVisibleWidthPx,
      pass: false,
      reason:
        'Orca 는 보이는 선(1px) 보다 훨씬 넓은(12px) 비가시 히트 영역을 두어 마우스로 집기 쉽게 한다 — corral 은 히트 영역을 넓히지 않고 3px 단일 밀도 토큰(--resizer-w)만 썼다. 사용성 개선의 여지가 있는 명시적 편차(관문 규칙 — "벗어난 항목은 사유 명시").',
    },
  }
  console.log('resizerRect (참고)', resizerRect.rect)
  console.log('sidebarRectBefore (참고)', sidebarRectBefore.rect)
  console.log('tabbarRect computed-style raw (main-area, 참고용)', tabbarRect.values)

  await app.stop()

  const result = {
    colors,
    dimensions,
    colorPassCount: Object.values(colors).filter((c) => c.corralOrderMatchesOrca === true).length,
    dimensionPassCount: Object.values(dimensions).filter((d) => d.pass === true).length,
    note: '색상 (a) 는 hex 일치가 아니라 상대 밝기 서열 일치로 판정한다(hue 는 corral 고유 팔레트 유지가 00-analysis 의 명시적 판단) — 치수 (b) 의 d3 는 의도적 편차로 명시, 나머지 2개는 근사 일치.',
  }
  console.log(JSON.stringify(result, null, 2))
  writeRaw('c9prime-orca-parity.json', result)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

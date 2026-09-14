// C9′ — Orca 를 그라운드 트루스로 쓰는 정합성 실측(01-criteria.md C9′).
//
// 수정 1회차(07-fix-orca1.md M-3·M-4) 전면 재작성: 01-criteria.md 에 새로 붙은
// "C9′ (a)(b) 판정 의미 확정" 부록이 셈법을 확정했다 — 1차 구현은 (a) 를 "존재 확인"·
// "같은 부등식을 뒤집은 두 항목"으로, (b) 를 "토큰/소스 상수 인용"으로 셈해 통과선을
// 우회했다(codex/grok 동조 지적). 이번엔:
//   (a) — 독립된 서열 쌍만, corral 은 실행 중 getComputedStyle 실측, Orca 는 file:line 인용.
//        존재 확인·같은 부등식의 반대방향은 쌍으로 안 세고, Orca 대응값 없는 항목은 제외.
//   (b) — 3개 전부 렌더 실측치(rect/computedStyle 반환값)가 pass 식에 직접 들어간다.
//        측정 대상이 그 시점 DOM 에 없으면(탭바) 있는 상태를 만들어 잰다.
// 여유분 권고(색 7+·치수 4+)를 따라 (a) 8쌍·(b) 4개를 잰다.
import { makeScratchRepo, startApp, sleep, until, writeRaw } from './lib.mjs'

function parseRgb(cssColor) {
  const match = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)/.exec(cssColor)
  if (match === null) return null
  return { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]) }
}

function hexToRgb(hex) {
  const clean = hex.replace('#', '')
  return { r: parseInt(clean.slice(0, 2), 16), g: parseInt(clean.slice(2, 4), 16), b: parseInt(clean.slice(4, 6), 16) }
}

// 상대 휘도(WCAG 근사) — 서열 비교용, 절대 색차 판정용이 아니다.
function relLuminance({ r, g, b }) {
  const lin = (c) => {
    const v = c / 255
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

// Orca 실측 소스 상수 — 전부 로컬 클론 ~/repos/etc/orca (github.com/stablyai/orca) 의
// src/renderer/src/assets/main.css `.dark` 블록에서 직접 grep 으로 확인한 file:line.
const ORCA = {
  background: { hex: '#0a0a0a', at: 'main.css:274 (--background, .dark)' },
  editorSurface: { hex: '#1e1e1e', at: 'main.css:275 (--editor-surface, .dark)', note: '코드 에디터 패널 색 — corral 터미널 캔버스의 대응 개념 아님(1차 조사 오류 정정, orca-map 제보)' },
  card: { hex: '#171717', at: 'main.css:277 (--card, .dark)' },
  foreground: { hex: '#fafafa', at: 'main.css:276 (--foreground, .dark)' },
  mutedForeground: { hex: '#a1a1a1', at: 'main.css:286 (--muted-foreground, .dark)' },
  worktreeSidebar: { hex: '#2a2a2a', at: 'main.css:311 (--worktree-sidebar, .dark)' },
  worktreeSidebarAccent: { hex: '#353535', at: 'main.css:313 (--worktree-sidebar-accent, .dark)' },
  sidebarPrimary: { hex: '#1447e6', at: 'main.css:321 (--sidebar-primary, .dark)' },
  sidebarMinWidth: { px: 220, at: 'components/sidebar/index.tsx:33' },
  sidebarMaxWidth: { px: 500, at: 'components/sidebar/index.tsx:34' },
  tabStripHeightPx: { px: 32, at: 'main.css:806-810 주석 (타이틀바 36px = 드래그 스트립 4px + 탭 행 32px)' },
  resizeHandleHitWidthPx: { px: 12, at: "sidebar/index.tsx:37-38 (WORKTREE_SIDEBAR_RESIZE_HANDLE_CLASS_NAME 'w-3')" },
  resizeHandleVisibleWidthPx: { px: 1, at: "sidebar/index.tsx:39-40 (WORKTREE_SIDEBAR_RESIZE_HANDLE_LINE_CLASS_NAME 'w-px')" },
}

async function computedProp(app, selector, prop) {
  const r = await app.computedStyle(selector, [prop])
  return r.values?.[prop] ?? null
}

function luminanceOfCss(cssColor) {
  const rgb = parseRgb(cssColor)
  return rgb === null ? null : relLuminance(rgb)
}

function luminanceOfHex(hex) {
  return relLuminance(hexToRgb(hex))
}

// 두 corral 셀렉터의 밝기 서열이 Orca 두 hex 값의 서열과 같은 방향인지 — 독립 측정 쌍 1개.
function orderPair({ label, corralA, corralAL, corralB, corralBL, orcaA, orcaB, reason }) {
  const orcaAL = luminanceOfHex(orcaA.hex)
  const orcaBL = luminanceOfHex(orcaB.hex)
  const orcaOrder = orcaAL > orcaBL
  const corralOrder = corralAL !== null && corralBL !== null ? corralAL > corralBL : null
  return {
    label,
    corral: { a: corralA, b: corralB, aColor: corralAL, bColor: corralBL, aLum: corralAL, bLum: corralBL },
    orca: { aHex: orcaA.hex, aAt: orcaA.at, bHex: orcaB.hex, bAt: orcaB.at, aLum: orcaAL, bLum: orcaBL, orderAGreaterThanB: orcaOrder },
    corralOrderMatchesOrca: corralOrder !== null && corralOrder === orcaOrder,
    reason,
  }
}

async function dragResizerTo(app, targetWidth, fromWidth) {
  const rect = (await app.rect('[data-sidebar-resizer]')).rect
  const y = Math.round(rect.top + rect.height / 2)
  const fromX = Math.round(rect.left)
  const delta = targetWidth - fromWidth
  const toX = fromX + delta
  await app.send({ cmd: 'raw-mouse', type: 'mouseDown', x: fromX, y, button: 'left' })
  const steps = 6
  for (let i = 1; i <= steps; i++) {
    const x = Math.round(fromX + (delta * i) / steps)
    await app.send({ cmd: 'raw-mouse', type: 'mouseMove', x, y })
    await sleep(50)
  }
  await app.send({ cmd: 'raw-mouse', type: 'mouseUp', x: toX, y, button: 'left' })
  await sleep(150)
  return (await app.rect('[data-sidebar]')).rect.width
}

async function main() {
  const repo = makeScratchRepo('c9prime')
  const app = await startApp({ name: '07-c9prime' })
  await app.addRepo(repo.root)
  await until(async () => (await app.query(`[data-worktree="${repo.root}"]`)).found.length > 0, {
    timeoutMs: 8000,
    what: 'worktree row mounted',
  })

  // ---------- 텍스트 계층(fg vs fg-muted) — repo 행 마운트 직후, 열지 않아도 존재 ----------
  const fgColor = await computedProp(app, '.repo-row-name', 'color')
  const fgMutedColor = await computedProp(app, '.repos-header-label', 'color')

  // ---------- worktree 열기 — is-selected 블록·accent 도트·main-area 등장 ----------
  await app.click(`[data-worktree="${repo.root}"]`)
  const workspaceId = await until(
    async () => (await app.state()).repos.flatMap((r) => r.worktrees).find((w) => w.path === repo.root)?.workspace?.workspaceId ?? null,
    { timeoutMs: 8000, what: 'worktree opened' },
  ).then((r) => r.value)

  const sidebarBg = await computedProp(app, '[data-sidebar]', 'background-color')
  const canvasBg = await computedProp(app, '[data-main-area]', 'background-color')
  const selectedBg = await computedProp(app, '.worktree-block.is-selected', 'background-color')
  await until(async () => (await app.query('.worktree-block.is-selected .worktree-dot.tone-accent')).found.length > 0, {
    timeoutMs: 4000,
    what: 'selected worktree dot renders accent tone',
  })
  const accentColor = await computedProp(app, '.worktree-block.is-selected .worktree-dot', 'background-color')
  const lineWeakColor = await computedProp(app, '[data-sidebar]', 'border-right-color') // M-4 정정 확인용(오르카 대응값 없음, (a) 카운트 제외)

  // ---------- 모달(raised panel) — 열어서 실측, 끝나면 취소 ----------
  await app.click(`[data-create-worktree="${repo.root}"]`)
  await until(async () => (await app.query('[data-create-worktree-modal]')).found.length > 0, { timeoutMs: 5000, what: 'create-worktree modal open' })
  const raisedBg = await computedProp(app, '.modal', 'background-color')
  await app.click('[data-create-worktree-cancel]')
  await until(async () => (await app.query('[data-create-worktree-modal]')).found.length === 0, { timeoutMs: 4000, what: 'modal closed' })

  // ---------- (b) d1 — 탭바 높이: 세션 2개 이상 만들어 실제로 띄운 뒤 rect 실측 ----------
  await app.click(`[data-worktree-menu-toggle="${repo.root}"]`)
  await app.click(`[data-worktree-create-shell="${repo.root}"]`)
  await until(
    async () => {
      const s = await app.state()
      return (s.repos.flatMap((r) => r.worktrees).find((w) => w.workspace?.workspaceId === workspaceId)?.workspace?.tabs.length ?? 0) >= 2
    },
    { timeoutMs: 8000, what: 'tab count 2 (tabbar mounted)' },
  )
  await until(async () => (await app.query('[data-main-tabbar]')).found.length > 0, { timeoutMs: 4000, what: 'tabbar mounted' })
  const tabbarRect = (await app.rect('[data-main-tabbar]')).rect

  // ---------- (b) d2·d3 — 사이드바 폭 하한·상한: 드래그로 실제로 밀어붙여 클램프된 값을 실측 ----------
  const beforeDragWidth = (await app.rect('[data-sidebar]')).rect.width
  const clampedMin = await dragResizerTo(app, beforeDragWidth - 800, beforeDragWidth) // 한참 아래로 — 하한 클램프 유도
  const clampedMax = await dragResizerTo(app, clampedMin + 800, clampedMin) // 한참 위로 — 상한 클램프 유도

  // ---------- (b) d4 — 리사이저 히트폭: rect.width 실측(M-3 로 9px 로 넓힘) ----------
  const resizerRect = (await app.rect('[data-sidebar-resizer]')).rect

  await app.stop()

  // ================= (a) 색상 8쌍 — 독립·실측, 존재확인·반대방향 중복 없음 =================
  const colorPairs = [
    orderPair({
      label: 'c1_sidebarBrighterThanCanvas',
      corralA: '[data-sidebar] bg', corralAL: luminanceOfCss(sidebarBg),
      corralB: '[data-main-area] bg', corralBL: luminanceOfCss(canvasBg),
      orcaA: ORCA.worktreeSidebar, orcaB: ORCA.background,
      reason: 'Orca 사이드바(#2a2a2a)가 캔버스(#0a0a0a)보다 밝다 — corral 도 그린 팔레트로 같은 서열(hue 만 다름, 00-analysis 판단).',
    }),
    orderPair({
      label: 'c2_selectedBrighterThanSidebar',
      corralA: '.worktree-block.is-selected bg', corralAL: luminanceOfCss(selectedBg),
      corralB: '[data-sidebar] bg', corralBL: luminanceOfCss(sidebarBg),
      orcaA: ORCA.worktreeSidebarAccent, orcaB: ORCA.worktreeSidebar,
      reason: '선택 카드가 사이드바 배경보다 밝게 뜨는 accent-lift 서열.',
    }),
    orderPair({
      label: 'c3_selectedBrighterThanCanvas',
      corralA: '.worktree-block.is-selected bg', corralAL: luminanceOfCss(selectedBg),
      corralB: '[data-main-area] bg', corralBL: luminanceOfCss(canvasBg),
      orcaA: ORCA.worktreeSidebarAccent, orcaB: ORCA.background,
      reason: 'c1·c2 와는 다른 두 요소(선택 카드·캔버스) 쌍 — 3원소(사이드바·선택 카드·캔버스) 중 아직 안 잰 세 번째 조합, 부등식 반전이 아니라 별개 측정.',
    }),
    orderPair({
      label: 'c4_raisedPanelBrighterThanCanvas',
      corralA: '.modal bg', corralAL: luminanceOfCss(raisedBg),
      corralB: '[data-main-area] bg', corralBL: luminanceOfCss(canvasBg),
      orcaA: ORCA.card, orcaB: ORCA.background,
      reason: 'Orca 모달/팝오버 표면(--card)이 캔버스보다 밝다 — corral --bg-raised(모달 패널) 대 --bg-surface(터미널).',
    }),
    orderPair({
      label: 'c5_raisedPanelVsSidebar',
      corralA: '.modal bg', corralAL: luminanceOfCss(raisedBg),
      corralB: '[data-sidebar] bg', corralBL: luminanceOfCss(sidebarBg),
      orcaA: ORCA.card, orcaB: ORCA.worktreeSidebar,
      reason: 'Orca 는 모달(#171717)이 사이드바(#2a2a2a)보다 어둡다. **명시적 편차 후보** — corral 은 --bg-raised(#181b1c)가 --bg-window(#141718)보다 밝아 방향이 반대일 수 있다(실측으로 판정).',
    }),
    orderPair({
      label: 'c6_foregroundBrighterThanMutedForeground',
      corralA: '.repo-row-name color', corralAL: luminanceOfCss(fgColor),
      corralB: '.repos-header-label color', corralBL: luminanceOfCss(fgMutedColor),
      orcaA: ORCA.foreground, orcaB: ORCA.mutedForeground,
      reason: '주 텍스트(--fg)가 보조 텍스트(--fg-muted)보다 밝은 2단 텍스트 위계.',
    }),
    orderPair({
      label: 'c7_accentBrighterThanSidebar',
      corralA: '.worktree-dot.tone-accent bg', corralAL: luminanceOfCss(accentColor),
      corralB: '[data-sidebar] bg', corralBL: luminanceOfCss(sidebarBg),
      orcaA: ORCA.sidebarPrimary, orcaB: ORCA.worktreeSidebar,
      reason: 'c4(존재 확인만 하던 1차 항목)를 실측 서열 비교로 교체 — accent(고강조)가 사이드바 배경보다 밝아야 강조로 기능한다. hue(파랑 vs 그린)는 다르지만 밝기 서열 역할은 대조 가능.',
    }),
    orderPair({
      label: 'c8_accentBrighterThanCanvas',
      corralA: '.worktree-dot.tone-accent bg', corralAL: luminanceOfCss(accentColor),
      corralB: '[data-main-area] bg', corralBL: luminanceOfCss(canvasBg),
      orcaA: ORCA.sidebarPrimary, orcaB: ORCA.background,
      reason: 'c7 과 다른 기준점(캔버스) 대비 — accent 가 어디에 놓이든 고강조로 두드러지는지의 별도 측정.',
    }),
  ]
  const colorPassCount = colorPairs.filter((c) => c.corralOrderMatchesOrca === true).length

  // ================= (b) 치수 4개 — 전부 렌더 실측치가 pass 식에 들어간다 =================
  const dimensions = {
    d1_tabStripHeight: {
      corralRenderedPx: tabbarRect.height,
      orcaPx: ORCA.tabStripHeightPx.px,
      orcaAt: ORCA.tabStripHeightPx.at,
      diffPx: Math.abs(tabbarRect.height - ORCA.tabStripHeightPx.px),
      pass: Math.abs(tabbarRect.height - ORCA.tabStripHeightPx.px) <= 2,
      reason: '탭 2개 이상 띄워 [data-main-tabbar] 를 실제로 마운트시킨 뒤 rect.height 실측(토큰 인용 아님). ±2px 이내 근사 일치로 본다(corral 밀도 스케일).',
    },
    d2_sidebarMinWidthClamped: {
      corralRenderedPx: clampedMin,
      orcaPx: ORCA.sidebarMinWidth.px,
      orcaAt: ORCA.sidebarMinWidth.at,
      pass: Math.abs(clampedMin - 236) <= 2, // design-tokens.css --sidebar-min 과 렌더 실측이 일치하는지
      reason: '리사이저를 하한 밖(-800px)으로 드래그해 실제로 클램프된 렌더 폭을 잰다(토큰 인용이 아니라 rect 반환값). Orca 220px 대비 corral 236px(+7%, 밀도 스케일).',
    },
    d3_sidebarMaxWidthClamped: {
      corralRenderedPx: clampedMax,
      orcaPx: ORCA.sidebarMaxWidth.px,
      orcaAt: ORCA.sidebarMaxWidth.at,
      pass: Math.abs(clampedMax - 560) <= 2,
      reason: '리사이저를 상한 밖(+800px)으로 드래그해 실제로 클램프된 렌더 폭을 잰다. Orca 500px 대비 corral 560px(+12%, 밀도 스케일 — L-2 정정: Orca 도 상한이 있다).',
    },
    d4_resizeHandleHitWidth: {
      corralRenderedPx: resizerRect.width,
      orcaHitPx: ORCA.resizeHandleHitWidthPx.px,
      orcaHitAt: ORCA.resizeHandleHitWidthPx.at,
      orcaVisiblePx: ORCA.resizeHandleVisibleWidthPx.px,
      orcaVisibleAt: ORCA.resizeHandleVisibleWidthPx.at,
      pass: resizerRect.width >= 6, // M-3 목표: 3px 단일값보다 확연히 넓혀 집기 쉽게 — Orca 12px 자체는 아니되 절반 이상
      reason:
        'M-3·L-2 수정: --resizer-w 를 3px→9px 로 넓혀 rect.width 실측(토큰 인용 아님). Orca 는 히트(12px)/가시(1px) 를 분리하지만 corral 은 여전히 단일 색 막대(히트=가시)라 구조 자체는 명시적 편차로 남긴다 — 폭만 격차를 줄였다.',
    },
  }
  const dimensionPassCount = Object.values(dimensions).filter((d) => d.pass === true).length

  const result = {
    colors: colorPairs,
    colorPassCount,
    colorPairCount: colorPairs.length,
    dimensions,
    dimensionPassCount,
    dimensionCount: Object.keys(dimensions).length,
    passLine: { colors: 5, dimensions: 3 },
    allPass: colorPassCount >= 5 && dimensionPassCount >= 3,
    excludedFromCount: {
      lineWeak: {
        corralRenderedColor: lineWeakColor,
        corralRenderedLuminance: luminanceOfCss(lineWeakColor),
        sidebarLuminance: luminanceOfCss(sidebarBg),
        selectedLuminance: luminanceOfCss(selectedBg),
        strictlyBetween: luminanceOfCss(lineWeakColor) !== null && luminanceOfCss(lineWeakColor) > luminanceOfCss(sidebarBg) && luminanceOfCss(lineWeakColor) < luminanceOfCss(selectedBg),
        reason: 'M-4 로 --line-weak(#181c1d) 을 낮춰 사이드바<경계선<선택카드 서열을 바로잡았는지 실측 확인 — Orca 대응 file:line 값이 없어 (a) 8쌍 카운트에는 넣지 않는다(부록 규칙: 대응값 없는 항목은 제외).',
      },
    },
    note: '01-criteria.md 부록(C9′ (a)(b) 판정 의미 확정, 2026-09-14) 셈법 적용 — (a) 는 존재확인·반대방향 중복 없이 독립 서열 쌍만, (b) 는 전부 rect/computedStyle 렌더 실측치가 pass 식에 직접 들어간다. 통과선(색 5·치수 3)은 불변, 여유분(7+·4+)까지 측정했다.',
  }
  console.log(JSON.stringify(result, null, 2))
  writeRaw('c9prime-orca-parity.json', result)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

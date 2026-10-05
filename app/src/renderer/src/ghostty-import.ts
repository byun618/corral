// Ghostty 가져오기 렌더러 쪽 순수 함수 (LIFE-513 K5ⓐ·K8ⓑ) — 모달과 단위 테스트가 같이 본다.
// Orca v1.4.198 `useGhosttyImport.ts`(적용 병합)·`GhosttyImportModal.tsx`(`formatDiffValue`)·`setting-labels.ts`(칸 이름)에 대응한다(MIT, 고지 `src/main/ghostty/NOTICE.md`).
// 칸 이름은 Orca 영어 라벨 대신 **corral 설정 화면의 한국어 라벨**을 쓴다(01-criteria K8ⓑ).
import type { Settings } from '../../shared/terminal-settings.js'

export const GHOSTTY_DIFF_LABELS: Record<keyof Settings, string> = {
  terminalFontSize: '글꼴 크기',
  terminalFontFamily: '글꼴군',
  terminalFontWeight: '글꼴 두께',
  terminalFontWeightBold: 'Bold Font Weight',
  terminalLineHeight: '라인 높이',
  terminalThemeDark: '어두운 테마',
  terminalCursorStyle: 'Cursor 모양',
  terminalCursorBlink: '깜박이는 Cursor',
  terminalInactivePaneOpacity: '비활성 창 불투명도',
  terminalDividerColorDark: '다크 디바이더 색상',
  terminalDividerThicknessPx: '구분선 두께',
  terminalColorOverrides: '터미널 색 재정의',
}

export type GhosttyDiffRow =
  | { kind: 'value'; key: keyof Settings; label: string; value: string }
  | { kind: 'colors'; key: 'terminalColorOverrides'; label: string; colors: Array<{ name: string; color: string }> }

/** 문자열 → 설정 칸 이름(단언 없이 좁힌다). 모르는 이름이면 null. */
function settingKey(name: string): keyof Settings | null {
  switch (name) {
    case 'terminalFontSize':
    case 'terminalFontFamily':
    case 'terminalFontWeight':
    case 'terminalFontWeightBold':
    case 'terminalLineHeight':
    case 'terminalThemeDark':
    case 'terminalCursorStyle':
    case 'terminalCursorBlink':
    case 'terminalInactivePaneOpacity':
    case 'terminalDividerColorDark':
    case 'terminalDividerThicknessPx':
    case 'terminalColorOverrides':
      return name
    default:
      return null
  }
}

function formatValue(value: unknown): string {
  if (typeof value === 'boolean') return value ? '켬' : '끔'
  return String(value)
}

/** diff → 모달 행. override 는 색 견본 + `칸: 값` 으로 펼친다. */
export function ghosttyDiffRows(diff: Partial<Settings>): GhosttyDiffRow[] {
  const rows: GhosttyDiffRow[] = []
  for (const [name, value] of Object.entries(diff)) {
    const key = settingKey(name)
    if (key === null || value === undefined) continue
    const label = GHOSTTY_DIFF_LABELS[key]
    if (key === 'terminalColorOverrides') {
      const colors = Object.entries(diff.terminalColorOverrides ?? {}).map(([colorName, color]) => ({ name: colorName, color }))
      rows.push({ kind: 'colors', key, label, colors })
      continue
    }
    rows.push({ kind: 'value', key, label, value: formatValue(value) })
  }
  return rows
}

/** 적용 패치 — diff 그대로, override 는 **현재 override 위에 병합**(Orca `useGhosttyImport` 와 같다). 쓰기 1회로 보낸다(K5ⓐ). */
export function ghosttyImportPatch({ diff, current }: { diff: Partial<Settings>; current: Settings }): Partial<Settings> {
  if (diff.terminalColorOverrides === undefined) return { ...diff }
  return { ...diff, terminalColorOverrides: { ...current.terminalColorOverrides, ...diff.terminalColorOverrides } }
}

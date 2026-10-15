// 화면 전용 영속 상태 (LIFE-357 C2·C3 — 사이드바 폭, 레포/에이전트그룹 접힘).
//
// **`localStorage` 대신 이 파일을 쓰는 이유** (실측): 이 앱은 프로덕션 빌드에서 렌더러를
// `loadFile()`(file:// 오리진)로 띄우는데, 그 경로에서는 Chromium 의 LocalStorage 커밋이
// 디스크에 반영되지 않는 현상을 실측했다 — `session.flushStorageData()` 를 명시로 불러도,
// 프로세스를 정상 종료해도 재기동 후 값이 사라졌다(raw/claude-orca/c2-resize.json 1차 실행
// 참고). registry.ts 와 같은 tmp→rename 원자적 쓰기로 옮겨 이 문제를 완전히 피한다 — corral
// 이 이미 갖고 있는, 검증된 영속 패턴이다.
//
// 저장하는 것은 **화면 UI 상태뿐**이다(레포 목록 등 다른 영속 상태와 섞지 않는다, registry.ts
// 의 "저장하는 순간 두 진실이 생긴다" 원칙과 같은 결). 파일: `<userData>/ui-prefs.json`.

import fs from 'node:fs'
import path from 'node:path'
import { isRecord, safeParse } from '../shared/json.js'
import { DEFAULT_SIDEBAR_VIEW, readSidebarView, sidebarViewToPrefs, type SidebarViewPrefs } from '../shared/sidebar-view.js'
import { log } from './log.js'
import { readRecentFiles, type RecentFiles } from '../shared/recent-files.js'

/** 폴백 번호 배정 한 칸 (LIFE-366 C13) — `shared/types.ts` 의 `TabOrdinal` 과 같은 모양이다. */
export type TabOrdinal = { tabId: string; groupId: string; ordinal: number }

export type UiPrefs = {
  sidebarWidth: number | null
  sidebarCollapsed: boolean
  collapsedRepos: string[]
  collapsedGroups: string[]
  /** 에이전트 묶음 알약을 펼쳐 둔 worktree 경로 (LIFE-467) — `shared/types.ts` 의 같은 칸 주석. */
  expandedAgentGroups: string[]
  /**
   * 폴백 번호 배정표 (LIFE-366 C13, 수정 라운드 8).
   *
   * **왜 여기냐**: Orca 는 `tab.defaultTitle` 에 저장한다. corral 에서 같은 자리는 herdr
   * `tab.label` 인데 거기 쓰면 `userLabel` 이 그 숫자를 사용자 이름으로 읽어 **G5 가 되살아난다**.
   * 그래서 "저장하는 것은 화면 UI 상태뿐" 인 이 파일에 싣는다 — 폴백 번호는 herdr 가 모르는,
   * 화면이 혼자 쓰는 표시 상태다.
   */
  tabOrdinals: TabOrdinal[]
  /**
   * 영역(탭 그룹) 배치 — **worktree 별** (LIFE-373 F1-6 · §10-R3-h).
   *
   * 여기 있는 이유는 tabOrdinals 와 같다: herdr 가 모르는, 화면이 혼자 쓰는 상태다. 키를
   * `workspace_id` 가 아니라 **worktree 경로**로 잡는다 — workspace_id 는 herdr 서버 생애
   * 안에서만 유일해서(LIFE-344) 재기동하면 다른 worktree 의 배치를 뒤집어쓴다.
   *
   * 모양 검사는 렌더러(`group-tree.ts` readStoredLayouts)가 한다 — 트리 모양을 아는 쪽이
   * 거기고, 저장소는 **통째로 실어 나르기만** 한다(여기서 또 검사하면 두 진실이 생긴다).
   */
  groupLayouts: unknown[]
  /**
   * 사이드바 수동 순서 (LIFE-469) — 레포 root 목록, 레포 root → 연결 워크트리 path 목록. 키를 경로로 잡는 이유는
   * `groupLayouts` 와 같다. 여기서는 모양(문자열 배열·중복 없음)만 지킨다 — 순서의 뜻은 렌더러 `manual-order.ts` 가 안다.
   */
  manualRepoOrder: string[]
  manualWorktreeOrder: Record<string, string[]>
  /** Group by None 수동 순서 (LIFE-470) — 워크트리 path 목록. 모양만 지킨다(뜻은 렌더러 `manual-order.ts`). */
  manualFlatOrder: string[]
  /**
   * 고정한 워크트리 경로 (LIFE-478 K5 · 게이트 ⓪ Q1) — Pinned 구획에 모이는 순서는 현재 정렬을 따른다(198, 고정 시각 없음).
   * 레지스트리가 아니라 여기 두는 이유: 접힘·수동 순서와 같은 사이드바 화면 상태다. 없는 경로는 화면이 무시한다.
   */
  pinnedWorktrees: string[]
  /**
   * 「N 하위」 를 접은 부모 워크트리 경로 (LIFE-576 D6 — Orca `collapsedGroups` 의 `lineage:` 키). 기본 펼침이라 접은 것만 담는다.
   * 경로 키인 이유는 `pinnedWorktrees` 와 같다. 없는 경로는 화면이 무시한다.
   */
  collapsedLineage: string[]
  /** 안 읽음 벨이 켜진 워크트리 경로 (LIFE-471) — `shared/types.ts` 의 같은 칸 주석. 없는 경로는 화면이 무시한다. */
  unreadWorktrees: string[]
  /**
   * 탭 핀·색 (LIFE-495 K3·K4) — `{tabId, workspaceId, pinned, color}` 목록. 모양은 렌더러 `tab-marks.ts` 가 안다(`groupLayouts` 처럼
   * 여기서는 실어 나르기만 한다). 키가 herdr tab id 라 herdr 가 재기동하면 배치·폴백 번호와 같이 잃는다(00-analysis F13).
   */
  tabMarks: unknown[]
  /** 오른쪽 패널·탐색기 (LIFE-589) — `shared/types.ts` 의 같은 칸 주석. */
  rightPanelOpen: boolean
  rightPanelWidth: number | null
  explorerShowDotfiles: boolean
  explorerShowIgnored: boolean
  /** 최근 연 파일 (LIFE-593) — `shared/types.ts` 의 같은 칸 주석. 읽을 때 `readRecentFiles` 로 모양을 본다. */
  recentFiles: RecentFiles
} & SidebarViewPrefs

const VERSION = 1
const DEFAULT_PREFS: UiPrefs = {
  sidebarWidth: null,
  sidebarCollapsed: false,
  collapsedRepos: [],
  collapsedGroups: [],
  expandedAgentGroups: [],
  tabOrdinals: [],
  groupLayouts: [],
  manualRepoOrder: [],
  manualWorktreeOrder: {},
  manualFlatOrder: [],
  pinnedWorktrees: [],
  collapsedLineage: [],
  unreadWorktrees: [],
  tabMarks: [],
  rightPanelOpen: false,
  rightPanelWidth: null,
  explorerShowDotfiles: true,
  explorerShowIgnored: true,
  recentFiles: {},
  // Workspace options (LIFE-470) — 칸 이름·기본값·읽기 규칙은 `shared/sidebar-view.ts` 한 곳.
  ...sidebarViewToPrefs(DEFAULT_SIDEBAR_VIEW),
}

/** 문자열 목록 — 문자열 아닌 칸·빈 문자열·중복은 버린다(손상된 칸이 다른 칸까지 깨뜨리지 않게, LIFE-469 K4ⓓ). */
function readKeyList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((item): item is string => typeof item === 'string' && item.length > 0))]
}

function readKeyListMap(value: unknown): Record<string, string[]> {
  if (!isRecord(value)) return {}
  const out: Record<string, string[]> = {}
  for (const [key, list] of Object.entries(value)) if (key.length > 0 && Array.isArray(list)) out[key] = readKeyList(list)
  return out
}

/** 저장된 배정표를 **모양을 확인하며** 읽는다 — 손으로 고친 파일이 화면을 깨뜨리지 않게. */
function readTabOrdinals(value: unknown): TabOrdinal[] {
  if (!Array.isArray(value)) return []
  const rows: TabOrdinal[] = []
  for (const item of value) {
    if (!isRecord(item)) continue
    const tabId = item['tabId']
    const groupId = item['groupId']
    const ordinal = item['ordinal']
    if (typeof tabId !== 'string' || tabId.length === 0) continue
    if (typeof groupId !== 'string') continue
    if (typeof ordinal !== 'number' || !Number.isInteger(ordinal) || ordinal < 1) continue
    rows.push({ tabId, groupId, ordinal })
  }
  return rows
}

export class UiPrefsStore {
  private readonly file: string
  private prefs: UiPrefs = { ...DEFAULT_PREFS }

  constructor(userDataDir: string) {
    const fromEnv = process.env.CORRAL_UI_PREFS
    this.file = fromEnv !== undefined && fromEnv.length > 0 ? fromEnv : path.join(userDataDir, 'ui-prefs.json')
  }

  load(): void {
    try {
      if (!fs.existsSync(this.file)) {
        this.prefs = { ...DEFAULT_PREFS }
        return
      }
      const parsed = safeParse(fs.readFileSync(this.file, 'utf8'))
      if (!isRecord(parsed)) throw new Error('ui-prefs 파일이 객체가 아니다')
      const width = parsed['sidebarWidth']
      const repos = parsed['collapsedRepos']
      const groups = parsed['collapsedGroups']
      const expanded = parsed['expandedAgentGroups']
      this.prefs = {
        sidebarWidth: typeof width === 'number' ? width : null,
        sidebarCollapsed: parsed['sidebarCollapsed'] === true,
        collapsedRepos: Array.isArray(repos) ? repos.filter((item): item is string => typeof item === 'string') : [],
        collapsedGroups: Array.isArray(groups) ? groups.filter((item): item is string => typeof item === 'string') : [],
        expandedAgentGroups: Array.isArray(expanded) ? expanded.filter((item): item is string => typeof item === 'string') : [],
        tabOrdinals: readTabOrdinals(parsed['tabOrdinals']),
        groupLayouts: Array.isArray(parsed['groupLayouts']) ? parsed['groupLayouts'] : [],
        manualRepoOrder: readKeyList(parsed['manualRepoOrder']),
        manualWorktreeOrder: readKeyListMap(parsed['manualWorktreeOrder']),
        manualFlatOrder: readKeyList(parsed['manualFlatOrder']),
        pinnedWorktrees: readKeyList(parsed['pinnedWorktrees']),
        collapsedLineage: readKeyList(parsed['collapsedLineage']),
        unreadWorktrees: readKeyList(parsed['unreadWorktrees']),
        tabMarks: Array.isArray(parsed['tabMarks']) ? parsed['tabMarks'] : [],
        // LIFE-589 — 칸마다 형을 보고, 아니면 기본값(닫힘·토큰 폭·둘 다 보임).
        rightPanelOpen: parsed['rightPanelOpen'] === true,
        rightPanelWidth: typeof parsed['rightPanelWidth'] === 'number' && Number.isFinite(parsed['rightPanelWidth']) ? parsed['rightPanelWidth'] : null,
        explorerShowDotfiles: parsed['explorerShowDotfiles'] !== false,
        explorerShowIgnored: parsed['explorerShowIgnored'] !== false,
        // LIFE-593 — 칸 모양이 틀리면 그 칸(또는 그 worktree)만 버린다. 다른 칸은 그대로.
        recentFiles: readRecentFiles(parsed['recentFiles']),
        // 칸마다 따로 기본값으로 떨어진다 — 손상된 모드 문자열이 다른 칸을 버리지 않게(LIFE-470 K9ⓓ).
        ...sidebarViewToPrefs(readSidebarView(parsed)),
      }
      log('ui_prefs.load', { file: this.file })
    } catch (error) {
      this.prefs = { ...DEFAULT_PREFS }
      log('ui_prefs.load_failed', { file: this.file, error: String(error) })
    }
  }

  get(): UiPrefs {
    return {
      ...this.prefs,
      collapsedRepos: [...this.prefs.collapsedRepos],
      collapsedGroups: [...this.prefs.collapsedGroups],
      expandedAgentGroups: [...this.prefs.expandedAgentGroups],
      tabOrdinals: this.prefs.tabOrdinals.map((row) => ({ ...row })),
      groupLayouts: [...this.prefs.groupLayouts],
      manualRepoOrder: [...this.prefs.manualRepoOrder],
      manualWorktreeOrder: Object.fromEntries(Object.entries(this.prefs.manualWorktreeOrder).map(([key, list]) => [key, [...list]])),
      manualFlatOrder: [...this.prefs.manualFlatOrder],
      pinnedWorktrees: [...this.prefs.pinnedWorktrees],
      collapsedLineage: [...this.prefs.collapsedLineage],
      unreadWorktrees: [...this.prefs.unreadWorktrees],
      tabMarks: [...this.prefs.tabMarks],
      recentFiles: Object.fromEntries(Object.entries(this.prefs.recentFiles).map(([key, list]) => [key, [...list]])),
      sidebarRepoFilter: [...this.prefs.sidebarRepoFilter],
      sidebarCardProperties: [...this.prefs.sidebarCardProperties],
    }
  }

  /** 부분 갱신 — 준 필드만 덮는다(레지스트리처럼 즉시 원자적 쓰기, 디바운스 없음 — 쓰기 빈도가 낮다). */
  update(patch: Partial<UiPrefs>): void {
    this.prefs = { ...this.prefs, ...patch }
    // LIFE-593 — 렌더러가 준 최근 기록도 저장 전에 같은 규칙으로 거른다(상대 경로만 — E8ⓔ).
    if (patch.recentFiles !== undefined) this.prefs.recentFiles = readRecentFiles(patch.recentFiles)
    const payload = JSON.stringify({ version: VERSION, ...this.prefs }, null, 2) + '\n'
    const tmp = `${this.file}.${process.pid}.tmp`
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      fs.writeFileSync(tmp, payload)
      fs.renameSync(tmp, this.file)
    } catch (error) {
      fs.rmSync(tmp, { force: true })
      log('ui_prefs.save_failed', { file: this.file, error: String(error) })
    }
  }
}

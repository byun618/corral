// LIFE-601 C3 — 작업 페이지 상태(`tasksPage`)가 ui-prefs 파일로 재시작을 넘는다. 옛 파일(칸 없음)은 칸 없이 읽히고 다른 칸은 그대로다.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { UiPrefsStore } from './ui-prefs.js'

let dir: string
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l601-prefs-')) })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

it('tasksPage 를 쓰고 새 저장소(재시작)로 읽으면 같다 · 다른 칸을 건드리지 않는다', () => {
  const first = new UiPrefsStore(dir)
  first.load()
  first.update({ sidebarCollapsed: true })
  const tasksPage = { space: { kind: 'space', connectionId: 'c1', spaceKey: 'p1' }, view: 'list', sort: 'due', group: 'priority', density: 'compact', defaultPreset: 'week', filters: { kinds: [], priorities: ['high'], blocked: true, working: false, dueWeek: false } }
  first.update({ tasksPage })
  const second = new UiPrefsStore(dir)
  second.load()
  expect(second.get().tasksPage).toEqual(tasksPage)
  expect(second.get().sidebarCollapsed).toBe(true)
})

it('옛 파일 — tasksPage 칸이 없으면 없음(화면 기본값), 객체가 아니면 버린다', () => {
  fs.writeFileSync(path.join(dir, 'ui-prefs.json'), JSON.stringify({ version: 1, sidebarCollapsed: true, tasksPage: 'broken' }))
  const store = new UiPrefsStore(dir)
  store.load()
  expect(store.get().tasksPage).toBeUndefined()
  expect(store.get().sidebarCollapsed).toBe(true)
})

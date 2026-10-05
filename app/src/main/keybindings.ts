import fs from 'node:fs'
import path from 'node:path'
import { migrateLegacyOverrides, validateOverrides, type Keybindings } from '../shared/keybindings.js'
import { log } from './log.js'

export class KeybindingStore {
  private overrides: Keybindings = {}
  private readonly file: string
  constructor(userData: string) { this.file = path.join(userData, 'keybindings.json') }
  load(): void {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      // LIFE-495 K7ⓘ — 기본 조합 수가 바뀐 액션의 옛 재정의를 옮기다 못 실은 조합은 로그로 남긴다(조용히 버리지 않는다).
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const { dropped } = migrateLegacyOverrides(parsed)
        if (dropped.length > 0) log('keybindings.migration_dropped', { file: this.file, dropped })
      }
      this.overrides = validateOverrides(parsed, true)
      log('keybindings.loaded', { file: this.file })
    } catch (error) {
      this.overrides = {}
      log('keybindings.defaults', { file: this.file, reason: String(error) })
    }
  }
  get(): Keybindings { return structuredClone(this.overrides) }
  save(value: unknown): Keybindings {
    const next = validateOverrides(value)
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const temporary = `${this.file}.${process.pid}.tmp`
    try {
      fs.writeFileSync(temporary, JSON.stringify(next, null, 2) + '\n')
      fs.renameSync(temporary, this.file)
    } finally { fs.rmSync(temporary, { force: true }) }
    this.overrides = next
    return this.get()
  }
}

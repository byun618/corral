import fs from 'node:fs'
import path from 'node:path'
import { validateOverrides, type Keybindings } from '../shared/keybindings.js'
import { log } from './log.js'

export class KeybindingStore {
  private overrides: Keybindings = {}
  private readonly file: string
  constructor(userData: string) { this.file = path.join(userData, 'keybindings.json') }
  load(): void {
    try {
      this.overrides = validateOverrides(JSON.parse(fs.readFileSync(this.file, 'utf8')), true)
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

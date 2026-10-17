// LIFE-593 수정 r1 R1-C-10 — 나눠 돌리기: 결과가 한 번에 돌린 것과 같고, 예산마다 양보하며, 취소되면 null.
import { describe, expect, it } from 'vitest'
import { drain, drainSliced } from './sliced.js'
import { fileIndexSteps, searchFiles, searchSteps } from './quick-open-search.js'
import { buildFilterTree, filterRows, filterTreeSteps, sortFilterTree } from './explorer-filter.js'

const files = Array.from({ length: 30_000 }, (_value, index) => `src/m${index % 97}/s${index % 7}/file_${index}.ts`)

describe('drainSliced', () => {
  it('색인·검색·필터 트리 — 나눠 돌린 결과가 한 번에 돌린 결과와 같다', async () => {
    const signal = { aborted: false }
    const index = await drainSliced({ steps: fileIndexSteps(files), signal, budgetMs: 1 })
    expect(index).not.toBeNull()
    if (index === null) return
    const sliced = await drainSliced({ steps: searchSteps({ index, query: 'file 12', recent: ['src/m5/s5/file_12.ts'] }), signal, budgetMs: 1 })
    expect(sliced?.rows).toEqual(searchFiles({ index: drain(fileIndexSteps(files)), query: 'file 12', recent: ['src/m5/s5/file_12.ts'] }).rows)
    const tree = await drainSliced({ steps: filterTreeSteps({ files, showDotfiles: true }), signal, budgetMs: 1 })
    const whole = buildFilterTree({ files, showDotfiles: true })
    sortFilterTree(whole)
    expect(tree?.sorted).toBe(true)
    if (tree === null) return
    const empty = new Set<string>()
    expect(filterRows({ tree, words: ['file_12'], collapsed: empty, opened: empty, ignored: null }).rows).toEqual(filterRows({ tree: whole, words: ['file_12'], collapsed: empty, opened: empty, ignored: null }).rows)
  })
  it('예산을 넘기면 다음 작업으로 넘긴다(그 사이 다른 작업이 돈다) · 취소되면 null', async () => {
    const signal = { aborted: false }
    let other = 0
    const timer = setInterval(() => (other += 1), 0)
    const index = await drainSliced({ steps: fileIndexSteps([...files, ...files, ...files]), signal, budgetMs: 1 })
    clearInterval(timer)
    expect(index).not.toBeNull()
    expect(other).toBeGreaterThan(0)
    const stopped = { aborted: false }
    const pending = drainSliced({ steps: fileIndexSteps([...files, ...files, ...files]), signal: stopped, budgetMs: 1 })
    stopped.aborted = true
    expect(await pending).toBeNull()
  })
})

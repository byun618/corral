export type PaletteEntry = { id: string; title: string; detail: string; keywords?: string; shortcut?: string; disabled?: string; run: () => void }
export function searchPalette(entries: PaletteEntry[], query: string): PaletteEntry[] {
  const needle = query.trim().toLocaleLowerCase()
  const score = (entry: PaletteEntry): number => {
    if (!needle) return 0
    const words = [entry.title, entry.id, entry.keywords ?? '', entry.detail].map(word => word.toLocaleLowerCase())
    if (words.some(word => word === needle)) return 0
    if (words.some(word => word.startsWith(needle))) return 1
    if (words.some(word => word.includes(needle))) return 2
    for (const word of words) {
      let i = 0
      for (const char of word) if (char === needle[i]) i++
      if (i === needle.length) return 3
    }
    return Infinity
  }
  return entries.map((entry, index) => ({ entry, index, score: score(entry) })).filter(row => Number.isFinite(row.score)).sort((a,b) => a.score - b.score || a.index - b.index).map(row => row.entry)
}

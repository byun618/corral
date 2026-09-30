/**
 * LIFE-459 — which worker pane was started from which pane, resolved against what is live now.
 *
 * The record (`worker.spawner`, written by `worker-start`) says what was true when an attempt was
 * made. This turns it into what may be shown *now*, and every rule here leans the same way: when
 * the record and the backend do not agree, the parent is dropped rather than guessed. A pane id
 * alone is not an identity — ids repeat across sessions and a closed pane's id is handed to the next
 * PTY — so a parent is kept only when its session and its generation both still match.
 *
 * Pure: the caller supplies the document and one look at the backend.
 */
import type { OrchestrationLineageEntry } from '../../shared/types.js'
import type { DispatchRecord, OrchestrationState } from './model.js'

/**
 * herdr names the default session by leaving `HERDR_SESSION` unset in its panes, while a runtime
 * started with `CORRAL_SESSION=default` spells it out. Both mean the same session.
 */
const sessionName = (session: string | null): string => session === null || session === '' ? 'default' : session
export const sameBackendSession = (a: string | null, b: string | null): boolean => sessionName(a) === sessionName(b)

/** One successful look at the backend the runtime drives: its generation, and every pane's PTY. */
export interface LivePanes { session: string | null; epoch: string; panes: { paneId: string; ptyId: string }[] }

export function resolveLineage(state: OrchestrationState, live: LivePanes): OrchestrationLineageEntry[] {
  const ptyOf = new Map(live.panes.map(pane => [pane.paneId, pane.ptyId]))
  // L3ⓐ: attempts are appended, so the last worker attempt bound to a pane id is the only one that
  // may speak for it. An older attempt on a reused pane never lends it its parent.
  const latest = new Map<string, DispatchRecord>()
  for (const entry of state.dispatches) if (entry.worker !== null) latest.set(entry.target.paneId, entry)

  const children: { entry: DispatchRecord; parentPaneId: string | null }[] = []
  for (const [paneId, entry] of latest) {
    const worker = entry.worker
    if (worker === null) continue
    // L2ⓒ: the child pane must still be the PTY this attempt was bound to. A new PTY under the same
    // id is someone else, and it gets no entry at all rather than this attempt's lineage.
    if (entry.target.epoch !== live.epoch || ptyOf.get(paneId) !== entry.target.ptyId) continue
    // L3ⓒ: a released pane has been handed back, so it is no longer this attempt's worker pane.
    if (worker.release?.state === 'released') continue
    if (!sameBackendSession(worker.paneSession, live.session)) continue
    children.push({ entry, parentPaneId: parentOf(entry, live, ptyOf) })
  }

  // L4: reuse can close a loop (A starts a worker in B, later B hands A a Task). Cut the edge whose
  // attempt is oldest — the newer attempt describes the panes as they are now.
  const parent = new Map(children.map(child => [child.entry.target.paneId, child.parentPaneId]))
  const order = new Map(state.dispatches.map((entry, index) => [entry.id, index]))
  for (const child of children) {
    const loop = cycleThrough(child.entry.target.paneId, parent)
    if (loop.length === 0) continue
    const oldest = children
      .filter(candidate => loop.includes(candidate.entry.target.paneId))
      .sort((a, b) => (order.get(a.entry.id) ?? 0) - (order.get(b.entry.id) ?? 0))[0]
    if (oldest !== undefined) parent.set(oldest.entry.target.paneId, null)
  }

  return children.map(({ entry }) => ({
    paneId: entry.target.paneId,
    runId: entry.runId,
    taskId: entry.taskId,
    dispatchId: entry.id,
    dispatchStatus: entry.status,
    parentPaneId: parent.get(entry.target.paneId) ?? null,
  }))
}

/** L2ⓐⓑ: the recorded caller, if it is still the same pane in the same session. */
function parentOf(entry: DispatchRecord, live: LivePanes, ptyOf: ReadonlyMap<string, string>): string | null {
  const spawner = entry.worker?.spawner ?? null
  if (spawner === null || spawner.kind === 'outside_pane') return null
  if (spawner.epoch === null || spawner.ptyId === null) return null
  if (!sameBackendSession(spawner.session, entry.worker?.paneSession ?? null)) return null
  if (spawner.epoch !== live.epoch || ptyOf.get(spawner.paneId) !== spawner.ptyId) return null
  // A pane cannot be its own parent — `worker-start --terminal` run from the pane it reuses.
  if (spawner.paneId === entry.target.paneId) return null
  return spawner.paneId
}

/** The panes on the loop that starts at `start`, or nothing when following parents ends at a root. */
function cycleThrough(start: string, parent: ReadonlyMap<string, string | null>): string[] {
  const path: string[] = []
  let at: string | null | undefined = start
  while (at !== null && at !== undefined) {
    const seen = path.indexOf(at)
    if (seen !== -1) return path.slice(seen)
    path.push(at)
    at = parent.get(at)
  }
  return []
}

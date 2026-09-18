import { createContext, useContext } from 'react'
import { bindingsFor, formatBinding, type ActionId, type Keybindings } from '../../../shared/keybindings.js'

/** Presentation shares the live map; it does not own another store or dispatcher. */
export const BindingLabels = createContext<Keybindings>({})
export function useBindingLabel(): (id: ActionId, variant?: number) => string {
  const overrides = useContext(BindingLabels)
  return (id, variant = 0) => formatBinding(bindingsFor(id, overrides)[variant] ?? '')
}

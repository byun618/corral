/// <reference types="vite/client" />
import type { CorralApi } from '../../shared/types.js'

declare global {
  interface Window {
    corral: CorralApi
  }
}

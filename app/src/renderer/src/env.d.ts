import type { CorralApi } from '../../shared/types'

declare global {
  interface Window {
    corral: CorralApi
  }
}

export {}

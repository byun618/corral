// 금고 — 페어링 기록(토큰 포함)은 expo-secure-store 한 칸에만 둔다(P3ⓒ). AsyncStorage·파일·로그에 쓰지 않는다.
import * as SecureStore from 'expo-secure-store'
import type { PairingRecord, Vault } from '../core/connection'

const KEY = 'corral.pairing.v1'

function readRecord(text: string | null): PairingRecord | null {
  if (text === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const value: Record<string, unknown> = { ...parsed }
  const { token, url, macName, serverVersion, deviceId, deviceName, pairedAt } = value
  if (typeof token !== 'string' || typeof url !== 'string' || typeof macName !== 'string' || typeof serverVersion !== 'string') return null
  if (typeof deviceId !== 'string' || typeof deviceName !== 'string' || typeof pairedAt !== 'number') return null
  return { token, url, macName, serverVersion, deviceId, deviceName, pairedAt }
}

export const secureVault: Vault = {
  load: async () => readRecord(await SecureStore.getItemAsync(KEY)),
  save: (record) => SecureStore.setItemAsync(KEY, JSON.stringify(record), { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY }),
  clear: () => SecureStore.deleteItemAsync(KEY),
}

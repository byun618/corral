// S3 근거 — 설정 파일이 아니라 **실행 중** 무엇이 막혀 있는지를 렌더러 컨텍스트에서 확인한다.
// 결과를 화면 하단에 그대로 띄우고 (스크린샷 근거) 동시에 main 로그로 보낸다.

import { useEffect, useState } from 'react'

type Probe = { name: string; value: string }

function probeGlobal(name: string): string {
  try {
    const value = Reflect.get(globalThis, name)
    if (value === undefined) return 'undefined'
    return typeof value
  } catch (error) {
    return `throws: ${String(error)}`
  }
}

function probeRequire(): string {
  try {
    const fn = Reflect.get(globalThis, 'require')
    if (typeof fn !== 'function') return 'undefined'
    fn('node:net')
    return 'LOADED node:net (막히지 않았다)'
  } catch (error) {
    return `throws: ${String(error).slice(0, 60)}`
  }
}

function collect(): Probe[] {
  const exposed = window.corral?.preloadEnv
  return [
    { name: 'require', value: probeRequire() },
    { name: 'process', value: probeGlobal('process') },
    { name: 'module', value: probeGlobal('module') },
    { name: 'Buffer', value: probeGlobal('Buffer') },
    { name: 'ipcRenderer', value: probeGlobal('ipcRenderer') },
    { name: 'window.corral', value: typeof window.corral },
    { name: 'preload.sandboxed', value: String(exposed?.sandboxed) },
    { name: 'preload.contextIsolated', value: String(exposed?.contextIsolated) },
    { name: 'exposed', value: (exposed?.exposedMethods ?? []).join(',') },
  ]
}

export function SecurityProbe(): React.JSX.Element {
  const [probes, setProbes] = useState<Probe[]>([])

  useEffect(() => {
    const results = collect()
    setProbes(results)
    const detail: Record<string, string> = {}
    for (const probe of results) detail[probe.name] = probe.value
    window.corral.reportProbe('renderer-sandbox', detail)
  }, [])

  return (
    <span className="probes">
      {probes.map((probe) => (
        <span key={probe.name} className="probe">
          <b>{probe.name}</b>
          <span className="mono">{probe.value}</span>
        </span>
      ))}
    </span>
  )
}

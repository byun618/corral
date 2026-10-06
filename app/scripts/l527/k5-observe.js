/* LIFE-527 K5 — OS 입력 한 단계 뒤 렌더러 관측(식 하나, ev.sh 로 평가). fix1 F4: 탭·영역 상태 전환을 판별할 수 있게
   익명 탭 id(원래 id 의 FNV-1a 해시 — 경로·이름을 남기지 않고 단계 사이에 같은 탭은 같은 값) · activeTabId(활성 영역의 활성 탭) ·
   영역별 탭 배열·영역 박스를 남긴다. */
/* global window, document */
(() => {
  const anon = (prefix, raw) => {
    let hash = 0x811c9dc5
    for (const ch of String(raw)) { hash ^= ch.codePointAt(0); hash = Math.imul(hash, 0x01000193) >>> 0 }
    return `${prefix}${hash.toString(16).padStart(8, '0').slice(0, 6)}`
  }
  const rect = (element) => { const b = element.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)] }
  const groups = [...document.querySelectorAll('[data-main-tabbar]')].map((bar) => {
    const tabs = [...bar.querySelectorAll('[data-main-tab]')]
    const area = bar.closest('.tab-group') ?? bar.parentElement
    return {
      groupId: anon('g', bar.dataset.groupHeader ?? '?'),
      activeGroup: bar.classList.contains('is-active-group'),
      tabs: tabs.map((tab) => anon('t', tab.dataset.mainTab)),
      activeTab: tabs.filter((tab) => tab.dataset.active === 'true').map((tab) => anon('t', tab.dataset.mainTab))[0] ?? null,
      tabbar: rect(bar),
      area: area ? rect(area) : null,
    }
  })
  return {
    events: window.__l527,
    move: window.__l527move,
    sidebar: document.querySelector('[data-sidebar-toggle]')?.dataset.sidebarToggle ?? (document.querySelector('.titlebar-left-floating') ? 'floating' : null),
    groupCount: groups.length,
    activeTabId: groups.find((group) => group.activeGroup)?.activeTab ?? null,
    groups,
    menus: [...document.querySelectorAll('.tab-create-menu, .tab-context-menu, .ctx-menu, [role=menu]')].map((menu) => [menu.className.toString().slice(0, 40), ...rect(menu)]),
    settings: Boolean(document.querySelector('[data-settings-topbar], .settings-page, [data-settings-page]')),
    sidebarWidth: document.querySelector('.sidebar-column') ? rect(document.querySelector('.sidebar-column'))[2] : null,
    zoom: window.devicePixelRatio,
  }
})()

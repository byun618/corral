#!/usr/bin/env python3
# LIFE-605 수정 1 R1-K — 리뷰어 r1 뮤테이션(claude-r1-raw/scratch/mut.py·mut2.py·mut3.py)을 이 worktree 코드에 옮겨 다시 돌린다.
#   python3 -I scripts/l605/mut.py <OUT> [이름…]   (app/ 에서, **커밋된 깨끗한 트리에서만** — 끝나면 `git checkout -- <파일>` 로 되돌린다)
# 행 = (이름, 파일, 바꿀 글, 바꾼 글). 리뷰어 원문 앵커가 수정 1 로 바뀐 행은 같은 뜻의 패치로 옮기고 이름에 `@moved` 를 붙였다.
# 바꿀 글이 None = 코드가 사라져 해당 없음(사유 칸). `Y…` 행 = 리뷰 r2 의 34행(수정 2 R2-C). X10 은 R2-G 로 규칙이 되돌려져 반대 방향(대소문자 구분)으로 바꿨다. `Z…` 행 = 리뷰 r3 의 12행(수정 3). `R4-…` 행 = 리뷰 r4 의 16행(수정 4). X30 은 R4-A 로 규칙이 바뀌어(마크를 그대로 싣고 규칙 그물이 거절) 반대 방향(마크를 버림)으로 바꿨다. M01 은 원문 앵커가 머리 주석의 `redirect: 'manual'` 에 먼저 걸려 코드를 안 바꿨다(mut1 회차 생존) — 코드 줄로 옮겼다. `X…` 행 = 수정 1 의 새 규칙마다 하나씩 더한 뮤테이션.
# 판정: vitest 가 실패(exit≠0)면 KILLED, 통과면 SURVIVED, 앵커가 없으면 NO-MATCH(실패로 센다 — 옮기기를 빠뜨린 것).
# 결과: OUT/<이름>.txt(출력 끝 6000자) · OUT/RESULTS.jsonl · OUT/SUMMARY. 생존·NO-MATCH 가 0 이면 exit 0.
import json, os, re, subprocess, sys

APP = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
env = dict(os.environ, PATH=os.path.expanduser('~/.nvm/versions/node/v24.14.1/bin') + ':' + os.environ['PATH'], TMPDIR='/tmp/l605t')
TESTS = ['src/main/work/jira-source.test.ts', 'src/main/work/adf.test.ts', 'src/main/work/adf-editor.test.ts', 'src/main/work/jira-source.contract.test.ts', 'src/main/work/service.test.ts', 'src/main/work/store.test.ts',
         'src/renderer/src/components/ConnectionsSection.test.tsx', 'src/renderer/src/components/TasksPage.jira.test.tsx', 'src/renderer/src/markdown.test.tsx']
M = [('M01-redirect-follow@moved', 'src/main/work/jira-http.ts', "JSON.stringify(body), redirect: 'manual', signal", "JSON.stringify(body), redirect: 'follow', signal"),
 ('M02-no-historyMetadata', 'src/main/work/jira-source.ts', 'return writeId === null ? {} : { historyMetadata:', 'return true ? {} : { historyMetadata:'),
 ('M03-userinfo-allowed', 'src/main/work/jira-source.ts', "if (url.username !== '' || url.password !== '' || url.port !== '')", 'if (false)'),
 ('M04-jql-no-backslash-escape', 'src/main/work/jira-source.ts', 'replace(/[\\\\"]/g, (char) => `\\\\${char}`)', 'replace(/["]/g, (char) => `\\\\${char}`)'),
 ('M05-write-retry', 'src/main/work/jira-http.ts', 'if (reply.ok || write || attempt', 'if (reply.ok || attempt'),
 ('M06-bodyupdate-no-lock', 'src/main/work/jira-source.ts', 'if (shown.unsupported.length > 0) return { ok: false, message: lockReason(shown.unsupported) }', ''),
 ('M07-transitionplan-ignore-required', 'src/main/work/jira-source.ts', 'const needs = transition.fields.filter((field) => field.required && !field.hasDefaultValue)', 'const needs = [] as typeof transition.fields'),
 ('M08-vault-no-extra', 'src/main/work/vault.ts', 'for (const secrets of this.extra.values()) for (const secret of secrets) out = redactSecret({ text: out, secret })', ''),
 ('M09-note-no-redact@moved', 'src/main/work/jira-source.ts', 'errorText({ body, redact: (text) => this.http?.redact(text) ?? text })', 'errorText({ body })'),
 ('M10-207-ok@moved', 'src/main/work/jira-http.ts', 'const PASS_THROUGH = new Set([400, 404])', 'const PASS_THROUGH = new Set([400, 404, 207])'),
 ('M11-unknown-category-todo@moved', 'src/main/work/jira-source.ts', 'if (category === undefined) return { ok: false, outcome:', 'if (false) return { ok: false, outcome:'),
 ('M12-conflict-on', 'src/main/work/jira-source.ts', "conflictCheck: { state: 'disabled'", "conflictCheck: { state: 'on', x: 1 } as never, xconflict: { state: 'disabled'"),
 ('M13-fixture-env-open', 'src/main/work/jira-source.ts', 'if (socket.length === 0 || !/^http:', 'if (!/^http:'),
 ('M14-redact-basic-only-token', 'src/main/work/jira-http.ts', "this.secrets = [this.authorization, this.authorization.slice('Basic '.length), options.token, options.email, `${options.email}:${options.token}`]", 'this.secrets = [options.token]'),
 ('M15-scrub-extra-secrets', 'src/main/work/service.ts', 'for (const secret of secrets) message = redactSecret({ text: message, secret })', ''),
 ('M16-search-nextpage-ignore', 'src/main/work/jira-shape.ts', 'return { issues, nextPageToken: token === null || token.length === 0 ? null : token }', 'return { issues, nextPageToken: null }'),
 ('M17-fixedOnReplace-off@moved', 'src/main/work/service.ts', 'if (field.fixedOnReplace && fixed[field.key] !== undefined', 'if (false && fixed[field.key] !== undefined'),
 ('M18-spacecaps-widen', 'src/shared/work.ts', "const narrow = (base: WorkCapability, own: WorkCapability | undefined): WorkCapability => (base.state !== 'on' || own === undefined ? base : own)", 'const narrow = (base: WorkCapability, own: WorkCapability | undefined): WorkCapability => (own === undefined ? base : own)'),
 ('M19-reorder207-ok@moved', 'src/main/work/jira-source.ts', '      if (failed.length > 0) {', '      if (false) {'),
 ('M20-cross-space-parent', 'src/main/work/jira-source.ts', "if (issue.value.projectKey !== spaceKey) return rejected('Jira 에서는 다른 스페이스(프로젝트)로", "if (false) return rejected('Jira 에서는 다른 스페이스(프로젝트)로"),
 ('M21-adf-toggle-all', 'src/main/work/adf.ts', "next.attrs = { ...(node.attrs ?? {}), state: states[at] === true ? 'DONE' : 'TODO' }", "next.attrs = { state: states[at] === true ? 'DONE' : 'TODO' }"),
 ('M22-escapeLineStarts-off@moved', 'src/main/work/adf.ts', 'if (/^(#{1,6}(\\s|$)|>|[-+](\\s|$)|~~~|-{3,}|={3,})/.test(line)) return `\\\\${line}`', 'if (false) return `\\\\${line}`'),
 ('M23-maybeApplied-off', 'src/main/work/jira-source.ts', 'return { ...error, message: `${APPLIED_PREFIX}${error.message}`, maybeApplied: true }', 'return error'),
 ('M24-old-search-path', 'src/main/work/jira-source.ts', "path: '/rest/api/3/search/jql'", "path: '/rest/api/3/search'"),
 ('M25-createmeta-old', 'src/main/work/jira-source.ts', 'path: `/rest/api/3/issue/createmeta/${encodeURIComponent(spaceKey)}/issuetypes/${encodeURIComponent(kindKey)}`', 'path: `/rest/api/3/issue/createmeta`'),
 ('N01-close-noop', 'src/main/work/jira-http.ts', 'close(): void {\n    this.closed = true\n  }', 'close(): void {\n  }'),
 ('N02-retry-cap-off', 'src/main/work/jira-http.ts', 'if (wait === null || wait > RETRY_AFTER_CAP_MS) return reply', 'if (wait === null) return reply'),
 ('N03-available-ignored', 'src/main/work/jira-source.ts', 'if (!transition.available || transition.looped) continue', 'if (transition.looped) continue'),
 ('N04-nonCorral-links', 'src/main/work/jira-source.ts', None, 'R1-H 로 remote link 읽기 코드가 사라졌다 — 해당 없음'),
 ('N05-findByKey-404-err', 'src/main/work/jira-source.ts', "if (!reply.ok) return reply.status === 404 ? { ok: true, result: { op: 'findByKey', item: null } } : { ok: false, error: reply.error }", 'if (!reply.ok) return { ok: false, error: reply.error }'),
 ('N06-priority-null-ok', 'src/main/work/jira-source.ts', "if (priority === null) return { ok: false, outcome: rejected('Jira 는 우선순위를 비울 수 없습니다.') }", "if (priority === null) return { ok: true, value: '3' }"),
 ('N07-writeid-regex', 'src/main/work/jira-shape.ts', "writeId: typeof raw === 'string' && WRITE_ID.test(raw) ? raw : null", "writeId: typeof raw === 'string' ? raw : null"),
 ('N08-concurrency-1000', 'src/main/work/jira-http.ts', 'this.maxConcurrent = Math.max(1, options.maxConcurrent ?? 4)', 'this.maxConcurrent = 1000'),
 ('N09-sealed-plain-json-account-dropped', 'src/main/work/service.ts', 'return Object.keys(credentials.account).length === 0 ? credentials.token : JSON.stringify({ v: 1, token: credentials.token, account: credentials.account })', 'return credentials.token'),
 ('N10-readAccount-unknownkey', 'src/main/work/service.ts', "if (!fields.some((field) => field.key === key)) return { ok: false, message: '이 출처에 없는 연결 칸입니다.' }", ''),
 ('N11-hostregex-off', 'src/main/work/jira-source.ts', 'if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.atlassian\\.net$/.test(host))', 'if (false)'),
 ('N12-empty-query-where', 'src/main/work/jira-source.ts', "return { where: where.length === 0 ? 'issuekey IS NOT EMPTY' : where,", 'return { where: where,'),
 ('N13-collect-limit', 'src/main/work/jira-source.ts', 'const SEARCH_LIMIT = 100', 'const SEARCH_LIMIT = 100000'),
 ('N14-subtask-parent', 'src/main/work/jira-source.ts', "if (issue.value.issueType.subtask) return rejected('하위 작업은 부모 없이 둘 수 없습니다.')", ''),
 ('N15-inward-outward-swap', 'src/main/work/jira-source.ts', 'inwardIssue: { id: outward ? issue.value.id : other.value.id }, outwardIssue: { id: outward ? other.value.id : issue.value.id }', 'inwardIssue: { id: outward ? other.value.id : issue.value.id }, outwardIssue: { id: outward ? issue.value.id : other.value.id }'),
 ('N16-link-dup', 'src/main/work/jira-source.ts', "if (relationsOf(issue.value).some((relation) => relation.kind === kind && relation.other.id === other.value.id)) return rejected('이미 있는 연결입니다.')", ''),
 ('N17-hasDefault-included', 'src/main/work/jira-source.ts', 'field.required && !field.hasDefaultValue && !SYSTEM_CREATE_FIELDS.has(field.key)', 'field.required && !SYSTEM_CREATE_FIELDS.has(field.key)'),
 ('N18-orderClause-created@moved', 'src/main/work/jira-source.ts', "return (await this.orderFor(spaceKey)).state === 'on' ? 'ORDER BY Rank ASC' : 'ORDER BY created ASC'", "return 'ORDER BY created ASC'"),
 ('N19-reorder-null-afterId', 'src/main/work/jira-source.ts', 'body = { issues: [itemId], rankBeforeIssue: head.id }', 'body = { issues: [itemId], rankAfterIssue: head.id }'),
 ('N20-boards-absent@moved', 'src/main/work/jira-source.ts', "return { state: reply.status === 404 ? 'absent' : reply.status === 401 || reply.status === 403 ? 'forbidden' : 'unavailable' }", "return { state: 'absent' }"),
 ('P01-redirect-follow', 'src/main/work/jira-http.ts', "body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual',", "body: body === undefined ? undefined : JSON.stringify(body), redirect: 'follow',"),
 ('P02-redirect-3xx-as-ok', 'src/main/work/jira-http.ts', "if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {", 'if (false) {'),
 ('M11b-unknown-status-kept', 'src/main/work/jira-source.ts', 'if (CATEGORY[status.categoryKey] === undefined) continue', 'if (false) continue'),
 ('M22b-numbered-escape-off', 'src/main/work/adf.ts', 'if (numbered !== null) return', 'if (false) return'),
 ('X01-R1C-paren-balance-off', 'src/main/work/jira-source.ts', 'if (depth < 0) return null', 'if (false) return null'),
 ('X02-R1E-search-same-token-ok', 'src/main/work/jira-source.ts', "if (found.issues.length === 0 || seen.has(cursor)) return { ok: false, status: null, reason: null, error: pagingError('검색') }", "if (false) return { ok: false, status: null, reason: null, error: pagingError('검색') }"),
 ('X02b-R1E-children-same-token-ok', 'src/main/work/jira-source.ts', "if (found.issues.length === 0 || seen.has(cursor)) return { ok: false, error: pagingError('자식 목록') }", "if (false) return { ok: false, error: pagingError('자식 목록') }"),
 ('X03-R1D-debounce-off', 'src/renderer/src/hooks/useTasksPage.ts', '    if (!queried) { send(); return }', '    if (true) { send(); return }'),
 ('X04-R1D-split-off', 'src/renderer/src/hooks/useTasksPage.ts', 'index += WORK_SEARCH_SPACES_MAX) out.push({ connectionId, call: { ...call, spaceKeys: call.spaceKeys.slice(index, index + WORK_SEARCH_SPACES_MAX) } })', 'index += call.spaceKeys.length) out.push({ connectionId, call })'),
 ('X05-R1U-id-check-off', 'src/main/work/jira-source.ts', "if (!issueIdsOf(call).every((value) => ISSUE_ID.test(value))) return rejected('없는 작업입니다.')", ''),
 ('X06-R1X-written-plain-error@moved', 'src/main/work/jira-source.ts', 'return { ok: false, error: { ...outcome.error, message: `${prefix}${outcome.error.message}`, maybeApplied: true } }', 'return outcome'),
 ('X07-R1M-429-maybeApplied', 'src/main/work/jira-source.ts', '    if (reply.status === 429) return', '    if (false) return'),
 ('X08-R1T-captcha-401-only', 'src/main/work/jira-http.ts', "if ((headers.get('x-seraph-loginreason') ?? '').toUpperCase().includes('AUTHENTICATION_DENIED')) {", "if (status === 401 && (headers.get('x-seraph-loginreason') ?? '').toUpperCase().includes('AUTHENTICATION_DENIED')) {"),
 ('X09-R1P-restore-off', 'src/main/work/service.ts', '      this.restoreAccount({ connectionId, account: credentials.account })\n', ''),
 ('X10-R2G-case-sensitive', 'src/renderer/src/components/MarkdownView.tsx', "(?![A-Za-z0-9_])`, 'gi')", "(?![A-Za-z0-9_])`, 'g')"),
 ('X11-R1J-id-fallback-off', 'src/main/work/jira-source.ts', '?? WORK_PRIORITIES.find((known) => PRIORITY_DEFAULT_ID[known] === priority.id) ?? null', '?? null'),
 ('X12-R1I-no-category-dropped', 'src/main/work/jira-source.ts', "{ undefined: 'todo', new: 'todo',", "{ new: 'todo',"),
 ('X13-R1F-reporter-required', 'src/main/work/jira-source.ts', "'priority', 'parent', 'reporter'])", "'priority', 'parent'])"),
 ('X14-R1N-transient-forbidden', 'src/main/work/jira-source.ts', "reply.status === 401 || reply.status === 403 ? 'forbidden' : 'unavailable'", "'forbidden'"),
 ('X15-R1O-order-unknown-created', 'src/main/work/jira-source.ts', '    const known = this.orderOf.get(spaceKey)\n    if (known !== undefined) return known\n', "    const known = this.orderOf.get(spaceKey)\n    return known ?? { state: 'disabled', reason: ORDER_OFF_NO_BOARD }\n"),
 ('X16-R1L-207-names-remote', 'src/main/work/jira-source.ts', 'return rejected(`Jira 가 ${names} 의 순서를 바꾸지 못했습니다(207) — 잠시 후 다시 시도하세요.`, 207)', "return rejected('Jira 가 순서를 바꾸지 못했습니다(207).', 207)"),
 ('X17-R1B-acquire-token-off', 'src/main/work/service.ts', 'secrets: [credentials.token, ...(entry.secretsOf?.(credentials) ?? [])] })', 'secrets: [...(entry.secretsOf?.(credentials) ?? [])] })'),
 ('X18-R1S-truncate-before-redact', 'src/main/work/jira-http.ts', 'const flat = redact(first).replace(', 'const flat = first.slice(0, 120).replace('),
 ('X19-R1E-offset-empty-more-ok', 'src/main/work/jira-source.ts', '      if (step.value.values.length === 0) return { ok: false, outcome: { ok: false, error: pagingError(path) } }\n', ''),
 # 수정 2 의 새 규칙마다 하나(R2-D·R2-E·R2-F·R2-I·R2-J).
 ('X20-R2E-status-cache-kept', 'src/main/work/jira-source.ts', '    this.statusCache.clear()\n', ''),
 ('X21-R2E-priorities-kept', 'src/main/work/jira-source.ts', '    this.priorities = null\n', ''),
 ('X22-R2F-shape-error-throws', 'src/main/work/jira-source.ts', '      if (!(error instanceof JiraShapeError)) throw error\n      outcome =', '      throw error\n      outcome ='),
 ('X23-R2I-curly-quotes-sent', 'src/main/work/jira-source.ts', '  if (/[\\u2018\\u2019\\u201c\\u201d]/.test(query)) return null\n', ''),
 ('X24-R2D-empty-paragraph-kept', 'src/main/work/adf.ts', "    if (node.type === 'paragraph' && content === undefined && Object.keys(attrs).length === 0 && (node.marks ?? []).length === 0) continue\n", ''),
 ('X25-R2D-hardbreak-text-attr', 'src/main/work/adf.ts', " && !(node.type === 'hardBreak' && key === 'text' && value === '\\n')", ''),
 ('X26-R2D-lock-no-place@moved', 'src/main/work/adf.ts', 'unsupported: [at === -1 ? ROUNDTRIP : `${ROUNDTRIP}:${at + 1}:${shownBlocks[at]?.type ?? \'\'}`]', 'unsupported: [ROUNDTRIP]'),
 ('X27-R2J-note-key-connection', 'src/renderer/src/components/TasksPage.tsx', 'key={`${note.connectionId}:${note.text}`}', 'key={note.connectionId}'),
 # 리뷰 r2 리뷰어 자체 뮤테이션 34행(raw/review/claude-r2-raw/mut-r2-own.py) 편입 — R2-C.

 ('Y01-errortext-limit', 'src/main/work/jira-http.ts', 'flat.length > 200 ? `${flat.slice(0, 199)}…`', 'flat.length > 2000 ? `${flat.slice(0, 1999)}…`'),
 ('Y02-adfview-net-off@moved', 'src/main/work/adf.ts', '  if (sameAdf({ a: back, b: doc })) {', '  if (true) {'),
 ('Y03-canonical-drop-text-marks', 'src/main/work/adf.ts', ".map(canonicalMark).sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y)))", ".map(canonicalMark).map(() => ({ type: 'x' })).sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y)))"),
 ('Y04-canonicalMark-drop-attrs', 'src/main/work/adf.ts', "  const attrs = Object.fromEntries(Object.entries(mark.attrs ?? {}).filter(([, value]) => value !== null && value !== undefined))\n  return Object.keys(attrs).length === 0 ? { type: mark.type } : { type: mark.type, attrs }", "  return { type: mark.type }"),
 ('Y05-canonical-drop-node-attrs', 'src/main/work/adf.ts', "const attrs = Object.fromEntries(Object.entries(node.attrs ?? {}).filter(([key, value]) => key !== 'localId'", "const attrs = Object.fromEntries(Object.entries(node.attrs ?? {}).filter(([key, value]) => key !== 'localId' && key !== 'level' && key !== 'language'"),
 ('Y06-toggle-no-text-check', 'src/main/work/jira-source.ts', 'if (toggled !== null && adfToMarkdown(toggled).markdown === next) return', 'if (toggled !== null) return'),
 ('Y07-withTaskStates-count-off', 'src/main/work/adf.ts', 'if (taskStates(doc).length !== states.length) return null', ''),
 ('Y08-markattrs-lock-off', 'src/main/work/adf.ts', 'unsupported.add(MARK_ATTRS)', 'void 0'),
 ('Y09-blocklevel-marks-off', 'src/main/work/adf.ts', 'for (const mark of node.marks ?? []) unsupported.add(mark.type)', ''),
 ('Y10-restore-overwrite', 'src/main/work/service.ts', 'account: { ...account, ...row.account } }', 'account: { ...row.account, ...account } }'),
 ('Y11-order-capped-as-nobd', 'src/main/work/jira-source.ts', 'reason: boards.complete ? ORDER_OFF_NO_BOARD : ORDER_OFF_CAPPED', 'reason: ORDER_OFF_NO_BOARD'),
 ('Y12-child-guard', 'src/main/work/jira-source.ts', 'const CHILD_PAGE_GUARD = 20', 'const CHILD_PAGE_GUARD = 2000'),
 ('Y13-read-retries', 'src/main/work/jira-http.ts', 'const READ_RETRIES = 2', 'const READ_RETRIES = 6'),
 ('Y14-jqlstring-newline', 'src/main/work/jira-source.ts', "value.replace(/[\\r\\n]+/g, ' ').replace(", 'value.replace('),
 ('Y15-scheme-check-off', 'src/main/work/jira-source.ts', "if (url.protocol !== 'https:' && url.protocol !== 'http:')", 'if (false)'),
 ('Y16-transitionplan-dup', 'src/main/work/jira-source.ts', '    if (open.has(statusKey)) continue\n', ''),
 ('Y17-history-description', 'src/main/work/jira-source.ts', "    case 'description': return 'body'\n", ''),
 ('Y18-search-scope-off', 'src/main/work/jira-source.ts', '`${scope} AND (${user.where})', '`(${user.where})'),
 ('Y19-text-scope-off', 'src/main/work/jira-source.ts', '`${scope} AND text ~ ${jqlString(words)}', '`text ~ ${jqlString(words)}'),
 ('Y20-looksLikeQuery-true', 'src/renderer/src/hooks/useTasksPage.ts', "if (pattern === null || query.trim().length === 0) return false", "if (query.trim().length === 0) return false\n  if (pattern === null) return true"),
 ('Y21-callCapabilities-nonarrow', 'src/main/work/service.ts', None, 'R2-C 로 서비스 쪽 스페이스 좁히기(callCapabilities)를 걷어냄 — 해당 없음(좁히기는 shared spaceCapabilities 한 곳, Y22 가 덮는다)'),
 ('Y22-placement-narrow-off', 'src/shared/work.ts', 'placement: narrow(capabilities.placement, space.capabilities.placement) }', 'placement: capabilities.placement }'),
 ('Y23-account-trim', 'src/main/work/service.ts', 'account[key] = entryValue.trim()', 'account[key] = entryValue'),
 ('Y24-label-slice', 'src/main/work/adf.ts', '.slice(0, 40) ||', '.slice(0, 4000) ||'),
 ('Y25-roundtrip-lock-ignored@moved', 'src/main/work/jira-source.ts', 'bodyLock: body === null || body.unsupported.length === 0 ? null : lockReason(body.unsupported)', "bodyLock: body === null || body.unsupported.filter((x) => !x.startsWith('#roundtrip')).length === 0 ? null : lockReason(body.unsupported)"),
 ('Y26-captcha-ci', 'src/main/work/jira-http.ts', ".toUpperCase().includes('AUTHENTICATION_DENIED')", ".includes('AUTHENTICATION_DENIED')"),
 ('Y27-retryafter-date', 'src/main/work/jira-http.ts', 'const at = Date.parse(value)', 'const at = NaN'),
 ('Y28-redirect-body-cancel', 'src/main/work/jira-http.ts', "await response.body?.cancel().catch(() => undefined)\n", ''),
 ('Y29-shape-created-id', 'src/main/work/jira-shape.ts', "return { id: id(root.id, 'created.id'), key: str(root.key, 'created.key') }", "return { id: String(root.id ?? ''), key: String(root.key ?? '') }"),
 ('Y30-priority-fallback-ignore-name', 'src/main/work/jira-source.ts', "?? this.priorities.find((entry) => entry.id === PRIORITY_DEFAULT_ID[priority] && priorityOf({ id: entry.id, name: entry.name }) === priority)", '?? undefined'),
 ('Y31-split-orderby-case', 'src/main/work/jira-source.ts', "/^order\\s+by\\b/i.exec", "/^order\\s+by\\b/.exec"),
 ('Y32-quote-backslash', 'src/main/work/jira-source.ts', "if (char === '\\\\') index += 1\n      else if (char === quote) quote = null", "if (char === quote) quote = null"),
 ('Y33-single-quote-track@moved', 'src/main/work/jira-source.ts', 'if (char === \'"\' || char === "\'") {', 'if (char === \'"\') {'),
 ('Y34-dueFromJira-tz', 'src/main/work/jira-source.ts', 'new Date(year, month - 1, day, 23, 59, 59).toISOString()', 'new Date(Date.UTC(year, month - 1, day, 23, 59, 59)).toISOString()'), # 리뷰 r3 리뷰어 자체 뮤테이션 12행(raw/review/claude-r3-raw/mut-r3-own.py) 편입 — 앵커가 수정 3 으로 바뀐 행은 @moved.
 ('Z01-linkTypes-cache-kept@moved', 'src/main/work/jira-source.ts', '    this.linkTypes = null\n    this.metaSince = this.now()\n', '    this.metaSince = this.now()\n'),
 ('Z02-writeBlocks-keeps-empty', 'src/main/work/adf.ts', ".filter((text, index) => !(text === '' && nodes[index]?.type === 'paragraph'))", ''),
 ('Z03-canonical-empty-content-differs', 'src/main/work/adf.ts', "const content = inner.length === 0 ? undefined : inner", "const content = node.content === undefined ? undefined : inner"),
 ('Z04-lock-place-offbyone@moved', 'src/main/work/adf.ts', '`${ROUNDTRIP}:${at + 1}:${shownBlocks[at]?.type', '`${ROUNDTRIP}:${at}:${shownBlocks[at]?.type'),
 ('Z05-curly-only-left-double', 'src/main/work/jira-source.ts', '[\\u2018\\u2019\\u201c\\u201d]', '[\\u201c]'),
 ('Z06-afterWrite-addRelation-no-prefix', 'src/main/work/jira-source.ts', "return this.afterWrite({ prefix: WRITTEN_PREFIX, work: async () => {\n      const after = await this.fetchIssue(itemId)", "return this.afterWrite({ prefix: '', work: async () => {\n      const after = await this.fetchIssue(itemId)"),
 ('Z07-afterWrite-create-uses-written-prefix', 'src/main/work/jira-source.ts', 'return this.afterWrite({ prefix: MADE_PREFIX, work: async () => {\n      const created', 'return this.afterWrite({ prefix: WRITTEN_PREFIX, work: async () => {\n      const created'),
 ('Z08-canonical-paragraph-with-marks-dropped', 'src/main/work/adf.ts', "&& (node.marks ?? []).length === 0) continue", ") continue"),
 ('Z09-hardbreak-text-attr-any', 'src/main/work/adf.ts', "key === 'text' && value === '\\n')))", "key === 'text')))"),
 ('Z10-label-roundtrip-regex', 'src/main/work/adf.ts', '(\\\\d+):(.*)$`).exec(type)', '(\\\\d+):(.*)$`).exec("")'),
 ('Z11-statuses-cache-key', 'src/main/work/jira-source.ts', 'this.statusCache.set(spaceKey, info)', 'this.statusCache.set("x", info)'),
 ('Z12-visible-sort-off(test oracle)', 'src/main/work/adf-editor.test.ts', ".map((mark) => (mark.type === 'link' ? `link(${String(mark.attrs?.href)})` : mark.type)).sort().join('+')", ".map((mark) => (mark.type === 'link' ? 'link' : mark.type)).sort().join('+')"),
 # 수정 3 의 새 규칙마다 하나(R3-A·R3-B·R3-D·R3-E).
 ('X28-R3A-item-first-paragraph-off', 'src/main/work/adf.ts', "first === undefined || (first.type !== 'paragraph' && first.type !== 'codeBlock') ? [{ type: 'paragraph', content: [] }, ...blocks] : blocks }", "blocks.length === 0 ? [{ type: 'paragraph', content: [] }] : blocks }"),
 ('X29-R3A-empty-quote-kept', 'src/main/work/adf.ts', "content: inner.length === 0 ? [{ type: 'paragraph', content: [] }] : inner })", 'content: inner })'),
 ('X30-R3A-code-keeps-marks@moved', 'src/main/work/adf.ts', "marks: [...marks.map((mark) => ({ ...mark })), { type: 'code' }] })", "marks: [...marks.filter((mark) => mark.type === 'link').map((mark) => ({ ...mark })), { type: 'code' }] })"),
 ('X31-R3A-rules-lock-off', 'src/main/work/adf.ts', 'return adfRuleProblem(back) === null ? shown : { markdown: shown.markdown, unsupported: [RULES] }', 'return shown'),
 ('X32-R3A-write-guard-off', 'src/main/work/jira-source.ts', 'return problem === null ? { ok: true, doc } : { ok: false, message: `보내지 않았습니다 — ${problem}` }', 'return { ok: true, doc }'),
 ('X33-R3A-quote-allows-heading', 'src/main/work/adf.ts', "const QUOTE_CHILDREN = new Set(['paragraph', 'bulletList', 'orderedList', 'codeBlock'])", "const QUOTE_CHILDREN = new Set(['paragraph', 'bulletList', 'orderedList', 'codeBlock', 'heading'])"),
 ('X34-R3B-ttl-off', 'src/main/work/jira-source.ts', '    if (this.now() - this.metaSince >= META_CACHE_MS) this.clearMeta()\n', ''),
 ('X35-R3D-number-counts-empty', 'src/main/work/adf.ts', "const shownBlocks = doc.content.filter((block) => !(block.type === 'paragraph' && adfToMarkdown({ type: 'doc', version: 1, content: [block] }).markdown === ''))", 'const shownBlocks = doc.content'),
 ('X36-R3E-backslash-sent', 'src/main/work/jira-source.ts', "    else if (char === '\\\\') return null\n", ''),
 # 리뷰 r4 의 16행(수정 4 — 리뷰어 scratch/mymut.py 그대로, R4-09 는 가드를 지워 해당 없음).
 ('R4-01-addComment-bypass', 'src/main/work/jira-source.ts', "    const doc = writableAdf(body)\n    if (!doc.ok) return rejected(doc.message)\n    const sent = await this.write({ method: 'POST', path: `/rest/api/3/issue/${encodeURIComponent(itemId)}/comment`, body: { body: doc.doc }", "    const doc = { ok: true as const, doc: withLocalIds(markdownToAdf(body)) }\n    const sent = await this.write({ method: 'POST', path: `/rest/api/3/issue/${encodeURIComponent(itemId)}/comment`, body: { body: doc.doc }"),
 ('R4-02-create-desc-bypass', 'src/main/work/jira-source.ts', '      const description = writableAdf(call.body)\n      if (!description.ok) return rejected(description.message)\n      fields.description = description.doc', '      fields.description = withLocalIds(markdownToAdf(call.body))'),
 ('R4-03-create-textarea-bypass', 'src/main/work/jira-source.ts', '        const text = writableAdf(value.value)\n        if (!text.ok) return rejected(`${field.label}: ${text.message}`)\n        fields[value.key] = text.doc', '        fields[value.key] = withLocalIds(markdownToAdf(value.value))'),
 ('R4-04-priority-no-expire', 'src/main/work/jira-source.ts', "    if (priority === null) return { ok: false, outcome: rejected('Jira 는 우선순위를 비울 수 없습니다.') }\n    this.expireMeta()\n", "    if (priority === null) return { ok: false, outcome: rejected('Jira 는 우선순위를 비울 수 없습니다.') }\n"),
 ('R4-05-linktypes-no-expire', 'src/main/work/jira-source.ts', '  private async linkTypeList(): Promise<Step<JiraLinkType[]>> {\n    this.expireMeta()\n', '  private async linkTypeList(): Promise<Step<JiraLinkType[]>> {\n'),
 ('R4-06-statuses-no-expire', 'src/main/work/jira-source.ts', None, '수정 4 — statuses() 의 수명 검사를 지웠다(부르는 곳 listStatuses·createMeta 가 늘 먼저 project() 를 불러 같은 clearMeta 가 이 캐시도 비운다 — mut6 생존, 닿지 않는 중복)'),
 ('R4-07-item-allows-quote', 'src/main/work/adf.ts', "const ITEM_CHILDREN = new Set(['paragraph', 'bulletList', 'orderedList', 'taskList', 'codeBlock'])", "const ITEM_CHILDREN = new Set(['paragraph', 'bulletList', 'orderedList', 'taskList', 'codeBlock', 'blockquote', 'heading', 'rule'])"),
 ('R4-08-item-first-check-off', 'src/main/work/adf.ts', "if (first === undefined || (first.type !== 'paragraph' && first.type !== 'codeBlock')) return '목록 항목은 글로 시작해야 합니다(Jira 문서 규칙).'", ''),
 ('R4-09-empty-code-kept', 'src/main/work/adf.ts', None, '수정 4 R4-G — 닿지 않는 빈 코드 가드를 지웠다(닫는 표지는 여는 표지 바로 뒤에 올 수 없어 코드 글자가 비지 않는다, adf.ts walkInline 주석)'),
 ('R4-10-meta-since-not-reset', 'src/main/work/jira-source.ts', '    this.linkTypes = null\n    this.metaSince = this.now()\n  }', '    this.linkTypes = null\n  }'),
 ('R4-11-ttl-gt', 'src/main/work/jira-source.ts', 'if (this.now() - this.metaSince >= META_CACHE_MS) this.clearMeta()', 'if (this.now() - this.metaSince > META_CACHE_MS * 10) this.clearMeta()'),
 ('R4-12-quote-empty-rule-off', 'src/main/work/adf.ts', "if (content.length === 0) return '빈 인용은 Jira 문서 규칙에 맞지 않습니다.'", ''),
 ('R4-13-list-empty-rule-off', 'src/main/work/adf.ts', "&& content.length === 0) return '빈 목록은 Jira 문서 규칙에 맞지 않습니다.'", "&& false) return '빈 목록은 Jira 문서 규칙에 맞지 않습니다.'"),
 ('R4-14-bodyUpdate-no-writable', 'src/main/work/jira-source.ts', '  const doc = writableAdf(next)\n  return doc.ok ? { ok: true, doc: doc.doc } : doc', '  return { ok: true, doc: withLocalIds(markdownToAdf(next)) }'),
 ('R4-15-qdepth-backslash-in-quote', 'src/main/work/jira-source.ts', "if (char === '\\\\') index += 1\n      else if (char === quote) quote = null", 'if (char === quote) quote = null'),
 ('R4-16-adfView-rules-label', 'src/main/work/adf.ts', "[RULES]: '편집기 서식(저장하면 Jira 문서 규칙에 맞지 않는 모양)',", ''),
 ('X37-R4A-code-marks-rule-off', 'src/main/work/adf.ts', "      if (node.type === 'text' && (node.marks ?? []).some((mark) => mark.type === 'code') && (node.marks ?? []).some((mark) => mark.type !== 'code' && mark.type !== 'link')) {", '      if (false) {'),
 ('X38-R4B-note-off', 'src/main/work/jira-source.ts', '        ...(body !== null && body.unsupported.length === 0 && losesGaps(', '        ...(false && losesGaps('),
 ('X39-R4B-gaps-any-empty', 'src/main/work/adf.ts', '  return count(doc.content) > count(markdownToAdf(adfToMarkdown(doc).markdown).content)', '  return count(doc.content) > 0'),
 ('X40-R4B-render-off', 'src/renderer/src/components/TaskDetail.tsx', '{editing && item.bodySaveNote !== undefined ?', '{false && item.bodySaveNote !== undefined ?'),
 ('X41-R4C-midword-quote-sent', 'src/main/work/jira-source.ts', "      if (index > 0 && !/[\\s(),=~!<>]/.test(query[index - 1] ?? '')) return null\n", ''),
 ('X42-R4E-project-no-expire', 'src/main/work/jira-source.ts', '  private async project(spaceKey: string): Promise<Step<ProjectInfo>> {\n    this.expireMeta()\n', '  private async project(spaceKey: string): Promise<Step<ProjectInfo>> {\n'),
 ('X43-R4E-order-no-expire', 'src/main/work/jira-source.ts', '  private async orderFor(spaceKey: string): Promise<WorkCapability> {\n    this.expireMeta()\n', '  private async orderFor(spaceKey: string): Promise<WorkCapability> {\n'),
 ('X44-R4E-clear-keeps-projects', 'src/main/work/jira-source.ts', '    this.projects.clear()\n    this.orderOf.clear()\n', '')]

def main():
    out = os.path.abspath(sys.argv[1])
    only = sys.argv[2:]
    os.makedirs(out, exist_ok=True)
    files = sorted({row[1] for row in M})
    dirty = subprocess.run(['git', 'status', '--porcelain', '--'] + files, cwd=APP, capture_output=True, text=True).stdout.strip()
    if dirty:
        print('커밋 안 된 변경이 있다 — 되돌리기(git checkout)가 날린다. 멈춘다:\n' + dirty)
        sys.exit(3)
    head = subprocess.run(['git', 'rev-parse', '--short', 'HEAD'], cwd=APP, capture_output=True, text=True).stdout.strip()
    results = []
    for name, file, old, new in M:
        if only and name not in only:
            continue
        if old is None:
            results.append({'name': name, 'verdict': 'N/A', 'reason': new})
            continue
        path = os.path.join(APP, file)
        src = open(path).read()
        if old not in src:
            results.append({'name': name, 'verdict': 'NO-MATCH'})
            continue
        open(path, 'w').write(src.replace(old, new, 1))
        try:
            run = subprocess.run(['npx', 'vitest', 'run'] + TESTS, cwd=APP, env=env, capture_output=True, text=True, timeout=600)
            text = run.stdout + run.stderr
            tests = re.search(r'Tests\s+(.*)', text)
            fails = sorted(set(re.findall(r'^ +(?:FAIL|×)\s+(.*)$', text, re.M)))[:6]
            results.append({'name': name, 'verdict': 'KILLED' if run.returncode != 0 else 'SURVIVED', 'exit': run.returncode, 'tests': tests.group(1).strip() if tests else '', 'fails': fails})
            open(os.path.join(out, name.replace('/', '_') + '.txt'), 'w').write(text[-6000:])
        except subprocess.TimeoutExpired:
            results.append({'name': name, 'verdict': 'KILLED', 'exit': 'timeout'})
        finally:
            subprocess.run(['git', 'checkout', '--', file], cwd=APP)
        print(json.dumps(results[-1], ensure_ascii=False), flush=True)
    with open(os.path.join(out, 'RESULTS.jsonl'), 'w') as handle:
        for row in results:
            handle.write(json.dumps(row, ensure_ascii=False) + '\n')
    count = {key: sum(1 for row in results if row['verdict'] == key) for key in ['KILLED', 'SURVIVED', 'NO-MATCH', 'N/A']}
    summary = f"head={head} total={len(results)} killed={count['KILLED']} survived={count['SURVIVED']} no_match={count['NO-MATCH']} na={count['N/A']}"
    open(os.path.join(out, 'SUMMARY'), 'w').write(summary + '\n')
    print(summary)
    left = subprocess.run(['git', 'status', '--porcelain', '--'] + files, cwd=APP, capture_output=True, text=True).stdout.strip()
    if left:
        print('되돌리기 뒤 변경이 남았다:\n' + left)
        sys.exit(4)
    sys.exit(0 if count['SURVIVED'] == 0 and count['NO-MATCH'] == 0 else 1)

main()

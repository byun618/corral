#!/usr/bin/env python3
# LIFE-605 수정 1 R1-K — 리뷰어 r1 뮤테이션(claude-r1-raw/scratch/mut.py·mut2.py·mut3.py)을 이 worktree 코드에 옮겨 다시 돌린다.
#   python3 -I scripts/l605/mut.py <OUT> [이름…]   (app/ 에서, **커밋된 깨끗한 트리에서만** — 끝나면 `git checkout -- <파일>` 로 되돌린다)
# 행 = (이름, 파일, 바꿀 글, 바꾼 글). 리뷰어 원문 앵커가 수정 1 로 바뀐 행은 같은 뜻의 패치로 옮기고 이름에 `@moved` 를 붙였다.
# 바꿀 글이 None = 코드가 사라져 해당 없음(사유 칸). M01 은 원문 앵커가 머리 주석의 `redirect: 'manual'` 에 먼저 걸려 코드를 안 바꿨다(mut1 회차 생존) — 코드 줄로 옮겼다. `X…` 행 = 수정 1 의 새 규칙마다 하나씩 더한 뮤테이션.
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
 ('X06-R1X-written-plain-error', 'src/main/work/jira-source.ts', 'return { ok: false, error: { ...error, message: `${WRITTEN_PREFIX}${error.message}`, maybeApplied: true } }', 'return { ok: false, error }'),
 ('X07-R1M-429-maybeApplied', 'src/main/work/jira-source.ts', '    if (reply.status === 429) return', '    if (false) return'),
 ('X08-R1T-captcha-401-only', 'src/main/work/jira-http.ts', "if ((headers.get('x-seraph-loginreason') ?? '').toUpperCase().includes('AUTHENTICATION_DENIED')) {", "if (status === 401 && (headers.get('x-seraph-loginreason') ?? '').toUpperCase().includes('AUTHENTICATION_DENIED')) {"),
 ('X09-R1P-restore-off', 'src/main/work/service.ts', '      this.restoreAccount({ connectionId, account: credentials.account })\n', ''),
 ('X10-R1R-case-insensitive', 'src/renderer/src/components/MarkdownView.tsx', "(?![A-Za-z0-9_])`, 'g')", "(?![A-Za-z0-9_])`, 'gi')"),
 ('X11-R1J-id-fallback-off', 'src/main/work/jira-source.ts', '?? WORK_PRIORITIES.find((known) => PRIORITY_DEFAULT_ID[known] === priority.id) ?? null', '?? null'),
 ('X12-R1I-no-category-dropped', 'src/main/work/jira-source.ts', "{ undefined: 'todo', new: 'todo',", "{ new: 'todo',"),
 ('X13-R1F-reporter-required', 'src/main/work/jira-source.ts', "'priority', 'parent', 'reporter'])", "'priority', 'parent'])"),
 ('X14-R1N-transient-forbidden', 'src/main/work/jira-source.ts', "reply.status === 401 || reply.status === 403 ? 'forbidden' : 'unavailable'", "'forbidden'"),
 ('X15-R1O-order-unknown-created', 'src/main/work/jira-source.ts', '    const known = this.orderOf.get(spaceKey)\n    if (known !== undefined) return known\n', "    const known = this.orderOf.get(spaceKey)\n    return known ?? { state: 'disabled', reason: ORDER_OFF_NO_BOARD }\n"),
 ('X16-R1L-207-names-remote', 'src/main/work/jira-source.ts', 'return rejected(`Jira 가 ${names} 의 순서를 바꾸지 못했습니다(207) — 잠시 후 다시 시도하세요.`, 207)', "return rejected('Jira 가 순서를 바꾸지 못했습니다(207).', 207)"),
 ('X17-R1B-acquire-token-off', 'src/main/work/service.ts', 'secrets: [credentials.token, ...(entry.secretsOf?.(credentials) ?? [])] })', 'secrets: [...(entry.secretsOf?.(credentials) ?? [])] })'),
 ('X18-R1S-truncate-before-redact', 'src/main/work/jira-http.ts', 'const flat = redact(first).replace(', 'const flat = first.slice(0, 120).replace('),
 ('X19-R1E-offset-empty-more-ok', 'src/main/work/jira-source.ts', '      if (step.value.values.length === 0) return { ok: false, outcome: { ok: false, error: pagingError(path) } }\n', '')]

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

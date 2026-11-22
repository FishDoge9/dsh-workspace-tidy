/**
 * 集成自测 v3：假 ctx + 假 agent + 假 webServer，验证接线、设置页端点、整理回合与工具。
 * 用法：node scripts/integration.mjs
 */
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-tidy-v3-'))
process.env.DSH_PROFILE_DIR = tmp // 设置文件写进临时 profile

const { apply } = await import('../index.js')

const root = path.join(tmp, 'workspace')
const mkdir = (rel) => fs.mkdir(path.join(root, rel), { recursive: true })
const write = async (rel, body = 'x') => {
  await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true })
  await fs.writeFile(path.join(root, rel), body)
}
const exists = async (rel) => {
  try {
    await fs.stat(path.join(root, rel))
    return true
  } catch {
    return false
  }
}

await mkdir('00_索引')
await mkdir('09_高中学习')
await mkdir('10_杂项')
await write('工作区导航.md', '# 导航\n\n## 09_高中学习 — 高中各科复习资料\n\n## 10_杂项 — 测试与杂项\n')
await write('README.md', '# readme')
await write('__pycache__/a.pyc', 'cache')

const handlers = new Map()
let section
let tool
const routes = new Map()
const followups = []
const logs = []
const agent = {
  id: 'a1',
  session: { header: { id: 'a1', cwd: root } },
  whenIdle: async () => {},
  followup: (message) => followups.push(message),
}
const subAgent = {
  id: 'a2',
  session: { header: { id: 'a2', cwd: root, origin: 'subagent' } },
  whenIdle: async () => {},
  followup: (message) => followups.push(message),
}
// 另一个对话（不是子代理）：产物应该进它自己的目录
const otherAgent = {
  id: 'a3',
  session: {
    header: { id: 'a3', cwd: root },
    events: [{ type: 'user/message', data: { content: [{ type: 'text', text: '帮我做一份卷卡合一样例' }] } }],
  },
  whenIdle: async () => {},
  followup: (message) => followups.push(message),
}

const ctx = {
  logger: { info: (m) => logs.push(`info ${m}`), warn: (m) => logs.push(`warn ${m}`), error: (m) => logs.push(`error ${m}`) },
  get(name) {
    if (name === 'systemPrompt') return { section(s) { section = s; return () => {} } }
    if (name === 'agents') {
      return {
        list: () => [agent],
        get: (id) => (id === 'a1' ? agent : id === 'a2' ? subAgent : id === 'a3' ? otherAgent : undefined),
      }
    }
    if (name === 'webServer') return { register(r) { routes.set(r.path, r); return () => {} } }
    return undefined
  },
  on(event, handler) {
    assert.equal(handlers.has(event), false, `duplicate listener for ${event}`)
    handlers.set(event, handler)
  },
  effect(fn) { fn() },
  tools: { register(definition) { tool = definition; return () => {} } },
}

apply(ctx, { enabled: true, cooldownMs: 0, prompt: true })

/* 端点调用 helper：callRoute(path, method, body, contentType?) */
async function callRoute(path, method, body, contentType = 'application/json') {
  const route = routes.get(path)
  if (!route) throw new Error(`route not registered: ${path}`)
  const res = {
    status: 0,
    headers: {},
    payload: '',
    writeHead(status, headers) { this.status = status; this.headers = headers || {} },
    end(chunk) { this.payload = chunk == null ? '' : String(chunk) },
  }
  const req = {
    method,
    headers: { 'content-type': contentType },
    on(event, fn) {
      if (event === 'data' && body !== undefined) fn(Buffer.from(JSON.stringify(body)))
      if (event === 'end') fn()
      return req
    },
  }
  await route.handler(req, res)
  return { status: res.status, json: res.payload ? JSON.parse(res.payload) : null }
}

const SETTINGS = '/workspace-tidy/settings'
const RUN = '/workspace-tidy/run'

// 1) 接线
assert.equal(handlers.has('session/event'), true, 'session/event wired')
assert.equal(handlers.has('agent/created'), true, 'agent/created wired')
assert.equal(routes.has('/workspace-tidy/settings'), true, 'settings route registered')
assert.equal(routes.has('/workspace-tidy/run'), true, 'run route registered')
assert.equal(tool?.name, 'tidy_workspace', 'tool registered')
assert.equal(typeof section?.text, 'function', 'prompt section reads settings live')

// 2) GET 设置
const got = await callRoute(SETTINGS, 'GET')
assert.equal(got.status, 200)
assert.equal(got.json.settings.enabled, true)
assert.equal(got.json.settings.autoFile, true)
assert.equal(got.json.settings.junk, true)
assert.ok(Array.isArray(got.json.settings.rules) && got.json.settings.rules.length >= 3, 'default rules present')
assert.ok(got.json.settings.promptText.includes('NN_名称'), 'default prompt present')
assert.ok(got.json.defaults.rules.length >= 3)

const turnEnd = (agentRef, turn) =>
  handlers.get('session/event')(agentRef.session, { type: 'turn/end', data: { turn } })

// 启用时会记录主对话（= 安装插件时正在跑的会话）
await new Promise((r) => setTimeout(r, 400))
const adopted = await callRoute(SETTINGS, 'GET')
assert.equal(adopted.json.settings.mainSessionId, 'a1', 'main session adopted at activation')
assert.equal(adopted.json.settings.sessionInbox, true, 'session inbox on by default')
assert.equal(adopted.json.settings.sessionInboxDir, '16_对话产物')

// 3) 基线
handlers.get('agent/created')({ agent })
await new Promise((r) => setTimeout(r, 400))
assert.equal(await exists('.workspace-tidy/state.json'), true, 'baseline written')
assert.equal(await exists('工作区导航.md'), true, 'baseline moved nothing')

// 4) 回合结束 + 根目录新文件 → 起整理回合
await write('六年级说题.pptx', 'ppt')
await write('build_say.py', 'script')
await write('tmp_notes.tmp', 'tmp')
turnEnd(agent, 2)
await new Promise((r) => setTimeout(r, 500))
assert.equal(followups.length, 1, 'one tidy turn queued')
const message = followups[0]
assert.equal(message.role, 'user')
assert.equal(message.source.kind, 'user')
assert.match(message.content[0].text, /六年级说题\.pptx/)
assert.match(message.content[0].text, /09_高中学习/)
assert.match(message.content[0].text, /1\. /, 'rules are numbered')
assert.equal(await exists('tmp_notes.tmp'), false, 'junk recycled by the plugin')
assert.equal(await exists('六年级说题.pptx'), true, 'plugin itself does not move project files')
assert.equal(await exists('__pycache__'), false, 'cache dir recycled')

// 5) 整理回合不递归
turnEnd(agent, 3)
await new Promise((r) => setTimeout(r, 300))
assert.equal(followups.length, 1, 'tidy turn must not queue another tidy turn')

// 6) 子代理回合不参与
await write('sub_note.md', 'x')
turnEnd(subAgent, 1)
await new Promise((r) => setTimeout(r, 300))
assert.equal(followups.length, 1, 'subagent turn must not tidy')

// 6b) 其他对话的产物 → 16_对话产物/<对话名>/，不占用 AI 回合
await write('卷卡合一_样例卷.pdf', 'pdf')
turnEnd(otherAgent, 2)
await new Promise((r) => setTimeout(r, 600))
const inboxDir = '16_对话产物/帮我做一份卷卡合一样例'
assert.equal(await exists(`${inboxDir}/卷卡合一_样例卷.pdf`), true, 'other session artifacts filed under its own folder')
assert.equal(await exists('卷卡合一_样例卷.pdf'), false, 'removed from root')
assert.equal(await exists('六年级说题.pptx'), true, 'main session files are not swept by another conversation')
assert.equal(await exists('build_say.py'), true, 'script stays with its session until that session tidies')
assert.equal(followups.length, 1, 'other session does not spend an AI tidy turn')
const sessionRecord = await fs.readFile(path.join(root, '00_索引', '对话产物.md'), 'utf8')
assert.match(sessionRecord, /帮我做一份卷卡合一样例/)
assert.match(sessionRecord, /16_对话产物/)

// 7) 工具执行
const result = await tool.execute({
  moves: [
    { from: '六年级说题.pptx', to: '09_高中学习' },
    { from: 'build_say.py', to: '09_高中学习' },
  ],
}, { agent })
assert.equal(result.moved.length, 2, 'two moves applied')
assert.equal(await exists('09_高中学习/六年级说题.pptx'), true)
assert.equal(await exists('09_高中学习/build_say.py'), true, 'script follows its artifact')
assert.equal(await exists('撤销自动整理.ps1'), true, 'undo script regenerated')

// 8) 安全边界
const rejected = await tool.execute({
  moves: [
    { from: '工作区导航.md', to: '10_杂项' },
    { from: 'README.md', to: '../escape' },
    { from: 'nope.md', to: '10_杂项' },
  ],
}, { agent })
assert.equal(rejected.moved.length, 0)
assert.equal(rejected.failed.length, 3)

// 9) 同内容重名去重
await write('note.md', 'same-body')
await tool.execute({ moves: [{ from: 'note.md', to: '10_杂项' }] }, { agent })
await write('note.md', 'same-body')
await tool.execute({ moves: [{ from: 'note.md', to: '10_杂项' }] }, { agent })
const misc = await fs.readdir(path.join(root, '10_杂项'))
assert.deepEqual(misc.filter((n) => n.startsWith('note')).sort(), ['note.md'], 'identical copy deduped')

// 10) discard
await write('draft_v3.pptx', 'draft')
const discarded = await tool.execute({ discard: ['draft_v3.pptx'] }, { agent })
assert.equal(discarded.discarded.length, 1)
assert.equal(await exists('draft_v3.pptx'), false)

// 11) dry_run
await write('maybe.md', 'x')
const dry = await tool.execute({ moves: [{ from: 'maybe.md', to: '10_杂项' }], dry_run: true }, { agent })
assert.equal(dry.dryRun, true)
assert.equal(await exists('maybe.md'), true)

/* ------------------------------- 设置页行为 ------------------------------- */

// 12) 关闭总开关 → 不再排整理回合，也不再回收
const off = await callRoute(SETTINGS, 'POST', { enabled: false })
assert.equal(off.status, 200)
assert.equal(off.json.settings.enabled, false)
const settingsFile = path.join(tmp, '.dsh-workspace-tidy', 'settings.json')
const saved = JSON.parse(await fs.readFile(settingsFile, 'utf8'))
assert.equal(saved.enabled, false, 'settings persisted to disk')

await write('after_off.md', 'x')
await write('after_off.tmp', 'junk')
turnEnd(agent, 4)
await new Promise((r) => setTimeout(r, 400))
assert.equal(followups.length, 1, 'disabled: no tidy turn')
assert.equal(await exists('after_off.tmp'), true, 'disabled: junk not recycled')

// 13) 重新打开 + 自定义规则 → 整理回合带上自定义规则
const custom = await callRoute(SETTINGS, 'POST', { enabled: true, rules: ['所有东西都进 10_杂项', '  ', '脚本跟随产物'] })
assert.equal(custom.status, 200)
assert.deepEqual(custom.json.settings.rules, ['所有东西都进 10_杂项', '脚本跟随产物'], 'rules trimmed and blanks dropped')
await write('after_on.md', 'x')
turnEnd(agent, 5)
await new Promise((r) => setTimeout(r, 500))
assert.equal(followups.length, 2, 're-enabled: tidy turn queued again')
assert.match(followups[1].content[0].text, /所有东西都进 10_杂项/)
assert.match(followups[1].content[0].text, /after_on\.md/)

// 14) 提示词实时生效
const promptPatch = await callRoute(SETTINGS, 'POST', { promptText: '自定义提示：产物请进 NN_项目/' })
assert.equal(promptPatch.status, 200)
assert.match(section.text({}), /自定义提示：产物请进 NN_项目\//)

// 15) 非法请求
const bad = await callRoute(SETTINGS, 'POST', { promptText: 123 })
assert.equal(bad.status, 200)
assert.equal(typeof bad.json.settings.promptText, 'string', 'non-string prompt falls back')

// 16) content-type 必须是 JSON（挡住跨站简单请求）
const wrongType = await callRoute(SETTINGS, 'POST', { enabled: true }, 'text/plain')
assert.equal(wrongType.status, 415)

// 17) 并发保存不丢字段（串行化写入）
await Promise.all([
  callRoute(SETTINGS, 'POST', { autoFile: false }),
  callRoute(SETTINGS, 'POST', { junk: false }),
])
const merged = await callRoute(SETTINGS, 'GET')
assert.equal(merged.json.settings.autoFile, false, 'concurrent save kept autoFile')
assert.equal(merged.json.settings.junk, false, 'concurrent save kept junk')

// 18) 目录默认不参与自动整理（避免把项目文件夹套错层）
await write('dirA/inner.txt', 'x')
const dirMove = await tool.execute({ moves: [{ from: 'dirA', to: '16_新项目' }] }, { agent })
assert.equal(dirMove.moved.length, 0)
assert.match(dirMove.failed[0].error, /目录/)
assert.equal(await exists('dirA/inner.txt'), true, 'directory untouched')
const dirDiscard = await tool.execute({ discard: ['dirA'] }, { agent })
assert.equal(dirDiscard.discarded.length, 0)
assert.equal(await exists('dirA/inner.txt'), true, 'directory cannot be discarded either')
await fs.rm(path.join(root, 'dirA'), { recursive: true, force: true })

// 19) 「立即整理」端点
await write('leftover.md', 'x')
const run1 = await callRoute(RUN, 'POST', {})
assert.equal(run1.status, 200)
assert.equal(run1.json.queued, true, 'run queued a tidy turn')
assert.ok(followups.length >= 3, 'run produced a followup')
const beforeRun2 = followups.length
await tool.execute({
  moves: [
    { from: 'leftover.md', to: '10_杂项' },
    { from: 'maybe.md', to: '10_杂项' },
    { from: 'after_off.md', to: '10_杂项' },
    { from: 'after_on.md', to: '10_杂项' },
  ],
}, { agent })
// 关闭期间产生的临时文件不会被后续「新文件」规则回收，测试里直接删掉
await fs.rm(path.join(root, 'after_off.tmp'), { force: true })
const run2 = await callRoute(RUN, 'POST', {})
assert.equal(run2.status, 200)
assert.equal(run2.json.queued, false, 'nothing to tidy after the move')
assert.equal(followups.length, beforeRun2, 'no extra followup when clean')
// 非 POST / 非 JSON 被拒
const runGet = await callRoute(RUN, 'GET', undefined)
assert.equal(runGet.status, 405)
const runBadType = await callRoute(RUN, 'POST', {}, 'text/plain')
assert.equal(runBadType.status, 415)

await fs.rm(tmp, { recursive: true, force: true })
console.log(`workspace-tidy v3 integration: OK (${logs.length} log lines)`)

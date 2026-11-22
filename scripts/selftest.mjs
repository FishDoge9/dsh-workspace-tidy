/**
 * 单元自测 v2：直接测 organize.js 的原语（扫描、清理、存量、移动、撤销）。
 * 用法：node scripts/selftest.mjs [--undo]
 */
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  applyMoves,
  collectTurn,
  ensureBaseline,
  isJunkFile,
  isProtected,
  isSafeRoot,
  normalizeRel,
  withDefaults,
  writeUndoScript,
} from '../organize.js'

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-tidy-unit-'))
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
await write('工作区导航.md', '# 导航\n\n## 09_高中学习 — 高中各科复习资料\n')
await write('legacy.md', 'old')
await write('old.log', 'pre-existing junk')
await write('__pycache__/m.pyc', 'cache')

const config = { backlog: true }

// 1) 纯函数
assert.equal(normalizeRel('.\\a\\b/'), 'a/b')
assert.equal(isJunkFile('a.tmp'), true)
assert.equal(isJunkFile('笔记.md'), false)
assert.equal(isSafeRoot('C:\\'), false)
assert.equal(isSafeRoot(os.homedir()), false)
assert.equal(isProtected('.env', withDefaults({})), true)
assert.equal(isProtected('撤销整理.ps1', withDefaults({})), true)
assert.equal(isProtected('六年级试卷.docx', withDefaults({})), false)

// 2) 基线：只记录，不动文件
const baseline = await ensureBaseline({ root, config })
assert.equal(baseline.baseline, true)
assert.equal(await exists('legacy.md'), true)
assert.equal(await exists('00_索引/自动索引.md'), true)
assert.equal(await exists('.workspace-tidy/state.json'), true)

// 3) 第一次 collectTurn：清理缓存 + 给出存量清单（不改动历史文件）
const first = await collectTurn({ root, config })
assert.equal(await exists('__pycache__'), false, 'cache dir recycled')
assert.equal(await exists('old.log'), true, 'pre-existing junk stays until it changes')
assert.deepEqual(first.leftovers, [], 'no new files at root yet')
assert.ok(first.backlog.some((line) => line.startsWith('legacy.md')), 'backlog lists the historical loose file')
assert.ok(first.backlog.some((line) => line.startsWith('__pycache__')) === false, 'backlog skips what was recycled')

// 4) 新文件出现 → 进 leftovers，但插件不自己搬
await write('高二物理复习.md', '# 复习')
await write('noise.tmp', 'tmp')
const second = await collectTurn({ root, config })
assert.equal(second.leftovers.length, 1, 'only the real new file is listed')
assert.match(second.leftovers[0], /^高二物理复习\.md \(\d+ B\)$/)
assert.equal(await exists('高二物理复习.md'), true, 'collectTurn never moves project files')
assert.equal(await exists('noise.tmp'), false, 'new junk recycled')

// 5) applyMoves：移动 + 记录 + 撤销脚本
const moved = await applyMoves({
  root,
  config,
  moves: [
    { from: '高二物理复习.md', to: '09_高中学习' },
    { from: 'legacy.md', to: '10_杂项' },
  ],
  discard: ['old.log'],
})
assert.equal(moved.moved.length, 2)
assert.equal(moved.discarded.length, 1)
assert.equal(await exists('09_高中学习/高二物理复习.md'), true)
assert.equal(await exists('10_杂项/legacy.md'), true)
assert.equal(await exists('old.log'), false, 'discarded file left the root')
assert.equal(await exists('00_索引/_自动整理/回收站/' + day() + '/废弃/old.log'), true, 'discarded file is in the recycle bin')
assert.equal(await exists('撤销自动整理.ps1'), true)

// 6) 归档后快照更新：再 collectTurn 不应把已归档文件当新文件
const third = await collectTurn({ root, config })
assert.deepEqual(third.leftovers, [], 'moved files are not leftovers anymore')

// 7) 越界与受保护
const bad = await applyMoves({
  root,
  config,
  moves: [
    { from: '../../etc/passwd', to: '10_杂项' },
    { from: '工作区导航.md', to: '10_杂项' },
    { from: '00_索引/自动索引.md', to: '10_杂项' },
  ],
})
assert.equal(bad.moved.length, 0)
assert.equal(bad.failed.length, 3)

// 9) 目录移动语义（必须显式打开 moveDirectories）
await write('dirB/inner.txt', 'x')
const dirConfig = { ...config, moveDirectories: true }
const renamed = await applyMoves({ root, config: dirConfig, moves: [{ from: 'dirB', to: '16_新项目' }] })
assert.equal(renamed.moved.length, 1)
assert.equal(await exists('16_新项目/inner.txt'), true, 'directory renamed in place')
assert.equal(await exists('16_新项目/dirB'), false, 'no double nesting')
await applyMoves({ root, config: dirConfig, moves: [{ from: '16_新项目', to: '09_高中学习' }] })
assert.equal(await exists('09_高中学习/16_新项目/inner.txt'), true, 'existing folder keeps nesting semantics')

// 10) 默认配置拒绝目录（文件移动照常）
const deniedDir = await applyMoves({ root, config, moves: [{ from: '09_高中学习/16_新项目', to: '10_杂项' }] })
assert.equal(deniedDir.moved.length, 0)
assert.match(deniedDir.failed[0].error, /目录/)

// 8) 撤销脚本可执行（--undo）
if (process.argv.includes('--undo')) {
  await writeUndoScript(root, withDefaults(config))
  const { execFileSync } = await import('node:child_process')
  const shell = process.platform === 'win32' ? 'powershell' : 'pwsh'
  execFileSync(shell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, '撤销自动整理.ps1')], {
    cwd: root,
    stdio: 'inherit',
  })
  assert.equal(await exists('高二物理复习.md'), true, 'undo restored the note')
  assert.equal(await exists('legacy.md'), true, 'undo restored the legacy file')
  assert.equal(await exists('old.log'), true, 'undo restored the discarded file')
  assert.equal(await exists('09_高中学习/高二物理复习.md'), false)
}

await fs.rm(tmp, { recursive: true, force: true })
console.log('workspace-tidy v2 unit: OK')

function day() {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

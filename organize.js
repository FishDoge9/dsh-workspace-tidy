/**
 * dsh-workspace-tidy v2 — 工作区自动整理。
 *
 * 规则只做「确定安全」的事：回收临时文件与缓存目录、删被搬空的目录、记录快照并算出待归位清单。
 * **归位交给 AI**：每回合结束时把清单交给模型，由它按项目判断后调用 tidy_workspace 移动。
 *
 * 为什么不再按关键词搬：同一个项目的产物会被拆散（build_x.py 进 10_杂项、x.docx 进 09），
 * 重名还会产生 `(2)` 副本。归属判断需要理解「这批东西是一个项目」，规则做不到。
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { DEFAULT_RULES } from './settings.js'

const STATE_VERSION = 1
const JOURNAL_LIMIT = 800
const PROMPT_ITEM_MAX = 40

/** 临时文件后缀（小写，含点）。 */
const JUNK_EXT = new Set(['.tmp', '.temp', '.log', '.bak', '.orig', '.rej', '.swp', '.swo', '.pyc', '.pyo', '.part', '.crdownload'])
/** 临时文件名（小写）。 */
const JUNK_NAMES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini', '.directory', 'nul', 'npm-debug.log', 'yarn-error.log'])

/** 默认配置；`cordis.patch.yml` 里同名的键会整体覆盖（数组不合并）。 */
export const DEFAULTS = {
  enabled: true,
  /** root：只在主会话回合结束时整理；all：子代理也整理。 */
  scope: 'root',
  /** 让 AI 判断归属并调用 tidy_workspace。关掉就只清理 + 写待整理清单。 */
  aiTidy: true,
  /** 第一次整理时把根目录的历史遗留一起交给 AI（直到清干净为止，有次数上限）。 */
  backlog: true,
  /** 同一会话两次自动整理的最小间隔（毫秒）。 */
  cooldownMs: 5000,
  /** 自动整理连续没有进展时，最多尝试几次后改为只写清单。 */
  maxAttempts: 3,
  /** 清理临时文件。 */
  junk: true,
  /** 这些目录名连同内容一起移进回收站。 */
  junkDirs: ['__pycache__', '.pytest_cache', '.mypy_cache', '.ipynb_checkpoints', '.ruff_cache', '.tox'],
  /** 归位后删掉因此变空的目录。 */
  removeEmptyDirs: true,
  /** 扫描深度：0 = 根目录，2 = 根目录下两层。 */
  maxDepth: 2,
  /** 单次扫描文件上限。 */
  maxFiles: 5000,
  /** 单次整理超时（毫秒）。 */
  timeoutMs: 20000,
  /** 扫描时整体跳过的目录名。 */
  ignoreDirs: [
    'node_modules', '.git', '.hg', '.svn', '.dsh', '.dsh-plugins', '.workspace-tidy',
    '_自动整理', 'dist', 'build', 'out', '.next', '.cache', '.venv', 'venv', '.idea', '.vscode',
  ],
  /** 永不移动的文件名（大小写不敏感）。 */
  protectedNames: [
    'package.json', 'package-lock.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'yarn.lock',
    'tsconfig.json', 'jsconfig.json', 'readme.md', 'agents.md', 'claude.md', 'license',
    'makefile', 'dockerfile', 'docker-compose.yml', '.gitignore', '.gitattributes', '.npmrc',
    '.env', '.editorconfig', 'requirements.txt', 'pyproject.toml', 'cargo.toml', 'go.mod',
  ],
  /** 文件名前缀命中即跳过（保护整理记录、撤销脚本、导航）。 */
  protectedPrefixes: ['撤销', '工作区导航', '自动整理'],
  /** 记录目录：优先用已存在的 `00_索引`，否则放到状态目录里。 */
  indexDirName: '00_索引',
  /** 状态与日志目录（工作区根目录下）。 */
  stateDirName: '.workspace-tidy',
  /** 项目地图：从这个文件读 `## 名字 — 描述`，用来告诉 AI 每个文件夹是干什么的。 */
  mapFile: '工作区导航.md',
  dailyLog: true,
  autoIndex: true,
  undoScript: true,
  undoScriptName: '撤销自动整理.ps1',
  /** 给模型的工作区约定提示（常驻 system prompt）。 */
  prompt: true,
  promptText: [
    '## 工作区整理约定（dsh-workspace-tidy）',
    '- 本工作区按项目分文件夹：根目录只留导航与撤销脚本，产物放进 `NN_名称/`；起新项目就新建 `NN_名称/`。',
    '- 每回合结束时，插件会列出本回合留在根目录的东西，让你调用 `tidy_workspace` 按项目归位；临时文件与缓存目录由插件自动回收。',
    '- 归位原则：同一批产物进同一个项目文件夹；生成脚本跟随它的产物；拿不准就留在原地并说明。',
    '- 整理去向见 `<索引目录>/自动整理记录-YYYY-MM-DD.md`，撤销用根目录的 `撤销自动整理.ps1`。找不到刚生成的文件时先查记录，不要重复生成。',
  ].join('\n'),
}

/** 合并用户配置：同名键整体覆盖（数组不合并）。 */
export function withDefaults(raw) {
  const incoming = raw && typeof raw === 'object' ? raw : {}
  const cfg = { ...DEFAULTS, ...incoming }
  cfg.ignoreDirs = (cfg.ignoreDirs ?? []).map((v) => String(v))
  cfg.protectedNames = (cfg.protectedNames ?? []).map((v) => String(v).toLowerCase())
  cfg.protectedPrefixes = (cfg.protectedPrefixes ?? []).map((v) => String(v))
  cfg.junkDirs = (cfg.junkDirs ?? []).map((v) => String(v))
  for (const key of ['maxDepth', 'maxFiles', 'timeoutMs', 'cooldownMs', 'maxAttempts']) {
    const n = Number(cfg[key])
    cfg[key] = Number.isFinite(n) && n >= 0 ? n : DEFAULTS[key]
  }
  return cfg
}

/* ------------------------------------------------------------------ paths */

const toAbs = (root, rel) => path.join(root, ...String(rel).split('/'))
const toRel = (root, abs) => path.relative(root, abs).split(path.sep).join('/')

async function exists(target) {
  try {
    await fs.stat(target)
    return true
  } catch {
    return false
  }
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch {
    return fallback
  }
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

const pad = (n) => String(n).padStart(2, '0')
const isoDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const isoMinute = (d) => `${isoDay(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`

/** 相对路径归一化：反斜杠转正斜杠，去掉 ./ 与首尾斜杠。 */
export function normalizeRel(input) {
  return String(input ?? '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
}

const isInside = (root, abs) => {
  const rel = path.relative(root, abs)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/* ------------------------------------------------------------ safety gate */

/** 拒绝把盘符根目录、用户主目录当成工作区整理。 */
export function isSafeRoot(root) {
  if (typeof root !== 'string' || root.trim() === '') return false
  const resolved = path.resolve(root)
  if (path.parse(resolved).root === resolved) return false
  if (resolved === path.resolve(os.homedir())) return false
  if (resolved === path.resolve(path.sep, 'Windows')) return false
  return true
}

const isIgnoredDir = (name, cfg) => name.startsWith('.') || cfg.ignoreDirs.some((d) => d.toLowerCase() === name.toLowerCase())

/** 文件名看起来像临时文件。 */
export function isJunkFile(name) {
  const lower = name.toLowerCase()
  if (JUNK_NAMES.has(lower)) return true
  if (lower.endsWith('~')) return true
  if (lower.startsWith('.~lock.')) return true
  if (/^(npm-debug|yarn-error|pnpm-debug)\.log/.test(lower)) return true
  return JUNK_EXT.has(path.extname(lower))
}

/** 不可移动的名字：记录目录、受保护文件、点文件、撤销/导航/整理记录。 */
export function isProtected(name, cfg) {
  if (name.startsWith('.')) return true
  if (name === cfg.indexDirName) return true
  if (cfg.protectedNames.includes(name.toLowerCase())) return true
  return cfg.protectedPrefixes.some((prefix) => name.startsWith(prefix))
}

/* ------------------------------------------------------------------- scan */

/**
 * 扫描工作区。
 * @returns {{ files: Map<string, {size: number, mtimeMs: number}>, dirs: Set<string>, junkDirs: string[], truncated: boolean }}
 */
export async function scanRoot(root, cfg) {
  const files = new Map()
  const dirs = new Set()
  const junkDirs = []
  let truncated = false

  const walk = async (dir, rel, depth) => {
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (files.size >= cfg.maxFiles) {
        truncated = true
        return
      }
      const childRel = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (cfg.junkDirs.includes(entry.name)) {
          junkDirs.push(childRel)
          continue
        }
        if (isIgnoredDir(entry.name, cfg)) continue
        dirs.add(childRel)
        if (depth < cfg.maxDepth) await walk(path.join(dir, entry.name), childRel, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      try {
        const st = await fs.stat(path.join(dir, entry.name))
        files.set(childRel, { size: st.size, mtimeMs: Math.floor(st.mtimeMs) })
      } catch {
        // 读不到就当作不存在
      }
    }
  }

  await walk(root, '', 0)
  return { files, dirs, junkDirs, truncated }
}

function diffFiles(prev, current) {
  const changed = []
  for (const [rel, info] of current) {
    const before = prev[rel]
    if (!before || before.size !== info.size || before.mtimeMs !== info.mtimeMs) changed.push(rel)
  }
  changed.sort()
  return changed
}

/* ------------------------------------------------------------- state I/O */

const stateFile = (root, cfg) => path.join(root, cfg.stateDirName, 'state.json')
const journalFile = (root, cfg) => path.join(root, cfg.stateDirName, 'journal.json')

async function readState(root, cfg) {
  const state = await readJson(stateFile(root, cfg), null)
  if (!state || state.version !== STATE_VERSION || typeof state.files !== 'object') return null
  return state
}

async function writeState(root, cfg, snapshot, extra) {
  await writeJson(stateFile(root, cfg), { version: STATE_VERSION, root, ...snapshot, ...extra })
}

async function readJournal(root, cfg) {
  const journal = await readJson(journalFile(root, cfg), null)
  if (!journal || !Array.isArray(journal.entries)) return { version: STATE_VERSION, entries: [] }
  return journal
}

async function appendJournal(root, cfg, entries) {
  if (entries.length === 0) return
  const journal = await readJournal(root, cfg)
  journal.entries.push(...entries)
  if (journal.entries.length > JOURNAL_LIMIT) journal.entries = journal.entries.slice(-JOURNAL_LIMIT)
  await writeJson(journalFile(root, cfg), journal)
}

/* ------------------------------------------------------------- file moves */

function suffixed(name, index) {
  const ext = path.extname(name)
  const base = ext ? name.slice(0, -ext.length) : name
  return `${base} (${index})${ext}`
}

async function movePath(source, destination) {
  try {
    await fs.rename(source, destination)
  } catch (error) {
    if (error?.code !== 'EXDEV' && error?.code !== 'EPERM' && error?.code !== 'EACCES') throw error
    const st = await fs.stat(source)
    if (st.isDirectory()) {
      await fs.cp(source, destination, { recursive: true })
      await fs.rm(source, { recursive: true, force: true })
    } else {
      await fs.copyFile(source, destination)
      await fs.unlink(source)
    }
  }
}

async function freeName(dirAbs, name) {
  let candidate = path.join(dirAbs, name)
  for (let i = 2; i < 200; i++) {
    if (!(await exists(candidate))) return candidate
    candidate = path.join(dirAbs, suffixed(name, i))
  }
  return path.join(dirAbs, `${Date.now()}-${name}`)
}

/** 同内容判断：大小一致且（< 8MB 时）逐字节一致。 */
async function sameContent(a, b) {
  try {
    const [sa, sb] = await Promise.all([fs.stat(a), fs.stat(b)])
    if (!sa.isFile() || !sb.isFile() || sa.size !== sb.size) return false
    if (sa.size > 8 * 1024 * 1024) return false
    const [ba, bb] = await Promise.all([fs.readFile(a), fs.readFile(b)])
    return ba.equals(bb)
  } catch {
    return false
  }
}

/** 删掉被搬空的目录（只处理被搬空的父链）。 */
async function pruneEmptyParents(root, rels) {
  const removed = []
  const seen = new Set()
  for (const rel of rels) {
    let dir = path.posix.dirname(rel)
    while (dir && dir !== '.' && dir !== '/' && !seen.has(dir)) {
      seen.add(dir)
      const abs = toAbs(root, dir)
      let entries
      try {
        entries = await fs.readdir(abs)
      } catch {
        break
      }
      if (entries.length > 0) break
      try {
        await fs.rmdir(abs)
        removed.push(dir)
      } catch {
        break
      }
      dir = path.posix.dirname(dir)
    }
  }
  return removed
}

/* --------------------------------------------------------------- records */

/** 记录目录：优先用已存在的 `00_索引`，否则落到状态目录里。 */
export async function recordsDir(root, cfg) {
  const preferred = path.join(root, cfg.indexDirName)
  if (await exists(preferred)) return { dir: preferred, name: cfg.indexDirName }
  return { dir: path.join(root, cfg.stateDirName, 'records'), name: cfg.stateDirName }
}

async function appendDailyLog(target, day, time, lines) {
  const file = path.join(target.dir, `自动整理记录-${day}.md`)
  const header = (await exists(file))
    ? ''
    : `<!-- 由 dsh-workspace-tidy 自动写入，可手改但不要删标题 -->\n# 自动整理记录 ${day}\n\n`
  const body = [`## ${time}`, ...lines.map((line) => `- ${line}`), ''].join('\n')
  await fs.mkdir(target.dir, { recursive: true })
  await fs.appendFile(file, `${header}${body}\n`, 'utf8')
  return file
}

/** 生成/刷新目录索引。 */
export async function writeAutoIndex(root, cfg) {
  const target = await recordsDir(root, cfg)
  const { files, dirs } = await scanRoot(root, { ...cfg, maxDepth: 3, maxFiles: cfg.maxFiles * 2 })
  const stats = new Map()
  for (const rel of files.keys()) {
    const top = rel.includes('/') ? rel.split('/')[0] : '.'
    const bucket = stats.get(top) ?? { files: 0, latest: 0 }
    bucket.files += 1
    bucket.latest = Math.max(bucket.latest, files.get(rel).mtimeMs)
    stats.set(top, bucket)
  }
  for (const dir of dirs) {
    if (!dir.includes('/') && !stats.has(dir)) stats.set(dir, { files: 0, latest: 0 })
  }
  const rows = [...stats.entries()]
    .sort((a, b) => (a[0] === '.' ? 1 : b[0] === '.' ? -1 : a[0].localeCompare(b[0])))
    .slice(0, 60)
    .map(([name, s]) => `| \`${name}${name === '.' ? '' : '/'}\` | ${s.files} | ${s.latest ? isoMinute(new Date(s.latest)) : '—'} |`)

  const rootFiles = [...files.keys()].filter((rel) => !rel.includes('/'))
  const text = [
    '<!-- 由 dsh-workspace-tidy 自动生成，请勿手改 -->',
    '# 工作区自动索引',
    '',
    `更新时间：${isoMinute(new Date())} ｜ 根目录：\`${root}\``,
    '',
    '| 位置 | 文件数 | 最近修改 |',
    '| --- | --- | --- |',
    ...rows,
    '',
    `根目录散落文件：${rootFiles.length} 个`,
    '',
  ].join('\n')
  await fs.mkdir(target.dir, { recursive: true })
  await fs.writeFile(path.join(target.dir, '自动索引.md'), text, 'utf8')
  return path.join(target.dir, '自动索引.md')
}

/** 用日志重写撤销脚本（倒序还原，只还原文件与目录）。 */
export async function writeUndoScript(root, cfg) {
  const journal = await readJournal(root, cfg)
  const moves = journal.entries.filter((entry) => entry.kind === 'move').reverse()
  const quote = (value) => `'${String(value).replace(/'/g, "''")}'`
  const lines = [
    '# Generated by dsh-workspace-tidy: move auto-filed items back where they were.',
    `# Generated at: ${isoMinute(new Date())}`,
    '# Run from the workspace root:  powershell -ExecutionPolicy Bypass -File 撤销自动整理.ps1',
    '$ErrorActionPreference = "Stop"',
    `$root = ${quote(path.resolve(root))}`,
    '',
    '$moves = @(',
    ...moves.map((entry) => `  @{ from = ${quote(entry.to)}; to = ${quote(entry.from)} }`),
    ')',
    '',
    '$restored = 0',
    'foreach ($m in $moves) {',
    '  $src = Join-Path $root $m.from',
    '  $dst = Join-Path $root $m.to',
    '  if ((Test-Path -LiteralPath $src) -and -not (Test-Path -LiteralPath $dst)) {',
    '    $parent = Split-Path -Parent $dst',
    '    if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }',
    '    Move-Item -LiteralPath $src -Destination $dst',
    '    $restored++',
    '  }',
    '}',
    'Write-Host ("Restored {0} of {1} recorded moves." -f $restored, $moves.Count)',
    '',
  ]
  const file = path.join(root, cfg.undoScriptName)
  await fs.writeFile(file, `\uFEFF${lines.join('\n')}`, 'utf8')
  return { file, count: moves.length }
}

/* -------------------------------------------------------------- inventory */

/** 读项目地图（`## 名字 — 描述` 标题），用磁盘上已有的目录补全。 */
export async function readFolderMap(root, cfg, dirs) {
  const entries = new Map()
  try {
    const text = await fs.readFile(path.join(root, cfg.mapFile), 'utf8')
    for (const line of text.split(/\r?\n/)) {
      const heading = /^##\s+([^\s—–]+)\s*[—–-]+\s*(.+)$/.exec(line)
      if (!heading) continue
      const name = normalizeRel(heading[1])
      if (!name || entries.has(name)) continue
      entries.set(name, heading[2].trim())
    }
  } catch {
    // 没有导航文件就只用目录名
  }
  for (const dir of [...(dirs ?? [])].filter((d) => !d.includes('/')).sort()) {
    if (!entries.has(dir)) entries.set(dir, '')
  }
  return entries
}

const describeSize = (bytes) => {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} B`
}

/** 根目录条目的可读清单（跳过受保护条目；可选跳过已是项目的 `NN_` 目录）。 */
const listEntries = (files, dirs, info, cfg, { skipProjectDirs = false } = {}) => {
  const items = []
  for (const rel of files) {
    if (rel.includes('/')) continue
    if (isProtected(path.posix.basename(rel), cfg)) continue
    const meta = info?.get(rel)
    items.push(`${rel}${meta ? ` (${describeSize(meta.size)})` : ''}`)
  }
  for (const rel of dirs) {
    if (rel.includes('/')) continue
    if (isProtected(rel, cfg)) continue
    if (skipProjectDirs && /^\d{2}_/.test(rel)) continue
    items.push(`${rel}/ (目录)`)
  }
  return items
}

/**
 * 回合结束时的扫描与安全清理，并算出待归位清单。
 * @returns {Promise<{ leftovers: string[], backlog: string[], trashed: string[], removedDirs: string[], scanned: number }>}
 */
export async function collectTurn({ root, config, now = new Date(), logger, snapshotOnly = false, sessionId }) {
  const cfg = withDefaults(config)
  if (!cfg.enabled) return { skipped: 'disabled' }
  if (!isSafeRoot(root)) return { skipped: 'unsafe-root' }

  const records = await recordsDir(root, cfg)
  const state = await readState(root, cfg)
  const { files, dirs, junkDirs, truncated } = await scanRoot(root, cfg)
  const owners = state?.owners && typeof state.owners === 'object' ? state.owners : {}

  // 关闭自动整理时只刷新快照：再次打开时不会把这段时间的变化全当成「待归位」
  if (snapshotOnly) {
    await writeState(root, cfg, { files: Object.fromEntries(files), dirs: [...dirs], owners }, {
      baselineAt: state?.baselineAt ?? now.getTime(),
      lastTidyAt: now.getTime(),
      backlogDone: state?.backlogDone ?? false,
    })
    return { skipped: 'snapshot-only', scanned: files.size }
  }

  const changed = diffFiles(state?.files ?? {}, files)
  const includeBacklog = Boolean(cfg.backlog) && !state?.backlogDone

  const changedRootFiles = changed.filter((rel) => !rel.includes('/'))
  // 产物归属：别的对话产生、还没归位的文件，不归这次整理管
  const ownedBy = (rel) => owners[rel]
  const ownedByOther = (rel) => Boolean(owners[rel]) && owners[rel] !== sessionId
  // 目录默认不参与自动整理：项目文件夹的改名/归位是人的决定，AI 搬目录很容易套错层
  const includeDirs = cfg.moveDirectories === true
  const changedRootDirs = includeDirs && state?.dirs
    ? [...dirs].filter((rel) => !rel.includes('/') && !/^\d{2}_/.test(rel) && !(state.dirs ?? []).includes(rel))
    : []

  const junkFiles = changedRootFiles.filter((rel) => isJunkFile(path.posix.basename(rel)))
  const trashRoot = `${records.name}/_自动整理/回收站/${isoDay(now)}`
  const trashed = []
  const journal = []

  if (cfg.junk) {
    for (const rel of junkFiles) {
      try {
        const destDirAbs = toAbs(root, `${trashRoot}/文件`)
        await fs.mkdir(destDirAbs, { recursive: true })
        const target = await freeName(destDirAbs, path.posix.basename(rel))
        await movePath(toAbs(root, rel), target)
        trashed.push(toRel(root, target))
        journal.push({ at: now.getTime(), kind: 'move', from: rel, to: toRel(root, target) })
      } catch (error) {
        logger?.warn?.(`workspace-tidy: 回收 ${rel} 失败：${error?.message ?? error}`)
      }
    }
    for (const rel of junkDirs) {
      try {
        const destDirAbs = toAbs(root, `${trashRoot}/目录`)
        await fs.mkdir(destDirAbs, { recursive: true })
        const target = await freeName(destDirAbs, path.posix.basename(rel))
        await movePath(toAbs(root, rel), target)
        trashed.push(toRel(root, target))
        journal.push({ at: now.getTime(), kind: 'move', from: rel, to: toRel(root, target) })
      } catch (error) {
        logger?.warn?.(`workspace-tidy: 回收 ${rel} 失败：${error?.message ?? error}`)
      }
    }
  }

  const removedDirs = cfg.removeEmptyDirs ? await pruneEmptyParents(root, journal.map((entry) => entry.from)) : []
  await appendJournal(root, cfg, journal)

  const leftoverFiles = changedRootFiles.filter((rel) => !junkFiles.includes(rel) && !ownedByOther(rel))
  const leftovers = listEntries(leftoverFiles, changedRootDirs, files, cfg)
  const backlog = includeBacklog
    ? listEntries([...files.keys()], includeDirs ? [...dirs] : [], files, cfg, { skipProjectDirs: true })
        .filter((line) => !leftovers.includes(line))
    : []

  // 归属表：保留已有归属，新出现的根文件归本次会话，消失的清掉
  const nextOwners = {}
  for (const rel of files.keys()) {
    if (rel.includes('/')) continue
    const owner = owners[rel]
    if (owner) nextOwners[rel] = owner
    else if (sessionId) nextOwners[rel] = String(sessionId)
  }

  await writeState(root, cfg, { files: Object.fromEntries(files), dirs: [...dirs], owners: nextOwners }, {
    baselineAt: state?.baselineAt ?? now.getTime(),
    lastTidyAt: now.getTime(),
    backlogDone: (state?.backlogDone ?? false) || (includeBacklog && backlog.length === 0),
  })

  if (cfg.autoIndex && (leftovers.length > 0 || trashed.length > 0)) {
    try {
      await writeAutoIndex(root, cfg)
    } catch (error) {
      logger?.warn?.(`workspace-tidy: 写索引失败：${error?.message ?? error}`)
    }
  }
  if (cfg.dailyLog && trashed.length > 0) {
    await appendDailyLog(records, isoDay(now), isoMinute(now), [
      `清理 ${trashed.length} 项临时文件/缓存 → \`${trashRoot}\``,
    ])
  }

  return {
    leftovers: leftovers.slice(0, 200),
    backlog: backlog.slice(0, 200),
    leftoverPaths: leftoverFiles.filter((rel) => !isProtected(path.posix.basename(rel), cfg)).slice(0, 200),
    dirs: [...dirs].slice(0, 500),
    trashed,
    removedDirs,
    scanned: files.size,
    truncated,
  }
}

/** 记录「其他对话的产物去了哪」：追加一行到 00_索引/对话产物.md。 */
export async function appendSessionRecord({ root, config, title, sessionId, files, dir, now = new Date() }) {
  if (!Array.isArray(files) || files.length === 0) return undefined
  const cfg = withDefaults(config)
  const target = await recordsDir(root, cfg)
  const file = path.join(target.dir, '对话产物.md')
  const header = (await exists(file))
    ? ''
    : '<!-- 由 dsh-workspace-tidy 自动写入：其他对话的产物去向 -->\n# 对话产物去向\n\n| 时间 | 对话 | 文件 | 去向 |\n| --- | --- | --- | --- |\n'
  const cell = (value) => String(value).replace(/\|/g, '\\|')
  const stamp = isoMinute(now)
  const rows = files
    .slice(0, 80)
    .map((rel) => `| ${stamp} | ${cell(title)}（${String(sessionId).slice(0, 8)}） | \`${cell(rel)}\` | \`${cell(dir)}/\` |`)
  await fs.mkdir(target.dir, { recursive: true })
  await fs.appendFile(file, `${header}${rows.join('\n')}\n`, 'utf8')
  return file
}

/* ----------------------------------------------------------------- prompt */

/** 组装交给 AI 的整理指令；规则来自设置页（缺省用 DEFAULT_RULES）。 */
export function buildTidyPrompt({ inventory, folderMap, rules, undoScriptName }) {
  const folders = [...(folderMap?.entries?.() ?? [])]
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
    .filter(([name]) => !String(name).startsWith('.'))
    .slice(0, 40)
    .map(([name, desc]) => (desc ? `- \`${name}/\` — ${desc}` : `- \`${name}/\``))

  const ruleList = (Array.isArray(rules) ? rules : []).map((rule) => String(rule).trim()).filter(Boolean)
  const effectiveRules = ruleList.length > 0 ? ruleList : DEFAULT_RULES

  const renderItems = (items) => {
    if (!items || items.length === 0) return ['（无）']
    const head = items.slice(0, PROMPT_ITEM_MAX)
    const rest = items.length - head.length
    return [...head.map((item) => `- ${item}`), ...(rest > 0 ? [`- …还有 ${rest} 项`] : [])]
  }

  return [
    '【自动整理】',
    '<workspace_tidy>',
    '上个回合结束后，工作区根目录留下了下面这些没归位的东西。请用 `tidy_workspace` 工具把它们放进合适的项目文件夹。',
    '',
    '## 待归位（本回合新产生的）',
    ...renderItems(inventory?.leftovers),
    ...(inventory?.backlog?.length > 0
      ? ['', '## 存量遗留（历史堆积，这次一并处理）', ...renderItems(inventory.backlog)]
      : []),
    '',
    '## 现有项目文件夹',
    ...(folders.length > 0 ? folders : ['（暂无）']),
    '',
    '## 怎么归位',
    ...effectiveRules.map((rule, index) => `${index + 1}. ${rule}`),
    '',
    `工具参数：\`moves: [{ from, to }]\`（都相对工作区根目录，\`to\` 是目标文件夹）；\`discard: [路径]\`。`,
    '只做移动：不要读文件内容、不要改文件内容、不要创建新文件。完成后用一句话汇报移动了几项、去了哪里、还有什么没处理。',
    '</workspace_tidy>',
  ].join('\n')
}

/** 只写清单不动手（AI 不可用或连续没进展时）。 */
export async function writePendingList({ root, config, inventory }) {
  const cfg = withDefaults(config)
  const target = await recordsDir(root, cfg)
  const lines = [
    '<!-- 由 dsh-workspace-tidy 生成：待整理清单，未移动任何文件 -->',
    '# 待整理',
    '',
    `生成时间：${isoMinute(new Date())}`,
    '',
  ]
  if (inventory?.leftovers?.length > 0) {
    lines.push('## 本回合新产生', '', ...inventory.leftovers.map((item) => `- ${item}`), '')
  }
  if (inventory?.backlog?.length > 0) {
    lines.push('## 存量遗留', '', ...inventory.backlog.map((item) => `- ${item}`), '')
  }
  await fs.mkdir(target.dir, { recursive: true })
  const file = path.join(target.dir, '待整理.md')
  await fs.writeFile(file, lines.join('\n'), 'utf8')
  return file
}

/* ------------------------------------------------------------------ apply */

/**
 * 执行移动计划（`tidy_workspace` 工具的实现）。
 * @returns {Promise<{ moved: object[], discarded: string[], failed: object[], removedDirs: string[], dryRun: boolean }>}
 */
export async function applyMoves({ root, config, moves = [], discard = [], dryRun = false, now = new Date(), logger }) {
  const cfg = withDefaults(config)
  if (!isSafeRoot(root)) throw new Error('工作区路径不合法')
  const moveList = Array.isArray(moves) ? moves : []
  const discardList = Array.isArray(discard) ? discard : []
  const records = await recordsDir(root, cfg)
  const trashRoot = `${records.name}/_自动整理/回收站/${isoDay(now)}`

  const moved = []
  const discarded = []
  const failed = []
  const journal = []
  const touched = []
  const blocked = new Set([cfg.stateDirName, '.dsh-plugins'])

  const assertUsable = (rel, label) => {
    const first = rel.split('/')[0]
    if (blocked.has(first)) throw new Error(`${label} 在受保护目录内`)
    if (first === cfg.indexDirName) throw new Error(`${label} 在记录目录内`)
    if (isProtected(path.posix.basename(rel), cfg)) throw new Error(`${label} 是受保护文件`)
  }

  for (const raw of moveList) {
    const from = normalizeRel(raw?.from)
    const to = normalizeRel(raw?.to)
    try {
      if (!from) throw new Error('from 为空')
      if (!to) throw new Error('to 为空')
      const srcAbs = toAbs(root, from)
      if (!isInside(root, srcAbs)) throw new Error('from 越出工作区')
      if (!(await exists(srcAbs))) throw new Error('源不存在')
      assertUsable(from, '源')
      const toAbsPath = toAbs(root, to)
      if (!isInside(root, toAbsPath) && path.resolve(toAbsPath) !== path.resolve(root)) throw new Error('to 越出工作区')
      if (blocked.has(to.split('/')[0])) throw new Error('目标在受保护目录内')
      if (to.split('/')[0] === cfg.indexDirName) throw new Error('目标不能放进记录目录')
      if (to === from || to.startsWith(`${from}/`)) throw new Error('不能移动到自身内部')
      if (dryRun) {
        // 预览要和真正执行一致：目录 + 不存在的 to = 改名，其余 = 放进该目录
        const stat = await fs.stat(srcAbs)
        const toExists = await exists(toAbsPath)
        const renameDir = stat.isDirectory() && !toExists
        moved.push({ from, to: renameDir ? to : `${to}/${path.posix.basename(from)}` })
        continue
      }
      const name = path.posix.basename(from)
      const sourceIsDir = (await fs.stat(srcAbs)).isDirectory()
      if (sourceIsDir && cfg.moveDirectories !== true) {
        throw new Error('目录不在自动整理范围内（只整理文件；需要搬目录请把配置 moveDirectories 打开）')
      }
      const toExisted = await exists(toAbsPath)
      // 目录 + 尚不存在的 to：把 to 当成新名字（改名），不要把旧目录名再套一层
      const renameDir = sourceIsDir && !toExisted
      const targetDirAbs = renameDir ? path.dirname(toAbsPath) : toAbsPath
      const finalName = renameDir ? path.basename(toAbsPath) : name
      await fs.mkdir(targetDirAbs, { recursive: true })
      const existing = path.join(targetDirAbs, finalName)
      if ((await exists(existing)) && (await sameContent(srcAbs, existing))) {
        const destDirAbs = toAbs(root, `${trashRoot}/重复`)
        await fs.mkdir(destDirAbs, { recursive: true })
        const target = await freeName(destDirAbs, finalName)
        await movePath(srcAbs, target)
        discarded.push(`${from}（与目标同内容）`)
        touched.push(from)
        journal.push({ at: now.getTime(), kind: 'move', from, to: toRel(root, target) })
        continue
      }
      const target = await freeName(targetDirAbs, finalName)
      await movePath(srcAbs, target)
      const rel = toRel(root, target)
      moved.push({ from, to: rel })
      touched.push(from)
      journal.push({ at: now.getTime(), kind: 'move', from, to: rel })
    } catch (error) {
      failed.push({ from, to, error: String(error?.message ?? error) })
    }
  }

  for (const raw of discardList) {
    const rel = normalizeRel(raw)
    try {
      if (!rel) continue
      const abs = toAbs(root, rel)
      if (!isInside(root, abs)) throw new Error('越出工作区')
      if (!(await exists(abs))) throw new Error('不存在')
      if ((await fs.stat(abs)).isDirectory() && cfg.moveDirectories !== true) {
        throw new Error('目录不在自动整理范围内（只整理文件；需要处理目录请把配置 moveDirectories 打开）')
      }
      assertUsable(rel, '路径')
      const destDirAbs = toAbs(root, `${trashRoot}/废弃`)
      await fs.mkdir(destDirAbs, { recursive: true })
      const target = await freeName(destDirAbs, path.posix.basename(rel))
      if (!dryRun) await movePath(abs, target)
      discarded.push(rel)
      touched.push(rel)
      journal.push({ at: now.getTime(), kind: 'move', from: rel, to: toRel(root, target) })
    } catch (error) {
      failed.push({ from: rel, to: '(回收站)', error: String(error?.message ?? error) })
    }
  }

  if (dryRun) return { moved, discarded, failed, removedDirs: [], dryRun: true }

  await appendJournal(root, cfg, journal)
  const removedDirs = cfg.removeEmptyDirs ? await pruneEmptyParents(root, touched) : []
  try {
    if (journal.length > 0 && cfg.undoScript) await writeUndoScript(root, cfg)
    if ((moved.length > 0 || discarded.length > 0) && cfg.autoIndex) await writeAutoIndex(root, cfg)
    if (journal.length > 0 && cfg.dailyLog) {
      const lines = []
      if (moved.length > 0) {
        const shown = moved.slice(0, 20).map((m) => `\`${m.from}\` → \`${m.to}\``).join('；')
        lines.push(`归档 ${moved.length} 项：${shown}${moved.length > 20 ? ` …共 ${moved.length} 项` : ''}`)
      }
      if (discarded.length > 0) lines.push(`回收 ${discarded.length} 项：${discarded.slice(0, 12).map((d) => `\`${d}\``).join('、')}`)
      if (removedDirs.length > 0) lines.push(`删除空目录：${removedDirs.map((d) => `\`${d}/\``).join('、')}`)
      lines.push(`撤销：运行 \`${cfg.undoScriptName}\``)
      await appendDailyLog(records, isoDay(now), isoMinute(now), lines)
    }
  } catch (error) {
    logger?.warn?.(`workspace-tidy: 写记录失败：${error?.message ?? error}`)
  }

  return { moved, discarded, failed, removedDirs, dryRun: false }
}

/** 建立基线：只记录快照，不移动任何文件。 */
export async function ensureBaseline({ root, config, now = new Date(), logger }) {
  const cfg = withDefaults(config)
  if (!cfg.enabled) return { skipped: 'disabled' }
  if (!isSafeRoot(root)) return { skipped: 'unsafe-root' }
  if (await readState(root, cfg)) return { skipped: 'already-baselined' }
  const { files, dirs, truncated } = await scanRoot(root, cfg)
  if (truncated) logger?.warn?.(`workspace-tidy: ${root} 超出扫描上限 ${cfg.maxFiles}，已截断`)
  await writeState(root, cfg, { files: Object.fromEntries(files), dirs: [...dirs] }, {
    baselineAt: now.getTime(),
    lastTidyAt: now.getTime(),
    backlogDone: false,
  })
  if (cfg.autoIndex) await writeAutoIndex(root, cfg)
  if (cfg.dailyLog) {
    const target = await recordsDir(root, cfg)
    await appendDailyLog(target, isoDay(now), isoMinute(now), [`建立基线：记录 ${files.size} 个文件`])
  }
  logger?.info?.(`workspace-tidy: 已为 ${root} 建立基线（${files.size} 个文件）`)
  return { baseline: true, scanned: files.size }
}

/** 给一次异步操作加超时上限。 */
export function withTimeout(promise, ms) {
  if (!ms || ms <= 0) return promise
  const timer = new Promise((resolve) => {
    const handle = setTimeout(() => resolve({ skipped: 'timeout' }), ms)
    if (typeof handle.unref === 'function') handle.unref()
  })
  return Promise.race([promise, timer])
}

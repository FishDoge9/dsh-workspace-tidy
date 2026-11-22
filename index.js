/**
 * dsh-workspace-tidy v3 — AI 回合结束后自动整理工作区，设置页可开关与改规则。
 *
 * 分工：
 *   插件（确定性） → 回收临时文件/缓存目录、记快照、算出「根目录里还没归位的东西」
 *   模型（判断）   → 判断这些东西属于哪个项目，调用 tidy_workspace 移动
 *
 * 设置页通过 HTTP 读写 <profile>/.dsh-workspace-tidy/settings.json，Host 每回合重新读取，
 * 所以开关与规则改完立即生效，不需要重启插件。
 */

import { randomUUID } from 'node:crypto'
import path from 'node:path'
import {
  appendSessionRecord,
  applyMoves,
  buildTidyPrompt,
  collectTurn,
  ensureBaseline,
  isSafeRoot,
  readFolderMap,
  withDefaults,
  withTimeout,
  writePendingList,
} from './organize.js'
import { defaultSettings, loadSettings, saveSettings, settingsFile } from './settings.js'

export const name = 'workspace-tidy'
export const inject = ['tools']

/** 设置页读写的 HTTP 端点。 */
const SETTINGS_PATH = '/workspace-tidy/settings'
/** 设置页「立即整理」的端点。 */
const RUN_PATH = '/workspace-tidy/run'

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function readBody(req, limit = 262144) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** 取会话工作区目录；取不到就不动任何文件。 */
function workspaceOf(agent) {
  try {
    const cwd = agent?.session?.header?.cwd
    if (typeof cwd === 'string' && cwd.trim() !== '' && isSafeRoot(cwd)) return path.resolve(cwd)
  } catch {
    // session/header 结构变化时安静跳过
  }
  return undefined
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 用对话的第一句用户消息当目录名；取不到就用短 id。 */
export function sessionFolderName(session) {
  const events = Array.isArray(session?.events) ? session.events : []
  for (const event of events) {
    if (event?.type !== 'user/message') continue
    const content = event?.data?.content
    const text = Array.isArray(content)
      ? content.find((block) => block?.type === 'text' && typeof block.text === 'string')?.text
      : undefined
    const clean = String(text || '')
      .replace(/[\\/:*?"<>|\r\n\t]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (clean) return clean.slice(0, 24)
  }
  const id = String(session?.header?.id ?? '')
  return id ? `对话-${id.slice(0, 8)}` : '未知对话'
}

/** 注册 tidy_workspace 工具：模型用它把文件/目录归位，带日志与撤销记录。 */
function registerTidyTool(ctx, config, store, log, hooks = {}) {
  const definition = {
    name: 'tidy_workspace',
    description: [
      '整理工作区：把根目录里散落的文件或目录移动到指定项目文件夹。',
      '文件：`to` 是目标文件夹，不存在会自动创建。',
      '目录：`to` 已存在则把目录放进去；不存在则把 `to` 当成新名字（改名，不会再套一层旧目录名）。',
      '每次移动都会写入整理记录和可撤销脚本（根目录 撤销自动整理.ps1）；同内容重名不会产生副本。',
      '只在当前工作区内操作，不会删除任何东西：discard 只是把文件移进回收站。',
    ].join(''),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['moves'],
      properties: {
        moves: {
          type: 'array',
          description: '移动清单，按顺序执行。',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['from', 'to'],
            properties: {
              from: { type: 'string', description: '现有路径，相对工作区根目录，可带子目录。' },
              to: { type: 'string', description: '目标文件夹，相对工作区根目录；不存在会自动创建。目标是目录本身时，不存在的 to 会被当成新名字（改名）。' },
            },
          },
        },
        discard: {
          type: 'array',
          description: '要丢进回收站的路径（相对工作区根目录）。文件不会被真正删除。',
          items: { type: 'string' },
        },
        dry_run: { type: 'boolean', description: '只校验不移动。' },
        claim_main: { type: 'boolean', description: '把当前对话设为「主对话」（它的产物按项目归位）。' },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(args, value) {
        const v = value && typeof value === 'object' ? value : {}
        if (v.claimed) return [{ type: 'text', text: `主对话已设为 ${String(v.claimed).slice(0, 14)}…（这个对话的产物按项目归位）` }]
        const count = (key) => (Array.isArray(v[key]) ? v[key].length : 0)
        const failed = count('failed')
        const head = v.dryRun ? '整理预演' : '整理完成'
        return [{
          type: 'text',
          text: `${head}：移动 ${count('moved')} 项，回收 ${count('discarded')} 项${failed > 0 ? `，失败 ${failed} 项` : ''}。`,
        }]
      },
    },
    timeoutMs: 120000,
    async execute(args, exec) {
      const root = workspaceOf(exec?.agent)
      if (!root) throw new Error('无法确定当前工作区目录')
      if (args?.claim_main === true) {
        const id = String(exec?.agent?.id ?? '')
        if (!id) throw new Error('拿不到当前会话 id')
        if (typeof hooks.claimMain !== 'function') throw new Error('主对话设置不可用')
        const saved = await hooks.claimMain(id)
        log.info?.(`workspace-tidy: 主对话改为 ${saved}`)
        return { moved: [], discarded: [], failed: [], removedDirs: [], dryRun: true, claimed: saved }
      }
      const result = await applyMoves({
        root,
        config: store.runtime(),
        moves: args?.moves,
        discard: args?.discard,
        dryRun: args?.dry_run === true,
        logger: log,
      })
      return { ...result, caller: String(exec?.agent?.id ?? '') }
    },
  }
  ctx.tools.register(definition)
}

/**
 * Cordis 插件入口。
 * @param ctx - 插件上下文
 * @param rawConfig - `cordis.patch.yml` 里该行的 config（作为设置页的初始值）
 */
export function apply(ctx, rawConfig) {
  const config = withDefaults(rawConfig)
  const log = ctx.logger ?? {}
  const defaults = defaultSettings(config)
  let settings = { ...defaults }

  const refreshSettings = async () => {
    try {
      settings = await loadSettings(defaults)
    } catch {
      // 读不到就继续用内存里的值
    }
    return settings
  }
  void refreshSettings()

  /** 当回合生效的配置：设置页覆盖 patch 初始值。 */
  const store = { runtime: () => ({ ...config, aiTidy: settings.autoFile, junk: settings.junk }) }

  // 总开关是设置页的 enabled；patch 里的 enabled 只是初始值。
  // 所以这里不提前退出：即使初始为关，也要先把设置端点注册好，否则用户没法再打开。
  log.info?.(`workspace-tidy: 设置文件 ${settingsFile()}`)

  /**
   * 主对话：它的产物按项目归位，其他对话的产物各进一个目录。
   * 首次启用（装插件的那次）把当前正在跑的会话记为主对话，之后不再自动改。
   */
  const adoptMainSession = async () => {
    await refreshSettings()
    if (settings.mainSessionId) return
    let candidate
    try {
      // 优先：正在驱动这一轮异步链的会话（= 装插件/改设置的对话）
      const agents = ctx.get('agents')
      const initiator = agents?.currentInitiator?.()
      if (initiator && workspaceOf(initiator)) candidate = initiator
      if (!candidate) {
        for (const agent of agents?.list?.() ?? []) {
          if (!workspaceOf(agent)) continue
          candidate = agent
          if (agent?.status === 'running') break
        }
      }
    } catch {
      candidate = undefined
    }
    if (!candidate) return
    try {
      settings = await saveSettings({ mainSessionId: String(candidate.id) }, defaults)
      log.info?.(`workspace-tidy: 主对话设为 ${candidate.id}`)
    } catch (error) {
      log.warn?.(`workspace-tidy: 记录主对话失败：${error?.message ?? error}`)
    }
  }
  void adoptMainSession()

  /** 「立即整理」端点的实现；队列与 pending 就绪后赋值。 */
  let runNow = async () => ({ ok: false, error: '插件尚未就绪，请稍后再试' })

  // 设置页的读写端点
  const webServer = ctx.get('webServer')
  if (webServer) {
    ctx.effect(() => {
      const disposers = []
      const guard = (handler) => async (req, res) => {
        try {
          if (req.method === 'POST') {
            const contentType = String(req.headers['content-type'] || '')
            if (!/^application\/json\b/i.test(contentType)) {
              sendJson(res, 415, { error: 'content-type 必须是 application/json' })
              return
            }
          }
          await handler(req, res)
        } catch (error) {
          sendJson(res, 400, { error: String(error?.message ?? error) })
        }
      }

      try {
        disposers.push(webServer.register({
          kind: 'exact',
          path: SETTINGS_PATH,
          handler: guard(async (req, res) => {
            if (req.method === 'GET') {
              await refreshSettings()
              sendJson(res, 200, { settings, defaults })
              return
            }
            if (req.method === 'POST') {
              const body = await readBody(req)
              const patch = body.trim() === '' ? {} : JSON.parse(body)
              settings = await saveSettings(patch, defaults)
              sendJson(res, 200, { settings, defaults })
              log.info?.('workspace-tidy: 设置已更新')
              return
            }
            res.writeHead(405, { allow: 'GET, POST' })
            res.end()
          }),
        }))

        disposers.push(webServer.register({
          kind: 'exact',
          path: RUN_PATH,
          handler: guard(async (req, res) => {
            if (req.method !== 'POST') {
              res.writeHead(405, { allow: 'POST' })
              res.end()
              return
            }
            const result = await runNow()
            sendJson(res, result.ok ? 200 : 409, result)
          }),
        }))
      } catch (error) {
        log.warn?.(`workspace-tidy: 端点注册失败：${error?.message ?? error}`)
      }

      return () => {
        for (const dispose of disposers) {
          try {
            dispose()
          } catch {
            // 已经释放过
          }
        }
      }
    })
  } else {
    log.warn?.('workspace-tidy: 没有 webServer，设置页不可用')
  }

  /** 同一工作区的整理串行执行。 */
  const queues = new Map()
  const enqueue = (root, task) => {
    const previous = queues.get(root) ?? Promise.resolve()
    const next = previous.then(task, task)
    queues.set(root, next.then(() => {}, () => {}))
    return next
  }

  const pending = new Map()
  const attempts = new Map()
  const lastFollowup = new Map()

  /** 立即整理：扫描当前会话工作区，把待归位清单直接交给 AI。 */
  runNow = async () => {
    await refreshSettings()
    if (!settings.enabled) return { ok: false, error: '自动整理已关闭，先在设置里打开总开关' }

    let agent
    try {
      const all = ctx.get('agents')?.list?.() ?? []
      // 优先主对话：整理回合出现在你正在看的对话里，而不是某个后台会话
      agent = settings.mainSessionId
        ? all.find((candidate) => String(candidate.id) === settings.mainSessionId && workspaceOf(candidate))
        : undefined
      if (!agent) {
        for (const candidate of all) {
          if (workspaceOf(candidate)) agent = candidate
        }
      }
    } catch {
      agent = undefined
    }
    if (!agent) return { ok: false, error: '没有可用的会话，先打开一个对话' }
    const root = workspaceOf(agent)
    if (!root) return { ok: false, error: '拿不到当前会话的工作区目录' }

    let inventory
    try {
      inventory = await collectTurn({ root, config: { ...store.runtime(), backlog: true }, logger: log, sessionId: agent.id })
    } catch (error) {
      return { ok: false, error: `扫描失败：${error?.message ?? error}` }
    }
    if (!inventory || inventory.skipped) return { ok: false, error: '当前无法扫描工作区' }

    const leftovers = inventory.leftovers ?? []
    const backlog = inventory.backlog ?? []
    if (leftovers.length === 0 && backlog.length === 0) {
      return { ok: true, queued: false, message: '根目录没有需要整理的东西' }
    }

    let folderMap
    try {
      folderMap = await readFolderMap(root, config, inventory.dirs ?? [])
    } catch {
      folderMap = new Map()
    }

    const prompt = buildTidyPrompt({
      inventory,
      folderMap,
      rules: settings.rules,
      undoScriptName: config.undoScriptName,
    })
    const message = Object.freeze({
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: prompt }],
      source: { kind: 'user' },
    })

    try {
      await Promise.race([agent.whenIdle?.() ?? Promise.resolve(), sleep(10000)])
      agent.followup(message)
    } catch (error) {
      return { ok: false, error: `无法排入整理回合：${error?.message ?? error}` }
    }

    pending.set(agent.id, { at: Date.now(), turn: -1 })
    lastFollowup.set(agent.id, Date.now())
    log.info?.(`workspace-tidy: 手动触发整理（待归位 ${leftovers.length}，存量 ${backlog.length}）`)
    return {
      ok: true,
      queued: true,
      leftovers: leftovers.length,
      backlog: backlog.length,
      message: '已排入整理回合，回到对话看结果',
    }
  }

  // 常驻约定提示；文本从设置实时读，改完下一条消息就生效
  if (config.prompt) {
    ctx.effect(() => {
      try {
        const systemPrompt = ctx.get('systemPrompt')
        if (!systemPrompt) return undefined
        return systemPrompt.section({
          name: 'workspace-tidy',
          order: 950,
          text: () => settings.promptText.trim() || defaults.promptText,
        })
      } catch (error) {
        log.warn?.(`workspace-tidy: 未能注册提示段：${error?.message ?? error}`)
        return undefined
      }
    })
  }

  registerTidyTool(ctx, config, store, log, {
    claimMain: async (id) => {
      settings = await saveSettings({ mainSessionId: id }, defaults)
      return settings.mainSessionId
    },
  })

  const baseline = (root) =>
    enqueue(root, async () => {
      try {
        return await ensureBaseline({ root, config: store.runtime(), logger: log })
      } catch (error) {
        log.warn?.(`workspace-tidy: 建立基线失败（${root}）：${error?.message ?? error}`)
        return undefined
      }
    })

  const handleTurnEnd = async (agent, session, turn) => {
    const root = workspaceOf(agent) ?? (session?.header?.cwd ? path.resolve(session.header.cwd) : undefined)
    if (!root || !isSafeRoot(root)) return

    await enqueue(root, async () => {
      await refreshSettings()
      const wasPending = pending.delete(agent.id) === true

      if (!settings.enabled) {
        // 关闭时只刷新快照，保证重新打开时不会把这段时间的变化当成待归位
        await withTimeout(collectTurn({ root, config: store.runtime(), snapshotOnly: true, logger: log, sessionId: session.header.id }), config.timeoutMs).catch(() => undefined)
        return
      }

      let inventory
      try {
        inventory = await withTimeout(collectTurn({ root, config: store.runtime(), logger: log, sessionId: session.header.id }), config.timeoutMs)
      } catch (error) {
        log.warn?.(`workspace-tidy: 扫描失败（${root}）：${error?.message ?? error}`)
        return
      }
      if (!inventory || inventory.skipped) return

      const leftovers = inventory.leftovers ?? []
      const backlog = inventory.backlog ?? []
      if (leftovers.length === 0 && backlog.length === 0) {
        attempts.delete(root)
        return
      }
      if (wasPending) return // 这一回合就是整理回合，不再递归

      // 其他对话的产物：直接进它自己的目录，不占用 AI 整理回合
      const isMainSession = !settings.mainSessionId || String(session.header.id) === settings.mainSessionId
      if (!isMainSession && settings.sessionInbox) {
        const paths = inventory.leftoverPaths ?? []
        if (paths.length > 0) {
          const title = sessionFolderName(session)
          const dir = `${settings.sessionInboxDir}/${title}`
          try {
            const result = await applyMoves({
              root,
              config: store.runtime(),
              moves: paths.map((rel) => ({ from: rel, to: dir })),
              logger: log,
            })
            if (result.moved.length > 0) {
              try {
                await appendSessionRecord({
                  root,
                  config: store.runtime(),
                  title,
                  sessionId: session.header.id,
                  files: result.moved.map((item) => item.from),
                  dir,
                })
              } catch (error) {
                log.warn?.(`workspace-tidy: 写对话产物记录失败：${error?.message ?? error}`)
              }
              log.info?.(`workspace-tidy: 对话「${title}」的 ${result.moved.length} 个产物 → ${dir}/`)
            }
          } catch (error) {
            log.warn?.(`workspace-tidy: 对话产物归位失败：${error?.message ?? error}`)
          }
          attempts.delete(root)
          return
        }
      }

      if (!settings.autoFile) {
        try {
          await writePendingList({ root, config: store.runtime(), inventory })
        } catch {
          // 只写清单，失败也不影响会话
        }
        return
      }

      const tries = attempts.get(root) ?? 0
      if (tries >= config.maxAttempts) {
        log.warn?.(`workspace-tidy: ${root} 连续 ${tries} 次整理没有进展，改为只写待整理清单`)
        try {
          await writePendingList({ root, config: store.runtime(), inventory })
        } catch {
          // ignore
        }
        return
      }

      const last = lastFollowup.get(agent.id) ?? 0
      if (Date.now() - last < config.cooldownMs) return

      let folderMap
      try {
        folderMap = await readFolderMap(root, config, inventory.dirs ?? [])
      } catch {
        folderMap = new Map()
      }

      const prompt = buildTidyPrompt({
        inventory,
        folderMap,
        rules: settings.rules,
        undoScriptName: config.undoScriptName,
      })
      const message = Object.freeze({
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: prompt }],
        source: { kind: 'user' },
      })

      try {
        await Promise.race([agent.whenIdle?.() ?? Promise.resolve(), sleep(10000)])
        agent.followup(message)
        pending.set(agent.id, { at: Date.now(), turn })
        lastFollowup.set(agent.id, Date.now())
        attempts.set(root, tries + 1)
        log.info?.(`workspace-tidy: 已为 ${root} 排入自动整理回合（待归位 ${leftovers.length}，存量 ${backlog.length}）`)
      } catch (error) {
        log.warn?.(`workspace-tidy: 无法起整理回合：${error?.message ?? error}`)
        try {
          await writePendingList({ root, config: store.runtime(), inventory })
        } catch {
          // ignore
        }
      }
    })
  }

  ctx.on('session/event', (session, event) => {
    if (event?.type !== 'turn/end') return
    if (!session?.header?.cwd) return
    if (config.scope === 'root' && session.header.origin === 'subagent') return
    let agent
    try {
      agent = ctx.get('agents')?.get(session.header.id)
    } catch {
      agent = undefined
    }
    if (!agent) return
    void handleTurnEnd(agent, session, event.data?.turn).catch((error) => {
      log.warn?.(`workspace-tidy: 回合收尾失败：${error?.message ?? error}`)
    })
  })

  ctx.on('agent/created', ({ agent }) => {
    const root = workspaceOf(agent)
    if (root) void baseline(root)
  })

  ctx.on('agent/disposed', ({ agent }) => {
    pending.delete(agent.id)
    lastFollowup.delete(agent.id)
  })

  try {
    const agents = ctx.get('agents')
    for (const agent of agents?.list?.() ?? []) {
      const root = workspaceOf(agent)
      if (root) void baseline(root)
    }
  } catch (error) {
    log.warn?.(`workspace-tidy: 启动基线跳过：${error?.message ?? error}`)
  }

  log.info?.('workspace-tidy: 已启用（回合结束自动整理工作区，设置页 /workspace-tidy/settings）')
}

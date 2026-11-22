/**
 * 设置持久化：设置页写入 <profile>/.dsh-workspace-tidy/settings.json
 * （Host 进程没有 DSH_PROFILE_DIR 时落到 $DSH_HOME 或 ~/.dsh，实际路径启动时写进日志）。
 *
 * 写盘是串行 + 原子替换：避免两个标签页并发保存丢字段，也避免进程中断留下半截 JSON。
 */

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 默认归位规则（和初始行为一致；规则留空时用它）。 */
export const DEFAULT_RULES = [
  '同一批产物进同一个项目文件夹，不要按扩展名拆散；',
  '生成脚本跟随它的产物：`build_x.py` 和它生成的 `x.docx` / `x.pptx` 放同一目录；',
  '属于某个项目但还没有对应目录的，直接在 `to` 里给新目录名（例如 `14_新项目`），工具会自动创建；',
  '只移动文件：已有的项目文件夹、课程资料目录不要动（目录的归位由人决定）；',
  '明显是废弃草稿、版本残留、临时截图的，用 `discard` 丢进回收站，不要自己删；',
  '拿不准的就留在原地，在汇报里说明原因——一次没搬，比搬错强。',
]

const PROMPT_MAX = 8000
const RULE_MAX = 500
const RULES_MAX = 40
const DIR_MAX = 60

/** 设置文件位置。 */
export function settingsFile() {
  const base = process.env.DSH_PROFILE_DIR || process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(base, '.dsh-workspace-tidy', 'settings.json')
}

/** 由插件配置推导出的默认设置（配置层只是初始值）。 */
export function defaultSettings(config = {}) {
  return {
    enabled: config.enabled !== false,
    autoFile: config.aiTidy !== false,
    junk: config.junk !== false,
    promptText: typeof config.promptText === 'string' ? config.promptText : '',
    rules: DEFAULT_RULES.slice(),
    /** 其他对话的产物是否各进一个目录。 */
    sessionInbox: true,
    /** 其他对话产物的根目录。 */
    sessionInboxDir: '16_对话产物',
    /** 主对话：它的产物按项目归位，其他对话进各自目录。空 = 安装时的会话。 */
    mainSessionId: '',
  }
}

/** 校验并归一化，任何非法值都回落到 fallback 对应字段。 */
export function sanitize(input, fallback) {
  const base = fallback ?? defaultSettings({})
  const raw = input && typeof input === 'object' ? input : {}
  const bool = (value, alt) => (typeof value === 'boolean' ? value : alt)
  const promptText = typeof raw.promptText === 'string' ? raw.promptText.slice(0, PROMPT_MAX) : base.promptText
  let rules = base.rules
  if (Array.isArray(raw.rules)) {
    rules = raw.rules
      .map((rule) => (typeof rule === 'string' ? rule.trim() : ''))
      .filter((rule) => rule.length > 0)
      .map((rule) => rule.slice(0, RULE_MAX))
      .slice(0, RULES_MAX)
  }
  const inboxDir = typeof raw.sessionInboxDir === 'string'
    ? raw.sessionInboxDir.replace(/[\\/:*?"<>|]/g, '').trim().slice(0, DIR_MAX)
    : base.sessionInboxDir
  return {
    enabled: bool(raw.enabled, base.enabled),
    autoFile: bool(raw.autoFile, base.autoFile),
    junk: bool(raw.junk, base.junk),
    promptText,
    rules,
    sessionInbox: bool(raw.sessionInbox, base.sessionInbox),
    sessionInboxDir: inboxDir || base.sessionInboxDir,
    mainSessionId: typeof raw.mainSessionId === 'string' ? raw.mainSessionId.slice(0, 80) : base.mainSessionId,
  }
}

/** 读取设置；文件不存在或损坏都回落到默认值。 */
export async function loadSettings(fallback) {
  const base = fallback ?? defaultSettings({})
  try {
    const text = await fs.readFile(settingsFile(), 'utf8')
    return sanitize(JSON.parse(text), base)
  } catch {
    return base
  }
}

/** 串行化写入，避免并发保存互相覆盖。 */
let saveChain = Promise.resolve()

/**
 * 合并一处修改并落盘，返回保存后的完整设置。
 * @param patch - 只包含要改的字段
 * @param fallback - 默认值（来自插件配置）
 */
export async function saveSettings(patch, fallback) {
  const base = fallback ?? defaultSettings({})
  const run = async () => {
    const current = await loadSettings(base)
    const next = sanitize({ ...current, ...(patch && typeof patch === 'object' ? patch : {}) }, base)
    const file = settingsFile()
    await fs.mkdir(path.dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
    await fs.writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    await fs.rename(tmp, file)
    return next
  }
  const result = saveChain.then(run, run)
  saveChain = result.then(() => undefined, () => undefined)
  return result
}

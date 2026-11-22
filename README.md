# dsh-workspace-tidy

AI 每执行完一个回合，自动把工作区收拾一遍的 DSH 插件。

> v2 起分工变了：**安全清理是插件的事，归位判断是模型的事**。
> 规则不再按文件名关键词搬文件——那会把同一个项目的产物拆散，还会制造 `(2)` 副本。

## 安装

要求：DeepSeek Harness 0.2+（有 Settings → Plugins 即可），Node ≥ 22。

**图形界面**

1. 设置（左下角）→ Plugins → Add plugin，填 `github:FishDoge9/dsh-workspace-tidy`
   （若这一版只接受本地目录：先 `git clone https://github.com/FishDoge9/dsh-workspace-tidy`，再选那个目录）
2. 启用 `dsh-workspace-tidy`，重启 DSH
3. 打开 **设置 → 自动整理** 看到页面即成功

**命令行**

```bash
# 跟主分支最新
dsh plugin --profile <profile> add github:FishDoge9/dsh-workspace-tidy

# 钉版本（推荐）
dsh plugin --profile <profile> add github:FishDoge9/dsh-workspace-tidy#v3.2.5

# 或直接吃 tag 压缩包
dsh plugin --profile <profile> add https://github.com/FishDoge9/dsh-workspace-tidy/archive/refs/tags/v3.2.5.tar.gz
```

装完在 Plugins 里确认 `dsh-workspace-tidy` 这一行是启用状态。插件没有构建步骤、没有运行时依赖，装完即用。

**验证过的安装方式**（本机实测）：`pnpm add github:FishDoge9/dsh-workspace-tidy` 与 `pnpm add github:FishDoge9/dsh-workspace-tidy#v3.2.5` 都解析到 `3.2.5`，装出来的包含 `index.js / client.js / organize.js / settings.js / cordis.patch.yml / icon.svg / locale`，`dsh.bundle.patch` 与 `dsh.client` 字段完整。

## 设置页

**设置 → 自动整理**（`settings.section`，order 60）：

| 控件 | 作用 |
| --- | --- |
| 自动整理 | 总开关。关闭后不扫描、不回收，也不让 AI 归位；重新打开时不会把关闭期间的改动当成待归位 |
| 自动归位到项目文件夹 | 关闭后只回收临时文件，没归位的东西写进 `00_索引/待整理.md` |
| 回收临时文件与缓存 | `*.tmp` / `*.log` / `__pycache__` 等移进回收站 |
| 提示词 | 常驻系统提示的「工作区整理约定」，即 AI 每次看到的产物放置规则 |
| 整理规则 | 一行一条，编号后放进整理回合的指令里（默认 5 条：同批同目录、脚本跟随产物、新目录可建、草稿进回收站、拿不准留下） |
| 其他对话的产物进独立目录 | 主对话（装插件时正在跑的那个会话）仍按项目归位；**其他对话的产物进 `<投放目录>/<对话名>/`**，并在 `00_索引/对话产物.md` 记一行。不占用 AI 整理回合 |
| 投放目录 | 其他对话产物的一级目录，默认 `16_对话产物`，位于工作区根目录 |
| 立即整理 | 不等下个回合，马上扫描当前工作区（含存量目录）并把清单交给 AI 归位；根目录干净时直接提示「没有需要整理的东西」 |

对话名取该对话的第一句用户消息（清理非法字符后截 24 字），取不到就用 `对话-<短 id>`。
`16_对话产物/` 里的文件同样进整理日志，`撤销自动整理.ps1` 一条命令能全部移回。
某个文件归哪个对话，按「谁先看到它归谁」记录在 `.workspace-tidy/state.json` 的 `owners` 里，其他对话不会把它扫走。

开关立即保存并生效；文本点「保存文本」后生效，可「恢复默认」。Host 每回合重新读设置，不需要重启插件。
设置落盘在 `$DSH_HOME/.dsh-workspace-tidy/settings.json`（默认 `C:\Users\<你>\.dsh\`），`cordis.patch.yml` 里的同名项只是初始值。


## 它做了什么

每回合结束（`turn/end`，回合已提交）时：

1. **插件自动做**（不需要模型）：
   - 本回合新出现的 `*.tmp/*.log/*.bak/*~`、`.DS_Store`、`__pycache__/`、`.pytest_cache/` 等 → 移进 `<索引目录>/_自动整理/回收站/<日期>/`（移动，不删除）；
   - 删掉因此变空的目录；
   - 记录快照，算出「根目录里这一回合留下、还没归位的东西」。
2. **如果确实有东西没归位**，插件在当前会话里排一个很短的整理回合，把清单交给模型：
   - 本回合新产生的条目（文件带大小、目录带标记）；
   - 现有项目文件夹及其说明（从 `工作区导航.md` 的 `## 名字 — 描述` 读）；
   - 归位规则（同批产物同目录、脚本跟随产物、不确定就留下）。
3. **模型调用 `tidy_workspace` 工具**执行移动。工具负责：越界/受保护检查、同内容去重、写整理记录、写撤销脚本。
4. 整理回合自己结束后不会再触发下一轮（有 pending 守卫）；连续多次没进展会降级为只写 `00_索引/待整理.md`。

没有待归位的东西时，插件不会多花一次模型调用。

## 为什么这样改

v1 是「按文件名关键词搬」的，6 天真实使用暴露了三个硬伤：

| 现象 | 日志证据 |
| --- | --- |
| 同一批产物被拆散 | `build_hb_chem.py`→`09_高中学习`，`build_hb_chn.py`→`10_杂项` |
| 脚本和产物分家 | `build_explain_ppt.py` 在 `10_杂项`，产物在 `01_语文试卷` |
| 重名副本 | `revise_speech_doc (2).py`、`build_explain_ppt (2).py` |

归属判断需要理解「这批东西属于同一个项目」，关键词做不到。所以现在只让规则做它擅长的事。

## 工具：`tidy_workspace`

```
tidy_workspace({
  moves: [{ from: "根目录里的路径", to: "目标文件夹" }],   // to 不存在会自动创建
  discard: ["要丢进回收站的东西"],                         // 不删除，只移进回收站
  dry_run: true                                            // 只校验
})
```

安全边界：路径越出工作区、受保护文件（`README.md`/`package.json`/`工作区导航.md`/`撤销*`/`自动整理*`/点文件）、记录目录 `00_索引`、`from` 与 `to` 相同或互相嵌套，都会被拒绝并在返回的 `failed` 里说明原因。

目录的 `to` 语义：已存在 → 放进该目录；不存在 → 把 `to` 当新名字（改名，不会多套一层旧目录名）。

## 记录与撤销

| 位置 | 内容 |
| --- | --- |
| `<索引目录>/自动整理记录-YYYY-MM-DD.md` | 每次整理了哪些文件、从哪到哪 |
| `<索引目录>/自动索引.md` | 各目录文件数与最近修改（自动生成） |
| `<索引目录>/待整理.md` | 没能自动处理时的待办清单 |
| `撤销自动整理.ps1` | 按日志倒序把文件移回原位，一条命令回滚 |
| `.workspace-tidy/` | 快照与移动日志（隐藏目录，不参与整理） |

`撤销自动整理.ps1` 用 UTF-8 BOM 写出，Windows PowerShell 5.1 也能正确读中文路径。

## 配置

改 `cordis.patch.yml` 的 `config`（未知键忽略，缺省值见 `organize.js` 的 `DEFAULTS`）。
`enabled` / `aiTidy` / `junk` / `promptText` 在这里只是**初始值**，设置页保存过的值优先。

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关 |
| `scope` | `root` | `root` 只整理主会话；`all` 子代理也整理 |
| `aiTidy` | `true` | 关掉就只清理 + 写待整理清单（不花模型调用） |
| `backlog` | `false` | 是否把根目录历史遗留一起交给 AI（清干净后自动关闭） |
| `cooldownMs` | `5000` | 同会话两次自动整理的最小间隔 |
| `maxAttempts` | `3` | 连续没进展几次后改为只写清单 |
| `junk` | `true` | 回收临时文件与缓存目录 |
| `removeEmptyDirs` | `true` | 删掉被搬空的目录 |
| `maxDepth` / `maxFiles` | `2` / `5000` | 扫描范围 |
| `timeoutMs` | `20000` | 单次扫描超时，不阻塞会话 |
| `indexDirName` | `00_索引` | 记录目录 |
| `mapFile` | `工作区导航.md` | 项目地图来源 |
| `prompt` / `promptText` | `true` / 见 `organize.js` | 是否注入工作区约定 |

## 自测

```powershell
cd .dsh-plugins/workspace-tidy
node scripts/selftest.mjs --undo   # 原语：清理、存量清单、移动、撤销脚本真跑
node scripts/integration.mjs       # 接线：事件、整理回合、工具、去重、安全边界
```

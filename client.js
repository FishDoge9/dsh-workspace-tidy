/**
 * 客户端半：设置 → 自动整理。
 * 通过 /workspace-tidy/settings 读写 Host 侧设置；开关与文本改完立即生效。
 */

window.__ModuleLoader__.load({
  id: 'dsh-workspace-tidy',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const ENDPOINT = '/workspace-tidy/settings'
    const RUN_ENDPOINT = '/workspace-tidy/run'
    const TIMEOUT_MS = 8000
    const PROMPT_MAX = 8000

    const CSS = `
.wt-page{display:flex;flex-direction:column;gap:16px;padding:2px 2px 24px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.6}
.wt-title{margin:0;font-size:15px;font-weight:600}
.wt-sub{margin:6px 0 0;color:var(--dsw-alias-label-secondary);font-size:12px}
.wt-card{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;overflow:hidden}
.wt-row{display:flex;align-items:center;gap:16px;padding:13px 16px;border-top:1px solid var(--dsw-alias-border-l1)}
.wt-row:first-child{border-top:none}
.wt-row-main{flex:1;min-width:0}
.wt-row-title{font-weight:500}
.wt-row-hint{margin-top:2px;color:var(--dsw-alias-label-secondary);font-size:12px}
.wt-switch{position:relative;flex:0 0 auto;width:40px;height:22px;padding:0;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);cursor:pointer;transition:background .15s ease}
.wt-switch.wt-on{background:var(--dsw-alias-brand-primary);border-color:transparent}
.wt-switch:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.wt-switch:disabled{opacity:.45;cursor:default}
.wt-knob{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.25);transition:transform .15s ease}
.wt-switch.wt-on .wt-knob{transform:translateX(18px)}
.wt-field{padding:13px 16px;border-top:1px solid var(--dsw-alias-border-l1)}
.wt-field:first-child{border-top:none}
.wt-label{font-weight:500}
.wt-hint{margin:2px 0 8px;color:var(--dsw-alias-label-secondary);font-size:12px}
.wt-textarea{box-sizing:border-box;width:100%;min-height:96px;resize:vertical;padding:10px 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;line-height:1.65;outline:none}
.wt-textarea:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;border-color:var(--dsw-alias-brand-primary)}
.wt-input{box-sizing:border-box;width:260px;max-width:100%;padding:6px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;outline:none}
.wt-input:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;border-color:var(--dsw-alias-brand-primary)}
.wt-input:disabled{opacity:.5}
.wt-mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.wt-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.wt-btn{padding:6px 14px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;cursor:pointer}
.wt-btn:hover:not(:disabled){border-color:var(--dsw-alias-border-l2)}
.wt-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.wt-btn:disabled{opacity:.45;cursor:default}
.wt-btn-primary{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);font-weight:500}
.wt-note{font-size:12px}
.wt-ok{color:var(--dsw-alias-state-success-primary)}
.wt-err{color:var(--dsw-alias-state-error-primary)}
.wt-badge{font-size:11px;padding:1px 7px;border-radius:999px;border:1px solid var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary)}
.wt-loading{color:var(--dsw-alias-label-secondary);font-size:12.5px}
`

    /** 带超时的请求：Host 卡住时不能让整页永久禁用。 */
    function request(url, init) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
      return fetch(url, { ...(init || {}), signal: controller.signal })
        .finally(() => clearTimeout(timer))
        .catch((error) => {
          if (error && error.name === 'AbortError') throw new Error('请求超时，请重试')
          throw error
        })
    }

    function Toggle(props) {
      const { checked, disabled, onChange, label, hint } = props
      return h('div', { className: 'wt-row' },
        h('div', { className: 'wt-row-main' },
          h('div', { className: 'wt-row-title' }, label),
          hint ? h('div', { className: 'wt-row-hint' }, hint) : null),
        h('button', {
          type: 'button',
          role: 'switch',
          'aria-checked': checked ? 'true' : 'false',
          'aria-label': label,
          disabled,
          className: 'wt-switch' + (checked ? ' wt-on' : ''),
          onClick: () => onChange(!checked),
        }, h('span', { className: 'wt-knob' })))
    }

    function Page() {
      const [loaded, setLoaded] = React.useState(false)
      const [settings, setSettings] = React.useState(null)
      const [defaults, setDefaults] = React.useState(null)
      const [promptText, setPromptText] = React.useState('')
      const [rulesText, setRulesText] = React.useState('')
      const [inboxDir, setInboxDir] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [notice, setNotice] = React.useState(null)

      React.useEffect(() => {
        let alive = true
        request(ENDPOINT, { headers: { accept: 'application/json' } })
          .then((res) => {
            if (!res.ok) throw new Error('读取失败 (HTTP ' + res.status + ')')
            return res.json()
          })
          .then((data) => {
            if (!alive) return
            if (!data || !data.settings) throw new Error('返回内容不完整')
            setSettings(data.settings)
            setDefaults(data.defaults)
            setPromptText(data.settings.promptText || '')
            setRulesText((data.settings.rules || []).join('\n'))
            setInboxDir(data.settings.sessionInboxDir || '')
            setLoaded(true)
          })
          .catch((error) => {
            if (!alive) return
            setLoaded(true)
            setNotice({ kind: 'error', text: '设置不可用：' + (error && error.message ? error.message : error) })
          })
        return () => { alive = false }
      }, [])

      const save = React.useCallback((patch, done, onError) => {
        setBusy(true)
        setNotice(null)
        const syncText = Object.prototype.hasOwnProperty.call(patch, 'promptText')
          || Object.prototype.hasOwnProperty.call(patch, 'rules')
          || Object.prototype.hasOwnProperty.call(patch, 'sessionInboxDir')
        request(ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(patch),
        })
          .then(async (res) => {
            const data = await res.json().catch(() => ({}))
            if (!res.ok) throw new Error((data && data.error) || ('HTTP ' + res.status))
            if (!data || !data.settings) throw new Error('返回内容不完整')
            setSettings(data.settings)
            // 开关保存不能吞掉还没保存的文本编辑
            if (syncText) {
              setPromptText(data.settings.promptText || '')
              setRulesText((data.settings.rules || []).join('\n'))
              setInboxDir(data.settings.sessionInboxDir || '')
            }
            setNotice({ kind: 'ok', text: done || '已保存' })
          })
          .catch((error) => {
            // 失败要把乐观更新回滚，否则界面显示的状态和磁盘不一致
            if (onError) onError()
            setNotice({ kind: 'error', text: '保存失败：' + (error && error.message ? error.message : error) })
          })
          .then(() => setBusy(false))
      }, [])

      const toggle = (key, value) => {
        const previous = settings ? settings[key] : undefined
        setSettings((current) => (current ? { ...current, [key]: value } : current))
        save({ [key]: value }, '已保存，下个回合生效', () => {
          setSettings((current) => (current ? { ...current, [key]: previous } : current))
        })
      }

      // 立即整理：不等下个回合，马上扫描并让 AI 归位
      const runNow = React.useCallback(() => {
        setBusy(true)
        setNotice(null)
        request(RUN_ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        })
          .then(async (res) => {
            const data = await res.json().catch(() => ({}))
            if (!res.ok) throw new Error((data && data.error) || ('HTTP ' + res.status))
            setNotice({ kind: 'ok', text: (data && data.message) || '已排入整理回合' })
          })
          .catch((error) => {
            setNotice({ kind: 'error', text: '立即整理失败：' + (error && error.message ? error.message : error) })
          })
          .then(() => setBusy(false))
      }, [])

      const promptDirty = settings ? promptText !== (settings.promptText || '') : false
      const rulesDirty = settings ? rulesText.trim() !== (settings.rules || []).join('\n').trim() : false
      const inboxDirty = settings ? inboxDir !== (settings.sessionInboxDir || '') : false
      const dirty = promptDirty || rulesDirty || inboxDirty

      // 有未保存编辑时，关标签页/切走要拦一下
      React.useEffect(() => {
        if (!dirty) return undefined
        const handler = (event) => {
          event.preventDefault()
          event.returnValue = ''
        }
        window.addEventListener('beforeunload', handler)
        return () => window.removeEventListener('beforeunload', handler)
      }, [dirty])

      const onRestoreDefaults = () => {
        if (!defaults) return
        if (dirty && !window.confirm('放弃未保存的修改，恢复默认提示词与规则？')) return
        save({ promptText: defaults.promptText, rules: defaults.rules }, '已恢复默认')
      }

      if (!loaded) {
        return h('div', { className: 'wt-page' },
          h('style', null, CSS),
          h('div', { className: 'wt-loading' }, '正在读取设置…'))
      }

      if (!settings) {
        return h('div', { className: 'wt-page' },
          h('style', null, CSS),
          h('h2', { className: 'wt-title' }, '自动整理'),
          h('div', { className: 'wt-note wt-err', role: 'alert' }, (notice && notice.text) || '设置不可用：Host 端没有响应。'))
      }

      return h('div', { className: 'wt-page' },
        h('style', null, CSS),
        h('div', null,
          h('h2', { className: 'wt-title' }, '自动整理'),
          h('p', { className: 'wt-sub' }, '每个回合结束后，回收临时文件，并把散落在根目录的产物交给 AI 按项目归位。改完立即生效。')),

        h('div', { className: 'wt-card' },
          h(Toggle, {
            label: '自动整理',
            hint: '总开关。关闭后不再扫描、不再回收，也不会自动触发归位。',
            checked: settings.enabled,
            disabled: busy,
            onChange: (value) => toggle('enabled', value),
          }),
          h(Toggle, {
            label: '自动归位到项目文件夹',
            hint: '关闭后只回收临时文件，没归位的东西写进 00_索引/待整理.md。',
            checked: settings.autoFile,
            disabled: busy || !settings.enabled,
            onChange: (value) => toggle('autoFile', value),
          }),
          h(Toggle, {
            label: '回收临时文件与缓存',
            hint: '*.tmp / *.log / *.bak / __pycache__ 等移进 00_索引/_自动整理/回收站，可撤销。',
            checked: settings.junk,
            disabled: busy || !settings.enabled,
            onChange: (value) => toggle('junk', value),
          })),

        h('div', { className: 'wt-card' },
          h(Toggle, {
            label: '其他对话的产物进独立目录',
            hint: '主对话仍按项目归位；其他对话的产物进 `' + (settings.sessionInboxDir || '16_对话产物') + '/<对话名>/`，并在 00_索引/对话产物.md 记一行。',
            checked: settings.sessionInbox,
            disabled: busy || !settings.enabled,
            onChange: (value) => toggle('sessionInbox', value),
          }),
          h('div', { className: 'wt-field' },
            h('div', { className: 'wt-label' }, '投放目录'),
            h('div', { className: 'wt-hint' }, '其他对话产物的一级目录名，位于工作区根目录。'),
            h('input', {
              className: 'wt-input',
              value: inboxDir,
              disabled: busy || !settings.enabled || !settings.sessionInbox,
              onChange: (event) => { setInboxDir(event.target.value); setNotice(null) },
            })),
          h('div', { className: 'wt-row' },
            h('div', { className: 'wt-row-main' },
              h('div', { className: 'wt-row-title' }, '主对话'),
              h('div', { className: 'wt-row-hint' }, '这个对话的产物按项目归位，其余对话进各自目录。')),
            h('span', { className: 'wt-mono' }, settings.mainSessionId ? settings.mainSessionId.slice(0, 8) : '未设置'))),

        h('div', { className: 'wt-card' },
          h('div', { className: 'wt-field' },
            h('div', { className: 'wt-label' }, '提示词'),
            h('div', { className: 'wt-hint' }, '常驻在系统提示里，告诉 AI 产物该放哪、文件被归档后去哪查。最多 ' + PROMPT_MAX + ' 字。'),
            h('textarea', {
              className: 'wt-textarea',
              value: promptText,
              maxLength: PROMPT_MAX,
              spellCheck: false,
              onChange: (event) => { setPromptText(event.target.value); setNotice(null) },
            })),
          h('div', { className: 'wt-field' },
            h('div', { className: 'wt-label' }, '整理规则'),
            h('div', { className: 'wt-hint' }, '一行一条，编号后放进整理回合的指令里。留空则使用内置的 5 条默认规则。'),
            h('textarea', {
              className: 'wt-textarea',
              value: rulesText,
              spellCheck: false,
              onChange: (event) => { setRulesText(event.target.value); setNotice(null) },
            }))),

        h('p', { className: 'wt-sub' }, '「立即整理」会马上扫描当前工作区并让 AI 归位，不用等下个回合。'),

        h('div', { className: 'wt-actions' },
          h('button', { type: 'button', className: 'wt-btn', disabled: busy, onClick: runNow }, '立即整理'),
          h('button', {
            type: 'button',
            className: 'wt-btn wt-btn-primary',
            disabled: busy || !dirty,
            onClick: () => save({
              promptText,
              rules: rulesText.split('\n').map((line) => line.trim()).filter(Boolean),
              sessionInboxDir: inboxDir,
            }, '设置已保存'),
          }, busy ? '保存中…' : '保存文本'),
          h('button', {
            type: 'button',
            className: 'wt-btn',
            disabled: busy || !defaults,
            onClick: onRestoreDefaults,
          }, '恢复默认'),
          dirty ? h('span', { className: 'wt-badge' }, '未保存') : null,
          busy && !dirty ? h('span', { className: 'wt-note' }, '保存中…') : null,
          notice
            ? h('span', {
              className: 'wt-note ' + (notice.kind === 'ok' ? 'wt-ok' : 'wt-err'),
              role: notice.kind === 'ok' ? 'status' : 'alert',
              'aria-live': notice.kind === 'ok' ? 'polite' : 'assertive',
            }, notice.text)
            : null))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'workspace-tidy',
          order: 60,
          label: '自动整理',
        }, Page))
      },
    }
  },
})

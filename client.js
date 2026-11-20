/**
 * dsh-repo-sync —— 浏览器半端（设置页）
 */
window.__ModuleLoader__.load({
  id: 'dsh-repo-sync',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const API = '/api/repo-sync'

    const asJson = async (res) => {
      if (res.ok) return res.json()
      throw new Error('HTTP ' + res.status)
    }
    const jget = async (p) => asJson(await fetch(API + p, { credentials: 'same-origin' }))
    const jpost = async (p, body) => asJson(await fetch(API + p, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    }))

    const css = {
      wrap: { display: 'flex', flexDirection: 'column', gap: 14, padding: '4px 2px', maxWidth: 780 },
      h2: { fontSize: 15, fontWeight: 600, margin: '2px 0' },
      note: { fontSize: 12, opacity: 0.68, lineHeight: 1.6 },
      card: {
        border: '1px solid var(--dsh-border, rgba(128,128,128,.28))',
        borderRadius: 8, padding: 12, display: 'flex', flexDirection: 'column', gap: 10,
      },
      row: { display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'space-between' },
      label: { fontSize: 13 },
      input: {
        fontSize: 13, padding: '5px 8px', borderRadius: 6, minWidth: 150,
        border: '1px solid var(--dsh-border, rgba(128,128,128,.35))',
        background: 'var(--dsh-input-bg, transparent)', color: 'inherit',
      },
      btn: {
        fontSize: 13, padding: '5px 12px', borderRadius: 6, cursor: 'pointer',
        border: '1px solid var(--dsh-border, rgba(128,128,128,.35))',
        background: 'var(--dsh-btn-bg, transparent)', color: 'inherit',
      },
      ok: { fontSize: 12, color: '#1a7f37' },
      warn: { fontSize: 12, color: '#b26a00' },
      err: { fontSize: 12, color: '#c0392b' },
      mono: { fontFamily: 'ui-monospace, monospace', fontSize: 11, opacity: 0.7, wordBreak: 'break-all' },
      repoRow: {
        display: 'grid', gridTemplateColumns: '1fr auto', gap: 8,
        padding: '6px 0', borderTop: '1px solid var(--dsh-border, rgba(128,128,128,.18))',
        alignItems: 'center',
      },
    }

    const badge = (text, color) => h('span', {
      style: {
        fontSize: 11, padding: '1px 7px', borderRadius: 9,
        border: '1px solid ' + color, color,
      },
    }, text)

    function Toggle({ label, note, on, onChange }) {
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 3 } },
        h('label', { style: { display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' } },
          h('input', { type: 'checkbox', checked: Boolean(on), onChange: (e) => onChange(e.target.checked) }),
          h('span', { style: css.label }, label)),
        note ? h('div', { style: css.note }, note) : null)
    }

    function Panel() {
      const [st, setSt] = React.useState(null)
      const [msg, setMsg] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [draft, setDraft] = React.useState({})

      const [repos, setRepos] = React.useState([])
      const [onlySel, setOnlySel] = React.useState(null)

      const load = React.useCallback(async () => {
        try {
          const [s, r] = await Promise.all([jget('/status'), jget('/repos')])
          setSt(s)
          setRepos(r.repos || [])
          setOnlySel(Boolean(r.onlySelected))
        } catch (e) {
          setMsg({ kind: 'err', text: '读状态失败：' + String(e?.message ?? e) })
        }
      }, [])

      React.useEffect(() => {
        let alive = true
        const run = async () => { if (alive) await load() }
        run()
        const t = setInterval(run, 15_000)
        return () => { alive = false; clearInterval(t) }
      }, [load])

      const set = (patch) => setDraft((d) => ({ ...d, ...patch }))
      const val = (k, fb) => (draft[k] !== undefined ? draft[k] : (st ? st[k] : fb))

      const save = async (patch, label) => {
        setBusy(true); setMsg(null)
        try {
          const r = await jpost('/save', patch)
          if (!r?.ok) throw new Error(r?.error || '没保存成功')
          const un = r.host && r.host.ok === false
          setMsg({
            kind: un ? 'warn' : 'ok',
            text: (label || '设置') + '已保存' + (un ? '（只在插件这边生效）' : ''),
          })
          setDraft((d) => { const n = { ...d }; for (const k of Object.keys(patch)) delete n[k]; return n })
          if (r.status) setSt(r.status); else await load()
        } catch (e) {
          setMsg({ kind: 'err', text: '保存失败：' + String(e?.message ?? e) })
        } finally { setBusy(false) }
      }

      const toggleRepo = async (row) => {
        const next = repos.map((x) => x.dir === row.dir ? { ...x, selected: !x.selected } : x)
        setRepos(next)
        const picked = next.filter((x) => x.selected)
        try {
          const r = await jpost('/select', {
            selected: picked.map((x) => x.dir),
            names: picked.map((x) => x.name),
            onlySelected: onlySel !== null ? onlySel : true,
          })
          if (r.repos) setRepos(r.repos)
          if (typeof r.onlySelected === 'boolean') setOnlySel(r.onlySelected)
        } catch (e) {
          setMsg({ kind: 'err', text: '保存勾选失败：' + String(e?.message ?? e) })
        }
      }

      const setOnly = async (v) => {
        setOnlySel(v)
        try {
          const picked = repos.filter((x) => x.selected)
          const r = await jpost('/select', {
            selected: picked.map((x) => x.dir),
            names: picked.map((x) => x.name),
            onlySelected: v,
          })
          if (r.repos) setRepos(r.repos)
          await load()
        } catch (e) {
          setMsg({ kind: 'err', text: '保存失败：' + String(e?.message ?? e) })
        }
      }

      const doSync = async () => {
        setBusy(true); setMsg(null)
        try {
          const r = await jpost('/sync')
          if (r.status) setSt(r.status)
          const bad = (r.repos || []).filter((x) => x.error)
          const conf = (r.repos || []).filter((x) => x.conflict)
          if (bad.length) setMsg({ kind: 'err', text: `同步完成，但 ${bad.length} 个仓库出错：` + bad.map((b) => b.name).join('、') })
          else if (conf.length) setMsg({ kind: 'warn', text: `${conf.length} 个仓库需要先手动 pull：` + conf.map((c) => c.name).join('、') })
          else setMsg({ kind: 'ok', text: r.summary || '同步完成' })
        } catch (e) {
          setMsg({ kind: 'err', text: '同步失败：' + String(e?.message ?? e) })
        } finally { setBusy(false) }
      }

      if (!st) return h('div', { style: css.wrap }, h('div', { style: css.note }, '读取中…'))

      return h('div', { style: css.wrap },
        h('div', { style: css.h2 }, '仓库同步'),
        h('div', { style: css.note },
          '定时把工作区里的 git 仓库提交并推送到远程。',
          h('br'),
          '只处理**已经**是 git 仓库、且配置了 origin 的目录 —— 不会替你 git init，不会建远程仓库，也不会 force push。'),

        msg ? h('div', { style: msg.kind === 'ok' ? css.ok : (msg.kind === 'warn' ? css.warn : css.err) }, msg.text) : null,

        h('div', { style: css.card },
          h(Toggle, {
            label: '自动同步',
            note: '关了只停定时器，手动「立即同步」照样能用。',
            on: val('enabled', true),
            onChange: (v) => { set({ enabled: v }); save({ enabled: v }, '自动同步') },
          }),
          h('div', { style: css.row },
            h('span', { style: css.label }, '间隔（分钟）'),
            h('input', {
              style: { ...css.input, minWidth: 80, width: 80 },
              type: 'number', min: 1, value: val('intervalMinutes', 15),
              onChange: (e) => set({ intervalMinutes: Number(e.target.value) || 15 }),
              onBlur: () => save({ intervalMinutes: Number(val('intervalMinutes', 15)) || 15 }, '间隔'),
            })),
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
            h('span', { style: css.label }, '工作区目录'),
            h('input', {
              style: { ...css.input, width: '100%', boxSizing: 'border-box' },
              placeholder: '留空 = 自动探测 DSH 默认工作区',
              value: val('workspaceRoot', ''),
              onChange: (e) => set({ workspaceRoot: e.target.value }),
              onBlur: () => save({ workspaceRoot: String(val('workspaceRoot', '')).trim() }, '工作区'),
            }),
            h('div', { style: css.note }, '只扫描这个目录下一层带 .git 的文件夹，不会递归进 node_modules。'),
            h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4, marginTop: 4 } },
              h('span', { style: css.label }, '排除的目录名'),
              h('input', {
                style: { ...css.input, width: '100%', boxSizing: 'border-box' },
                placeholder: '逗号分隔，支持 * 通配。例：vendor, other-clone, *-test',
                value: val('excludeNames', ''),
                onChange: (e) => set({ excludeNames: e.target.value }),
                onBlur: () => save({ excludeNames: String(val('excludeNames', '')) }, '排除名单'),
              }),
              h('div', { style: css.note }, '工作区里别人的 clone 要写在这里 —— 否则它也会被提交推送到**它自己的**远程。')))),

        h('div', { style: css.card },
          h('div', { style: css.row },
            h('button', { style: css.btn, disabled: busy, onClick: doSync }, busy ? '同步中…' : '立即同步'),
            st.lastRun ? h('span', { style: css.note }, '上次：' + new Date(st.lastRun.at).toLocaleTimeString()) : null),
          st.lastRun ? h('div', { style: css.note }, st.lastRun.summary || '') : null,
          h('div', { style: css.row },
            h('span', { style: css.label }, '要同步哪些'),
            h('label', { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer' } },
              h('input', {
                type: 'checkbox',
                checked: onlySel !== null ? onlySel : false,
                onChange: (e) => setOnly(e.target.checked),
              }),
              '只同步勾选的'))),

          repos.length === 0
            ? h('div', { style: css.note }, '没找到仓库。确认工作区路径对不对，以及那些目录是不是已经 git init 过。')
            : h('div', { style: { display: 'flex', flexDirection: 'column' } },
              repos.map((r, i) => h('div', { key: r.dir, style: i === 0 ? { ...css.repoRow, borderTop: 'none' } : css.repoRow },
                h('div', { style: { display: 'flex', alignItems: 'flex-start', gap: 8 } },
                  h('input', {
                    type: 'checkbox',
                    checked: Boolean(r.selected),
                    disabled: !onlySel,
                    title: onlySel ? '勾选 = 参与同步' : '先打开「只同步勾选的」',
                    onChange: () => toggleRepo(r),
                    style: { marginTop: 3 },
                  }),
                  h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
                    h('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
                      h('span', { style: css.label }, r.name),
                      r.isPlugin ? badge('插件', '#3b7dd8') : null,
                      r.pkgVersion ? h('span', { style: css.mono }, r.pkgVersion) : null),
                    h('span', { style: css.mono }, r.dir))),
                h('div', { style: { display: 'flex', gap: 6, alignItems: 'center' } },
                  !onlySel || r.selected
                    ? (r.error ? badge('出错', '#c0392b')
                      : r.conflict ? badge('需 pull', '#b26a00')
                        : r.skipped ? badge('跳过', '#888')
                          : r.pushed ? badge('已推送', '#1a7f37')
                            : badge('最新', '#1a7f37'))
                    : badge('不同步', '#999')))),
            ),

        h('div', { style: css.card },
          h('div', { style: css.h2 }, '高级'),
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
            h('span', { style: css.label }, '自定义提交信息（留空 = 自动带时间戳）'),
            h('input', {
              style: { ...css.input, width: '100%', boxSizing: 'border-box' },
              placeholder: '留空 = chore: 自动同步 2026-01-01 12:00',
              value: val('commitMessage', ''),
              onChange: (e) => set({ commitMessage: e.target.value }),
              onBlur: () => save({ commitMessage: String(val('commitMessage', '')) }, '提交信息'),
            })),
          h(Toggle, {
            label: 'DSH 启动后自动跑一次',
            note: '默认关。开了会在启动 10 秒后同步一次。',
            on: val('pushOnStart', false),
            onChange: (v) => { set({ pushOnStart: v }); save({ pushOnStart: v }, '启动时同步') },
          }),
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
            h('span', { style: css.label }, '额外仓库（绝对路径，逗号分隔）'),
            h('input', {
              style: { ...css.input, width: '100%', boxSizing: 'border-box' },
              placeholder: '工作区外面的仓库，比如 /home/you/dsh-private',
              value: val('extraRepos', ''),
              onChange: (e) => set({ extraRepos: e.target.value }),
              onBlur: () => save({ extraRepos: String(val('extraRepos', '')) }, '额外仓库'),
            }),
            h('div', { style: css.note }, '这些目录不在工作区下面也能同步，但同样必须是已有 origin 的 git 仓库。')),
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
            h('span', { style: css.label }, '同步前先跑的采集脚本'),
            h('input', {
              style: { ...css.input, width: '100%', boxSizing: 'border-box' },
              placeholder: '留空 = 不跑。例：/home/you/dsh-config/scripts/collect.sh',
              value: val('collectScript', ''),
              onChange: (e) => set({ collectScript: e.target.value }),
              onBlur: () => save({ collectScript: String(val('collectScript', '')) }, '采集脚本'),
            }),
            h('div', { style: css.note }, '用 bash 跑。适合把 ~/.dsh/ 里的配置先采集到某个暂存仓库，再一起推。')),
          h('div', { style: css.note }, '日志：' + st.log))
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        if (!slots) return
        slots.inject('settings.section', () => slots.register(
          { name: 'settings.section', id: 'repo-sync', order: 32, label: '仓库同步' },
          () => h(Panel),
        ))
      },
    }
  },
})

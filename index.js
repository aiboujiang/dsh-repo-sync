/**
 * dsh-repo-sync —— host 半端
 *
 * 把工作区里的一组 git 仓库定时提交并推送。
 *
 * ⭐ 为什么做成插件而不是 cron + shell：
 *   · 配置在设置页里，不用改脚本
 *   · 每个仓库的状态（落后 / 冲突 / 失败原因）能直接看到
 *   · 出问题时有结构化日志，而不是一行 shell 错误
 *   · 跟着 DSH 一起启动，换机器不用重装定时器
 *
 * 🔴 四条安全红线（都是这类工具最容易出事的地方）：
 *   ① 不自动 `git init` —— 没 .git 就跳过
 *   ② 不自动建远程仓库 —— 没 origin 就跳过
 *   ③ 不 force push —— 远程有本地没有的提交时报冲突，交给人处理
 *   ④ 不绕过 hook —— 不加 --no-verify
 */

import { existsSync, readdirSync, statSync, mkdirSync, appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { homedir } from 'node:os'

import {
  inspect, commitAll, push, lastCommit, git,
} from './lib/git.mjs'
import { spawn } from 'node:child_process'

/** 跑一条外部命令（采集脚本用），永不抛 */
function runShell(cmd, args, timeoutMs = 120_000) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      return resolve({ ok: false, code: -1, out: '', err: String(e?.message ?? e) })
    }
    let out = '', err = ''
    child.stdout?.on('data', (b) => { out += b.toString('utf8') })
    child.stderr?.on('data', (b) => { err += b.toString('utf8') })
    const t = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* 忽略 */ } }, timeoutMs)
    t.unref?.()
    child.on('error', (e) => { clearTimeout(t); resolve({ ok: false, code: -1, out, err: err + String(e?.message ?? e) }) })
    child.on('close', (code) => { clearTimeout(t); resolve({ ok: code === 0, code, out: out.trim(), err: err.trim() }) })
  })
}


const NAME = 'repo-sync'
const API = '/api/repo-sync'

/** 设置页靠这几个键认出"哪一行是我们" */
const CFG_SIG = ['enabled', 'intervalMinutes', 'workspaceRoot']

const DEFAULTS = {
  enabled: true,
  intervalMinutes: 15,
  workspaceRoot: '',
  excludeNames: '',
  extraRepos: '',
  collectScript: '',
  onlySelected: false,
  mirrors: '',
  commitMessage: '',
  pushOnStart: false,
}

export let Config
try {
  const mod = await import('@deepseek-ai/schemastery')
  const z = mod.z || mod.default
  Config = z.object({
    enabled: z.boolean().default(true).extra('volatile', true),
    intervalMinutes: z.natural().default(15).extra('volatile', true),
    workspaceRoot: z.string().default('').extra('volatile', true),
    excludeNames: z.string().default('').extra('volatile', true),
    extraRepos: z.string().default('').extra('volatile', true),
    collectScript: z.string().default('').extra('volatile', true),
    onlySelected: z.boolean().default(false).extra('volatile', true),
    mirrors: z.string().default('').extra('volatile', true),
    commitMessage: z.string().default('').extra('volatile', true),
    pushOnStart: z.boolean().default(false).extra('volatile', true),
  })
} catch {
  Config = undefined
}

const log = (...a) => { try { console.log('[repo-sync]', ...a) } catch { /* 忽略 */ } }

function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return fallback }
}
function writeJson(file, v) {
  try { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(v, null, 2), 'utf8') } catch (e) { log('写文件失败', file, e?.message) }
}

/** volatile 字段是实时引用，得摊平 */
function unwrapVolatile(v) {
  if (v === null || typeof v !== 'object') return v
  if (typeof v.get === 'function') { try { return unwrapVolatile(v.get()) } catch { return undefined } }
  if (Array.isArray(v)) return v.map(unwrapVolatile)
  const out = {}
  for (const k of Object.keys(v)) out[k] = unwrapVolatile(v[k])
  return out
}

function dshHome(ctx) {
  try {
    const fn = ctx.get?.('dshHomePath')
    if (typeof fn === 'function') return fn()
  } catch { /* 忽略 */ }
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

export const name = NAME
export const inject = ['webServer', 'settings']

export function apply(ctx, rawConfig) {
  const home = dshHome(ctx)
  const stateDir = (() => {
    try {
      const fn = ctx.get?.('dshHomePath')
      if (typeof fn === 'function') return fn('repo-sync')
    } catch { /* 忽略 */ }
    return join(home, 'repo-sync')
  })()
  try { mkdirSync(stateDir, { recursive: true }) } catch { /* 忽略 */ }

  const logFile = join(stateDir, 'sync.log')
  const cfgFile = join(stateDir, 'config.json')
  const stateFile = join(stateDir, 'state.json')
  const selFile = join(stateDir, 'selection.json')

  const logf = (msg) => {
    try { appendFileSync(logFile, `${new Date().toISOString()}  ${msg}\n`, 'utf8') } catch { /* 忽略 */ }
    log(msg)
  }

  /* ───────────── 配置 ───────────── */

  const settingsRow = { at: 0, row: null }
  const settingsDesc = (fresh = false) => {
    const t = Date.now()
    if (!fresh && t - settingsRow.at < 3000) return settingsRow.row
    let row = null
    try {
      const rows = ctx.settings?.describe?.() || []
      row = rows.find((r) => r?.value && CFG_SIG.every((k) => k in r.value)) || null
    } catch (e) { log(`读设置表单失败：${e?.message ?? e}`) }
    settingsRow.at = t
    settingsRow.row = row
    return row
  }

  const normalize = (p, base) => {
    const o = { ...base }
    if (!p || typeof p !== 'object') return o
    if ('enabled' in p) o.enabled = Boolean(p.enabled)
    if ('intervalMinutes' in p) o.intervalMinutes = Math.max(1, Math.min(1440, Number(p.intervalMinutes) || 15))
    if ('excludeNames' in p) o.excludeNames = String(p.excludeNames ?? '').trim().slice(0, 2000)
    if ('extraRepos' in p) o.extraRepos = String(p.extraRepos ?? '').trim().slice(0, 4000)
    if ('collectScript' in p) o.collectScript = String(p.collectScript ?? '').trim().slice(0, 1000)
    if ('onlySelected' in p) o.onlySelected = Boolean(p.onlySelected)
    if ('mirrors' in p) o.mirrors = String(p.mirrors ?? '').trim().slice(0, 4000)
    if ('pushOnStart' in p) o.pushOnStart = Boolean(p.pushOnStart)
    for (const k of ['workspaceRoot', 'commitMessage']) {
      if (k in p) o[k] = String(p[k] ?? '').trim().slice(0, 1000)
    }
    return o
  }

  const loadCfg = () => {
    const saved = readJson(cfgFile, {}) || {}
    const row = settingsDesc()
    const base = normalize(row?.value && typeof row.value === 'object' ? unwrapVolatile(row.value) : unwrapVolatile(rawConfig || {}), DEFAULTS)
    const cfg = normalize(saved, base)
    // workspaceRoot 留空时自动探测：DSH 自己的默认工作区
    if (!cfg.workspaceRoot) {
      cfg.workspaceRoot = join(home, '..', 'Documents', 'deepseek-harness', 'default-workspace')
      // 探测不到就退回 home
      try { if (!existsSync(cfg.workspaceRoot)) cfg.workspaceRoot = join(homedir(), 'Documents', 'deepseek-harness', 'default-workspace') } catch { /* 忽略 */ }
    }
    return cfg
  }

  const cfg = loadCfg()
  const refresh = () => { try { Object.assign(cfg, loadCfg()) } catch { /* 忽略 */ } }

  const outsideHmr = (fn) => {
    try {
      const ex = ctx.get('hmr')?.executing
      if (ex && typeof ex.exit === 'function' && ex.getStore()) return ex.exit(fn)
    } catch { /* 忽略 */ }
    return fn()
  }

  const saveCfg = async (patch) => {
    const clean = normalize(patch, cfg)
    Object.assign(cfg, clean)
    writeJson(cfgFile, clean)

    let host = { ok: false, error: '这个宿主没有可写的设置表单' }
    const attempt = async (fresh) => {
      const row = settingsDesc(fresh)
      if (!row?.ns || typeof ctx.settings?.update !== 'function') throw Object.assign(new Error('no-form'), { noForm: true })
      await outsideHmr(() => ctx.settings.update(row.ns, patch, row.revision))
      return row.ns
    }
    try { host = { ok: true, ns: await attempt(false) } }
    catch (e) {
      if (!e?.noForm) { try { host = { ok: true, ns: await attempt(true), retried: true } } catch (e2) { e = e2 } }
      if (host.ok !== true) { host = { ok: false, error: String(e?.message ?? e) } }
    }
    return { clean, host }
  }

  /* ───────────── 发现仓库 ───────────── */

  /**
   * 找要同步的仓库。
   * ⭐ 只认 workspaceRoot **下一层**带 .git 的目录，不递归深挖 ——
   *   递归会把 node_modules 里的东西也扫出来。
   */
  /**
   * 读一个目录的插件身份。
   * 判据：package.json 里有 dsh.bundle 或 dsh.client —— 这是 DSH 插件的标志，
   *       普通仓库（比如 dsh-private 汇总库）没有。
   */
  function pluginMeta(dir) {
    const pkgFile = join(dir, 'package.json')
    if (!existsSync(pkgFile)) return { isPlugin: false }
    try {
      const p = JSON.parse(readFileSync(pkgFile, 'utf8'))
      const dsh = p?.dsh || {}
      const isPlugin = Boolean(dsh.bundle || dsh.client)
      return {
        isPlugin,
        pkgName: String(p.name || ''),
        pkgVersion: String(p.version || ''),
        hasBundle: Boolean(dsh.bundle),
        hasClient: Boolean(dsh.client),
      }
    } catch {
      return { isPlugin: false, pkgError: true }
    }
  }

  function discoverRepos() {
    refresh()
    const root = cfg.workspaceRoot
    if (!root || !existsSync(root)) return []

    // 排除名单：逗号或换行分隔的目录名（也支持通配 *）
    const pats = String(cfg.excludeNames || '')
      .split(/[,\n]+/).map((x) => x.trim()).filter(Boolean)
    const excluded = (name) => pats.some((p) => {
      if (p.includes('*')) {
        const re = new RegExp('^' + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$')
        return re.test(name)
      }
      return p === name
    })

    // ⭐ 人工确认：selection.json 里记着「哪些仓库要同步」
    //    onlySelected=false（默认）⇒ 全同步；true ⇒ 只同步勾选过的
    const sel = readJson(selFile, null)
    const selectedDirs = new Set(Array.isArray(sel?.selected) ? sel.selected : [])
    const selectedNames = new Set(Array.isArray(sel?.names) ? sel.names : [])
    const keep = (dir, name) => {
      if (!cfg.onlySelected) return true
      return selectedDirs.has(dir) || selectedNames.has(name)
    }

    const out = []
    const seen = new Set()
    let names = []
    try { names = readdirSync(root) } catch { names = [] }
    for (const n of names) {
      if (n.startsWith('.')) continue
      if (excluded(n)) continue
      const dir = join(root, n)
      try { if (!statSync(dir).isDirectory()) continue } catch { continue }
      if (!existsSync(join(dir, '.git'))) continue
      if (!keep(dir, n)) continue
      out.push({ name: n, dir, ...pluginMeta(dir) })
      seen.add(dir)
    }

    // ⭐ 额外仓库：不在 workspaceRoot 下面的（比如 ~/dsh-private 这种汇总库）
    for (const raw of String(cfg.extraRepos || '').split(/[,\n]+/)) {
      const dir = raw.trim()
      if (!dir || !dir.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(dir)) continue
      if (seen.has(dir)) continue
      if (!existsSync(join(dir, '.git'))) continue
      const nm = basename(dir)
      if (!keep(dir, nm)) continue
      out.push({ name: nm, dir, ...pluginMeta(dir) })
      seen.add(dir)
    }
    return out
  }

  /**
   * 列出**全部候选**仓库（不受 selection 过滤），给设置页的勾选表用。
   * 和 discoverRepos 的区别：这个只用于展示与选择，不参与同步。
   */
  function scanAll() {
    refresh()
    const root = cfg.workspaceRoot
    const sel = readJson(selFile, null)
    const selectedDirs = new Set(Array.isArray(sel?.selected) ? sel.selected : [])
    const selectedNames = new Set(Array.isArray(sel?.names) ? sel.names : [])
    const isSelected = (dir, name) => selectedDirs.has(dir) || selectedNames.has(name)
    const pats = String(cfg.excludeNames || '').split(/[,\n]+/).map((x) => x.trim()).filter(Boolean)
    const excluded = (name) => pats.some((p) => {
      if (p.includes('*')) {
        const re = new RegExp('^' + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$')
        return re.test(name)
      }
      return p === name
    })

    const rows = []
    const seen = new Set()
    if (root && existsSync(root)) {
      let names = []
      try { names = readdirSync(root) } catch { names = [] }
      for (const n of names) {
        if (n.startsWith('.')) continue
        if (excluded(n)) continue
        const dir = join(root, n)
        try { if (!statSync(dir).isDirectory()) continue } catch { continue }
        if (!existsSync(join(dir, '.git'))) continue
        rows.push({ name: n, dir, selected: isSelected(dir, n), excluded: false, ...pluginMeta(dir) })
        seen.add(dir)
      }
    }
    for (const raw of String(cfg.extraRepos || '').split(/[,\n]+/)) {
      const dir = raw.trim()
      if (!dir) continue
      if (!dir.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(dir)) continue
      if (seen.has(dir)) continue
      if (!existsSync(join(dir, '.git'))) continue
      const nm = basename(dir)
      rows.push({ name: nm, dir, selected: isSelected(dir, nm), excluded: false, ...pluginMeta(dir) })
      seen.add(dir)
    }
    return rows
  }

  /* ───────────── 同步一轮 ───────────── */

  let running = false

  async function syncOnce(why = 'timer') {
    if (running) return { ok: false, busy: true }
    refresh()
    if (!cfg.enabled && why === 'timer') return { ok: false, disabled: true }

    running = true
    const startedAt = Date.now()

    // ⭐ 0) 先跑采集脚本（把 ~/.dsh/ 里可同步的配置采到暂存仓库）
    //    只在配置了脚本时跑；失败不算整轮失败，但要在日志里说清。
    if (cfg.collectScript) {
      const script = String(cfg.collectScript).trim()
      if (existsSync(script)) {
        const r = await runShell('bash', [script], 120_000)
        if (!r.ok) logf(`采集脚本失败（继续同步其余仓库）：${r.err || r.out || 'exit ' + r.code}`)
        else logf('采集脚本跑完了')
      } else {
        logf(`采集脚本不存在，跳过：${script}`)
      }
    }

    // ⭐ 0.5) 镜像：把采集产出的目录复制到目标目录（比如 dsh-config → dsh-private/config）
    //    每行格式：源绝对路径 => 目标绝对路径
    //    为什么要这一步：采集脚本只把 ~/.dsh 的东西写进暂存仓库，
    //    暂存仓库本身没有 remote、也不在同步范围里 —— 得靠这个把它搬进真正会推的仓库。
    if (cfg.mirrors) {
      for (const raw of String(cfg.mirrors).split('\n')) {
        const line = raw.trim()
        if (!line || line.startsWith('#')) continue
        const m = line.match(/^(.+?)\s*=>\s*(.+)$/)
        if (!m) { logf(`镜像规则格式不对，跳过：${line}`); continue }
        const src = m[1].trim()
        const dst = m[2].trim()
        if (!existsSync(src)) { logf(`镜像源不存在，跳过：${src}`); continue }
        const r = await runShell('rsync', ['-a', '--delete', '--exclude=.git', src + '/', dst + '/'], 120_000)
        if (!r.ok) logf(`镜像失败 ${src} → ${dst}：${r.err || r.out || 'exit ' + r.code}`)
        else logf(`已镜像 ${src} → ${dst}`)
      }
    }

    const repos = discoverRepos()
    const results = []
    const stamp = new Date()
    const pad = (n) => String(n).padStart(2, '0')
    const defaultMsg = `chore: 自动同步 ${stamp.getFullYear()}-${pad(stamp.getMonth() + 1)}-${pad(stamp.getDate())} ${pad(stamp.getHours())}:${pad(stamp.getMinutes())}`
    const message = String(cfg.commitMessage || '').trim() || defaultMsg

    try {
      for (const r of repos) {
        const one = { name: r.name, dir: r.dir, committed: false, pushed: false }

        const info = await inspect(r.dir)
        if (!info.ok) {
          one.skipped = info.skip
          one.detail = info.skip === 'no-origin' ? '没有配置 origin'
            : info.skip === 'not-a-repo' ? '不是 git 仓库'
              : info.skip === 'detached' ? '处于 detached HEAD 状态'
                : String(info.skip)
          results.push(one)
          continue
        }

        one.branch = info.branch

        // ① 提交
        const c = await commitAll(r.dir, message)
        one.committed = c.committed
        if (c.reason && c.reason !== 'clean') {
          if (c.reason.startsWith('commit-failed') || c.reason.startsWith('add-failed') || c.reason === 'status-failed') {
            one.error = c.reason
            results.push(one)
            continue
          }
        }

        // ② 推送（前提：确实领先远程）
        const after = await inspect(r.dir)
        if (after.behind && after.behind > 0) {
          one.conflict = true
          one.detail = `落后远程 ${after.behind} 个提交，需要手动 pull`
          results.push(one)
          continue
        }
        if (after.ahead && after.ahead > 0) {
          const p = await push(r.dir, after.branch)
          one.pushed = p.pushed
          if (p.conflict) { one.conflict = true; one.detail = p.reason }
          else if (!p.pushed) one.error = p.reason
        } else {
          one.detail = one.committed ? '已提交，无需推送' : '已是最新'
        }

        one.last = await lastCommit(r.dir)
        results.push(one)
      }

      const okCount = results.filter((r) => !r.error && !r.conflict).length
      const pushedCount = results.filter((r) => r.pushed).length
      const summary = `同步完成（${why}）：${results.length} 个仓库，${okCount} 个正常，${pushedCount} 个推送`
      logf(summary)
      for (const r of results) {
        if (r.error) logf(`  ✗ ${r.name}: ${r.error}`)
        else if (r.conflict) logf(`  ⚠ ${r.name}: ${r.detail}`)
        else if (r.pushed) logf(`  ✓ ${r.name}: 已推送 ${r.last || ''}`)
        else if (r.skipped) logf(`  - ${r.name}: 跳过（${r.detail}）`)
      }

      const state = {
        at: Date.now(),
        why,
        tookMs: Date.now() - startedAt,
        repos: results,
        summary,
      }
      writeJson(stateFile, state)
      return { ok: true, ...state }
    } finally {
      running = false
    }
  }

  /* ───────────── 定时器 ───────────── */

  let timer = null
  function startTimer() {
    try {
      if (timer) { clearInterval(timer); timer = null }
      const mins = Math.max(1, Number(cfg.intervalMinutes) || 15)
      timer = setInterval(() => { syncOnce('timer').catch((e) => logf('定时同步异常：' + String(e?.message ?? e))) }, mins * 60_000)
      timer.unref?.()
      logf(`自动同步已开（每 ${mins} 分钟）· 工作区：${cfg.workspaceRoot}`)
    } catch (e) { logf('启定时器失败：' + String(e?.message ?? e)) }
  }

  /* ───────────── HTTP ───────────── */

  const sendJson = (res, code, obj) => {
    try {
      res.statusCode = code
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.end(JSON.stringify(obj))
    } catch { /* 忽略 */ }
  }

  const sameOriginOk = (req) => {
    try {
      const origin = String(req.headers?.origin || '')
      const host = String(req.headers?.host || '')
      if (!origin) return true
      const u = new URL(origin)
      return u.host === host && (u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '::1')
    } catch { return false }
  }

  const statusOf = () => {
    refresh()
    const st = readJson(stateFile, null)
    const repos = discoverRepos().map((r) => {
      const prev = (st?.repos || []).find((x) => x.name === r.name)
      return { name: r.name, dir: r.dir, ...(prev || {}) }
    })
    return {
      ok: true,
      ...unwrapVolatile(cfg),
      repos,
      lastRun: st ? { at: st.at, why: st.why, summary: st.summary, tookMs: st.tookMs } : null,
      running,
      home: stateDir,
      log: logFile,
    }
  }

  async function handle(req, res, url) {
    if (!sameOriginOk(req)) return sendJson(res, 403, { ok: false, error: '只接受本机同源请求' })
    const path = url.pathname.slice(API.length) || '/status'

    if (path === '/status' && req.method === 'GET') return sendJson(res, 200, statusOf())

    if (path === '/save' && req.method === 'POST') {
      let body = ''
      for await (const chunk of req) body += chunk
      let patch = null
      try { patch = JSON.parse(body || '') } catch { return sendJson(res, 400, { ok: false, error: '请求体不是 JSON' }) }
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
        return sendJson(res, 400, { ok: false, error: '要保存的字段得是一个对象' })
      }
      const out = await saveCfg(patch)
      // 间隔改了要重启定时器
      if ('intervalMinutes' in patch || 'enabled' in patch) startTimer()
      return sendJson(res, 200, { ok: true, host: out.host, status: statusOf() })
    }

    if (path === '/sync' && req.method === 'POST') {
      const r = await syncOnce('manual')
      return sendJson(res, 200, { ok: true, ...r, status: statusOf() })
    }

    if (path === '/repos' && req.method === 'GET') {
      return sendJson(res, 200, {
        ok: true,
        workspaceRoot: cfg.workspaceRoot,
        onlySelected: Boolean(cfg.onlySelected),
        repos: scanAll(),
      })
    }

    if (path === '/select' && req.method === 'POST') {
      let body = ''
      for await (const chunk of req) body += chunk
      let patch = null
      try { patch = JSON.parse(body || '') } catch { return sendJson(res, 400, { ok: false, error: '请求体不是 JSON' }) }
      if (!patch || typeof patch !== 'object') return sendJson(res, 400, { ok: false, error: '要一个对象' })

      const selected = Array.isArray(patch.selected) ? patch.selected.filter((x) => typeof x === 'string') : []
      const names = Array.isArray(patch.names) ? patch.names.filter((x) => typeof x === 'string') : []
      writeJson(selFile, { selected, names, at: Date.now() })

      if (typeof patch.onlySelected === 'boolean') {
        await saveCfg({ onlySelected: patch.onlySelected })
      }
      return sendJson(res, 200, { ok: true, repos: scanAll(), onlySelected: Boolean(cfg.onlySelected) })
    }

    if (path === '/inspect' && req.method === 'POST') {
      // 只读：看每个仓库的状态，不改任何东西
      const rows = []
      for (const r of discoverRepos()) {
        const i = await inspect(r.dir)
        rows.push({ name: r.name, ...i })
      }
      return sendJson(res, 200, { ok: true, repos: rows })
    }

    return sendJson(res, 404, { ok: false, error: '没有这个接口' })
  }

  try {
    if (ctx.webServer?.register) {
      ctx.effect(() => ctx.webServer.register({
        kind: 'prefix',
        path: API,
        handler: async (req, res) => {
          try { await handle(req, res, new URL(req.url, 'http://127.0.0.1')) }
          catch (e) { sendJson(res, 500, { ok: false, error: String(e?.message ?? e) }) }
        },
      }), 'repo-sync: 设置页接口')
    }
  } catch (e) { logf('HTTP 路由没挂上：' + String(e?.message ?? e)) }

  try { startTimer() } catch { /* 已在内部记日志 */ }
  ctx.effect(() => () => { try { if (timer) clearInterval(timer) } catch { /* 忽略 */ } }, 'repo-sync: 定时器')

  if (cfg.pushOnStart) {
    const t = setTimeout(() => { syncOnce('startup').catch(() => {}) }, 10_000)
    t.unref?.()
  }

  logf(`已挂载（家=${stateDir}，工作区=${cfg.workspaceRoot}）`)
}

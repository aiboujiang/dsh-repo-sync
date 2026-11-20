/**
 * lib/git.mjs —— 对一个仓库执行「该不该提交 / 该不该推 / 推得动吗」
 *
 * 为什么单独拆出来：这层逻辑全是 git 命令的边界情况，值得独立测试。
 * 不 import 任何宿主服务，可以拿 node 直接跑。
 *
 * 设计原则（都是踩过的坑）：
 *   ① **不自动 git init** —— 目录里没有 .git 就跳过，绝不替用户建仓库
 *   ② **不自动建远程仓库** —— 没有 origin 就跳过，只记原因
 *   ③ **不 force push** —— 远程有本地没有的提交时，报冲突让人处理
 *   ④ **不用 --no-verify** —— 用户的 hook 该跑就跑
 *   ⑤ 提交信息带时间戳，便于回溯
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** 跑一条 git 命令，返回 { ok, code, out, err } —— 永不抛 */
export function git(dir, args, opts = {}) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn('git', args, {
        cwd: dir,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          // 防止 git 因为没有终端而卡在交互式输入（比如要密码）
          GIT_TERMINAL_PROMPT: '0',
          // 别让 git 用编辑器打开提交信息
          GIT_EDITOR: 'true',
          ...(opts.env || {}),
        },
      })
    } catch (e) {
      return resolve({ ok: false, code: -1, out: '', err: String(e?.message ?? e) })
    }

    let out = ''
    let err = ''
    child.stdout?.on('data', (b) => { out += b.toString('utf8') })
    child.stderr?.on('data', (b) => { err += b.toString('utf8') })

    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* 已经没了 */ }
    }, opts.timeoutMs ?? 120_000)
    timer.unref?.()

    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ ok: false, code: -1, out, err: err + String(e?.message ?? e) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ ok: code === 0, code, out: out.trim(), err: err.trim() })
    })
  })
}

/** 这个目录是不是一个 git 仓库（找 .git，不往上冒泡） */
export function isRepo(dir) {
  try { return existsSync(join(dir, '.git')) } catch { return false }
}

/** 当前分支名（detached 时返回 HEAD 之类的值） */
export async function currentBranch(dir) {
  const r = await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])
  return r.ok ? r.out : ''
}

/** 有没有配置 origin */
export async function hasOrigin(dir) {
  const r = await git(dir, ['remote', 'get-url', 'origin'])
  return r.ok && r.out !== ''
}

/** 工作区是不是干净的（含未跟踪文件） */
export async function isClean(dir) {
  const r = await git(dir, ['status', '--porcelain'])
  if (!r.ok) return null // 读不出来就说不知道，别当成"干净"
  return r.out === ''
}

/** 本地领先远程多少个提交；远程不存在时返回 null */
export async function aheadCount(dir, branch) {
  const r = await git(dir, ['rev-list', '--count', `origin/${branch}..HEAD`])
  if (!r.ok) return null
  const n = Number(r.out)
  return Number.isFinite(n) ? n : null
}

/** 本地落后远程多少个提交 */
export async function behindCount(dir, branch) {
  const r = await git(dir, ['rev-list', '--count', `HEAD..origin/${branch}`])
  if (!r.ok) return null
  const n = Number(r.out)
  return Number.isFinite(n) ? n : null
}

/**
 * 检查一个仓库能不能安全推送。
 * @returns {Promise<{ok:boolean, skip?:string, reason?:string, branch?:string, ahead?:number, behind?:number}>}
 */
export async function inspect(dir) {
  if (!isRepo(dir)) return { ok: false, skip: 'not-a-repo' }
  if (!(await hasOrigin(dir))) return { ok: false, skip: 'no-origin' }

  const branch = await currentBranch(dir)
  if (!branch) return { ok: false, skip: 'detached' }

  // 先 fetch 一次，才知道远程真实状态（fetch 失败不致命，可能只是断网）
  await git(dir, ['fetch', '--quiet', 'origin'], { timeoutMs: 60_000 })

  const ahead = await aheadCount(dir, branch)
  const behind = await behindCount(dir, branch)
  return { ok: true, branch, ahead, behind }
}

/**
 * 提交工作区改动（如果有）。
 * @returns {Promise<{committed:boolean, reason?:string}>}
 */
export async function commitAll(dir, message) {
  const clean = await isClean(dir)
  if (clean === true) return { committed: false, reason: 'clean' }
  if (clean === null) return { committed: false, reason: 'status-failed' }

  const add = await git(dir, ['add', '-A'])
  if (!add.ok) return { committed: false, reason: 'add-failed: ' + add.err }

  // add 之后可能又没有实际差异（比如只有被忽略的文件变了）
  const staged = await git(dir, ['diff', '--cached', '--quiet'])
  if (staged.ok) return { committed: false, reason: 'nothing-staged' }

  const c = await git(dir, ['commit', '-m', message])
  if (!c.ok) {
    // 用户可能配了 pre-commit 钩子并拒绝了提交 —— 如实报，不绕过
    return { committed: false, reason: 'commit-failed: ' + (c.err || c.out) }
  }
  return { committed: true }
}

/**
 * 推送。
 * ⚠️ 落后远程时**不推**：那意味着别人（或另一台机器）推过东西，
 *    直接推会被拒；force 推会覆盖别人的提交。两种都不该自动做。
 */
export async function push(dir, branch) {
  const behind = await behindCount(dir, branch)
  if (behind !== null && behind > 0) {
    return { pushed: false, conflict: true, reason: `落后远程 ${behind} 个提交，需要先 pull` }
  }
  const r = await git(dir, ['push', 'origin', branch], { timeoutMs: 180_000 })
  if (!r.ok) return { pushed: false, reason: r.err || r.out }
  return { pushed: true }
}

/** 最近一次提交的简述 */
export async function lastCommit(dir) {
  const r = await git(dir, ['log', '-1', '--pretty=%h %s'])
  return r.ok ? r.out : ''
}

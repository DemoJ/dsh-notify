/**
 * dsh-notify — DSH Host 插件：需要人介入时主动弹系统通知。
 *
 * 通知格式约定 —— 标题只说"现在是什么状态"，细节一律进正文：
 *
 *   场景                          标题            正文
 *   工具需要用户审批              ⚠️ 需要审批     需要审批：工具「×」正在等待你的授权 — 原因
 *   被沙箱/审批/权限规则拒绝      ⚠️ 权限问题     权限问题：工具「×」执行被拒绝 — 原因
 *   工具在等你回答问题            ❓ 需要回答     需要回答：问题正文（共 N 个问题）
 *   任务完成（Agent 转为 idle）   ✅ 任务完成     任务完成：本轮处理已结束
 *
 * 四类时机的来源事件：
 *  1. 等审批        —— `approval/request`（并在审批落地后补一条拒绝/取消）
 *  2. 被拒绝        —— `tools/result` 的失败结果里识别沙箱标记与提权拒绝
 *  3. 等你回答      —— `user-questions/request`。`ask_user_question` 走的是这条，
 *                      和审批不是同一个事件；而且提问期间 Agent 仍是 running，
 *                      所以「任务完成」也不会覆盖这一段，必须单独监听。
 *  4. 任务完成      —— `agent/status` 的 running → idle 转换
 *
 * 为什么完成用 idle 而不是 `turn/end`：`turn/end` 只是"这一轮关了"，goal 自动续轮时
 * 会一轮一条，而且 agent 还在干活；`idle` 才真正等于"驱动已停下、在等你"。
 * `turn/end` 在这里只负责记账（轮次号与结束原因），供 idle 时取用。
 *
 * 设计约束：
 *  - 只 import Node 内置模块与 schemastery，其余通过 Cordis 事件观察，
 *    因此不需要 inject 任何 Service，装载顺序不会成为失败点。
 *  - 所有发送都包在 try/catch 里：通知失败绝不能影响工具调用或对话本身。
 *  - 每个 hook 都原样透传流水线返回值，本插件对会话状态是只读的。
 *
 * @module dsh-notify
 */

import { spawn } from 'node:child_process'
import { appendFile } from 'node:fs/promises'
import { homedir, platform as hostPlatform } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'

export const name = 'dsh-notify'

export const Config = z.object({
  /** 工具开始等待审批时通知。 */
  approvals: z.boolean().default(true),
  /** 审批结果为拒绝/取消/无通道时，再补一条「权限问题」。 */
  approvalOutcomes: z.boolean().default(true),
  /** 被沙箱拒绝、或被拒绝提权时通知。 */
  denials: z.boolean().default(true),
  /** 工具在等你回答问题（`ask_user_question`）时通知。 */
  questions: z.boolean().default(true),
  /** Agent 转为 idle（本轮处理结束）时通知。 */
  completion: z.boolean().default(true),
  /** 只通知主会话，忽略子代理（subagent）自己的轮次。 */
  rootSessionsOnly: z.boolean().default(true),
  /** 短于该时长的轮次不通知（毫秒）；0 表示每轮都通知。 */
  minTurnMs: z.number().default(0),
  /** 通知通道；auto 按平台选择。 */
  backend: z.union([z.const('auto'), z.const('toast'), z.const('log')]).default('auto'),
  /** Windows 通知使用的 AppUserModelID；默认复用 DeepSeek Harness 已注册的那个。 */
  appId: z.string().default('com.deepseek.dsh'),
  /** 通知是否播放提示音。 */
  sound: z.boolean().default(true),
  /** 同一事件的去重窗口（毫秒），防止一次审批弹两次。 */
  dedupeWindowMs: z.number().default(1500),
  /**
   * 完成通知的正文里附上回答预览的字符数。
   * 默认 0（关闭），此时正文严格是「任务完成：本轮处理已结束」。
   */
  bodyPreviewChars: z.number().default(0),
  /** 把每次通知追加写入 ~/.dsh/dsh-notify.log，便于排查。 */
  debug: z.boolean().default(false),
})

const HERE = dirname(fileURLToPath(import.meta.url))
const TOAST_SCRIPT = join(HERE, 'toast.ps1')
const DEBUG_LOG = join(homedir(), '.dsh', 'dsh-notify.log')

/** 会话是否为主会话：从 session/event 拿到的 header 记账。 */
const sessionIsRoot = new Map()
/** 每个会话最近一次 turn/end 的 { turn, reason, error }，由 idle 消费一次。 */
const pendingTurn = new Map()
/** 每个会话本轮开始时间，用于 minTurnMs。 */
const turnStartedAt = new Map()
/** 每个 Agent 上一次的 status，用于识别 running → idle 这个真实转换。 */
const lastStatus = new Map()
/** 每个会话最近一条回答，仅当 bodyPreviewChars > 0 时才收集。 */
const previewStore = new Map()
const MAX_PREVIEW_SESSIONS = 64

/** @param {unknown} value @returns {string} */
function text(value) {
  return typeof value === 'string' ? value : ''
}

/** 从 ContentBlock[] 里取出所有 text 块并拼接。 @param {unknown} content @returns {string} */
function textFromContent(content) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block !== null && typeof block === 'object' && block.type === 'text') {
      const value = text(block.text)
      if (value !== '') parts.push(value)
    }
  }
  return parts.join(' ')
}

/**
 * 把 Markdown 压成适合通知横幅的纯文本。
 * 刻意不处理 `_斜体_`：工具名和错误码里全是下划线
 * （`FS_SANDBOX_DENIED` 会被吃成 `FSSANDBOXDENIED`），得不偿失。
 * @param {string} value
 */
function plainText(value) {
  return value
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 折叠空白并截断，保证正文是适合通知横幅的一行。 @param {string} value @param {number} limit */
function condense(value, limit) {
  const flat = plainText(value)
  if (limit <= 0 || flat.length <= limit) return flat
  return `${flat.slice(0, Math.max(0, limit - 1))}…`
}

/** 审批理由可能是字符串，也可能是 `{ en, zh, ... }` 这种本地化映射。 @param {unknown} reason */
function reasonText(reason) {
  if (typeof reason === 'string') return reason
  if (reason === null || typeof reason !== 'object') return ''
  const map = /** @type {Record<string, unknown>} */ (reason)
  for (const key of ['zh', 'zh-CN', 'zh-Hans', 'en']) {
    const value = text(map[key])
    if (value !== '') return value
  }
  for (const value of Object.values(map)) {
    const found = text(value)
    if (found !== '') return found
  }
  return ''
}

/** 从拒绝文本里挑出最像"原因"的那一行。 @param {string} value */
function markerLine(value) {
  const marker = value.match(/\[sandbox:[^\]]*\]/)
  if (marker !== null) return marker[0]
  for (const line of value.split('\n')) {
    const trimmed = line.trim()
    if (trimmed !== '') return trimmed
  }
  return ''
}

/** 会话是否为顶层会话（非子代理派生）。 @param {unknown} session */
function isRootSession(session) {
  try {
    const header = session?.header
    if (header === undefined || header === null) return true
    if (header.parentSession !== undefined) return false
    if (header.origin === 'subagent') return false
    if (typeof header.delegationDepth === 'number' && header.delegationDepth > 0) return false
    return true
  } catch {
    // header 是活对象；读不到就按"是主会话"处理，宁可多提醒也不要漏。
    return true
  }
}

/**
 * 判断一次工具失败是不是权限拒绝，并归纳成一句中文原因。
 * @param {any} result - `tools/result` 的 ToolExecutionResult
 * @returns {{ reason: string } | null}
 */
function detectDenial(result) {
  const evidence = []
  const failure = result?.error
  if (failure !== undefined && failure !== null) {
    evidence.push(text(failure.message), text(failure.info?.code), text(failure.info?.reason))
  }
  evidence.push(textFromContent(result?.content))
  const joined = evidence.filter(Boolean).join('\n')
  if (joined === '') return null

  if (/FS_SANDBOX_DENIED|file access denied under|\[sandbox:/i.test(joined)) {
    const mode = joined.match(/file access denied under ([\w-]+) mode/i)?.[1]
    return { reason: mode === undefined ? '被沙箱拦截' : `沙箱拒绝（${mode} 模式）` }
  }
  if (/rejected escalating/i.test(joined)) return { reason: '提权审批被拒绝' }
  if (/approval for escalating .* was cancelled/i.test(joined)) return { reason: '提权审批被取消' }
  if (/requires approval, but no approval|no approval channel/i.test(joined)) return { reason: '没有可用的审批通道' }
  return null
}

/** 追加一行 JSON 诊断日志；失败静默，绝不冒泡。 @param {Record<string, unknown>} entry */
async function debugLog(entry) {
  try {
    await appendFile(DEBUG_LOG, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, 'utf8')
  } catch {
    /* 诊断日志的失败不值得影响任何事 */
  }
}

/** 按平台派发一条系统通知。任何异常都被吞掉。 @param {any} config @param {{title: string, body: string, urgent?: boolean}} message */
function deliver(config, message) {
  try {
    if (config.debug) void debugLog({ title: message.title, body: message.body })
    if (config.backend === 'log') {
      console.log(`[dsh-notify] ${message.title} — ${message.body}`)
      return
    }

    const platform = hostPlatform()
    if (platform === 'win32') {
      const args = [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        TOAST_SCRIPT,
        // 需要人做决定的（审批、权限）横幅停留久一点；完成通知用默认时长。
        '-Duration',
        message.urgent === true ? 'long' : 'short',
        '-AppId',
        String(config.appId),
        '-Title',
        message.title,
        '-Body',
        message.body,
      ]
      if (!config.sound) args.push('-Silent')
      const child = spawn('powershell.exe', args, { windowsHide: true, stdio: 'ignore' })
      child.on('error', (error) => {
        console.warn(`dsh-notify: 无法启动 powershell.exe — ${error.message}`)
      })
      child.on('exit', (code) => {
        if (code !== 0 && code !== null) console.warn(`dsh-notify: toast 发送失败（退出码 ${code}）`)
      })
      return
    }

    if (platform === 'darwin') {
      const quote = (value) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
      const child = spawn('osascript', ['-e', `display notification ${quote(message.body)} with title ${quote(message.title)}`], {
        stdio: 'ignore',
      })
      child.on('error', () => {})
      return
    }

    const child = spawn('notify-send', [message.title, message.body], { stdio: 'ignore' })
    child.on('error', () => {})
  } catch (error) {
    console.warn(`dsh-notify: 通知发送异常 — ${String(error)}`)
  }
}

/** 非 completed 的结束原因各自的状态标题与正文。 @param {string} reason @param {string} detail */
function settleMessage(reason, detail) {
  switch (reason) {
    case 'error':
      return { title: '❌ 任务出错', body: `任务出错：本轮处理异常结束${detail === '' ? '' : ` — ${detail}`}` }
    case 'aborted':
    case 'interrupted':
      return { title: '⏹️ 任务已中止', body: '任务已中止：本轮处理被中断' }
    case 'blocked':
      return { title: '⛔ 任务被阻止', body: '任务被阻止：本轮处理被策略阻止' }
    case 'max-tokens':
      return { title: '⚠️ 达到输出上限', body: '达到输出上限：本轮处理被截断' }
    default:
      return { title: '✅ 任务完成', body: '任务完成：本轮处理已结束' }
  }
}

/**
 * 安装监听器。
 * @param {any} ctx - 插件上下文；监听器随 fiber 一起释放。
 * @param {any} config - 已经过 {@link Config} 校验并填好默认值的配置。
 */
export function apply(ctx, config) {
  /** 去重表：key → 上次通知时间。 */
  const recent = new Map()

  /** 同一条事件在窗口期内只通知一次（审批链路存在多点触发的可能）。 @param {string} key */
  function allow(key) {
    const now = Date.now()
    const last = recent.get(key)
    if (last !== undefined && now - last < config.dedupeWindowMs) return false
    recent.set(key, now)
    if (recent.size > 256) {
      for (const [existing, at] of recent) {
        if (now - at > 60_000) recent.delete(existing)
      }
    }
    return true
  }

  // ── 1. 等待审批 + 审批结果（都是「⚠️ 需要审批 / ⚠️ 权限问题」）──────────────
  if (config.approvals || config.approvalOutcomes) {
    ctx.on('approval/request', async (req, next) => {
      const toolName = text(req?.toolName) || '未知工具'
      const callKey = text(req?.callId) || toolName
      const reason = condense(reasonText(req?.displayReason) || text(req?.reason), 120)

      if (config.approvals && allow(`ask:${callKey}`)) {
        deliver(config, {
          title: '⚠️ 需要审批',
          body: `需要审批：工具「${toolName}」正在等待你的授权${reason === '' ? '' : ` — ${reason}`}`,
          urgent: true,
        })
      }

      // 原样透传流水线结果 —— 本插件只在旁边观察，不参与决策。
      const outcome = await next()

      if (config.approvalOutcomes) {
        const reason = {
          rejected: '你拒绝了这次操作',
          cancelled: '审批被取消，操作未执行',
          unavailable: '没有可用的审批通道，操作未执行',
        }[outcome]
        if (reason !== undefined && allow(`outcome:${callKey}:${outcome}`)) {
          deliver(config, {
            title: '⚠️ 权限问题',
            body: `权限问题：工具「${toolName}」执行被拒绝 — ${reason}`,
            urgent: true,
          })
        }
      }

      return outcome
    })
  }

  // ── 2. 工具在等你回答问题 ────────────────────────────────────────────────
  // 同样是 waterfall：必须 next() 并把答案原样返回，否则"问—答"这条链路就断了。
  if (config.questions) {
    ctx.on('user-questions/request', async (request, next) => {
      // 通知可能在任意环节抛错，但绝不能连累提问本身 —— 所以 next() 放在 try 外面。
      try {
        const questions = Array.isArray(request?.questions) ? request.questions : []
        const first = questions[0]
        const asked = condense(text(first?.question) || text(first?.header) || text(first?.detail), 120)
        const callKey = text(request?.wait?.callId) || text(first?.id) || 'question'
        if (allow(`ask-q:${callKey}`)) {
          const more = questions.length > 1 ? `（共 ${questions.length} 个问题）` : ''
          deliver(config, {
            title: '❓ 需要回答',
            body: `需要回答：${asked === '' ? '有一个问题在等你' : asked}${more}`,
            urgent: true,
          })
        }
      } catch (error) {
        console.warn(`dsh-notify: 处理 user-questions/request 失败 — ${String(error)}`)
      }
      return await next()
    })
  }

  // ── 3. 被沙箱 / 提权审批拒绝 ──────────────────────────────────────────────
  if (config.denials) {
    ctx.on('tools/result', (exec, result) => {
      // 成功结果里也可能出现 `[sandbox:` 文本，但只有失败才叫拒绝。
      if (result?.isError !== true) return
      const denial = detectDenial(result)
      if (denial === null) return

      const toolName = text(exec?.name) || '未知工具'
      const key = `deny:${text(exec?.callId) || toolName}`
      if (!allow(key)) return

      deliver(config, {
        title: '⚠️ 权限问题',
        body: `权限问题：工具「${toolName}」执行被拒绝 — ${denial.reason}`,
        urgent: true,
      })
    })
  }

  // ── 4. 记账：会话归属、轮次边界、结束原因 ────────────────────────────────
  // 这一条只写内存，不发通知；完成的时机由下面的 agent/status 决定。
  ctx.on('session/event', (session, event) => {
    try {
      const id = String(session?.id ?? '')
      if (id === '') return

      if (!sessionIsRoot.has(id)) sessionIsRoot.set(id, isRootSession(session))

      if (event?.type === 'turn/start') {
        turnStartedAt.set(id, Date.now())
        return
      }

      if (event?.type === 'assistant/message') {
        if (config.bodyPreviewChars <= 0) return
        const body = textFromContent(event.data?.message?.content)
        if (body === '') return
        if (previewStore.size >= MAX_PREVIEW_SESSIONS && !previewStore.has(id)) {
          const oldest = previewStore.keys().next()
          if (!oldest.done) previewStore.delete(oldest.value)
        }
        previewStore.set(id, body)
        return
      }

      if (event?.type !== 'turn/end') return

      // 每次都覆盖记账（包括 forked）：给下一次 idle 留一条陈旧的结束原因，
      // 会让"完成"通知报出上一轮的原因。forked 本身由 idle 那边跳过。
      pendingTurn.set(id, {
        turn: event.data?.turn,
        reason: text(event.data?.reason?.kind) || 'completed',
        error: condense(text(event.data?.reason?.error?.message), 120),
      })
    } catch (error) {
      // session/event 是"投递后不阻塞"的广播；这里抛错会被记进日志，但不要制造噪音源。
      console.warn(`dsh-notify: 处理 session/event 失败 — ${String(error)}`)
    }
  })

  // ── 5. 任务完成：running → idle ──────────────────────────────────────────
  if (config.completion) {
    ctx.on('agent/status', ({ agent, status } = {}) => {
      try {
        const id = String(agent?.id ?? '')
        if (id === '') return

        const previous = lastStatus.get(id)
        lastStatus.set(id, status)
        // 只认真正的 running → idle 转换：既放过"装载时本来就是 idle"，
        // 也避免 idle 被重复广播时连发。
        if (status !== 'idle' || previous !== 'running') return

        const recorded = pendingTurn.get(id)
        pendingTurn.delete(id)

        if (config.rootSessionsOnly && sessionIsRoot.get(id) === false) return
        if (config.minTurnMs > 0) {
          const startedAt = turnStartedAt.get(id)
          if (startedAt !== undefined && Date.now() - startedAt < config.minTurnMs) return
        }
        turnStartedAt.delete(id)

        const reason = recorded?.reason ?? 'completed'
        // 子代理 fork 出来的轮次不是"你的一轮结束了"。
        if (reason === 'forked') return
        if (!allow(`idle:${id}:${recorded?.turn ?? '?'}`)) return

        const message = settleMessage(reason, recorded?.error ?? '')
        const preview = config.bodyPreviewChars > 0 ? condense(text(previewStore.get(id)), config.bodyPreviewChars) : ''
        previewStore.delete(id)

        deliver(config, {
          title: message.title,
          body: preview === '' ? message.body : `${message.body} — ${preview}`,
        })
      } catch (error) {
        console.warn(`dsh-notify: 处理 agent/status 失败 — ${String(error)}`)
      }
    })
  }
}
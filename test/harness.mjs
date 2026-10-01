/**
 * 离线自测：用假的 ctx 驱动 apply()，逐条断言通知文案与触发条件。
 * 全部走 backend: 'log'，不会真的弹任何东西，可以放心跑。
 *
 * 运行： node test/harness.mjs
 */
import { Config, apply, name } from '../lib/index.js'

const listeners = new Map()
const fakeCtx = {
  on(event, listener) {
    if (!listeners.has(event)) listeners.set(event, [])
    listeners.get(event).push(listener)
    return () => {}
  },
}

let failures = 0
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`)
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`)
}

const config = Config({ backend: 'log', debug: false })
apply(fakeCtx, config)

console.log(`plugin name: ${name}`)
console.log(`registered events: ${[...listeners.keys()].join(', ')}\n`)

const emit = (event, ...args) => Promise.all(listeners.get(event).map((fn) => fn(...args)))

/** 捕获这一段里实际"发出去"的通知（backend: log 会打印）。 */
async function capture(run) {
  const lines = []
  const original = console.log
  console.log = (...args) => lines.push(args.join(' '))
  try {
    await run()
  } finally {
    console.log = original
  }
  return lines.map((line) => line.replace('[dsh-notify] ', ''))
}

const root = { id: 'session-root', header: { id: 'session-root', isSeeded: false } }
const child = { id: 'session-child', header: { id: 'session-child', isSeeded: false, parentSession: 'session-root', origin: 'subagent', delegationDepth: 1 } }

/** 让一个会话走完 running → idle。 */
async function settle(session, statuses = ['running', 'idle']) {
  for (const status of statuses) await emit('agent/status', { agent: { id: session.id }, status })
}

// ── 1. 工具等待审批 ────────────────────────────────────────────────────────
console.log('--- 工具等待审批 ---')
const askOutcome = await capture(() =>
  emit(
    'approval/request',
    {
      agent: { id: root.id },
      toolName: 'pwsh',
      callId: 'call-1',
      reason: 'write outside workspace',
      displayReason: { en: 'Write outside workspace', zh: '向工作区外写入文件' },
    },
    async () => 'allowed-once',
  ),
)
check('需要审批：标题=状态，正文=状态+工具+原因', askOutcome, ['⚠️ 需要审批 — 需要审批：工具「pwsh」正在等待你的授权 — 向工作区外写入文件'])

// ── 2. 同一 callId 立刻重复触发（历史上弹两次的那个 bug）─────────────────────
console.log('\n--- 同一 callId 重复触发（应被去重）---')
const askAgain = await capture(() => emit('approval/request', { agent: { id: root.id }, toolName: 'pwsh', callId: 'call-1' }, async () => 'allowed-once'))
check('去重生效，无第二条', askAgain, [])

// ── 3. 无原因时不留悬空破折号 ─────────────────────────────────────────────
console.log('\n--- 审批无原因 ---')
const askNoReason = await capture(() => emit('approval/request', { agent: { id: root.id }, toolName: 'read', callId: 'call-nr' }, async () => 'allowed-once'))
check('无原因时不追加破折号', askNoReason, ['⚠️ 需要审批 — 需要审批：工具「read」正在等待你的授权'])

// ── 4. 审批被拒绝 → 权限问题 ──────────────────────────────────────────────
console.log('\n--- 审批结果为 rejected ---')
const rejected = await capture(() => emit('approval/request', { agent: { id: root.id }, toolName: 'pwsh', callId: 'call-2' }, async () => 'rejected'))
check('先报「需要审批」，落地后再报「权限问题」', rejected, [
  '⚠️ 需要审批 — 需要审批：工具「pwsh」正在等待你的授权',
  '⚠️ 权限问题 — 权限问题：工具「pwsh」执行被拒绝 — 你拒绝了这次操作',
])

// ── 5. 沙箱拒绝 ────────────────────────────────────────────────────────────
console.log('\n--- 沙箱拒绝 ---')
const sandbox = await capture(() =>
  emit(
    'tools/result',
    { name: 'write', callId: 'call-3' },
    {
      isError: true,
      error: { message: 'cannot write "C:\\Windows\\x": file access denied under workspace-write mode', info: { name: 'FsError', code: 'FS_SANDBOX_DENIED' } },
      content: [],
    },
  ),
)
check('沙箱模式被解析进原因', sandbox, ['⚠️ 权限问题 — 权限问题：工具「write」执行被拒绝 — 沙箱拒绝（workspace-write 模式）'])

// ── 6. 提权审批被拒绝 ─────────────────────────────────────────────────────
console.log('\n--- 提权审批被拒绝 ---')
const escalate = await capture(() =>
  emit('tools/result', { name: 'pwsh', callId: 'call-4' }, { isError: true, error: { message: 'the user rejected escalating this command to "danger-full-access"; it stays denied' }, content: [] }),
)
check('提权拒绝归入「权限问题」', escalate, ['⚠️ 权限问题 — 权限问题：工具「pwsh」执行被拒绝 — 提权审批被拒绝'])

// ── 7. 不该通知的失败 ─────────────────────────────────────────────────────
console.log('\n--- 普通失败 / 成功文本含 [sandbox:（都应无输出）---')
const noise = await capture(async () => {
  await emit('tools/result', { name: 'read', callId: 'call-5' }, { isError: true, error: { message: 'ENOENT: no such file' }, content: [] })
  await emit('tools/result', { name: 'read', callId: 'call-6' }, { isError: false, value: null, content: [{ type: 'text', text: 'docs mention [sandbox: ...] markers' }] })
})
check('普通失败与成功结果都不通知', noise, [])

// ── 8. 任务完成：running → idle ───────────────────────────────────────────
console.log('\n--- 任务完成（Agent 转为 idle）---')
const completed = await capture(async () => {
  await emit('session/event', root, { type: 'turn/start', seq: 1, time: Date.now(), data: { turn: 7 } })
  await emit('session/event', root, { type: 'assistant/message', seq: 2, time: Date.now(), data: { turn: 7, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '**加粗** 和 `代码`' }] } } })
  await emit('session/event', root, { type: 'turn/end', seq: 3, time: Date.now(), data: { turn: 7, reason: { kind: 'completed' } } })
  await settle(root)
})
check('完成：标题=✅ 任务完成，正文不夹带预览', completed, ['✅ 任务完成 — 任务完成：本轮处理已结束'])

// ── 9. 没有 idle 转换就不通知 ─────────────────────────────────────────────
console.log('\n--- 只 turn/end、Agent 没转 idle（应无输出）---')
const noIdle = await capture(async () => {
  await emit('session/event', root, { type: 'turn/end', seq: 4, time: Date.now(), data: { turn: 8, reason: { kind: 'completed' } } })
})
check('完成通知由 idle 触发，不由 turn/end 触发', noIdle, [])

// ── 10. 装载时本来就是 idle，不该补发 ─────────────────────────────────────
console.log('\n--- Agent 首次出现即 idle（应无输出）---')
const firstIdle = await capture(() => emit('agent/status', { agent: { id: 'session-fresh' }, status: 'idle' }))
check('首次即 idle 不通知', firstIdle, [])

// ── 11. 出错轮次 ──────────────────────────────────────────────────────────
console.log('\n--- 轮次以错误结束 ---')
const errored = await capture(async () => {
  await emit('session/event', root, { type: 'turn/end', seq: 5, time: Date.now(), data: { turn: 9, reason: { kind: 'error', error: { message: 'LLM request failed: 429 rate limited', code: 'RATE_LIMIT' } } } })
  await settle(root)
})
check('出错有独立状态标题，不谎报成功', errored, ['❌ 任务出错 — 任务出错：本轮处理异常结束 — LLM request failed: 429 rate limited'])

// ── 12. 中止轮次 ──────────────────────────────────────────────────────────
console.log('\n--- 轮次被中止 ---')
const aborted = await capture(async () => {
  await emit('session/event', root, { type: 'turn/end', seq: 6, time: Date.now(), data: { turn: 10, reason: { kind: 'aborted', reason: { kind: 'user' } } } })
  await settle(root)
})
check('中止有独立状态标题', aborted, ['⏹️ 任务已中止 — 任务已中止：本轮处理被中断'])

// ── 13. 子代理不通知 ──────────────────────────────────────────────────────
console.log('\n--- 子代理 idle（应无输出）---')
const subagent = await capture(async () => {
  await emit('session/event', child, { type: 'turn/start', seq: 1, time: Date.now(), data: { turn: 1 } })
  await emit('session/event', child, { type: 'turn/end', seq: 2, time: Date.now(), data: { turn: 1, reason: { kind: 'completed' } } })
  await settle(child)
})
check('子代理轮次被 rootSessionsOnly 过滤', subagent, [])

// ── 14. forked 不算一轮结束 ───────────────────────────────────────────────
console.log('\n--- forked 轮次（应无输出）---')
const forked = await capture(async () => {
  await emit('session/event', root, { type: 'turn/end', seq: 7, time: Date.now(), data: { turn: 11, reason: { kind: 'forked' } } })
  await settle(root)
})
check('forked 轮次不通知（且不留陈旧原因给下一次 idle）', forked, [])

// ── 15. 预览可选开关 ──────────────────────────────────────────────────────
console.log('\n--- bodyPreviewChars > 0 时才附加预览 ---')
const previewListeners = new Map()
apply({ on: (e, l) => { if (!previewListeners.has(e)) previewListeners.set(e, []); previewListeners.get(e).push(l) } }, Config({ backend: 'log', bodyPreviewChars: 40 }))
const emitPreview = (event, ...args) => Promise.all(previewListeners.get(event).map((fn) => fn(...args)))
const withPreview = await capture(async () => {
  const session = { id: 'session-preview', header: { id: 'session-preview', isSeeded: false } }
  await emitPreview('session/event', session, { type: 'assistant/message', seq: 1, time: Date.now(), data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '**加粗** 和 `代码` 与 [链接](http://x) 还有 FS_SANDBOX_DENIED' }] } } })
  await emitPreview('session/event', session, { type: 'turn/end', seq: 2, time: Date.now(), data: { turn: 1, reason: { kind: 'completed' } } })
  await emitPreview('agent/status', { agent: { id: session.id }, status: 'running' })
  await emitPreview('agent/status', { agent: { id: session.id }, status: 'idle' })
})
check(
  '预览剥离 Markdown 且不破坏下划线标识符',
  withPreview,
  ['✅ 任务完成 — 任务完成：本轮处理已结束 — 加粗 和 代码 与 链接 还有 FS_SANDBOX_DENIED'],
)

// ── 16. 工具在等你回答问题（ask_user_question 走的是另一条事件）─────────────
console.log('\n--- user-questions/request ---')
const singleQ = await capture(() =>
  emit(
    'user-questions/request',
    { questions: [{ id: 'q1', question: '要我把插件放到哪个目录？', header: '目录' }], wait: { callId: 'q-call-1' }, agent: { id: root.id } },
    async () => ({ answers: [{ id: 'q1', selected: ['A'] }] }),
  ),
)
check('提问：标题=状态，正文=问题原文', singleQ, ['❓ 需要回答 — 需要回答：要我把插件放到哪个目录？'])

const multiQ = await capture(() =>
  emit(
    'user-questions/request',
    {
      questions: [{ id: 'a', question: '第一个问题' }, { id: 'b', question: '第二个问题' }, { id: 'c', question: '第三个问题' }],
      wait: { callId: 'q-call-2' },
    },
    async () => ({ answers: [] }),
  ),
)
check('多问题会标出总数', multiQ, ['❓ 需要回答 — 需要回答：第一个问题（共 3 个问题）'])

// 这是 waterfall：返回值必须原样透传，否则用户的回答会被插件吞掉。
const ANSWER = { answers: [{ id: 'x', selected: ['yes'], custom: '补充说明' }] }
let passthrough
await capture(async () => {
  passthrough = await emit('user-questions/request', { questions: [{ id: 'x', question: 'q' }], wait: { callId: 'q-call-3' } }, async () => ANSWER)
})
check('答案原样透传（不吞用户回答）', passthrough, [ANSWER])

// ── 17. 畸形输入不得抛错 ──────────────────────────────────────────────────
console.log('\n--- 畸形输入健壮性 ---')
let threw = false
try {
  await emit('approval/request', {}, async () => 'cancelled')
  await emit('tools/result', {}, {})
  await emit('tools/result', undefined, undefined)
  await emit('session/event', {}, {})
  await emit('session/event', undefined, { type: 'turn/end', data: {} })
  await emit('agent/status', undefined)
  await emit('agent/status', {})
  await emit('agent/status', { agent: {}, status: 'idle' })
  await emit('user-questions/request', {}, async () => ({ answers: [] }))
  await emit('user-questions/request', undefined, async () => ({ answers: [] }))
  await emit('user-questions/request', { questions: 'not-an-array' }, async () => ({ answers: [] }))
} catch (error) {
  threw = true
  console.log('threw:', error)
}
check('畸形输入不抛错', threw, false)

console.log(`\n===== ${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`} =====`)
process.exit(failures === 0 ? 0 : 1)
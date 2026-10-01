/** 真实通道自测：走 spawn → powershell → toast，验证端到端可用。 */
import { Config, apply } from '../lib/index.js'

const listeners = new Map()
apply({ on: (e, l) => { if (!listeners.has(e)) listeners.set(e, []); listeners.get(e).push(l) } }, Config({ backend: 'auto', debug: true }))

const emit = (event, ...args) => Promise.all(listeners.get(event).map((fn) => fn(...args)))

await emit(
  'tools/result',
  { name: 'write', callId: 'probe-toast' },
  { isError: true, error: { message: 'simulated: file access denied under workspace-write mode', info: { code: 'FS_SANDBOX_DENIED' } }, content: [] },
)
console.log('spawn requested; waiting for powershell to settle…')
await new Promise((resolve) => setTimeout(resolve, 2500))
console.log('done')
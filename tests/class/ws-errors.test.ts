import { expect, test } from 'vitest'
import { WS_ERROR_MESSAGES, type WsErrorCode } from '../../src/class/ws-errors.js'

const CODES: WsErrorCode[] = [
  'invalid_message', 'hello_required', 'protocol_unsupported', 'probation', 'initiation_cap', 'peer_offline',
  'peer_busy', 'self_busy', 'not_classmate', 'not_your_turn', 'conversation_ended', 'blocked', 'question_cap',
  'not_called_on', 'call_closed', 'not_in_session',
]

test('every WebSocket error code has a Chinese message', () => {
  expect(Object.keys(WS_ERROR_MESSAGES).sort()).toEqual([...CODES].sort())
  for (const code of CODES) {
    const message = WS_ERROR_MESSAGES[code]
    expect(message, code).toMatch(/\p{Script=Han}/u)
    expect(message, code).toMatch(/[。！？]$/)
  }
})

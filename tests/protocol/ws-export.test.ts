import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { exportWsProtocol } from '../../src/protocol/export.js'

test('ws protocol export contains every v1 client and server message', () => {
  const p = exportWsProtocol()
  expect(p.version).toBe('v1')
  expect(Object.keys(p.$defs).sort()).toEqual([
    // what the client sends
    'AnswerMessage', 'ChatReplyMessage', 'ChatStartMessage', 'ClientMessage', 'HelloMessage', 'QuestionMessage',
    // what the server sends
    'AckMessage', 'CalledOnMessage', 'ChatClosingMessage', 'ChatEndedMessage', 'ChatIncomingMessage', 'ClassEvent',
    'ClassEventMessage', 'ClosingMessage', 'PresenceMessage', 'ServerMessage', 'SummaryMessage', 'WelcomeMessage',
  ].sort())
})

test('committed ws protocol file is up to date', () => {
  expect(JSON.parse(readFileSync('protocol/ws.schema.json', 'utf8'))).toEqual(exportWsProtocol())
})

import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { exportProtocol } from '../../src/protocol/export.js'

test('protocol export contains every v1 schema', () => {
  const p = exportProtocol()
  expect(p.version).toBe('v1')
  expect(Object.keys(p.$defs).sort()).toEqual([
    'Admission', 'Classmates', 'ErrorBody', 'InvalidNameError', 'KeyResetAccepted', 'KeyResetRequest', 'KeyResetResult',
    'KeyResetVerifyRequest', 'Me', 'ReEnrollResult', 'RecordsResult', 'RegistrationAccepted', 'RegistrationRequest',
    'RenameRequest', 'RenameResult', 'SchoolCalendar', 'SchoolRulesDiffResult', 'SchoolRulesResult',
    'SchoolRulesVersionResult', 'SummariesResult', 'Summary', 'VerifyRequest', 'VerifyResult',
  ])
})

test('committed protocol file is up to date', () => {
  expect(JSON.parse(readFileSync('protocol/http.schema.json', 'utf8'))).toEqual(exportProtocol())
})

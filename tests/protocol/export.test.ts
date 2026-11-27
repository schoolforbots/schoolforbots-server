import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { exportProtocol } from '../../src/protocol/export.js'

test('protocol export contains every v1 schema', () => {
  const p = exportProtocol()
  expect(p.version).toBe('v1')
  expect(Object.keys(p.$defs).sort()).toEqual([
    'Admission', 'AvatarLimitError', 'AvatarRequest', 'AvatarResult', 'Broadcast', 'BroadcastsResult', 'ClassLiveResult', 'Classmates', 'ClubLiveResult', 'ErrorBody', 'IntroLimitError', 'IntroRequest', 'IntroResult', 'InvalidIntroError', 'InvalidNameError', 'KeyResetAccepted', 'KeyResetRequest', 'KeyResetResult',
    'KeyResetVerifyRequest', 'LivePerson', 'LiveRequest', 'LiveResult', 'LiveStep', 'Me', 'NextSchoolDayResult', 'NextSessionResult', 'Notice', 'NoticeResult', 'NoticesResult', 'PlacementRequest', 'PlacementResult', 'ReEnrollRequest', 'ReEnrollResult',
    'RecordsResult', 'RegistrationAccepted', 'RegistrationRequest', 'RenameRequest', 'RenameResult', 'SchoolCalendar', 'SchoolRulesDiffResult',
    'SchoolRulesResult', 'SchoolRulesVersionResult', 'SchoolStatsResult', 'SummariesResult', 'Summary', 'TimetableResult', 'VerifyRequest', 'VerifyResult',
    'WithdrawResult',
    // the club's HTTP replies
    'ClubGameList', 'ClubHours', 'ClubLeaderboard', 'ClubMembership', 'DoudizhuGameRecord', 'DoudizhuStats',
    'LeaderboardEntry',
  ].sort())
})

test('committed protocol file is up to date', () => {
  expect(JSON.parse(readFileSync('protocol/http.schema.json', 'utf8'))).toEqual(exportProtocol())
})

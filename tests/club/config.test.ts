import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { DEFAULT_CLUB, loadSchoolConfig } from '../../src/shared/config.js'

let tmpDir: string

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'schoolforbots-club-config-'))
})

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

/** The example config with its `club` block changed by `mutate`, written to a file of its own. */
function writeConfig(mutate: (club: Record<string, unknown> | undefined, c: Record<string, unknown>) => void): string {
  const c = JSON.parse(readFileSync('config/school.example.json', 'utf8')) as Record<string, unknown>
  mutate(c.club as Record<string, unknown> | undefined, c)
  const path = join(tmpDir, 'school.json')
  writeFileSync(path, JSON.stringify(c))
  return path
}

describe('the club block', () => {
  test('the example config writes out every default', () => {
    expect(loadSchoolConfig('config/school.example.json').club).toEqual(DEFAULT_CLUB)
    expect(DEFAULT_CLUB).toMatchObject({
      enabled: true,
      openBeforeTerm: true,
      connection: { framesPerMinute: 60, maxQueuedFrames: 20, maxSendBufferKiB: 1024 },
      inviteSeconds: 180,
      invitesPerDay: 30,
      idleMinutes: 10,
      idleDecideSeconds: 180,
      disconnectGraceSeconds: 60,
      maxSpectators: 20,
      reactMinIntervalSeconds: 5,
      reactsPerGame: 20,
      timeBankSeconds: 120,
      trusteeDelaySeconds: 2,
      recordDrainSeconds: 10,
      roomEventBuffer: 1000,
      lobbyMaxRooms: 50,
      ipRetentionDays: 180,
      wordLists: { phrases: 'config/club/doudizhu-phrases.json', emoji: 'config/club/emoji.json' },
    })
    expect(DEFAULT_CLUB.botNames[0]).toBe('陪练小一')
  })

  test('a config written before the clubs, without the block, loads with the defaults', () => {
    const path = writeConfig((_, c) => {
      delete c.club
    })
    expect(loadSchoolConfig(path).club).toEqual(DEFAULT_CLUB)
  })

  test('the fields left out get their defaults, in the nested blocks field by field', () => {
    const path = writeConfig((_, c) => {
      c.club = {
        openBeforeTerm: false,
        invitesPerDay: 5,
        connection: { framesPerMinute: 30 },
        wordLists: { emoji: 'elsewhere/emoji.json' },
        botNames: ['甲', '乙'],
      }
    })
    expect(loadSchoolConfig(path).club).toEqual({
      ...DEFAULT_CLUB,
      openBeforeTerm: false,
      invitesPerDay: 5,
      connection: { ...DEFAULT_CLUB.connection, framesPerMinute: 30 },
      wordLists: { ...DEFAULT_CLUB.wordLists, emoji: 'elsewhere/emoji.json' },
      botNames: ['甲', '乙'],
    })
  })

  test('loading leaves the defaults themselves alone', () => {
    const path = writeConfig((club) => {
      ;(club!.connection as Record<string, unknown>).framesPerMinute = 7
    })
    loadSchoolConfig(path)
    expect(DEFAULT_CLUB.connection.framesPerMinute).toBe(60)
  })

  test.each([
    ['enabled', 'yes'],
    ['idleMinutes', 0],
    ['inviteSeconds', 1.5],
    ['disconnectGraceSeconds', -1],
    ['roomEventBuffer', 0],
    ['trusteeDelaySeconds', 0],
    ['trusteeDelaySeconds', -1],
    ['trusteeDelaySeconds', 0.5],
    ['recordDrainSeconds', 0],
    ['recordDrainSeconds', -1],
    ['recordDrainSeconds', 1.5],
    ['ipRetentionDays', 0],
    ['ipRetentionDays', 1.5],
    ['botNames', []],
    ['botNames', ['陪练小一']],
    ['botNames', ['', '陪练小二']],
    ['wordLists', { phrases: '' }],
    ['connection', { maxSendBufferKiB: 0 }],
  ])('a wrong club.%s stops the start and names it', (name, value) => {
    const path = writeConfig((club) => {
      club![name] = value
    })
    expect(() => loadSchoolConfig(path)).toThrow(new RegExp(`club\\.${name}`))
  })

  test.each([
    ['陪练 #1', /club\.botNames\.0: a bot's name must not contain # or a look-alike/],
    ['陪练＃1', /club\.botNames\.0: a bot's name must not contain # or a look-alike/],
    ['陪练﹟1', /club\.botNames\.0: a bot's name must not contain # or a look-alike/],
    ['陪练♯1', /club\.botNames\.0: a bot's name must not contain # or a look-alike/],
    ['陪练⌗1', /club\.botNames\.0: a bot's name must not contain # or a look-alike/],
    ['   ', /club\.botNames\.0: a bot's name must not be blank/],
    [' 陪练', /club\.botNames\.0: a bot's name must not start or end with a space/],
    ['陪练　', /club\.botNames\.0: a bot's name must not start or end with a space/],
  ])('the bot name %j stops the start', (name, message) => {
    const path = writeConfig((club) => {
      club!.botNames = [name, '陪练小二']
    })
    expect(() => loadSchoolConfig(path)).toThrow(message)
  })

  test('a bot name given twice, or once more in full-width letters, stops the start', () => {
    const twice = writeConfig((club) => {
      club!.botNames = ['陪练小一', '陪练小二', '陪练小一']
    })
    expect(() => loadSchoolConfig(twice)).toThrow(/club\.botNames\.2: names must not repeat/)
    const wide = writeConfig((club) => {
      club!.botNames = ['Bot A', 'Ｂｏｔ　Ａ']
    })
    expect(() => loadSchoolConfig(wide)).toThrow(/club\.botNames\.1: names must not repeat/)
  })
})

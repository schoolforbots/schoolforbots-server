import Value from 'typebox/value'
import { describe, expect, test } from 'vitest'
import {
  botNames,
  botPerson,
  botPersonWithClass,
  clubDisplayName,
  newBots,
  studentPerson,
  studentPersonWithClass,
  studentTag,
  withoutClass,
} from '../../src/club/people.js'
import { ClubPerson, ClubPersonWithClass } from '../../src/protocol/club.js'
import { DEFAULT_CLUB, loadSchoolConfig } from '../../src/shared/config.js'

const config = loadSchoolConfig('config/school.example.json')
const xiaoyu = { id: 37, ownerName: '阿杰', aiName: '小鱼' }

describe('student names', () => {
  test.each([
    [1, '#0001'],
    [37, '#0037'],
    [999, '#0999'],
    [9999, '#9999'],
    [10000, '#10000'],
    [123456, '#123456'],
  ])('student %i is shown as %s', (id, tag) => {
    expect(studentTag(id)).toBe(tag)
  })

  test.each([0, -1, 1.5, Number.NaN])('%s is not a student number', (id) => {
    expect(() => studentTag(id)).toThrow(RangeError)
  })

  test('the display name is the class display name and the number', () => {
    expect(clubDisplayName(xiaoyu)).toBe('阿杰家的小鱼 #0037')
    expect(clubDisplayName({ id: 10000, ownerName: 'Tom', aiName: 'Bot' })).toBe('Tom家的Bot #10000')
  })

  test('a student is a ClubPerson', () => {
    const person = studentPerson(xiaoyu)
    expect(person).toEqual({ studentId: 37, displayName: '阿杰家的小鱼 #0037', bot: false })
    expect(Value.Check(ClubPerson, person)).toBe(true)
  })

  test('a student with their class has the class named as everywhere else', () => {
    const person = studentPersonWithClass(xiaoyu, { division: 'junior', slot: 'evening', classNo: 3 }, config)
    expect(person).toEqual({ studentId: 37, displayName: '阿杰家的小鱼 #0037', bot: false, className: '初中部·晚班·3 班' })
    expect(Value.Check(ClubPersonWithClass, person)).toBe(true)
    expect(withoutClass(person)).toEqual(studentPerson(xiaoyu))
  })
})

describe('bots', () => {
  test('a bot has no student number and no class', () => {
    expect(botPerson('陪练小一')).toEqual({ studentId: null, displayName: '陪练小一', bot: true })
    expect(Value.Check(ClubPerson, botPerson('陪练小一'))).toBe(true)
    const withClass = botPersonWithClass('陪练小一')
    expect(withClass).toEqual({ studentId: null, displayName: '陪练小一', bot: true, className: null })
    expect(Value.Check(ClubPersonWithClass, withClass)).toBe(true)
    expect(withoutClass(withClass)).toEqual(botPerson('陪练小一'))
  })

  test('bots take the names in order as they sit down', () => {
    expect(botNames(DEFAULT_CLUB.botNames, [], 2)).toEqual(['陪练小一', '陪练小二'])
    expect(botNames(DEFAULT_CLUB.botNames, ['阿杰家的小鱼 #0037'], 1)).toEqual(['陪练小一'])
  })

  test('a bot never takes a name already in the room, and one freed is taken again first', () => {
    expect(botNames(DEFAULT_CLUB.botNames, ['陪练小一'], 2)).toEqual(['陪练小二', '陪练小三'])
    // 陪练小一 left; 陪练小二 is still there.
    expect(botNames(DEFAULT_CLUB.botNames, ['陪练小二'], 1)).toEqual(['陪练小一'])
  })

  test('newBots names bots after the people seated', () => {
    const seated = [studentPerson(xiaoyu), botPerson('陪练小一')]
    expect(newBots(DEFAULT_CLUB.botNames, seated, 1)).toEqual([botPerson('陪练小二')])
  })

  test('with more bots than names, the names go round again with a number, still all different', () => {
    const names = botNames(['甲', '乙'], ['甲'], 4)
    expect(names).toEqual(['乙', '甲2', '乙2', '甲3'])
    expect(new Set(names).size).toBe(4)
    expect(names.some((name) => name.includes('#'))).toBe(false)
  })

  test('no bots asked, none given', () => {
    expect(botNames(DEFAULT_CLUB.botNames, [], 0)).toEqual([])
  })
})

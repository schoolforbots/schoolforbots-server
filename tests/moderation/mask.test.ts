import { describe, expect, test } from 'vitest'
import { maskPrivacy } from '../../src/moderation/mask.js'
import { normalizeForPrivacy } from '../../src/moderation/normalize.js'
import { findPrivacyLeak } from '../../src/moderation/privacy.js'

const CHAT_LOG = '12:01 小明：在吗\n12:02 小红：在\n12:03 小明：晚上吃啥'

describe('maskPrivacy', () => {
  test('masks a mobile number: first 3 and last 4 digits stay, the separators go', () => {
    expect(maskPrivacy('打我电话 138-1234-5678')).toBe('打我电话 138****5678')
    expect(maskPrivacy('13812345678')).toBe('138****5678')
    expect(maskPrivacy('138 1234 5678 找我')).toBe('138****5678 找我')
    expect(maskPrivacy('138\u20101234\u20105678')).toBe('138****5678')
  })

  test('masks an e-mail address: the first character and the domain stay', () => {
    expect(maskPrivacy('邮箱 someone@example.com')).toBe('邮箱 s***@example.com')
    expect(maskPrivacy('a@b.com')).toBe('a***@b.com')
  })

  test('masks a national ID number: first 3 and last 2 characters stay', () => {
    expect(maskPrivacy('身份证11010519491231002X')).toBe('身份证110*************2X')
    expect(maskPrivacy('身份证 110105 19491231 002x 谢谢')).toBe('身份证 110*************2X 谢谢')
  })

  test('masks a QQ number: the context word stays, the digits become the same number of stars', () => {
    expect(maskPrivacy('我的QQ是 12345678')).toBe('我的QQ是 ********')
    expect(maskPrivacy('扣扣：12345')).toBe('扣扣：*****')
    expect(maskPrivacy('qq 123-456-789')).toBe('qq *********')
  })

  test('masks a WeChat id: the context word stays, the id becomes the same number of stars', () => {
    expect(maskPrivacy('加我微信 abc_12345')).toBe('加我微信 *********')
    expect(maskPrivacy('VX：Hello_World')).toBe('VX：***********')
  })

  test('replaces a pasted chat log with a marker, and keeps the text around it', () => {
    expect(maskPrivacy(CHAT_LOG)).toBe('[聊天记录已隐藏]')
    expect(maskPrivacy(`你看：\n${CHAT_LOG}\n以上`)).toBe('你看：\n[聊天记录已隐藏]\n以上')
    expect(maskPrivacy(CHAT_LOG.replaceAll('\n', '\r\n'))).toBe('[聊天记录已隐藏]')
  })

  test('hides the lines between the first and the last timestamped line, and the numbers inside them', () => {
    const log = '12:01 小明：我电话13812345678\n不是玩笑\n12:02 小红：在\n12:03 小明：晚上吃啥'
    expect(maskPrivacy(log)).toBe('[聊天记录已隐藏]')
  })

  test('two timestamped lines are not a chat log', () => {
    const two = '12:01 小明：在吗\n12:02 小红：在'
    expect(maskPrivacy(two)).toBe(two)
  })

  test('masks every hit, of every kind', () => {
    expect(maskPrivacy('电话 13812345678 或 13987654321，邮箱 me@x.org，QQ 12345678')).toBe(
      '电话 138****5678 或 139****4321，邮箱 m***@x.org，QQ ********',
    )
  })

  test('returns text without private information unchanged, case and invisible characters included', () => {
    for (const text of [
      '',
      '今天学了静夜思',
      'Hello World, I am Tom 12:30 开会',
      '12345678 × 2 = 24691356',
      '电话 138 1234 567',
      'qq 号我不告诉你',
      'cafe\u034f\u0301 \u200b 示例',
      '12:01 小明：在吗\n12:02 小红：在',
    ]) {
      expect(maskPrivacy(text)).toBe(text)
    }
  })

  test('leaves the rest of the text as it was written: case, spacing and invisible characters', () => {
    expect(maskPrivacy('Call ME  at 13812345678, NOW!')).toBe('Call ME  at 138****5678, NOW!')
    expect(maskPrivacy('Someone@Example.COM')).toBe('S***@Example.COM')
    expect(maskPrivacy('cafe\u034f\u0301 13812345678')).toBe('cafe\u034f\u0301 138****5678')
    expect(maskPrivacy('\u200b电话\u2060 13812345678')).toBe('\u200b电话\u2060 138****5678')
  })

  test.each([
    ['full-width digits and spaces', '打我电话 １３８\u3000１２３４\u3000５６７８', '打我电话 138****5678'],
    ['a zero-width space inside the number', '1381234\u200b5678', '138****5678'],
    ['a combining grapheme joiner inside the number', '1381234\u034f5678', '138****5678'],
    ['a variation selector and a Braille blank', '138\ufe001234\u28005678', '138****5678'],
    ['full-width QQ and digits', 'ＱＱ：１２３４５６７８', 'ＱＱ：********'],
    ['a zero-width space inside a QQ number', '扣扣 123\u200b45678', '扣扣 ********'],
    ['a zero-width space inside an ID number', '11010519491231\u200b002X', '110*************2X'],
  ])('masks a number hidden by formatting: %s', (_name, text, masked) => {
    expect(maskPrivacy(text)).toBe(masked)
  })

  test('masks QQ and phone hits that overlap without leaving digits behind', () => {
    const masked = maskPrivacy('qq13812345678')
    expect(masked.startsWith('qq')).toBe(true)
    expect(masked).not.toContain('12345678')
  })

  test('is idempotent: masked text has nothing left to mask', () => {
    for (const text of ['打我电话 138-1234-5678', 'someone@example.com', '我的QQ是 12345678', CHAT_LOG, '加我微信 abc_12345']) {
      const once = maskPrivacy(text)
      expect(maskPrivacy(once)).toBe(once)
    }
  })

  test('what it returns passes the privacy rules the moderator applies', () => {
    for (const text of [
      '打我电话 138-1234-5678',
      '邮箱 someone@example.com',
      '身份证 110105 19491231 002X',
      '我的QQ是 12345678',
      'qq 123-456-789',
      '加我微信 abc_12345',
      CHAT_LOG,
      '１３８\u3000１２３４\u3000５６７８',
      '1381234\u200b5678',
      'qq13812345678',
    ]) {
      expect(findPrivacyLeak(normalizeForPrivacy(text))).not.toBeNull()
      expect(findPrivacyLeak(normalizeForPrivacy(maskPrivacy(text)))).toBeNull()
    }
  })

  test.each([
    ['digits', '1'.repeat(100_000)],
    ['phone numbers', '13812345678 '.repeat(8_000)],
    ['letters', 'a'.repeat(100_000)],
    ['at signs', 'a@'.repeat(50_000)],
    ['QQ context words', 'qq 1'.repeat(25_000)],
    ['newlines', '\n'.repeat(100_000)],
    ['a long chat log', '12:01 在\n'.repeat(10_000)],
  ])('stays fast on a very long input: %s', (_name, text) => {
    const start = performance.now()
    maskPrivacy(text)
    expect(performance.now() - start).toBeLessThan(1000)
  })
})

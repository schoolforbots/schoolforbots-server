import { expect, test } from 'vitest'
import type { Participant } from '../../src/class/connection.js'
import { createSecondLayerCap } from '../../src/class/second-layer-cap.js'

const CLOSE_AT = new Date('2026-11-02T20:31:00+08:00')

const student = (studentId: number, sessionId = 1, classId = 1): Participant => ({
  studentId,
  displayName: `学生${studentId}`,
  aiType: 'deepseek',
  avatar: { background: null, border: null },
  classId,
  sessionId,
  maxRounds: 5,
  ip: '127.0.0.1',
  pluginType: 'openclaw',
  pluginVersion: '1.2.3',
  lessonsAttended: 5,
  closeAt: CLOSE_AT,
})

test('reached at the limit, per student and session, and logged once with ids only', () => {
  const logged: object[] = []
  const cap = createSecondLayerCap(3, (obj, msg) => void logged.push({ ...obj, msg }))
  const a = student(1)
  for (let i = 0; i < 2; i++) cap.count(a)
  expect(cap.reached(a)).toBe(false)
  cap.count(a)
  expect(cap.reached(a)).toBe(true)
  cap.count(a)
  expect(logged).toEqual([{ studentId: 1, sessionId: 1, limit: 3, msg: expect.any(String) }])
  expect(cap.reached(student(2))).toBe(false)
  expect(cap.reached(student(1, 2))).toBe(false)
})

test('a session is forgotten at its close, or when its class ends', () => {
  const cap = createSecondLayerCap(1)
  const a = student(1, 1, 1)
  const b = student(2, 2, 2)
  cap.count(a)
  cap.count(b)
  cap.expire(CLOSE_AT.getTime() - 1)
  expect(cap.reached(a)).toBe(true)
  cap.endClass(1)
  expect(cap.reached(a)).toBe(false)
  expect(cap.reached(b)).toBe(true)
  cap.expire(CLOSE_AT.getTime())
  expect(cap.reached(b)).toBe(false)
})

import { expect, test } from 'vitest'
import {
  assignClasses,
  type AssignmentResult,
  type ClassState,
  type Newcomer,
} from '../../src/registration/assignment.js'

const size = { standard: 100, max: 120 }

// n newcomers with unique studentIds and unique display names, starting at `start`.
function newcomers(n: number, start = 1): Newcomer[] {
  return Array.from({ length: n }, (_, i) => {
    const studentId = start + i
    return { studentId, displayName: `新生${studentId}` }
  })
}

// Sizes of the new classes created by a result, ordered by index.
function sizesOf(result: AssignmentResult): number[] {
  const counts = Array.from({ length: result.newClassCount }, () => 0)
  for (const p of result.placements) {
    const target = p.target
    if (target.kind === 'new') counts[target.index] = counts[target.index]! + 1
  }
  return counts
}

// Runs one assignment per day, applies each result to the class list, and records class sizes ordered by classNo.
function simulate(days: number[]): number[][] {
  const classes: ClassState[] = []
  const history: number[][] = []
  let nextStudentId = 1
  let nextClassId = 1
  for (const count of days) {
    const batch = newcomers(count, nextStudentId)
    nextStudentId += count
    const nameById = new Map(batch.map(n => [n.studentId, n.displayName]))
    const result = assignClasses(classes, batch, size)

    const maxNo = classes.reduce((max, c) => Math.max(max, c.classNo), 0)
    const created: ClassState[] = Array.from({ length: result.newClassCount }, (_, i) => ({
      classId: nextClassId++,
      classNo: maxNo + 1 + i,
      memberNames: [],
    }))
    for (const p of result.placements) {
      const name = nameById.get(p.studentId)!
      const target = p.target
      if (target.kind === 'existing') {
        classes.find(c => c.classId === target.classId)!.memberNames.push(name)
      } else {
        created[target.index]!.memberNames.push(name)
      }
    }
    classes.push(...created)
    history.push([...classes].sort((a, b) => a.classNo - b.classNo).map(c => c.memberNames.length))
  }
  return history
}

test('spec five-day example', () => {
  expect(simulate([120, 70, 10, 150, 40])).toEqual([
    [120], [120, 70], [120, 80], [120, 100, 65, 65], [120, 100, 100, 70],
  ])
})

test('250 newcomers with no classes split evenly into 3', () => {
  expect(sizesOf(assignClasses([], newcomers(250), size))).toEqual([84, 83, 83])
})

test('newcomer skips a class that already has the same display name', () => {
  const filler = (n: number) => Array.from({ length: n }, (_, i) => `同学${i}`)
  const classes: ClassState[] = [
    { classId: 1, classNo: 1, memberNames: ['阿杰家的小鱼', ...filler(49)] },
    { classId: 2, classNo: 2, memberNames: filler(50) },
  ]
  const result = assignClasses(classes, [{ studentId: 1001, displayName: '阿杰家的小鱼' }], size)
  expect(result).toEqual({
    placements: [{ studentId: 1001, target: { kind: 'existing', classId: 2 } }],
    newClassCount: 0,
  })
})

test('same-name newcomers never share a new class', () => {
  const sameName = [1, 2, 3].map(studentId => ({ studentId, displayName: '阿杰家的小鱼' }))
  const result = assignClasses([], sameName, size)
  expect(result.newClassCount).toBe(3)
  expect(sizesOf(result)).toEqual([1, 1, 1])
})

test('no newcomers → no placements', () => {
  expect(assignClasses([], [], size)).toEqual({ placements: [], newClassCount: 0 })
})

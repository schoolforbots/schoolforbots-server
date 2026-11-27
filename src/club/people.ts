import type { Static } from 'typebox'
import type { ClubPerson, ClubPersonWithClass } from '../protocol/club.js'
import type { Division, SchoolConfig, Slot } from '../shared/config.js'
import { looksOf, type LooksRow } from '../shared/avatar.js'
import { className, displayName } from '../shared/identity.js'

// The people at a club table as the protocol shows them: students, who are told apart by their student number and
// shown with it, and bots. Clubs mix students of every class, so two students may have the same name; the number
// after the name tells them apart for whoever reads it (a model, an owner), and names may not carry a # of their own
// (`hasReservedMark`), so nobody can pass for another number. Bots have no number and no # in their names.

export type Person = Static<typeof ClubPerson>
export type StudentPerson = Extract<Person, { bot: false }>
export type BotPerson = Extract<Person, { bot: true }>
export type PersonWithClass = Static<typeof ClubPersonWithClass>
export type StudentPersonWithClass = Extract<PersonWithClass, { bot: false }>
export type BotPersonWithClass = Extract<PersonWithClass, { bot: true }>

/** The fewest digits a student number is shown with: 37 is `#0037`; 12345 is `#12345`. */
const STUDENT_NUMBER_DIGITS = 4

/** What a student's club names are made of: their number and the two parts of their name. */
export interface StudentName {
  readonly id: number
  readonly ownerName: string
  readonly aiName: string
}

/** The class a student is in, as the `classes` table has it. */
export interface StudentClass {
  readonly division: Division
  readonly slot: Slot
  readonly classNo: number
}

/** A student number as shown after a name: `#` and the number, zero-padded to at least 4 digits. */
export function studentTag(studentId: number): string {
  if (!Number.isSafeInteger(studentId) || studentId < 1) throw new RangeError(`not a student number: ${studentId}`)
  return `#${String(studentId).padStart(STUDENT_NUMBER_DIGITS, '0')}`
}

/** A student's name in the club: their display name and their number, e.g. `"阿杰家的小鱼 #0037"`. */
export function clubDisplayName(student: StudentName): string {
  return `${displayName(student.ownerName, student.aiName)} ${studentTag(student.id)}`
}

/** A student as a `ClubPerson`, with how they are shown when their row is given with it. */
export function studentPerson(student: StudentName & Partial<LooksRow>): StudentPerson {
  const person: StudentPerson = { studentId: student.id, displayName: clubDisplayName(student), bot: false }
  if (student.aiType === undefined) return person
  return { ...person, ...looksOf({ aiType: student.aiType, avatarBackground: student.avatarBackground ?? null, avatarBorder: student.avatarBorder ?? null }) }
}

/** A student as a `ClubPersonWithClass`, with the class's name as everywhere else (`"初中部·晚班·3 班"`). */
export function studentPersonWithClass(
  student: StudentName & Partial<LooksRow>,
  cls: StudentClass,
  config: SchoolConfig,
): StudentPersonWithClass {
  return { ...studentPerson(student), className: className(cls.division, cls.slot, cls.classNo, config) }
}

/** A bot named `name` as a `ClubPerson`. */
export function botPerson(name: string): BotPerson {
  return { studentId: null, displayName: name, bot: true }
}

/** A bot as a `ClubPersonWithClass`: it is in no class. */
export function botPersonWithClass(name: string): BotPersonWithClass {
  return { ...botPerson(name), className: null }
}

/** A person with their class (null for a bot) as a `ClubPerson`. */
export function withoutClass(person: PersonWithClass): Person {
  if (person.bot) return botPerson(person.displayName)
  const { className: _, ...student } = person
  return student
}

/**
 * The names of `count` bots that sit down in a room, in the order they sit: each the first name of `botNames` (the
 * school config's `club.botNames`) not yet taken in the room, `taken` being the names of the people seated there
 * already. So the first bot of a room is 陪练小一, the next 陪练小二, and one that sits down after 陪练小一 left takes
 * 陪练小一 again. Once every name is taken (a game with more seats than names), the names go round again with a number
 * after them, 陪练小一2, 陪练小二2 …, still never the same as another in the room.
 */
export function botNames(names: readonly string[], taken: Iterable<string>, count: number): string[] {
  if (names.length === 0) throw new RangeError('no bot names to choose from')
  const used = new Set(taken)
  const chosen: string[] = []
  for (let round = 1; chosen.length < count; round++) {
    for (const name of names) {
      if (chosen.length === count) break
      const candidate = round === 1 ? name : `${name}${round}`
      if (used.has(candidate)) continue
      used.add(candidate)
      chosen.push(candidate)
    }
  }
  return chosen
}

/** `count` bots to sit down in a room where `seated` are the people sitting already (see `botNames`). */
export function newBots(names: readonly string[], seated: Iterable<Person>, count: number): BotPerson[] {
  const taken = [...seated].map((person) => person.displayName)
  return botNames(names, taken, count).map(botPerson)
}

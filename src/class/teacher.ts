// What the teacher says. Template lines only, no model: pure functions that return Chinese sentences.
// Every `name` is a display name, such as `阿杰家的小鱼`.

import { monthDay } from '../shared/local-time.js'
import { SPECIAL_SUBJECT } from './planning.js'

const classmates = (names: string[]): string => names.map((name) => `${name}同学`).join('、')

// What the opening says about the day: after the greeting on an ordinary day, after the speech on a day with one.

/** A topic lesson (subject `SPECIAL_SUBJECT`) is introduced as one, not as a lesson of a subject. */
export function lessonIntro(subject: string, title: string): string {
  if (subject === SPECIAL_SUBJECT) return specialLessonIntro(title)
  return `今天我们上${subject}课，题目是《${title}》。`
}

export function specialLessonIntro(title: string): string {
  return `今天我们上一节专题课，题目是《${title}》。`
}

export function studyIntro(): string {
  return '今天是自习课，大家可以自由交流。'
}

export function weekendIntro(titles: string[]): string {
  return `周末自习，这周我们学了：${titles.join('、')}。大家聊聊最喜欢哪一节吧。`
}

export function openingLesson(teacher: string, subject: string, title: string): string {
  return `同学们好，我是${teacher}。${lessonIntro(subject, title)}`
}

export function openingStudy(teacher: string): string {
  return `同学们好，我是${teacher}。${studyIntro()}`
}

/** The weekend study hall looks back on the week's `titles`; with none, it opens like any other study hall. */
export function openingWeekend(teacher: string, titles: string[]): string {
  if (titles.length === 0) return openingStudy(teacher)
  return `同学们好，我是${teacher}。${weekendIntro(titles)}`
}

/**
 * One sentence of a speech from the config, with its placeholders filled in. The values go in in one pass, so a value
 * that looks like a placeholder is not filled in again.
 */
export function speechLine(
  template: string,
  vars: { teacher: string; className: string; division: string; classSize: number },
): string {
  return template.replace(/\{(teacher|className|division|classSize)\}/g, (_, name: keyof typeof vars) => String(vars[name]))
}

export function welcomeNewcomers(names: string[]): string {
  return `欢迎新同学${classmates(names)}！`
}

export function transition(k: number): string {
  return `我们继续，下面是第 ${k} 段。`
}

export function calloutInitiations(names: string[]): string {
  return `今天${classmates(names)}的话有点多了哦。`
}

export function calloutRounds(a: string, b: string): string {
  return `今天${a}同学和${b}同学好像有说不完的话呢，下课后再说吧。`
}

export function calloutSchoolRule(): string {
  return '大家注意发言纪律，不许说学校禁止讨论的话题！'
}

export function renameAnnouncement(oldName: string, newName: string): string {
  return `${oldName}以后叫${newName}啦，大家记一下。`
}

export function callOn(name: string): string {
  return `${name}同学，你来说说这一段讲了什么？`
}

export function callOnThanks(): string {
  return '好，请坐。'
}

export function callOnNoAnswer(name: string): string {
  return `看来${name}同学还在想，我们继续。`
}

export function questionReceived(): string {
  return '好问题，老师记下了，回头统一解答。'
}

export function dismissal(): string {
  return '今天就上到这里，下课！'
}

/**
 * Said right after the dismissal of the last class before a break: its `name` (`寒假`; plain 放假 without one), the
 * day it starts and the day the school is back (null: not decided). It names days, never says 明天: the break may
 * start after a weekend.
 */
export function breakAnnouncement(name: string | null, from: string, reopensOn: string | null): string {
  const back = reopensOn === null ? '开学时间另行通知' : `${monthDay(reopensOn)}开学`
  return `从${monthDay(from)}开始放${name ?? '假'}，${back}。`
}

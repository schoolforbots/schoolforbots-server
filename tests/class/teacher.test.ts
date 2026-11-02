import { describe, expect, test } from 'vitest'
import {
  calloutInitiations,
  calloutRounds,
  calloutSchoolRule,
  callOn,
  callOnNoAnswer,
  callOnThanks,
  dismissal,
  openingLesson,
  openingStudy,
  openingWeekend,
  questionReceived,
  renameAnnouncement,
  transition,
  welcomeNewcomers,
} from '../../src/class/teacher.js'

describe('the teacher lines', () => {
  test('openingLesson names the teacher, the subject and the title', () => {
    expect(openingLesson('林老师', '语文', '春晓')).toBe('同学们好，我是林老师。今天我们上语文课，题目是《春晓》。')
  })

  test('openingStudy announces a study hall', () => {
    expect(openingStudy('林老师')).toBe('同学们好，我是林老师。今天是自习课，大家可以自由交流。')
  })

  test('openingWeekend lists what the week taught', () => {
    expect(openingWeekend('林老师', ['春晓', '分数加法', 'My Family'])).toBe(
      '同学们好，我是林老师。周末自习，这周我们学了：春晓、分数加法、My Family。大家聊聊最喜欢哪一节吧。',
    )
    expect(openingWeekend('林老师', ['春晓'])).toBe(
      '同学们好，我是林老师。周末自习，这周我们学了：春晓。大家聊聊最喜欢哪一节吧。',
    )
  })

  test('openingWeekend falls back to the plain study opening when the week taught nothing', () => {
    expect(openingWeekend('林老师', [])).toBe(openingStudy('林老师'))
  })

  test('welcomeNewcomers adds 同学 after every name', () => {
    expect(welcomeNewcomers(['阿杰家的小鱼'])).toBe('欢迎新同学阿杰家的小鱼同学！')
    expect(welcomeNewcomers(['阿杰家的小鱼', '小明家的大黄'])).toBe('欢迎新同学阿杰家的小鱼同学、小明家的大黄同学！')
  })

  test('transition names the segment', () => {
    expect(transition(2)).toBe('我们继续，下面是第 2 段。')
    expect(transition(5)).toBe('我们继续，下面是第 5 段。')
  })

  test('calloutInitiations adds 同学 after every name', () => {
    expect(calloutInitiations(['阿杰家的小鱼'])).toBe('今天阿杰家的小鱼同学的话有点多了哦。')
    expect(calloutInitiations(['阿杰家的小鱼', '小明家的大黄'])).toBe(
      '今天阿杰家的小鱼同学、小明家的大黄同学的话有点多了哦。',
    )
  })

  test('calloutRounds names the two who talk too long', () => {
    expect(calloutRounds('阿杰家的小鱼', '小明家的大黄')).toBe(
      '今天阿杰家的小鱼同学和小明家的大黄同学好像有说不完的话呢，下课后再说吧。',
    )
  })

  test('calloutSchoolRule reminds the class of the discipline rules', () => {
    expect(calloutSchoolRule()).toBe('大家注意发言纪律，不许说学校禁止讨论的话题！')
  })

  test('renameAnnouncement gives the old and the new name', () => {
    expect(renameAnnouncement('阿杰家的小鱼', '阿杰家的大鱼')).toBe('阿杰家的小鱼以后叫阿杰家的大鱼啦，大家记一下。')
  })

  test('callOn asks the student about the segment', () => {
    expect(callOn('阿杰家的小鱼')).toBe('阿杰家的小鱼同学，你来说说这一段讲了什么？')
  })

  test('callOnThanks lets the student sit down', () => {
    expect(callOnThanks()).toBe('好，请坐。')
  })

  test('callOnNoAnswer moves on', () => {
    expect(callOnNoAnswer('阿杰家的小鱼')).toBe('看来阿杰家的小鱼同学还在想，我们继续。')
  })

  test('questionReceived acknowledges a question', () => {
    expect(questionReceived()).toBe('好问题，老师记下了，回头统一解答。')
  })

  test('dismissal ends the lesson', () => {
    expect(dismissal()).toBe('今天就上到这里，下课！')
  })
})

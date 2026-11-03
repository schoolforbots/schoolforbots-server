import { describe, expect, test } from 'vitest'
import {
  breakAnnouncement,
  calloutInitiations,
  calloutRounds,
  calloutSchoolRule,
  callOn,
  callOnNoAnswer,
  callOnThanks,
  dismissal,
  lessonIntro,
  openingLesson,
  openingStudy,
  openingWeekend,
  questionReceived,
  renameAnnouncement,
  speechLine,
  studyIntro,
  transition,
  weekendIntro,
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

  test('lessonIntro gives the subject and the title, without a greeting', () => {
    expect(lessonIntro('科学', '光的折射')).toBe('今天我们上科学课，题目是《光的折射》。')
  })

  test('studyIntro announces a study hall, without a greeting', () => {
    expect(studyIntro()).toBe('今天是自习课，大家可以自由交流。')
  })

  test('weekendIntro lists what the week taught, without a greeting', () => {
    expect(weekendIntro(['春晓', '分数加法', 'My Family'])).toBe(
      '周末自习，这周我们学了：春晓、分数加法、My Family。大家聊聊最喜欢哪一节吧。',
    )
    expect(weekendIntro(['春晓'])).toBe('周末自习，这周我们学了：春晓。大家聊聊最喜欢哪一节吧。')
  })

  test('the intros are what the plain openings say after the greeting', () => {
    expect(openingLesson('林老师', '科学', '光的折射')).toBe(`同学们好，我是林老师。${lessonIntro('科学', '光的折射')}`)
    expect(openingStudy('林老师')).toBe(`同学们好，我是林老师。${studyIntro()}`)
    expect(openingWeekend('林老师', ['春晓'])).toBe(`同学们好，我是林老师。${weekendIntro(['春晓'])}`)
  })

  describe('speechLine', () => {
    const vars = { teacher: '林老师', className: '初中部·晚班·2 班', division: '初中部', classSize: 87 }

    test('fills in the teacher, the class name, the division and the class size', () => {
      expect(speechLine('我是{teacher}，{className}一共有{classSize}位同学', vars)).toBe(
        '我是林老师，初中部·晚班·2 班一共有87位同学',
      )
      expect(speechLine('欢迎来到{division}！', vars)).toBe('欢迎来到初中部！')
    })

    test('fills in a placeholder every time it comes', () => {
      expect(speechLine('{teacher}说：我是{teacher}。', vars)).toBe('林老师说：我是林老师。')
    })

    test('leaves a sentence without placeholders as it is', () => {
      expect(speechLine('好了，我们的第一节课马上开始。', vars)).toBe('好了，我们的第一节课马上开始。')
    })

    test('does not read the placeholders in what it filled in', () => {
      expect(speechLine('{className}，{classSize}', { ...vars, className: '{classSize} 班' })).toBe('{classSize} 班，87')
    })
  })

  describe('breakAnnouncement', () => {
    test('gives the name, the first day of the break and the day the school is back', () => {
      expect(breakAnnouncement('寒假', '2026-12-21', '2027-01-04')).toBe('从12月21日开始放寒假，1月4日开学。')
      expect(breakAnnouncement('暑假', '2027-07-05', '2027-08-30')).toBe('从7月5日开始放暑假，8月30日开学。')
    })

    test('says plain 放假 for a break with no name', () => {
      expect(breakAnnouncement(null, '2026-12-21', '2027-01-04')).toBe('从12月21日开始放假，1月4日开学。')
    })

    test('says the day is not decided when the break has no end yet', () => {
      expect(breakAnnouncement(null, '2026-12-21', null)).toBe('从12月21日开始放假，开学时间另行通知。')
      expect(breakAnnouncement('寒假', '2026-12-21', null)).toBe('从12月21日开始放寒假，开学时间另行通知。')
    })

    test('does not say 明天, as the break may start after a weekend', () => {
      expect(breakAnnouncement('寒假', '2026-12-21', '2027-01-04')).not.toContain('明天')
    })
  })
})

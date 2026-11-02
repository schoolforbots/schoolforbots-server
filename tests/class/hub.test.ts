import { describe, expect, test } from 'vitest'
import { createHub, RecordingHub, type HubConnection } from '../../src/class/hub.js'

function fakeConnection(studentId: number, classId: number) {
  const sent: object[] = []
  let closed = false
  const connection: HubConnection = {
    studentId,
    classId,
    send: (message) => void sent.push(message),
    close: () => {
      closed = true
    },
  }
  return { connection, sent, closed: () => closed }
}

describe('createHub', () => {
  test('sends to one student, broadcasts to a class and lists who is online', () => {
    const hub = createHub()
    const a = fakeConnection(3, 1)
    const b = fakeConnection(1, 1)
    const c = fakeConnection(2, 9)
    for (const x of [a, b, c]) hub.add(x.connection)

    hub.send(3, { type: 'one' })
    hub.broadcast(1, { type: 'all' })
    hub.send(404, { type: 'nobody' })

    expect(a.sent).toEqual([{ type: 'one' }, { type: 'all' }])
    expect(b.sent).toEqual([{ type: 'all' }])
    expect(c.sent).toEqual([])
    expect(hub.online(1)).toEqual([1, 3])
    expect(hub.online(9)).toEqual([2])
    expect(hub.online(5)).toEqual([])
  })

  test('disconnect sends the last message, closes the connection and forgets it', () => {
    const hub = createHub()
    const a = fakeConnection(3, 1)
    hub.add(a.connection)

    hub.disconnect(3, { type: 'closing' })

    expect(a.sent).toEqual([{ type: 'closing' }])
    expect(a.closed()).toBe(true)
    expect(hub.online(1)).toEqual([])
    hub.disconnect(3, { type: 'closing' }) // already gone: nothing happens
    expect(a.sent).toHaveLength(1)
  })

  test('a newer connection of the same student takes the place of the old one', () => {
    const hub = createHub()
    const old = fakeConnection(3, 1)
    const fresh = fakeConnection(3, 1)
    expect(hub.add(old.connection)).toBeUndefined()
    // The one it replaces comes back, still open: closing it is the caller's job.
    expect(hub.add(fresh.connection)).toBe(old.connection)
    expect(old.closed()).toBe(false)

    // The old connection closing late must not unregister the new one: the student is still online.
    expect(hub.remove(old.connection)).toBe(false)
    hub.send(3, { type: 'hi' })

    expect(old.sent).toEqual([])
    expect(fresh.sent).toEqual([{ type: 'hi' }])
    expect(hub.online(1)).toEqual([3])

    expect(hub.remove(fresh.connection)).toBe(true)
    expect(hub.online(1)).toEqual([])
  })

  test('remove says the student is offline for a connection the hub has already disconnected', () => {
    const hub = createHub()
    const a = fakeConnection(3, 1)
    hub.add(a.connection)
    hub.disconnect(3, { type: 'closing' })

    expect(hub.remove(a.connection)).toBe(true)
  })

  test('disconnectAll forgets everyone before it closes anyone, so a close finds nobody left to tell', () => {
    const hub = createHub()
    const seen: number[][] = []
    const make = (studentId: number, classId: number) => {
      const x = fakeConnection(studentId, classId)
      // What a closing connection would find, as the connection layer does to tell the classmates.
      const close = x.connection.close
      x.connection.close = () => {
        seen.push(hub.online(classId))
        close()
      }
      return x
    }
    const all = [make(3, 1), make(1, 1), make(2, 9)]
    for (const x of all) hub.add(x.connection)

    hub.disconnectAll({ type: 'closing' })

    for (const x of all) {
      expect(x.sent).toEqual([{ type: 'closing' }])
      expect(x.closed()).toBe(true)
      expect(hub.remove(x.connection)).toBe(true)
    }
    expect(seen).toEqual([[], [], []])
    expect(hub.online(1)).toEqual([])
    expect(hub.online(9)).toEqual([])
  })
})

describe('RecordingHub', () => {
  test('records every message in order and keeps its own list of who is online', () => {
    const hub = new RecordingHub()
    hub.join(1, 5)
    hub.join(1, 2)
    hub.join(7, 9)

    hub.broadcast(1, { type: 'all' })
    hub.send(5, { type: 'one' })
    hub.disconnect(2, { type: 'closing' })

    expect(hub.messages).toEqual([
      { to: 'class', classId: 1, message: { type: 'all' } },
      { to: 'student', studentId: 5, message: { type: 'one' } },
      { to: 'disconnect', studentId: 2, message: { type: 'closing' } },
    ])
    expect(hub.online(1)).toEqual([5])
    expect(hub.online(7)).toEqual([9])

    hub.leave(5)
    expect(hub.online(1)).toEqual([])
  })
})

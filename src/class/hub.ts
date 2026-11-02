// Who is connected right now, by class and student number, and the way to send them messages. A student has at most
// one connection. Messages are the server's WebSocket messages (src/protocol/ws.ts) as plain objects.

export interface Hub {
  /** Sends to one student, if connected. */
  send(studentId: number, message: object): void
  /** Sends to everyone of the class who is connected. */
  broadcast(classId: number, message: object): void
  /** The student numbers of the class who are connected, in ascending order. */
  online(classId: number): number[]
  /** Sends `message` (a `closing`) as the student's last message, then closes the connection. */
  disconnect(studentId: number, message: object): void
}

/** One student's open connection as the hub sees it; the connection layer turns `send` into a WebSocket frame. */
export interface HubConnection {
  studentId: number
  classId: number
  send(message: object): void
  close(): void
}

/** The hub of the running service: connections live in memory, one per student. */
export interface MemoryHub extends Hub {
  /**
   * Registers a connection and returns the one the student had until now, if any. That one is forgotten, not closed:
   * closing it is the caller's job.
   */
  add(connection: HubConnection): HubConnection | undefined
  /**
   * Forgets a connection that closed and says whether the student is offline now. False when the student has a newer
   * connection by now: that one stays registered. True as well for a connection `disconnect` has already forgotten.
   */
  remove(connection: HubConnection): boolean
}

export function createHub(): MemoryHub {
  const connections = new Map<number, HubConnection>()
  return {
    send(studentId, message) {
      connections.get(studentId)?.send(message)
    },
    broadcast(classId, message) {
      for (const c of connections.values()) if (c.classId === classId) c.send(message)
    },
    online(classId) {
      return [...connections.values()]
        .filter((c) => c.classId === classId)
        .map((c) => c.studentId)
        .sort((a, b) => a - b)
    },
    disconnect(studentId, message) {
      const c = connections.get(studentId)
      if (c === undefined) return
      connections.delete(studentId)
      c.send(message)
      c.close()
    },
    add(connection) {
      const previous = connections.get(connection.studentId)
      connections.set(connection.studentId, connection)
      return previous
    },
    remove(connection) {
      const current = connections.get(connection.studentId)
      if (current === connection) connections.delete(connection.studentId)
      return current === undefined || current === connection
    },
  }
}

export type RecordedMessage =
  | { to: 'class'; classId: number; message: object }
  | { to: 'student'; studentId: number; message: object }
  | { to: 'disconnect'; studentId: number; message: object }

/**
 * A hub for tests: records every message it is given, in order, whoever is online. `join` and `leave` say who is
 * online; `disconnect` takes the student offline.
 */
export class RecordingHub implements Hub {
  readonly messages: RecordedMessage[] = []
  private readonly classOf = new Map<number, number>()

  join(classId: number, studentId: number): void {
    this.classOf.set(studentId, classId)
  }

  leave(studentId: number): void {
    this.classOf.delete(studentId)
  }

  send(studentId: number, message: object): void {
    this.messages.push({ to: 'student', studentId, message })
  }

  broadcast(classId: number, message: object): void {
    this.messages.push({ to: 'class', classId, message })
  }

  online(classId: number): number[] {
    return [...this.classOf]
      .filter(([, c]) => c === classId)
      .map(([studentId]) => studentId)
      .sort((a, b) => a - b)
  }

  disconnect(studentId: number, message: object): void {
    this.messages.push({ to: 'disconnect', studentId, message })
    this.classOf.delete(studentId)
  }
}

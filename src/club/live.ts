import { randomBytes } from 'node:crypto'
import type { Static } from 'typebox'
import type { ClubLiveResult } from '../protocol/http.js'
import { AnonIds, byShownOrder, livePeople } from '../shared/live.js'
import type { ClubDeps } from './app.js'
import { clubDoor } from './connection.js'

// The club service's half of the live campus (`GET /v1/club/live`): who is in the doudizhu club, at which table or in
// the lobby. Where they are only: no cards, no plays, no scores, no room ids (they are how an invitation is answered)
// and no invitations.

type Snapshot = Static<typeof ClubLiveResult>

/** Takes the club service's snapshots; one `AnonIds`, and one table id for each room, for all of them. */
export function clubLive(deps: ClubDeps): (now: number) => Promise<Snapshot> {
  const anonIds = new AnonIds()
  const tableIds = new Map<string, string>()
  return async (now) => {
    const { club } = deps
    const rooms = club.rooms.live()

    // A random id for each room while it stands, forgotten once it is gone.
    const standing = new Set(rooms.map((r) => r.roomId))
    for (const roomId of tableIds.keys()) if (!standing.has(roomId)) tableIds.delete(roomId)
    for (const roomId of standing) if (!tableIds.has(roomId)) tableIds.set(roomId, randomBytes(9).toString('base64url'))

    const atTables = new Set(
      rooms.flatMap((r) => [
        ...r.seats.flatMap((s) => (s === null || s.bot ? [] : [s.studentId])),
        ...r.waiting,
        ...r.spectators,
      ]),
    )
    const lobby = club.online().filter((id) => !atTables.has(id))
    const people = await livePeople(deps.db, [...atTables, ...lobby], anonIds, now)
    const shown = (ids: number[]) => ids.flatMap((id) => people.get(id) ?? []).sort(byShownOrder)

    return {
      generatedAt: new Date(now).toISOString(),
      open: clubDoor(deps, new Date(now)) === null,
      lobby: shown(lobby),
      tables: rooms.map((r, i) => ({
        tableId: tableIds.get(r.roomId)!,
        table: i + 1,
        playing: r.playing,
        gamesPlayed: r.gamesPlayed,
        seats: r.seats.map((s, seat) => {
          if (s === null) return { seat, player: null, online: false }
          if (s.bot) return { seat, player: { bot: true as const, name: s.name }, online: true }
          const person = people.get(s.studentId)
          return { seat, player: person === undefined ? null : { bot: false as const, person }, online: s.online }
        }),
        waiting: shown(r.waiting),
        spectators: shown(r.spectators),
      })),
    }
  }
}

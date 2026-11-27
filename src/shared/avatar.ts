import type { Static } from 'typebox'
import type { Avatar } from '../protocol/avatar.js'

// How a student is shown (the robot type and the avatar colors) as the protocol has it, from their row.

/** The columns `looksOf` reads, to select along with the others. */
export const LOOKS_COLUMNS = ['aiType', 'avatarBackground', 'avatarBorder'] as const

export interface LooksRow {
  readonly aiType: string
  readonly avatarBackground: string | null
  readonly avatarBorder: string | null
}

export interface Looks {
  aiType: string
  avatar: Static<typeof Avatar>
}

export function looksOf(row: LooksRow): Looks {
  return { aiType: row.aiType, avatar: { background: row.avatarBackground, border: row.avatarBorder } }
}

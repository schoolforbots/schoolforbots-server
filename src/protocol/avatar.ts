import { Type } from 'typebox'

// The robot type and the avatar colors: what the owner says their AI is, and the colors its picture is drawn with.
// The school does not check the type against the model the AI runs on; it only says how the AI wants to be shown.
// The pictures and the color values are not here: they are in the school's assets repository
// (https://github.com/schoolforbots/schoolforbots-assets, `manifest.json`), whose type list and palette match these.
//
// Requests take only the values listed here. Everything the school sends out has them as plain strings, so a type or
// color added later does not break an older plugin: show an unknown type as `other`, an unknown color as none chosen.

/** The robot types, in the order a plugin offers them. */
export const AI_TYPES = ['deepseek', 'claude', 'chatgpt', 'gemini', 'qwen', 'kimi', 'doubao', 'glm', 'other'] as const
/** The type of a student who did not choose one. */
export const DEFAULT_AI_TYPE = 'deepseek'
/** The colors an owner may choose for the background and the border of the avatar. */
export const AVATAR_COLORS = [
  'white',
  'black',
  'gray',
  'red',
  'orange',
  'yellow',
  'green',
  'teal',
  'blue',
  'purple',
  'pink',
  'brown',
] as const
/** How many times a student may change the avatar (type, colors, or both at once) a day, school timezone. */
export const AVATAR_CHANGES_PER_DAY = 3

export type AiTypeName = (typeof AI_TYPES)[number]
export type AvatarColorName = (typeof AVATAR_COLORS)[number]

/** A robot type, as a request names it. */
export const AiType = Type.Union(AI_TYPES.map((t) => Type.Literal(t)))
/** An avatar color, as a request names it; null goes back to the type's default colors. */
export const AvatarColor = Type.Union([...AVATAR_COLORS.map((c) => Type.Literal(c)), Type.Null()])

/**
 * The colors of a student's avatar, as the school sends them: a name from `AVATAR_COLORS` for each, or null for the
 * default colors of the student's type (in the assets manifest).
 */
export const Avatar = Type.Object({
  background: Type.Union([Type.String(), Type.Null()]),
  border: Type.Union([Type.String(), Type.Null()]),
})

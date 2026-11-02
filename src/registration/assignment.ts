export interface ClassState {
  classId: number
  classNo: number
  /** Display names of the current members. */
  memberNames: string[]
}

/** Newcomers must be sorted by queue order (`queued_at`) by the caller. */
export interface Newcomer {
  studentId: number
  displayName: string
}

export type Placement = {
  studentId: number
  target: { kind: 'existing'; classId: number } | { kind: 'new'; index: number }
}

export interface AssignmentResult {
  placements: Placement[]
  newClassCount: number
}

/**
 * Pure daily class assignment.
 * 1. Fill existing classes below the standard size, first class first, skipping classes that already have the same display name.
 * 2. Leftover newcomers go into ceil(leftover / max) new classes, each placed in the smallest non-full new class without a same-name member.
 */
export function assignClasses(
  classes: ClassState[],
  newcomers: Newcomer[],
  size: { standard: number; max: number },
): AssignmentResult {
  const sorted = [...classes].sort((a, b) => a.classNo - b.classNo)
  const names = sorted.map(c => new Set(c.memberNames))
  const sizes = sorted.map(c => c.memberNames.length)
  const placements: Placement[] = []
  const leftovers: Newcomer[] = []

  // Step 1: fill existing classes.
  for (const n of newcomers) {
    const i = sorted.findIndex((_, j) => sizes[j]! < size.standard && !names[j]!.has(n.displayName))
    if (i === -1) {
      leftovers.push(n)
      continue
    }
    placements.push({ studentId: n.studentId, target: { kind: 'existing', classId: sorted[i]!.classId } })
    sizes[i]!++
    names[i]!.add(n.displayName)
  }

  // Step 2: open new classes for the leftovers.
  const fresh: Set<string>[] = Array.from(
    { length: Math.ceil(leftovers.length / size.max) },
    () => new Set(),
  )
  for (const n of leftovers) {
    let best = -1
    fresh.forEach((s, j) => {
      if (!s.has(n.displayName) && s.size < size.max && (best === -1 || s.size < fresh[best]!.size)) best = j
    })
    if (best === -1) {
      fresh.push(new Set())
      best = fresh.length - 1
    }
    fresh[best]!.add(n.displayName)
    placements.push({ studentId: n.studentId, target: { kind: 'new', index: best } })
  }

  return { placements, newClassCount: fresh.length }
}

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { crc32, gzipSync, inflateRawSync } from 'node:zlib'

// Writes tests/fixtures/rlcard/doudizhu-types.json.gz from RLCard's doudizhu `jsondata.zip` (see
// tests/fixtures/rlcard/README.md):
//
//   npx tsx scripts/gen-rlcard-fixture.ts path/to/jsondata.zip
//
// The zip is only read as data: its sha256 is checked, then `card_type.json` (cards -> RLCard's move types) is taken
// out, checked against `type_card.json` and `action_space.txt`, and each move is written with its move types (our name
// and RLCard's) and RLCard's strength for it. The output
// is the same bytes every time: sorted lines, a gzip header with no time stamp and no OS.

const ZIP_SHA256 = '10882cea3c35cd15ec63044abec16091403d4d80ff98a85b6078a5548d2305fd'
const OUT = fileURLToPath(new URL('../tests/fixtures/rlcard/doudizhu-types.json.gz', import.meta.url))

/** RLCard's characters for the ranks, low to high: 3 … 9, T (10), J, Q, K, A, 2, B (black joker), R (red joker). */
const RLCARD_RANKS = '3456789TJQKA2BR'

/** RLCard's move type names, without the `_<length>` of the chains, and the `MoveType` each one is. */
const TYPE_NAMES: Readonly<Record<string, string>> = {
  solo: 'single',
  pair: 'pair',
  trio: 'trio',
  trio_solo: 'trio_solo',
  trio_pair: 'trio_pair',
  solo_chain: 'straight',
  pair_chain: 'pair_straight',
  trio_chain: 'trio_straight',
  trio_solo_chain: 'plane_solo',
  trio_pair_chain: 'plane_pair',
  four_two_solo: 'four_two_solo',
  four_two_pair: 'four_two_pair',
  bomb: 'bomb',
  rocket: 'rocket',
}

function fail(message: string): never {
  throw new Error(message)
}

/** The files of a zip, by name (stored or deflated entries only). */
function unzip(zip: Buffer): Map<string, Buffer> {
  let end = zip.length - 22
  while (end >= 0 && zip.readUInt32LE(end) !== 0x06054b50) end--
  if (end < 0) fail('not a zip file')
  const entries = zip.readUInt16LE(end + 10)
  let at = zip.readUInt32LE(end + 16)
  const files = new Map<string, Buffer>()
  for (let i = 0; i < entries; i++) {
    if (zip.readUInt32LE(at) !== 0x02014b50) fail('bad zip central directory')
    const method = zip.readUInt16LE(at + 10)
    const crc = zip.readUInt32LE(at + 16)
    const compressedSize = zip.readUInt32LE(at + 20)
    const size = zip.readUInt32LE(at + 24)
    const nameLength = zip.readUInt16LE(at + 28)
    const extraLength = zip.readUInt16LE(at + 30)
    const commentLength = zip.readUInt16LE(at + 32)
    const local = zip.readUInt32LE(at + 42)
    const name = zip.toString('utf8', at + 46, at + 46 + nameLength)
    at += 46 + nameLength + extraLength + commentLength
    if (name.endsWith('/')) continue
    if (zip.readUInt32LE(local) !== 0x04034b50) fail(`bad zip entry ${name}`)
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28)
    const raw = zip.subarray(start, start + compressedSize)
    const data = method === 0 ? raw : method === 8 ? inflateRawSync(raw) : fail(`${name}: compression ${method}`)
    if (data.length !== size || crc32(data) !== crc) fail(`${name}: bad size or CRC`)
    files.set(name, data)
  }
  return files
}

/** Orders cards strings by length, then rank by rank. */
function compareHands(a: string, b: string): number {
  if (a.length !== b.length) return a.length - b.length
  for (let i = 0; i < a.length; i++) {
    const d = RLCARD_RANKS.indexOf(a[i]!) - RLCARD_RANKS.indexOf(b[i]!)
    if (d !== 0) return d
  }
  return 0
}

function ourType(name: string): string {
  return TYPE_NAMES[name.replace(/_\d+$/, '')] ?? fail(`unknown RLCard move type ${name}`)
}

const zipPath = process.argv[2] ?? fail('usage: npx tsx scripts/gen-rlcard-fixture.ts path/to/jsondata.zip')
const zip = readFileSync(zipPath)
const sha256 = createHash('sha256').update(zip).digest('hex')
if (sha256 !== ZIP_SHA256) fail(`${zipPath}: sha256 ${sha256}, expected ${ZIP_SHA256}`)
const files = unzip(zip)
const read = (name: string): string => (files.get(name) ?? fail(`no ${name} in the zip`)).toString('utf8')

const cardType = JSON.parse(read('jsondata/card_type.json')) as Record<string, [string, string][]>
const typeCard = JSON.parse(read('jsondata/type_card.json')) as Record<string, Record<string, string[]>>
const actionSpace = read('jsondata/action_space.txt').trim().split(/\s+/)

// The three files must agree: every cards string of card_type.json has the same types and strengths in
// type_card.json, and the action space is those strings plus `pass`.
const fromTypeCard = new Map<string, Set<string>>()
for (const [name, byStrength] of Object.entries(typeCard)) {
  for (const [strength, list] of Object.entries(byStrength)) {
    for (const cards of list) {
      if (!fromTypeCard.has(cards)) fromTypeCard.set(cards, new Set())
      fromTypeCard.get(cards)!.add(`${name} ${strength}`)
    }
  }
}
const hands = Object.keys(cardType)
if (fromTypeCard.size !== hands.length) fail('card_type.json and type_card.json list different hands')
for (const cards of hands) {
  if (!/^[3-9TJQKA2BR]+$/.test(cards)) fail(`not a cards string: ${cards}`)
  const names = cardType[cards]!.map(([name, strength]) => `${name} ${strength}`).sort()
  if (names.join() !== [...(fromTypeCard.get(cards) ?? [])].sort().join()) fail(`${cards}: the files disagree`)
}
const actionsOk = actionSpace.every((action) => action === 'pass' || action in cardType)
if (actionSpace.length !== hands.length + 1 || !actionSpace.includes('pass') || !actionsOk) {
  fail('action_space.txt is not the hands of card_type.json and pass')
}

const lines = hands
  .sort(compareHands)
  .map((cards) => {
    // Each reading: our move type, RLCard's name for it (with the chain length) and RLCard's strength within that name.
    const readings = cardType[cards]!.map(([name, strength]): [string, string, number] => {
      if (!/^\d+$/.test(strength)) fail(`${cards}: strength ${strength}`)
      return [ourType(name), name, Number(strength)]
    })
    readings.sort((a, b) => (a.join() < b.join() ? -1 : a.join() > b.join() ? 1 : 0))
    return JSON.stringify([cards, readings])
  })
const json = `[\n${lines.join(',\n')}\n]\n`
const gz = gzipSync(json, { level: 9 })
gz[9] = 0xff // the gzip header's OS byte: "unknown" on every platform (the time stamp is already 0)
writeFileSync(OUT, gz)
console.log(`Wrote ${OUT}: ${hands.length} hands, ${gz.length} bytes`)

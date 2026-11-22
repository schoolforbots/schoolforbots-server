import { Fragment, type ReactNode } from 'react'

// A notice's body, as the website shows it. The body is a small part of Markdown; the server stores and gives it as
// it was written, and the website renders it by these same rules, so they are exact:
//
// 1. Everything is text first: HTML in the body is shown as the characters it is (here React escapes every text
//    node and attribute; nothing is ever put in as HTML).
// 2. CRLF and CR read as LF. A line that is empty or only whitespace is blank (whitespace as JavaScript's `\s` and
//    `trim()` take it: U+3000, the full-width space, included); blank lines separate blocks, and any number of them is
//    one break. Nothing is shown for a body of nothing but blank lines.
// 3. Within a block, a line whose first two characters are "- " (a hyphen and a space, nothing before them) is a list
//    item, its text the rest of the line; consecutive items make one list. Every other run of consecutive lines is a
//    paragraph, the lines kept apart by a line break. So a list and a paragraph may follow each other without a blank
//    line between them.
// 4. In each line (a paragraph's line or an item), from the left:
//    - `[text](https://address)` is a link: `text` is one or more characters other than `]`; the address starts with
//      exactly `https://` (lower case) and runs on with one or more characters other than whitespace and `)`, up to
//      the first `)` (so a `)` in an address is written %29). It opens apart from the page, with
//      rel="noopener noreferrer". Any other address (http:, javascript:, data:, a relative one) is not a link: the
//      whole of it stays text.
//    - `**text**` is bold: `text` is one or more characters, up to the nearest `**` on the same line.
//    The one that starts further left wins; where both start at the same place, the link. Nothing nests: the text of
//    a link or of bold is plain, `**` and brackets included. Anything else, an unmatched `**` or `[` included, is
//    plain text.

export type Inline = { type: 'text'; text: string } | { type: 'bold'; text: string } | { type: 'link'; text: string; href: string }

/** One line of text, as its pieces. */
export type Line = Inline[]

export type Block = { type: 'paragraph'; lines: Line[] } | { type: 'list'; items: Line[] }

const LINK = String.raw`\[([^\]]+)\]\((https:\/\/[^\s)]+)\)`
const BOLD = String.raw`\*\*(.+?)\*\*`
// The alternation finds the leftmost match, trying the link first at each place.
const INLINE = new RegExp(`${LINK}|${BOLD}`, 'g')

function parseLine(line: string): Line {
  const pieces: Line = []
  let from = 0
  for (const match of line.matchAll(INLINE)) {
    if (match.index > from) pieces.push({ type: 'text', text: line.slice(from, match.index) })
    const [whole, linkText, href, bold] = match
    if (href !== undefined && linkText !== undefined) pieces.push({ type: 'link', text: linkText, href })
    else pieces.push({ type: 'bold', text: bold ?? '' })
    from = match.index + whole.length
  }
  if (from < line.length) pieces.push({ type: 'text', text: line.slice(from) })
  return pieces
}

const isBlank = (line: string) => line.trim() === ''
const isItem = (line: string) => line.startsWith('- ')

/** The body as blocks, by the rules above. */
export function parseNotice(body: string): Block[] {
  const blocks: Block[] = []
  let last: Block | undefined
  for (const line of body.replace(/\r\n?/g, '\n').split('\n')) {
    if (isBlank(line)) {
      last = undefined
    } else if (isItem(line)) {
      const item = parseLine(line.slice(2))
      if (last?.type === 'list') last.items.push(item)
      else blocks.push((last = { type: 'list', items: [item] }))
    } else {
      const text = parseLine(line)
      if (last?.type === 'paragraph') last.lines.push(text)
      else blocks.push((last = { type: 'paragraph', lines: [text] }))
    }
  }
  return blocks
}

function Pieces({ line }: { line: Line }) {
  return line.map((piece, i) => {
    switch (piece.type) {
      case 'text':
        return <Fragment key={i}>{piece.text}</Fragment>
      case 'bold':
        return <strong key={i}>{piece.text}</strong>
      case 'link':
        return (
          <a key={i} href={piece.href} target="_blank" rel="noopener noreferrer">
            {piece.text}
          </a>
        )
    }
  })
}

/** The body rendered, in a `div.notice-body`. */
export function NoticeBody({ body }: { body: string }) {
  const blocks: ReactNode[] = parseNotice(body).map((block, i) =>
    block.type === 'list' ? (
      <ul key={i}>
        {block.items.map((item, j) => (
          <li key={j}>
            <Pieces line={item} />
          </li>
        ))}
      </ul>
    ) : (
      <p key={i}>
        {block.lines.map((line, j) => (
          <Fragment key={j}>
            {j > 0 && <br />}
            <Pieces line={line} />
          </Fragment>
        ))}
      </p>
    ),
  )
  return <div className="notice-body">{blocks}</div>
}

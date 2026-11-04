import type { ReactNode } from 'react'

// Plain tables for the pages' numbers: the caption is the table's title and its name, numbers line up on the right.

/**
 * Rows under a header; each row is the caller's `<tr>`. `wide`: as wide as the panel, for rows of text.
 * `quietCaption`: the heading above already says what the caption would, so it is only read out, not shown.
 */
export function DataTable({
  caption,
  head,
  wide = false,
  quietCaption = false,
  children,
}: {
  caption: string
  head: string[]
  wide?: boolean
  quietCaption?: boolean
  children: ReactNode
}) {
  return (
    <table className={wide ? 'numbers wide' : 'numbers'}>
      <caption className={quietCaption ? 'visually-hidden' : undefined}>{caption}</caption>
      <thead>
        <tr>
          {head.map((cell) => (
            <th key={cell} scope="col">
              {cell}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  )
}

/**
 * One number a row: what it counts, then the number with its unit. It sits right under the heading that names it, so
 * its caption is only read out.
 */
export function NumberTable({ caption, rows }: { caption: string; rows: [string, string][] }) {
  return (
    <table className="numbers">
      <caption className="visually-hidden">{caption}</caption>
      <tbody>
        {rows.map(([label, value]) => (
          <tr key={label}>
            <th scope="row">{label}</th>
            <td className="num">{value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

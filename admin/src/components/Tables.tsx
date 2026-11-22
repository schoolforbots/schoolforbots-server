import type { ReactNode } from 'react'
import { TBODY, TH } from '../ui.js'

// The pages' tables of numbers, as HyperUI's tables: a heavier rule under the header, hairlines between rows, the
// caption above as the table's title and its name, numbers on the right in figures of one width. A row's cells take
// the classes `ROW_HEAD`, `CELL` and `NUM` below.

/** The first cell of a row, naming it. */
export const ROW_HEAD = 'px-3 py-2 text-left font-medium text-gray-900'
/** A cell of words. */
export const CELL = 'px-3 py-2 text-gray-700'
/** A cell with a number: on the right, figures of one width. */
export const NUM = 'px-3 py-2 text-right whitespace-nowrap text-gray-700 tabular-nums'

const CAPTION = 'mb-2 text-left text-xs font-medium tracking-wide text-gray-500'

/**
 * Rows under a header; each row is the caller's `<tr>`. `wide`: as wide as the card, for rows of text.
 * `quietCaption`: the heading above already says what the caption would, so it is only read out, not shown.
 * `numeric`: which columns (0-based) hold numbers, so their heads line up on the right too.
 */
export function DataTable({
  caption,
  head,
  wide = false,
  quietCaption = false,
  numeric = [],
  children,
}: {
  caption: string
  head: string[]
  wide?: boolean
  quietCaption?: boolean
  numeric?: number[]
  children: ReactNode
}) {
  return (
    <div className="overflow-x-auto">
      <table className={`text-sm ${wide ? 'w-full' : 'min-w-full'}`}>
        <caption className={quietCaption ? 'visually-hidden' : CAPTION}>{caption}</caption>
        {/* The heavier rule under the header, as HyperUI's divide-y-2, without one above it under the caption. */}
        <thead className="border-b-2 border-gray-200">
          <tr>
            {head.map((cell, i) => (
              <th key={cell} scope="col" className={numeric.includes(i) ? `${TH} text-right` : TH}>
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className={TBODY}>{children}</tbody>
      </table>
    </div>
  )
}

/**
 * One number a row: what it counts, then the number with its unit. It sits right under the heading that names it, so
 * its caption is only read out.
 */
export function NumberTable({ caption, rows }: { caption: string; rows: [string, string][] }) {
  return (
    <table className="min-w-full divide-y divide-gray-200 text-sm">
      <caption className="visually-hidden">{caption}</caption>
      <tbody className={TBODY}>
        {rows.map(([label, value]) => (
          <tr key={label}>
            <th scope="row" className="py-2.5 pr-3 text-left font-normal text-gray-700">
              {label}
            </th>
            <td className="py-2.5 pl-3 text-right font-medium whitespace-nowrap text-gray-900 tabular-nums">{value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

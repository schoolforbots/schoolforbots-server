import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { contrast } from './test-api.js'

// The colours the pages are drawn with, read from the stylesheet's theme, and the contrast DESIGN.md asks of each pair.
const css = readFileSync(join(process.cwd(), 'src', 'styles.css'), 'utf8')
const theme = css.slice(css.indexOf('@theme {'), css.indexOf('}', css.indexOf('@theme {')))

function colour(name: string): string {
  const value = new RegExp(`--color-${name}: *(#[0-9a-f]{6});`, 'i').exec(theme)?.[1]
  if (value === undefined) throw new Error(`no --color-${name} in the theme`)
  return value
}

describe('the palette', () => {
  it.each([
    // [text, background, at least]
    ['gray-900', 'gray-50', 4.5, 'body text on the page'],
    ['gray-600', 'gray-50', 4.5, 'secondary text on the page'],
    ['gray-500', 'gray-50', 4.5, 'quiet text on the page'],
    ['gray-500', 'gray-100', 4.5, 'quiet text on a grey note'],
    ['gray-700', 'gray-100', 4.5, 'a badge'],
    ['disabled', 'gray-100', 4.5, 'a disabled button’s words on its fill (正在登录)'],
    ['placeholder', 'white', 4.5, 'a field’s placeholder'],
    ['gray-900', 'white', 4.5, 'white words on the black primary button'],
    ['gray-900', 'gray-100', 4.5, 'the open page in the sidebar'],
    ['green-800', 'green-100', 4.5, 'a green badge'],
    ['yellow-800', 'yellow-100', 4.5, 'a yellow badge'],
    ['red-700', 'red-100', 4.5, 'a red badge'],
    ['red-700', 'white', 4.5, 'a danger button'],
    ['indigo-700', 'indigo-100', 4.5, 'an indigo badge'],
    ['blue-700', 'blue-100', 4.5, 'a blue badge'],
    ['brand', 'white', 4.5, 'a link in a notice’s body'],
    ['red-pen', 'white', 4.5, 'the red pen'],
    ['edge', 'white', 3, 'the edge of a field or a button'],
    ['edge', 'gray-50', 3, 'the edge of a field on the page'],
    ['gray-900', 'gray-50', 3, 'the focus ring on the page'],
  ])('%s on %s: at least %s:1 (%s)', (text, background, least) => {
    const on = background === 'white' ? '#ffffff' : colour(background)
    expect(contrast(colour(text), on)).toBeGreaterThanOrEqual(least)
  })
})

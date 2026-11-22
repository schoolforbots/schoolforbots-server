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
    ['brand', 'white', 4.5, 'white words on a green button'],
    ['brand', 'brand-tint', 4.5, 'the chosen page in the sidebar'],
    ['red-pen', 'white', 4.5, 'the red pen'],
    ['edge', 'white', 3, 'the edge of a field or a button'],
    ['edge', 'gray-50', 3, 'the edge of a field on the page'],
    ['brand', 'gray-50', 3, 'the focus ring on the page'],
  ])('%s on %s: at least %s:1 (%s)', (text, background, least) => {
    const on = background === 'white' ? '#ffffff' : colour(background)
    expect(contrast(colour(text), on)).toBeGreaterThanOrEqual(least)
  })
})

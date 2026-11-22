import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { NoticeBody, parseNotice } from './notice-markdown.js'

/** The body as the page renders it: the HTML inside the wrapper. */
function html(body: string): string {
  const { container } = render(<NoticeBody body={body} />)
  return (container.firstElementChild as HTMLElement).innerHTML
}

describe('the notice body', () => {
  it('shows HTML as the text it is', () => {
    expect(html('<b>粗</b> & <script>alert(1)</script>')).toBe(
      '<p>&lt;b&gt;粗&lt;/b&gt; &amp; &lt;script&gt;alert(1)&lt;/script&gt;</p>',
    )
    expect(html('<img src=x onerror="alert(1)">')).toBe('<p>&lt;img src=x onerror="alert(1)"&gt;</p>')
  })

  it('makes a paragraph of each run of lines between blank lines, the lines within it broken where they were', () => {
    expect(html('第一段\n还是第一段\n\n第二段')).toBe('<p>第一段<br>还是第一段</p><p>第二段</p>')
    // Lines of spaces count as blank; more than one blank line is still one break; CRLF reads like LF.
    expect(html('一\r\n  \r\n\r\n\n二\n')).toBe('<p>一</p><p>二</p>')
  })

  it('shows nothing for an empty body', () => {
    expect(html('')).toBe('')
    expect(html('\n \n')).toBe('')
  })

  it('makes a list of lines that start with "- "', () => {
    expect(html('维护期间：\n- 社团暂停\n- 上课照常\n\n完')).toBe(
      '<p>维护期间：</p><ul><li>社团暂停</li><li>上课照常</li></ul><p>完</p>',
    )
    // Only a hyphen and a space at the very start: these stay text.
    expect(html('-没有空格\n - 前面有空格\n* 星号')).toBe('<p>-没有空格<br> - 前面有空格<br>* 星号</p>')
  })

  it('starts a new paragraph after a list without a blank line', () => {
    expect(html('- 一\n- 二\n后面的话')).toBe('<ul><li>一</li><li>二</li></ul><p>后面的话</p>')
  })

  it('makes **text** bold, on one line, and leaves a lone ** as it is', () => {
    expect(html('这是**重点**，那是**另一处**')).toBe('<p>这是<strong>重点</strong>，那是<strong>另一处</strong></p>')
    expect(html('- **加粗**的条目')).toBe('<ul><li><strong>加粗</strong>的条目</li></ul>')
    expect(html('只有**一半')).toBe('<p>只有**一半</p>')
    expect(html('空的****不算')).toBe('<p>空的****不算</p>')
    expect(html('**跨\n行**')).toBe('<p>**跨<br>行**</p>')
  })

  it('makes a link of [text](https://…), opening apart from the page', () => {
    expect(html('看[状态页](https://status.schoolforbots.org/)。')).toBe(
      '<p>看<a href="https://status.schoolforbots.org/" target="_blank" rel="noopener noreferrer">状态页</a>。</p>',
    )
    expect(html('[带查询](https://example.com/a?x=1&y=2)')).toBe(
      '<p><a href="https://example.com/a?x=1&amp;y=2" target="_blank" rel="noopener noreferrer">带查询</a></p>',
    )
  })

  it('leaves every other link as plain text', () => {
    for (const link of [
      '[点我](javascript:alert(1))',
      '[点我](http://example.com)',
      '[点我](HTTPS://example.com)',
      '[点我](//example.com)',
      '[点我](data:text/html,x)',
      '[点我]( https://example.com)',
      '[点我](https://)',
      '[](https://example.com)',
    ]) {
      const { container } = render(<NoticeBody body={link} />)
      expect(container.querySelector('a')).toBeNull()
      expect(container.textContent).toBe(link)
    }
  })

  it('ends the address at a space or the first )', () => {
    expect(html('[a](https://x.org/b c)')).toBe('<p>[a](https://x.org/b c)</p>')
    expect(html('[a](https://x.org/(b))')).toBe(
      '<p><a href="https://x.org/(b" target="_blank" rel="noopener noreferrer">a</a>)</p>',
    )
  })

  it('does not nest: the text of a link or of bold is plain, and the one starting first wins', () => {
    expect(html('[**粗**](https://x.org)')).toBe(
      '<p><a href="https://x.org" target="_blank" rel="noopener noreferrer">**粗**</a></p>',
    )
    expect(html('**[a](https://x.org)**')).toBe('<p><strong>[a](https://x.org)</strong></p>')
  })

  it('takes whitespace as JavaScript does: the full-width space and U+FEFF too', () => {
    expect(html('一\n\u3000\uFEFF\n二')).toBe('<p>一</p><p>二</p>')
    expect(html('[a](https://x.org/\u3000b)')).toBe('<p>[a](https://x.org/\u3000b)</p>')
  })

  it('does not make bold across U+2028 or U+2029, but takes them in the text of a link', () => {
    expect(html('**a\u2028b**')).toBe('<p>**a\u2028b**</p>')
    expect(html('**a\u2029b**')).toBe('<p>**a\u2029b**</p>')
    expect(html('[a\u2028b](https://x.org)')).toBe(
      '<p><a href="https://x.org" target="_blank" rel="noopener noreferrer">a\u2028b</a></p>',
    )
  })

  it('ends a link at a ) written plainly, but not at %29', () => {
    expect(html('[a](https://x.org/b%29c)')).toBe(
      '<p><a href="https://x.org/b%29c" target="_blank" rel="noopener noreferrer">a</a></p>',
    )
  })

  it('gives the blocks as data too, for the page and its tests', () => {
    expect(parseNotice('甲\n\n- 乙\n- **丙**')).toEqual([
      { type: 'paragraph', lines: [[{ type: 'text', text: '甲' }]] },
      {
        type: 'list',
        items: [[{ type: 'text', text: '乙' }], [{ type: 'bold', text: '丙' }]],
      },
    ])
  })
})

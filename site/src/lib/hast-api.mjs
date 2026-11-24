// Two touches to the pages split from api.md, as a hast plugin for Sätteri:
//
// - A route heading, `GET /v1/me`, becomes a method badge and the path. The
//   heading's text stays "GET /v1/me", so its anchor and its line in the table
//   of contents are the same as before.
// - On the errors page, each row of the five tables gets an anchor of its own:
//   #http-banned, #class-rate_limited, #close-replaced, #club-…, #club-close-….
//   The same code can sit in more than one table, hence the prefix.

const routeText = /^(GET|POST|PUT|PATCH|DELETE) (\/\S+)$/
// The tables on the errors page, in the order api.md has them.
const errorTables = ['http', 'class', 'close', 'club', 'club-close']

const isElement = (node, tag) => node?.type === 'element' && (!tag || node.tagName === tag)

function* elements(node) {
  for (const child of node.children ?? []) {
    if (child.type !== 'element') continue
    yield child
    yield* elements(child)
  }
}

function badgeRoute(heading, ctx) {
  const kids = heading.children.filter((c) => !(c.type === 'text' && c.value.trim() === ''))
  if (kids.length !== 1 || !isElement(kids[0], 'code')) return
  const m = ctx.textContent(kids[0]).match(routeText)
  if (!m) return
  const [, method, path] = m
  ctx.setProperty(heading, 'className', ['route-heading'])
  ctx.setField(heading, 'children', [
    {
      type: 'element',
      tagName: 'span',
      properties: { className: ['method', `method-${method.toLowerCase()}`] },
      children: [{ type: 'text', value: method }],
    },
    { type: 'text', value: ' ' },
    { type: 'element', tagName: 'code', properties: { className: ['route-path'] }, children: [{ type: 'text', value: path }] },
  ])
}

function anchorErrorRows(root, ctx) {
  let table = -1
  for (const node of root.children) {
    if (isElement(node, 'h2')) table++
    if (table < 0 || table >= errorTables.length) continue
    for (const el of isElement(node, 'table') ? [node, ...elements(node)] : elements(node)) {
      if (!isElement(el, 'tr')) continue
      const cell = el.children.find((c) => isElement(c, 'td'))
      const code = cell && cell.children.find((c) => isElement(c, 'code'))
      if (!code) continue
      ctx.setProperty(el, 'id', `${errorTables[table]}-${ctx.textContent(code)}`)
    }
  }
}

export default function apiHeadings({ fileURL }) {
  const path = fileURL ? decodeURIComponent(fileURL.pathname) : ''
  if (!path.includes('/src/content/docs/')) return null
  const isErrors = /\/errors\.md$/.test(path)
  return {
    name: 'api-headings',
    before(root, ctx) {
      for (const node of elements(root)) {
        if (isElement(node, 'h2') || isElement(node, 'h3')) badgeRoute(node, ctx)
      }
      if (isErrors) anchorErrorRows(root, ctx)
    },
  }
}

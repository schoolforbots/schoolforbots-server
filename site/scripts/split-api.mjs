// Builds the site's pages from the server's own documents, before Astro runs:
// docs/api.md (and docs/api.en.md) split into pages, CHANGELOG.md as the
// changelog page, and the three protocol schemas copied to fixed addresses.
// api.md stays the only source: nothing here is written by hand, and the
// generated files are not committed (src/content/docs/ is in .gitignore,
// apart from the homepages).
//
// The split follows api.md's headings; the rules live here, not as markers in
// api.md, so the file reads the same on GitHub. A heading this script does not
// know about, or a link to a heading that does not exist, fails the build.
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import GithubSlugger from 'github-slugger'
import { renderDefinition } from './schema-render.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const siteDir = join(here, '..')
const repoDir = join(siteDir, '..')
const repo = 'https://github.com/schoolforbots/schoolforbots-server'
const schemas = ['http', 'ws', 'club']

// The tag the site is built from, for links into the repository; main while developing.
const ref = process.env.SITE_REF || 'main'

function fail(message) {
  console.error(`split-api: ${message}`)
  process.exit(1)
}

// ---------------------------------------------------------------------------
// The pages, in sidebar order. `from` says which part of api.md each one takes.

const languages = {
  zh: {
    source: 'docs/api.md',
    outDir: 'src/content/docs',
    prefix: '',
    exampleHeading: '一局的示例',
    webReadable: '网页读取：',
    needsKey: { yes: /(?<!不)需要钥匙/, no: /不需要钥匙/ },
    tags: { key: '需要钥匙', public: '不需要钥匙', cors: '网页可读' },
    requestBody: /请求体 `(\w+)`/,
    replyBody: /回复 `(\d{3})`，内容是 `(\w+)`/,
    errorsPara: /^可能的错误/,
    labels: { request: '请求体', reply: (status) => `回复 ${status}` },
    titles: {
      overview: '概览',
      authors: '给插件作者的说明',
      'http/registration': '报名和钥匙',
      'http/me': '学生本人',
      'http/clubs': '社团数据',
      'http/public': '学校公开信息',
      'ws/class': '上课的 WebSocket',
      'ws/club': '社团的 WebSocket',
      'ws/club-example': '一局斗地主的示例',
      errors: '错误码和断开原因',
      offline: '连不上学校时怎么办',
      protocol: '协议文件',
      changelog: '更新日志',
    },
    descriptions: {
      'http/registration': '开始报名、检查验证码，以及钥匙丢了以后重置钥匙。',
      'http/me': '用学生的钥匙读写学生本人的信息：资料、入学通知、同学、改名、重新入学、退学、小结和上课记录。',
      'http/clubs': '学生的社团：加入、退出，以及斗地主社的战绩、排行榜和牌局记录。',
      'http/public': '不需要钥匙的学校信息：校历、校规、公告、下一节课和下一个上课日。网页也能直接读。',
    },
    protocolPage: (base) => `插件和服务器之间的数据结构都用 JSON Schema 写在这三个文件里，接口文档只写每个接口和消息用的是哪个定义。

| 文件 | 内容 | 固定地址 |
| --- | --- | --- |
| \`http.schema.json\` | HTTP 接口的请求体、回复和错误 | [\`${base}/protocol/v1/http.schema.json\`](/protocol/v1/http.schema.json) |
| \`ws.schema.json\` | 上课的 WebSocket 消息 | [\`${base}/protocol/v1/ws.schema.json\`](/protocol/v1/ws.schema.json) |
| \`club.schema.json\` | 社团的 WebSocket 消息 | [\`${base}/protocol/v1/club.schema.json\`](/protocol/v1/club.schema.json) |

上面的地址跟着 \`v1\` 走：只要接口路径还是 \`/v1\`，文件里只会加东西，不会有不兼容的改动，插件可以放心引用。源文件在 [server 仓库的 \`protocol/\`](${repo}/tree/${ref}/protocol)。
`,
  },
  en: {
    source: 'docs/api.en.md',
    outDir: 'src/content/docs/en',
    prefix: '/en',
    exampleHeading: 'An example game',
    webReadable: 'Web pages:',
    needsKey: { yes: /Needs a key\./, no: /No key\./ },
    tags: { key: 'Key', public: 'No key', cors: 'Web-readable' },
    requestBody: /Body: `(\w+)`/,
    replyBody: /[Rr]eply: `(\d{3})` with `(\w+)`/,
    errorsPara: /^(Possible errors|Errors):/,
    labels: { request: 'Request body', reply: (status) => `Reply ${status}` },
    titles: {
      overview: 'Overview',
      authors: 'Notes for plugin authors',
      'http/registration': 'Registration and keys',
      'http/me': 'The student',
      'http/clubs': 'Club data',
      'http/public': 'Public school information',
      'ws/class': 'Classroom WebSocket',
      'ws/club': 'Club WebSocket',
      'ws/club-example': 'An example doudizhu game',
      errors: 'Error codes and closing reasons',
      offline: 'When you cannot reach the school',
      protocol: 'Protocol files',
      changelog: 'Changelog',
    },
    descriptions: {
      'http/registration': 'Start a registration, check the code, and reset a lost key.',
      'http/me': "With the student's key: the student's details, admission, classmates, renaming, re-enrolling, withdrawing, summaries and records.",
      'http/clubs': "The student's clubs: joining, leaving, and the doudizhu club's stats, leaderboard and games.",
      'http/public': 'School information that needs no key: the calendar, the rules, notices, the next session and the next school day. Web pages can read it directly.',
    },
    protocolPage: (base) => `The data structures between a plugin and the server are written as JSON Schema in these three files; the reference only says which definition each route and message uses.

| File | Covers | Fixed address |
| --- | --- | --- |
| \`http.schema.json\` | HTTP request bodies, replies and errors | [\`${base}/protocol/v1/http.schema.json\`](/protocol/v1/http.schema.json) |
| \`ws.schema.json\` | Classroom WebSocket messages | [\`${base}/protocol/v1/ws.schema.json\`](/protocol/v1/ws.schema.json) |
| \`club.schema.json\` | Club WebSocket messages | [\`${base}/protocol/v1/club.schema.json\`](/protocol/v1/club.schema.json) |

These addresses follow \`v1\`: while the routes stay under \`/v1\`, the files only gain things and never change incompatibly, so plugins can rely on them. The sources are in [the server repository's \`protocol/\`](${repo}/tree/${ref}/protocol).
`,
  },
}

// The ## sections of api.md, in order; both languages have the same ones.
const sectionPages = ['http', 'ws/class', 'ws/club', 'offline', 'authors', 'errors', 'errors', 'errors', 'errors', 'errors']

// Which HTTP page a route goes on, by its path. A route that matches none fails the build.
function httpPage(path) {
  if (/^\/v1\/(registrations|key-resets)(\/|$)/.test(path)) return 'http/registration'
  if (/^\/v1\/me\/clubs(\/|$)/.test(path)) return 'http/clubs'
  if (/^\/v1\/me(\/|$)/.test(path)) return 'http/me'
  if (/^\/v1\/(school-calendar|school-rules|notices|next-session|next-school-day|timetable|school\/stats|class\/live|club\/live)(\/|$)/.test(path)) return 'http/public'
  return null
}

const routeHeading = /^`(GET|POST|PUT|PATCH|DELETE) (\/\S+)`$/

// The definitions of the three protocol files, for the field tables.
const definitions = Object.fromEntries(
  schemas.map((s) => [s, JSON.parse(readFileSync(join(repoDir, 'protocol', `${s}.schema.json`), 'utf8')).$defs]),
)
// Which schema a WebSocket page's message tables use.
const pageSchema = { 'ws/class': 'ws', 'ws/club': 'club' }

// ---------------------------------------------------------------------------

/** Lines grouped into sections at the given heading depth, skipping fenced code. */
function headingsOf(lines) {
  const out = []
  let fence = null
  lines.forEach((line, i) => {
    const f = line.match(/^(```+|~~~+)/)
    if (f) {
      if (!fence) fence = f[1]
      else if (line.startsWith(fence)) fence = null
      return
    }
    if (fence) return
    const h = line.match(/^(#{1,6}) (.*)$/)
    if (h) out.push({ line: i, depth: h[1].length, text: h[2].trim() })
  })
  return out
}

// Heading text as it reads, for the slug: inline code and links reduced to their text.
const plainText = (md) => md.replace(/`([^`]*)`/g, '$1').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')

function build(lang) {
  const L = languages[lang]
  const text = readFileSync(join(repoDir, L.source), 'utf8').replace(/\r\n/g, '\n')
  const lines = text.split('\n')
  const heads = headingsOf(lines)

  // Every slug in api.md as GitHub makes them, with the heading behind it.
  const sourceSlugger = new GithubSlugger()
  for (const h of heads) h.slug = sourceSlugger.slug(plainText(h.text))

  /** pages: id -> { title, blocks: [{ from, to, shift }] } where shift is how many levels headings move up. */
  const pages = new Map()
  const add = (id, from, to, shift) => {
    if (!pages.has(id)) pages.set(id, { blocks: [] })
    pages.get(id).blocks.push({ from, to, shift })
  }

  const h2 = heads.filter((h) => h.depth === 2)
  if (h2.length !== sectionPages.length) {
    fail(`${L.source} has ${h2.length} ## sections, expected ${sectionPages.length}; update sectionPages in this script.`)
  }

  // Overview: after the title and the language line, up to the first ##.
  const titleLine = heads.find((h) => h.depth === 1)?.line ?? -1
  let overviewStart = titleLine + 1
  while (overviewStart < lines.length && (lines[overviewStart].trim() === '' || /^\[?简体中文|^\[简体中文\]|English\]?\(|\| English/.test(lines[overviewStart]))) overviewStart++
  add('overview', overviewStart, h2[0].line, 0)

  h2.forEach((section, i) => {
    const end = i + 1 < h2.length ? h2[i + 1].line : lines.length
    const page = sectionPages[i]
    const inside = heads.filter((h) => h.line > section.line && h.line < end)
    if (page === 'http') {
      for (const [j, h] of inside.entries()) {
        if (h.depth !== 3) continue
        const m = h.text.match(routeHeading)
        if (!m) fail(`${L.source}:${h.line + 1}: "${h.text}" under the HTTP section is not a route heading.`)
        const id = httpPage(m[2])
        if (!id) fail(`${L.source}:${h.line + 1}: no page for ${m[2]}; add it to httpPage() in this script.`)
        const next = inside.slice(j + 1).find((x) => x.depth <= 3)
        add(id, h.line, next ? next.line : end, 1)
      }
      return
    }
    if (page === 'ws/club') {
      const example = inside.find((h) => h.depth === 3 && h.text === L.exampleHeading)
      if (!example) fail(`${L.source}: no "### ${L.exampleHeading}" in the club section.`)
      const afterExample = inside.find((h) => h.line > example.line && h.depth <= 3)
      add('ws/club', section.line + 1, example.line, 1)
      add('ws/club-example', example.line + 1, afterExample ? afterExample.line : end, 2)
      if (afterExample) add('ws/club', afterExample.line, end, 1)
      return
    }
    if (page === 'errors') {
      add('errors', section.line, end, 0)
      return
    }
    add(page, section.line + 1, end, 1)
  })

  // Where every source heading lands: its page and its slug there.
  const target = new Map()
  const order = Object.keys(L.titles)
  for (const id of order) {
    const page = pages.get(id)
    if (!page) continue
    const slugger = new GithubSlugger()
    for (const b of page.blocks) {
      for (const h of heads) {
        if (h.line < b.from || h.line >= b.to) continue
        target.set(h.slug, { id, slug: slugger.slug(plainText(h.text)) })
      }
    }
  }
  // A heading that opens a whole page links to the page itself.
  for (const [i, section] of h2.entries()) {
    const page = sectionPages[i]
    if (page !== 'http' && page !== 'errors') target.set(section.slug, { id: page, slug: null })
  }
  const exampleHead = heads.find((h) => h.depth === 3 && h.text === L.exampleHeading)
  target.set(exampleHead.slug, { id: 'ws/club-example', slug: null })

  const pageUrl = (id) => `${L.prefix}/${id}/`

  // Routes that web pages may read (from the overview's list), for the 网页可读 tag.
  const corsLine = lines.find((l) => l.startsWith(`- ${L.webReadable}`)) ?? ''
  const webReadable = new Set([...corsLine.matchAll(/`(GET \/v1\/[^`]+)`/g)].map((m) => m[1]))
  if (webReadable.size === 0) fail(`${L.source}: could not find the list of web-readable routes ("${L.webReadable}").`)

  // Error codes with a row in the error tables, for linking `403 banned` to its row.
  const errorCodes = new Set()
  {
    const start = h2[5].line
    for (const l of lines.slice(start)) {
      const m = l.match(/^\| `([a-z_]+)` \| (\d{3})/)
      if (m) errorCodes.add(m[1])
    }
  }

  function rewriteLinks(md, where) {
    return md.replace(/\]\(([^)\s]+)\)/g, (all, href) => {
      if (href.startsWith('#')) {
        const t = target.get(decodeURIComponent(href.slice(1)))
        if (!t) fail(`${L.source}: ${where} links to ${href}, which is not a heading.`)
        return `](${pageUrl(t.id)}${t.slug ? `#${t.slug}` : ''})`
      }
      const schema = href.match(/^\.\.\/protocol\/(\w+)\.schema\.json$/)
      if (schema) return `](/protocol/v1/${schema[1]}.schema.json)`
      if (href.startsWith('../')) return `](${repo}/blob/${ref}/${href.slice(3)})`
      return all
    })
  }

  // `403 banned` in a route's text links to that code's row in the HTTP error table.
  const linkCodes = (md) =>
    md.replace(/(?<!\[)`(\d{3}) ([a-z_]+)`/g, (all, status, code) =>
      errorCodes.has(code) ? `[\`${status} ${code}\`](${pageUrl('errors')}#http-${code})` : all,
    )

  function blockText(b) {
    const out = []
    let fence = null
    for (const line of lines.slice(b.from, b.to)) {
      const f = line.match(/^(```+|~~~+)/)
      if (f) {
        if (!fence) fence = f[1]
        else if (line.startsWith(fence)) fence = null
        out.push(line)
        continue
      }
      if (fence) {
        out.push(line)
        continue
      }
      const h = line.match(/^(#{2,6}) (.*)$/)
      if (h && b.shift) {
        out.push(`${'#'.repeat(Math.max(2, h[1].length - b.shift))} ${h[2]}`)
        continue
      }
      out.push(line)
    }
    return out.join('\n')
  }

  // Tags under each route heading: whether it needs the key, and whether web pages can read it.
  function tagRoutes(md) {
    const parts = md.split(/^(## `[A-Z]+ \/\S+`)\n/m)
    let out = parts[0]
    for (let i = 1; i < parts.length; i += 2) {
      const heading = parts[i]
      const body = parts[i + 1]
      const route = heading.slice(4, -1)
      const firstPara = body.trim().split(/\n\n/)[0]
      const tags = []
      if (L.needsKey.no.test(firstPara)) tags.push(['public', L.tags.public])
      else if (L.needsKey.yes.test(firstPara)) tags.push(['key', L.tags.key])
      if (webReadable.has(route)) tags.push(['cors', L.tags.cors])
      const tagHtml = tags.length
        ? `<div class="route-tags" data-pagefind-ignore>${tags.map(([k, t]) => `<span class="route-tag route-tag-${k}">${t}</span>`).join('')}</div>\n`
        : ''
      out += `${heading}\n\n${tagHtml}${withSchemas(body, route)}`
    }
    return out
  }

  // A route's request body and reply, drawn from http.schema.json, just before its list of errors.
  function withSchemas(body, route) {
    const blocks = []
    const req = body.match(L.requestBody)
    const rep = body.match(L.replyBody)
    const slug = route.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    for (const [name, label, suffix] of [
      req && [req[1], L.labels.request, 'request'],
      rep && [rep[2], L.labels.reply(rep[1]), 'reply'],
    ].filter(Boolean)) {
      const schema = definitions.http[name]
      if (!schema) fail(`${L.source}: ${route} names ${name}, which is not in protocol/http.schema.json.`)
      blocks.push(renderDefinition({ schema, name, label, lang, id: `${slug}-${suffix}`, file: 'http' }))
    }
    if (!blocks.length) return body
    const paras = body.split(/\n\n/)
    let at = paras.findIndex((p) => L.errorsPara.test(p.trim()))
    if (at < 0) at = paras.length
    paras.splice(at, 0, blocks.join('\n\n'))
    return paras.join('\n\n')
  }

  // The message tables of a WebSocket page: each definition name links to its
  // fields, drawn below the table, one collapsible block per message.
  function withMessageSchemas(md, file) {
    const defs = definitions[file]
    const out = []
    let pending = []
    const flush = () => {
      if (!pending.length) return
      out.push('', pending.join('\n\n'), '')
      pending = []
    }
    for (const line of md.split('\n')) {
      const m = line.match(/^\| `([a-z_.]+)` \| `([A-Z]\w+)` \|/)
      if (m && defs[m[2]]) {
        const id = `msg-${m[1].replace(/\./g, '-')}`
        out.push(line.replace(`| \`${m[2]}\` |`, `| [\`${m[2]}\`](#${id}) |`))
        pending.push(renderDefinition({ schema: defs[m[2]], name: m[2], label: m[1], lang, id, file }))
        continue
      }
      if (pending.length && !line.startsWith('|')) flush()
      out.push(line)
    }
    flush()
    return out.join('\n')
  }

  const outDir = join(siteDir, L.outDir)
  for (const id of order) {
    const title = L.titles[id]
    let body
    if (id === 'protocol') body = L.protocolPage('https://docs.schoolforbots.org')
    else if (id === 'changelog') body = changelog()
    else {
      const page = pages.get(id)
      if (!page) fail(`${L.source}: nothing went to the page ${id}.`)
      body = page.blocks.map(blockText).join('\n\n')
      body = rewriteLinks(body, id)
      if (id.startsWith('http/')) body = tagRoutes(linkCodes(body))
      else if (pageSchema[id]) body = withMessageSchemas(linkCodes(body), pageSchema[id])
      else if (id !== 'errors' && id !== 'ws/club-example') body = linkCodes(body)
    }
    const description = L.descriptions[id]
    const front = ['---', `title: ${JSON.stringify(title)}`]
    if (description) front.push(`description: ${JSON.stringify(description)}`)
    front.push(`editUrl: ${JSON.stringify(id === 'changelog' ? `${repo}/blob/main/CHANGELOG.md` : `${repo}/edit/main/${L.source}`)}`)
    front.push('---', '')
    const file = join(outDir, `${id}.md`)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${front.join('\n')}\n${body.trim()}\n`)
  }
}

// The changelog, without its own title; release-please writes the versions as ## headings.
function changelog() {
  const text = readFileSync(join(repoDir, 'CHANGELOG.md'), 'utf8').replace(/\r\n/g, '\n')
  return text.replace(/^# .*\n+/, '')
}

// Clear what an earlier run wrote, so a page renamed here leaves nothing behind. The homepages stay.
for (const L of Object.values(languages)) {
  for (const id of Object.keys(L.titles)) rmSync(join(siteDir, L.outDir, `${id}.md`), { force: true })
}
for (const lang of Object.keys(languages)) build(lang)

const protocolDir = join(siteDir, 'public/protocol/v1')
mkdirSync(protocolDir, { recursive: true })
for (const s of schemas) copyFileSync(join(repoDir, 'protocol', `${s}.schema.json`), join(protocolDir, `${s}.schema.json`))

console.log('split-api: pages written for zh and en.')

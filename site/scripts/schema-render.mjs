// Renders a definition from the protocol schemas (protocol/*.schema.json) as a
// field table and an example, for the pages split from api.md. The schemas are
// written by the server's typebox definitions, so this is always what the
// server checks. They carry no descriptions yet; what a field means is in the
// prose of api.md.
//
// Covered: objects, arrays, anyOf (enums, nullable, unions of objects), allOf,
// const, the usual limits. Conditional rules (if/then, dependentSchemas, not)
// are not drawn; a note points to the schema for them.

const text = {
  zh: {
    field: '字段',
    type: '类型',
    required: '必填',
    yes: '必填',
    no: '可选',
    oneOf: '以下之一',
    variant: '形式',
    chars: (a, b) => (a != null && b != null ? `${a}–${b} 个字符` : a != null ? `至少 ${a} 个字符` : `最多 ${b} 个字符`),
    items: (a, b) => (a != null && b != null ? (a === b ? `${a} 项` : `${a}–${b} 项`) : a != null ? `至少 ${a} 项` : `最多 ${b} 项`),
    unique: '不重复',
    format: (f) => `格式 ${f}`,
    pattern: '格式见 schema',
    map: '键值对',
    conditional: '还有一些条件约束（某些字段在什么情况下必填或不能出现），见 schema 文件。',
    example: '示例（按 schema 生成，值是占位的）',
    noFields: '没有字段。',
  },
  en: {
    field: 'Field',
    type: 'Type',
    required: 'Required',
    yes: 'required',
    no: 'optional',
    oneOf: 'one of',
    variant: 'form',
    chars: (a, b) => (a != null && b != null ? `${a}–${b} characters` : a != null ? `at least ${a} characters` : `at most ${b} characters`),
    items: (a, b) => (a != null && b != null ? (a === b ? `${a} items` : `${a}–${b} items`) : a != null ? `at least ${a} items` : `at most ${b} items`),
    unique: 'unique',
    format: (f) => `format ${f}`,
    pattern: 'format in the schema',
    map: 'map',
    conditional: 'Some conditional rules (when a field is required or must be absent) are not shown here; see the schema file.',
    example: 'Example (generated from the schema; the values are placeholders)',
    noFields: 'No fields.',
  },
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const json = (v) => JSON.stringify(v)

const isNull = (s) => s && s.type === 'null'
const isConst = (s) => s && 'const' in s
const isObject = (s) => s && (s.type === 'object' || s.properties || s.allOf || (s.anyOf && s.anyOf.every(isObject)))

/** allOf folded into one object. */
function merged(s) {
  if (!s.allOf) return s
  const out = { ...s, properties: { ...(s.properties ?? {}) }, required: [...(s.required ?? [])] }
  delete out.allOf
  for (const part of s.allOf) {
    const m = merged(part)
    Object.assign(out.properties, m.properties ?? {})
    out.required.push(...(m.required ?? []))
    if (m.anyOf && !out.anyOf) out.anyOf = m.anyOf
  }
  return out
}

/** Whether a schema (or anything in it) has rules this renderer does not draw. */
function hasConditions(s) {
  if (!s || typeof s !== 'object') return false
  if (s.if || s.dependentSchemas || s.dependentRequired || s.not) return true
  return Object.values(s).some((v) => (Array.isArray(v) ? v.some(hasConditions) : typeof v === 'object' && hasConditions(v)))
}

/** The const values that tell the variants of a union apart, e.g. type = "hello". */
function variantLabel(s, t, n) {
  const m = merged(s)
  for (const key of ['type', 'kind', 'action', 'phase', 'ok', 'reason', 'name', 'code']) {
    const p = m.properties?.[key]
    if (p && isConst(p)) return `${key} = ${json(p.const)}`
  }
  return `${t.variant} ${n + 1}`
}

// Patterns that say a familiar thing, said the familiar way.
function knownPattern(p) {
  if (p === '^\\d{4}-\\d{2}-\\d{2}$') return '<code>YYYY-MM-DD</code>'
  if (p === '^([01][0-9]|2[0-3]):[0-5][0-9]$') return '<code>HH:MM</code>'
  if (p === '^\\d{6}$') return '<code>000000</code>–<code>999999</code>'
  return null
}

/** A short type, for the type column. */
function typeOf(s, t) {
  s = merged(s)
  if (isConst(s)) return `<code>${esc(json(s.const))}</code>`
  if (s.anyOf) {
    const opts = s.anyOf
    if (opts.every(isConst)) return opts.map((o) => `<code>${esc(json(o.const))}</code>`).join(' | ')
    if (opts.every(isObject) && opts.length > 1) return t.oneOf
    return opts.map((o) => typeOf(o, t)).join(' | ')
  }
  const notes = []
  let base = s.type ?? (s.properties ? 'object' : 'any')
  if (Array.isArray(base)) base = base.join(' | ')
  if (base === 'string') {
    if (s.format) notes.push(t.format(s.format))
    else if (s.pattern) notes.push(knownPattern(s.pattern) ?? (s.pattern.length <= 32 ? `<code>${esc(s.pattern)}</code>` : t.pattern))
    if (s.minLength != null || s.maxLength != null) notes.push(t.chars(s.minLength, s.maxLength))
  }
  if (base === 'integer' || base === 'number') {
    // The 32-bit ceiling the server puts on ids is no limit worth reading.
    if (s.maximum != null && s.maximum >= 2147483647) s = { ...s, maximum: undefined }
    if (s.minimum != null && s.maximum != null) notes.push(`${s.minimum}–${s.maximum}`)
    else if (s.minimum != null) notes.push(`≥ ${s.minimum}`)
    else if (s.maximum != null) notes.push(`≤ ${s.maximum}`)
  }
  if (base === 'array') {
    const it = s.items ? merged(s.items) : null
    base = it && !isObject(it) ? `array&lt;${typeOf(it, t)}&gt;` : 'array'
    if (s.minItems != null || s.maxItems != null) notes.push(t.items(s.minItems, s.maxItems))
    if (s.uniqueItems) notes.push(t.unique)
  }
  if (base === 'object' && !s.properties && s.additionalProperties && typeof s.additionalProperties === 'object') {
    base = `${t.map} &lt;string, ${typeOf(s.additionalProperties, t)}&gt;`
  }
  return `<span class="schema-type">${base}</span>${notes.length ? ` <span class="schema-note">${notes.join(t === text.en ? ', ' : '，')}</span>` : ''}`
}

/** Table rows for an object's fields, nested ones indented under their parent. */
function rows(s, t, depth, out) {
  s = merged(s)
  if (s.anyOf && s.anyOf.every(isObject)) {
    s.anyOf.forEach((v, n) => {
      out.push(`<tr class="schema-variant" style="--d:${depth}"><td colspan="3"><span>${esc(variantLabel(v, t, n))}</span></td></tr>`)
      rows(v, t, depth + 1, out)
    })
    return
  }
  const required = new Set(s.required ?? [])
  for (const [name, raw] of Object.entries(s.properties ?? {})) {
    const p = merged(raw)
    const req = required.has(name)
    out.push(
      `<tr style="--d:${depth}"><td class="schema-name"><code>${esc(name)}</code></td><td>${typeOf(p, t)}</td><td class="${req ? 'schema-req' : 'schema-opt'}">${req ? t.yes : t.no}</td></tr>`,
    )
    // What is inside: an object's fields, an array's item fields, the object in a nullable.
    let inner = p
    if (inner.type === 'array' && inner.items) inner = merged(inner.items)
    if (inner.anyOf && !inner.anyOf.every(isObject)) {
      const objs = inner.anyOf.filter((o) => !isNull(o))
      if (objs.length === 1) inner = merged(objs[0])
      if (inner.type === 'array' && inner.items) inner = merged(inner.items)
    }
    if (isObject(inner) && (inner.properties || inner.anyOf)) rows(inner, t, depth + 1, out)
  }
}

// ---------------------------------------------------------------------------
// Examples: a value of the right shape, with placeholders.

function sample(s, name = '') {
  s = merged(s)
  if (isConst(s)) return s.const
  if (s.anyOf) {
    const notNull = s.anyOf.filter((o) => !isNull(o))
    return sample(notNull[0] ?? s.anyOf[0], name)
  }
  const type = Array.isArray(s.type) ? s.type.find((x) => x !== 'null') : s.type ?? (s.properties ? 'object' : null)
  switch (type) {
    case 'object': {
      const o = {}
      for (const [k, v] of Object.entries(s.properties ?? {})) o[k] = sample(v, k)
      return o
    }
    case 'array': {
      const n = Math.max(1, s.minItems ?? 1)
      return Array.from({ length: Math.min(n, 3) }, () => sample(s.items ?? {}, name))
    }
    case 'string':
      if (s.format === 'date-time') return '2026-11-30T08:00:00+08:00'
      if (s.format === 'uuid') return '0b7e4c1a-5d2f-4a8e-9c31-7f0e2d6b9a14'
      if (s.format === 'email' || /email/i.test(name)) return 'owner@example.com'
      if (s.format === 'uri') return 'https://example.com/'
      if (s.pattern === '^\\d{4}-\\d{2}-\\d{2}$') return '2026-11-30'
      if (s.pattern === '^([01][0-9]|2[0-3]):[0-5][0-9]$') return '08:00'
      if (s.pattern === '^\\d{6}$') return '123456'
      if (s.pattern === '^r[0-9a-z]{4,15}$') return 'r7k2m9'
      return name ? `<${name}>` : '<string>'
    case 'integer':
      return s.minimum ?? 1
    case 'number':
      return s.minimum ?? 0
    case 'boolean':
      return false
    case 'null':
      return null
    default:
      return null
  }
}

/**
 * One definition, as a collapsible block: Markdown with raw HTML around a fenced
 * JSON example (so the example gets the site's code block and copy button).
 */
export function renderDefinition({ schema, name, label, lang, id, file }) {
  const t = text[lang]
  const out = []
  rows(schema, t, 0, out)
  const table = out.length
    ? `<table class="schema-table"><thead><tr><th>${t.field}</th><th>${t.type}</th><th>${t.required}</th></tr></thead><tbody>${out.join('')}</tbody></table>`
    : `<p class="schema-empty">${t.noFields}</p>`
  const note = hasConditions(schema) ? `<p class="schema-cond">${t.conditional}</p>` : ''
  const example = JSON.stringify(sample(schema), null, 2)
  return [
    `<details class="schema" id="${esc(id)}">`,
    `<summary><span class="schema-label">${esc(label)}</span> <code>${esc(name)}</code><a class="schema-src" href="/protocol/v1/${file}.schema.json" aria-label="${esc(file)}.schema.json">${esc(file)}.schema.json</a></summary>`,
    `<div class="schema-body">${table}${note}<p class="schema-ex">${t.example}</p>`,
    '',
    '```json',
    example,
    '```',
    '',
    '</div>',
    '</details>',
  ].join('\n')
}

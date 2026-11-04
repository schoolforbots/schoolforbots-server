import { expect, test } from 'vitest'
import { extractJson, JsonNotFound } from '../../src/llm/json.js'

test('extracts a bare object', () => {
  expect(extractJson('{"a":1}')).toEqual({ a: 1 })
})

test('extracts an object surrounded by explanation text', () => {
  expect(extractJson('好的，结果如下：\n{"a":1,"b":[2]}\n希望有帮助')).toEqual({ a: 1, b: [2] })
})

test('prefers a ```json block', () => {
  expect(extractJson('先说明 {"x":0}\n```json\n{"a":1}\n```\n完')).toEqual({ a: 1 })
})

test('handles nested braces and braces inside strings', () => {
  expect(extractJson('前言 {"a":{"b":"}"},"c":"{"} 后记')).toEqual({ a: { b: '}' }, c: '{' })
  expect(extractJson('{"a":"带\\"引号}"}')).toEqual({ a: '带"引号}' })
})

test('falls through to the brace scan when the fenced block is not JSON', () => {
  expect(extractJson('```json\n不是 json\n```\n{"a":1}')).toEqual({ a: 1 })
})

test('skips an unbalanced or invalid first brace and finds a later object', () => {
  expect(extractJson('{ 坏的 然后 {"a":1}')).toEqual({ a: 1 })
})

test('throws JsonNotFound when there is no object', () => {
  expect(() => extractJson('没有对象')).toThrow(JsonNotFound)
  expect(() => extractJson('{"a":')).toThrow(JsonNotFound)
  expect(() => extractJson('')).toThrow(JsonNotFound)
})

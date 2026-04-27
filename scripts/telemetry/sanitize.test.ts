import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { sanitizeString } from './sanitize'

test('strips double quotes', () => {
  assert.equal(sanitizeString('he"llo'), 'hello')
})

test('strips backslashes', () => {
  assert.equal(sanitizeString('he\\llo'), 'hello')
})

test('strips control characters', () => {
  assert.equal(sanitizeString('he\x00\x01\x1fllo'), 'hello')
})

test('strips newlines and tabs', () => {
  assert.equal(sanitizeString('he\n\tllo'), 'hello')
})

test('caps length at 200 by default', () => {
  const input = 'x'.repeat(300)
  assert.equal(sanitizeString(input).length, 200)
})

test('respects custom length cap', () => {
  assert.equal(sanitizeString('x'.repeat(100), 50).length, 50)
})

test('returns empty string for non-string input', () => {
  // @ts-expect-error intentional
  assert.equal(sanitizeString(null), '')
  // @ts-expect-error intentional
  assert.equal(sanitizeString(undefined), '')
  // @ts-expect-error intentional
  assert.equal(sanitizeString(123), '')
})

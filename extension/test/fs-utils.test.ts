/**
 * Unit tests for readNewFileLines.
 *
 * The critical invariant: if a writer flushes a line in two chunks, the reader
 * reassembles it via the `tail` field instead of dropping the split line. A
 * watcher that doesn't forward `tail` back on the next call silently loses
 * the line — which is the bug we'd silently regress if this test goes away.
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { readNewFileLines } from '../src/fs-utils'

describe('readNewFileLines', () => {
  let dir: string
  let file: string

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-flow-fs-utils-'))
    file = path.join(dir, 'sample.jsonl')
  })

  after(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  it('returns null when file has not grown', () => {
    fs.writeFileSync(file, 'line1\n')
    const size = fs.statSync(file).size
    assert.equal(readNewFileLines(file, size), null)
  })

  it('splits complete lines and leaves tail empty', () => {
    fs.writeFileSync(file, 'a\nb\nc\n')
    const r = readNewFileLines(file, 0)
    assert.ok(r)
    assert.deepEqual(r!.lines, ['a', 'b', 'c'])
    assert.equal(r!.tail, '')
    assert.equal(r!.newSize, fs.statSync(file).size)
  })

  it('returns the trailing partial line as tail', () => {
    fs.writeFileSync(file, 'first\nsecond-incompl')
    const r = readNewFileLines(file, 0)
    assert.ok(r)
    assert.deepEqual(r!.lines, ['first'])
    assert.equal(r!.tail, 'second-incompl')
  })

  it('reassembles a line split across two reads via tail', () => {
    // Simulate a JSONL writer that flushes mid-line.
    fs.writeFileSync(file, '{"type":"session_meta","pay')
    const first = readNewFileLines(file, 0)
    assert.ok(first)
    assert.deepEqual(first!.lines, [])
    assert.equal(first!.tail, '{"type":"session_meta","pay')

    // Writer appends the rest of the line plus a new one.
    fs.appendFileSync(file, 'load":{}}\n{"type":"other"}\n')
    const second = readNewFileLines(file, first!.newSize, first!.tail)
    assert.ok(second)
    assert.deepEqual(second!.lines, [
      '{"type":"session_meta","payload":{}}',
      '{"type":"other"}',
    ])
    assert.equal(second!.tail, '')
  })

  it('drops the split line when caller ignores tail (regression guard)', () => {
    // If a caller passes no lastTail and silently discards tail, a split line
    // is lost. This test locks in the "contract" so the mistake is visible.
    fs.writeFileSync(file, 'aaa\nbbb-cut')
    const first = readNewFileLines(file, 0)
    assert.ok(first)
    assert.equal(first!.tail, 'bbb-cut')

    fs.appendFileSync(file, 'here\nccc\n')
    // Caller forgets to forward tail — "bbb-cuthere" never appears.
    const second = readNewFileLines(file, first!.newSize /* no tail */)
    assert.ok(second)
    assert.ok(!second!.lines.includes('bbb-cuthere'))
  })

  it('resets to 0 when the file is truncated', () => {
    fs.writeFileSync(file, 'only\n')
    const r = readNewFileLines(file, 9999, 'stale-tail')
    assert.ok(r)
    assert.deepEqual(r!.lines, [])
    assert.equal(r!.newSize, 0)
    assert.equal(r!.tail, '')
  })

  it('tolerates CRLF line endings', () => {
    fs.writeFileSync(file, 'x\r\ny\r\n')
    const r = readNewFileLines(file, 0)
    assert.ok(r)
    assert.deepEqual(r!.lines, ['x', 'y'])
  })

  it('returns null when the file does not exist', () => {
    assert.equal(readNewFileLines(path.join(dir, 'missing.jsonl'), 0), null)
  })
})

import { describe, expect, test } from 'claude-code/testing'

import type { PaneState } from '../types'
import { drawField, drawnTyped, settleDrawn } from '../src/fields'
import { freshPane } from '../src/model'

const browsing = (query: string, drawn = ''): PaneState => ({ ...freshPane(), query, drawn: { ...freshPane().drawn, q: drawn } })

describe('fields', () => {
  test('typing in a field in view never changes what it draws', () => {
    const before = browsing('ren')
    expect(settleDrawn(before, { ...before, query: 'rename' }).drawn.q).toBe('')
  })

  test('a field coming into view draws the text typed in it', () => {
    const browse = { ...freshPane(), capture: { ...freshPane().capture, draft: 'half a thought' } }
    expect(settleDrawn(browse, { ...browse, mode: 'capture' }).drawn.capture).toBe('half a thought')
    const editing = { ...browse, mode: 'edit' as const, edit: { id: 'a', draft: 'one' } }
    // Another note's card is another field.
    expect(settleDrawn(editing, { ...editing, edit: { id: 'b', draft: 'two' } }).drawn.edit).toBe('two')
  })

  test('a field coming into view keeps a value the same change set on purpose', () => {
    const browse = freshPane()
    const after = drawField({ ...browse, mode: 'capture' }, 'capture', 'on purpose')
    expect(settleDrawn(browse, after).drawn.capture).toBe('on purpose')
  })

  test('an emptied field drawn empty last draws no value, then empty again', () => {
    const once = drawField(browsing('cache'), 'q', '')
    expect(once.drawn.q).toBeNull()
    expect(drawField(once, 'q', '').drawn.q).toBe('')
    // Drawn with text last, empty is already another value.
    expect(drawField(browsing('cache', 'cache'), 'q', '').drawn.q).toBe('')
  })

  test('text drawn back after Enter differs from the last value drawn', () => {
    expect(drawField(browsing('rename'), 'q', 'rename').drawn.q).toBe('rename')
    expect(drawField(browsing('rename', 'rename'), 'q', 'rename').drawn.q).toBe('rename ')
    expect(drawField(browsing('rename ', 'rename '), 'q', 'rename ').drawn.q).toBe('rename')
  })

  test('a pane opened again draws every field with its typed text', () => {
    const state = { ...browsing('rename'), moveFind: 'inf', edit: { id: 'a', draft: 'one' } }
    expect(drawnTyped(state).drawn).toEqual({ q: 'rename', capture: '', target: '', edit: 'one', move: 'inf' })
  })
})

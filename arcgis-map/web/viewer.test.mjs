// Viewer input mapping: node --test web/
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { pixelSize, toKeys, toMouse } from './viewer.mjs'

const size = pixelSize(40, 20) // 400 x 400 px

test('pixel size follows the pane region', () => {
  assert.deepEqual(size, { width: 400, height: 400 })
})

test('a press, drag and release map to CDP mouse events in page pixels', () => {
  const last = {}
  assert.deepEqual(toMouse({ type: 'down', x: 0.5, y: 0.25, button: 'left', at: 1000 }, size, last), {
    type: 'mousePressed', x: 200, y: 100, button: 'left', buttons: 1, clickCount: 1, modifiers: 0,
  })
  assert.deepEqual(toMouse({ type: 'move', x: 0.75, y: 0.25, button: 'left' }, size, last), {
    type: 'mouseMoved', x: 300, y: 100, button: 'left', buttons: 1, modifiers: 0,
  })
  assert.deepEqual(toMouse({ type: 'up', x: 0.75, y: 0.25, button: 'left' }, size, last), {
    type: 'mouseReleased', x: 300, y: 100, button: 'left', buttons: 0, clickCount: 1, modifiers: 0,
  })
})

test('two quick presses in one place are a double-click (zoom in); a third starts over', () => {
  const last = {}
  const press = at => toMouse({ type: 'down', x: 0.5, y: 0.5, button: 'left', at }, size, last).clickCount
  assert.equal(press(0), 1)
  assert.equal(press(200), 2)
  assert.equal(press(300), 1)
  assert.equal(press(1000), 1, 'too slow')
})

test('positions past the region edge are held to it while dragging', () => {
  const event = toMouse({ type: 'move', x: -0.2, y: 1.4, button: 'left' }, size, {})
  assert.equal(event.x, 0)
  assert.equal(event.y, 400)
})

test('keys: arrows and Enter by name, characters as text, other names ignored', () => {
  assert.deepEqual(toKeys({ key: 'up' })[0], { type: 'rawKeyDown', key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38, modifiers: 0 })
  assert.deepEqual(toKeys({ key: '+' }), [
    { type: 'keyDown', key: '+', text: '+', modifiers: 0 },
    { type: 'keyUp', key: '+', modifiers: 0 },
  ])
  assert.deepEqual(toKeys({ key: 'f13' }), [])
})

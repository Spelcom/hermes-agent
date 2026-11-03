import { expect, it, vi } from 'vitest'

import { registerFloatingComposer } from './floating-target'
import { focusComposerInput, getActiveComposer, markActiveComposer, releaseActiveComposer } from './focus'

it('lets an unregistered embedded editor own native focus and typing while a layout composer is registered', async () => {
  const main = document.createElement('div')
  main.dataset.composerOwner = 'main-surface'
  const mainEditor = document.createElement('div')
  mainEditor.dataset.slot = 'composer-rich-input'
  mainEditor.tabIndex = 0
  main.append(mainEditor)
  const bubble = document.createElement('div')
  bubble.dataset.composerTarget = 'agent-conversation:kai'
  const host = document.createElement('div')
  host.dataset.composerOwner = 'embedded-surface'
  host.dataset.embeddedComposer = ''
  const editor = document.createElement('div')
  editor.dataset.slot = 'composer-rich-input'
  editor.contentEditable = 'true'
  editor.tabIndex = 0
  host.append(editor)
  bubble.append(host)
  document.body.append(main, bubble)
  const unregister = registerFloatingComposer('main-surface', { groupId: 'main-zone', target: 'main' })
  const focusin = vi.fn(() => markActiveComposer('agent-conversation:kai'))
  editor.addEventListener('focusin', focusin)

  try {
    mainEditor.focus()
    focusComposerInput(editor)
    expect(document.activeElement).toBe(editor)
    expect(focusin).toHaveBeenCalledOnce()
    expect(getActiveComposer()).toBe('agent-conversation:kai')
    focusComposerInput(mainEditor)
    expect(document.activeElement).toBe(editor)
    // Hovering the layout composer must not steal the caret or its bus route.
    main.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, buttons: 0, clientX: 345, clientY: 123 }))
    expect(document.activeElement).toBe(editor)
    expect(getActiveComposer()).toBe('agent-conversation:kai')
    bubble.remove()
    releaseActiveComposer('agent-conversation:kai')
    expect(getActiveComposer()).toBe('main')
  } finally {
    unregister()
    main.remove()
    bubble.remove()
    await Promise.resolve()
    markActiveComposer('main')
  }
})

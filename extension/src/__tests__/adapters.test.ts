// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import {
  adapterFor,
  isSubmitEvent,
  promptFrom,
  promptNear,
  sendControlFrom,
} from '../adapters'

/**
 * Adapters are the only part of this system that touches a third-party DOM, so
 * they are the part most likely to break when a site ships a redesign. These
 * tests pin the two things that must hold: they find the composer through
 * ordinary DOM structure, and they fail by returning null rather than by
 * throwing into somebody's page.
 */

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('finding the prompt', () => {
  it('reads and writes a textarea', () => {
    document.body.innerHTML = '<textarea id="t"></textarea>'
    const target = promptFrom(document.getElementById('t'))

    expect(target).not.toBeNull()
    target!.write('hello there')
    expect(target!.read()).toBe('hello there')
    expect((document.getElementById('t') as HTMLTextAreaElement).value).toBe(
      'hello there',
    )
  })

  it('reads and writes a contenteditable, which is what these sites use now', () => {
    document.body.innerHTML = '<div id="c" contenteditable="true">draft</div>'
    const target = promptFrom(document.getElementById('c'))

    expect(target!.read()).toBe('draft')
    target!.write('replaced')
    expect(document.getElementById('c')!.textContent).toBe('replaced')
  })

  it('walks up from a nested node, since events fire on inner spans', () => {
    document.body.innerHTML =
      '<div contenteditable="true"><p><span id="deep">text</span></p></div>'
    expect(promptFrom(document.getElementById('deep'))).not.toBeNull()
  })

  it('fires an input event so a controlled component notices', () => {
    document.body.innerHTML = '<textarea id="t"></textarea>'
    const element = document.getElementById('t') as HTMLTextAreaElement
    let fired = false
    element.addEventListener('input', () => (fired = true))

    promptFrom(element)!.write('x')
    expect(fired).toBe(true)
  })

  it('returns null rather than throwing when there is no composer', () => {
    document.body.innerHTML = '<div id="plain">not editable</div>'
    expect(promptFrom(document.getElementById('plain'))).toBeNull()
    expect(promptFrom(null)).toBeNull()
  })
})

describe('recognising a send', () => {
  const generic = adapterFor('unknown-ai.example')

  it('treats a bare Enter as a send', () => {
    const event = new KeyboardEvent('keydown', { key: 'Enter' })
    expect(isSubmitEvent(event, generic)).toBe(true)
  })

  it.each([
    ['Shift', { shiftKey: true }],
    ['Ctrl', { ctrlKey: true }],
    ['Meta', { metaKey: true }],
  ])('does not treat %s+Enter as a send — that is a newline', (_n, mods) => {
    const event = new KeyboardEvent('keydown', { key: 'Enter', ...mods })
    expect(isSubmitEvent(event, generic)).toBe(false)
  })

  it('ignores Enter while composing, so IME input is untouched', () => {
    // Committing a Japanese or Chinese candidate sends Enter; intercepting it
    // would make the extension unusable in those languages.
    const event = new KeyboardEvent('keydown', { key: 'Enter', isComposing: true })
    expect(isSubmitEvent(event, generic)).toBe(false)
  })

  it('recognises a send button by its accessible name, not a class', () => {
    document.body.innerHTML = '<button aria-label="Send message">↑</button>'
    const event = new MouseEvent('click')
    Object.defineProperty(event, 'target', {
      value: document.querySelector('button'),
    })
    expect(isSubmitEvent(event, generic)).toBe(true)
  })

  it('does not treat an unrelated button as a send', () => {
    document.body.innerHTML = '<button aria-label="Attach file">+</button>'
    const event = new MouseEvent('click')
    Object.defineProperty(event, 'target', {
      value: document.querySelector('button'),
    })
    expect(isSubmitEvent(event, generic)).toBe(false)
  })
})

describe('site adapters stay tiny', () => {
  it.each([
    ['chatgpt.com', 'chatgpt'],
    ['chat.openai.com', 'chatgpt'],
    ['claude.ai', 'claude'],
    ['gemini.google.com', 'gemini'],
    ['copilot.microsoft.com', 'copilot'],
  ])('maps %s to the %s adapter', (host, id) => {
    expect(adapterFor(host).id).toBe(id)
  })

  it('falls back to the generic adapter on an unknown AI site', () => {
    expect(adapterFor('some-new-assistant.example').id).toBe('generic')
  })

  it('does not match a lookalike domain', () => {
    // "notchatgpt.com" must not inherit ChatGPT's selectors.
    expect(adapterFor('notchatgpt.com').id).toBe('generic')
  })

  it('carries only selectors, never detection logic', () => {
    for (const host of ['chatgpt.com', 'claude.ai', 'gemini.google.com']) {
      const adapter = adapterFor(host)
      expect(Object.keys(adapter).sort()).toEqual([
        'id',
        'label',
        'sendSelectors',
      ])
      expect(adapter.sendSelectors.length).toBeLessThanOrEqual(3)
    }
  })
})

describe('re-issuing a held send', () => {
  const generic = adapterFor('unknown-ai.example')

  /**
   * A held send has to be replayed the way it was made. A click must come back
   * as a click on the same button — a synthetic Enter cannot submit a form,
   * because implicit submission is browser behaviour, so replaying a button
   * press as Enter would silently swallow the message.
   */
  it('hands back the exact button that was clicked', () => {
    document.body.innerHTML = `
      <form><textarea>hi</textarea>
        <button type="submit"><svg id="icon"></svg></button>
      </form>`
    const event = new MouseEvent('click')
    // The click lands on the icon inside the button, as it does on real sites.
    Object.defineProperty(event, 'target', {
      value: document.getElementById('icon'),
    })

    expect(sendControlFrom(event, generic)).toBe(
      document.querySelector('button'),
    )
  })

  it('has no control to replay for a keyboard send', () => {
    document.body.innerHTML = '<textarea id="t">hi</textarea>'
    const event = new KeyboardEvent('keydown', { key: 'Enter' })
    Object.defineProperty(event, 'target', {
      value: document.getElementById('t'),
    })

    // Falls through to the synthetic-Enter path, which is right for a keypress.
    expect(sendControlFrom(event, generic)).toBeNull()
  })

  it('returns null for a click that was not a send', () => {
    document.body.innerHTML = '<button aria-label="Attach file">+</button>'
    const event = new MouseEvent('click')
    Object.defineProperty(event, 'target', {
      value: document.querySelector('button'),
    })
    expect(sendControlFrom(event, generic)).toBeNull()
  })

  it('prefers the site adapter selector over the generic one', () => {
    document.body.innerHTML = `
      <div id="composer-submit-button"><span id="inner">↑</span></div>`
    const event = new MouseEvent('click')
    Object.defineProperty(event, 'target', {
      value: document.getElementById('inner'),
    })

    // ChatGPT's send control is not a <button type=submit>; without the
    // adapter selector this click would not register as a send at all.
    expect(sendControlFrom(event, adapterFor('chatgpt.com'))?.id).toBe(
      'composer-submit-button',
    )
    expect(sendControlFrom(event, generic)).toBeNull()
  })
})

describe('finding the composer from a send button', () => {
  it('uses the surrounding form', () => {
    document.body.innerHTML = `
      <form><textarea>hi</textarea><button type="submit">Send</button></form>`
    const target = promptNear(document.querySelector('button')!)
    expect(target?.read()).toBe('hi')
  })

  it('falls back to the largest visible editable', () => {
    document.body.innerHTML = `
      <div contenteditable="true" id="big">the prompt</div>
      <button>Send</button>`
    const big = document.getElementById('big') as HTMLElement
    // happy-dom reports zero sizes; make the fallback path reachable.
    Object.defineProperty(big, 'offsetParent', { value: document.body })
    Object.defineProperty(big, 'clientWidth', { value: 800 })
    Object.defineProperty(big, 'clientHeight', { value: 120 })

    expect(promptNear(document.querySelector('button')!)?.read()).toBe(
      'the prompt',
    )
  })
})

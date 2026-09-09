// @vitest-environment happy-dom
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CheckResponse, Request, SanitizeResponse } from '../protocol'

/**
 * The hold-and-reissue lifecycle.
 *
 * This is the most fragile code in the extension and the only place it is
 * allowed to interrupt somebody: the send is cancelled, a question is asked
 * across a process boundary, and the send may then have to be re-issued. Three
 * things can go wrong, and all three are silent — the message gets eaten, it
 * gets sent twice, or the user is warned again about text this tool wrote
 * itself.
 *
 * Deliberately driven through the real `document`-level capture listeners
 * rather than by calling the handler, because re-issuing a send re-enters
 * those listeners, and whether that terminates is the property under test.
 */

// --- the banner, stubbed so these tests are about the lifecycle ------------
interface BannerState {
  open: boolean
  onAction?: (action: 'redact' | 'pseudonymize' | 'dismiss' | 'send-anyway' | 'handoff') => void
  shown: number
  cleanedWith: number[]
  throwOnShow: boolean
}
const banner: BannerState = {
  open: false,
  shown: 0,
  cleanedWith: [],
  throwOnShow: false,
}

vi.mock('../ui', () => ({
  showBanner: (options: { onAction: BannerState['onAction'] }) => {
    banner.shown += 1
    if (banner.throwOnShow) throw new Error('shadow root refused')
    banner.open = true
    banner.onAction = options.onAction
  },
  dismissBanner: () => {
    banner.open = false
  },
  bannerIsOpen: () => banner.open,
  bannerIsDeep: () => false,
  showDeeperRunning: () => {},
  applyDeeper: () => {},
  showCleaned: (count: number) => banner.cleanedWith.push(count),
}))

// --- the worker, stubbed with a per-test responder ------------------------
let respond: (message: Request) => unknown = () => null
const asked: Request[] = []

const chromeStub = {
  runtime: {
    lastError: undefined,
    sendMessage: (message: Request, callback?: (response: unknown) => void) => {
      asked.push(message)
      callback?.(respond(message))
      return undefined
    },
  },
}

let content: typeof import('../content')

beforeAll(async () => {
  vi.stubGlobal('chrome', chromeStub)
  content = await import('../content')
  // Once: the listeners live on `document`, which survives body replacement.
  content.install()
})

const WARN: CheckResponse = {
  type: 'checked',
  decision: 'warn',
  headline: 'Check this before sending',
  summary: '1 email address',
  findings: [],
  ms: 0.2,
}

const ALLOW: CheckResponse = {
  type: 'checked',
  decision: 'allow',
  headline: 'Nothing sensitive found',
  summary: '',
  findings: [],
  ms: 0.1,
}

const DIRTY = 'Please email sarah.mitchell@example.com about the renewal today'
const CLEANED = 'Please email [EMAIL] about the renewal today'

function sanitized(text: string): SanitizeResponse {
  return {
    type: 'sanitized',
    text,
    replaced: [
      {
        category: 'EMAIL',
        label: 'Email address',
        value: 'sarah.mitchell@example.com',
        replacement: '[EMAIL]',
        tier: 'high',
        group: 'personal',
        why: 'An email address identifies a person.',
      },
    ],
    ms: 0.3,
  }
}

const checks = () => asked.filter((m) => m.type === 'check').length

beforeEach(() => {
  document.body.innerHTML = ''
  asked.length = 0
  banner.open = false
  banner.shown = 0
  banner.cleanedWith.length = 0
  banner.throwOnShow = false
  banner.onAction = undefined
  content.resetForTests()
})

/** A bare Enter on the composer — the universal send in these products. */
function pressEnter(element: HTMLElement) {
  element.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
  )
}

/** Lets the held async interception settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('clean, then send', () => {
  /**
   * The bug this exists for: cleaning writes with `target.write()` and the
   * next send reads with `target.read()`, and for a `contenteditable` those
   * are different functions over an editor that rewrites what it was given.
   * Substituting non-breaking spaces is the most common form of it.
   */
  function lexicalish(): HTMLElement {
    const editor = document.createElement('div')
    editor.setAttribute('contenteditable', 'true')
    document.body.appendChild(editor)
    editor.addEventListener('input', () => {
      // What a rich-text editor does to text handed to it.
      editor.textContent = (editor.textContent ?? '').replace(/ /g, ' ')
    })
    return editor
  }

  it('does not warn twice about text it wrote itself', async () => {
    const editor = lexicalish()
    editor.textContent = DIRTY

    respond = (m) => (m.type === 'check' ? WARN : m.type === 'sanitize' ? sanitized(CLEANED) : null)

    pressEnter(editor)
    await settle()
    expect(checks()).toBe(1)
    expect(banner.open).toBe(true)

    // The user cleans it.
    banner.onAction?.('redact')
    await settle()
    expect(banner.cleanedWith).toEqual([1])

    // The editor kept its own version of our string.
    expect(editor.textContent).toContain(' ')
    expect(editor.textContent).not.toBe(CLEANED)

    // Now they send. This must go straight through: comparing raw strings
    // misses here, and the user gets warned about the tool's own output —
    // which reads as the cleaning not having worked.
    pressEnter(editor)
    await settle()
    expect(checks()).toBe(1)
  })

  it('still checks a fresh edit after a clearance', async () => {
    const editor = lexicalish()
    editor.textContent = DIRTY
    respond = (m) => (m.type === 'check' ? WARN : m.type === 'sanitize' ? sanitized(CLEANED) : null)

    pressEnter(editor)
    await settle()
    banner.onAction?.('redact')
    await settle()

    // A clearance covers the text it was granted for, not the composer for
    // ever — otherwise one clean send would silence the rest of the session.
    editor.textContent = 'Now email david.okafor@example.com about the invoice'
    pressEnter(editor)
    await settle()
    expect(checks()).toBe(2)
  })

  it('scopes a clearance to the composer it was granted in', async () => {
    const first = document.createElement('textarea')
    const second = document.createElement('textarea')
    document.body.append(first, second)
    first.value = DIRTY
    second.value = DIRTY

    respond = (m) => (m.type === 'check' ? ALLOW : null)

    pressEnter(first)
    await settle()
    expect(checks()).toBe(1)

    // Same text, different editable. A page can have several, and a clearance
    // in one says nothing about another.
    pressEnter(second)
    await settle()
    expect(checks()).toBe(2)
  })
})

describe('re-issuing the send', () => {
  function composer() {
    const form = document.createElement('form')
    const textarea = document.createElement('textarea')
    const button = document.createElement('button')
    button.type = 'submit'
    form.append(textarea, button)
    document.body.appendChild(form)
    /**
     * Counted on `window` at capture phase, which runs *before* the
     * document-level interception. It has to: a held send calls
     * `stopPropagation`, so the button's own listener never fires — which is
     * the entire point of holding it, and would make a listener on the button
     * count zero no matter what happened.
     */
    let clicks = 0
    const count = () => {
      clicks += 1
    }
    window.addEventListener('click', count, true)
    return {
      textarea,
      button,
      clicks: () => clicks,
      done: () => window.removeEventListener('click', count, true),
    }
  }

  it('re-presses the same button, exactly once', async () => {
    const { textarea, button, clicks, done } = composer()
    textarea.value = DIRTY
    respond = (m) => (m.type === 'check' ? ALLOW : null)

    button.click()
    await settle()

    // Two: the click the user made, and one re-press. The re-press re-enters
    // this same listener, so anything other than 2 means the clearance failed
    // to terminate the cycle.
    expect(clicks()).toBe(2)
    expect(checks()).toBe(1)
    done()
  })

  it('terminates when the user sends anyway', async () => {
    const { textarea, button, clicks, done } = composer()
    textarea.value = DIRTY
    respond = (m) => (m.type === 'check' ? WARN : null)

    button.click()
    await settle()
    expect(banner.open).toBe(true)

    banner.onAction?.('send-anyway')
    await settle()

    expect(clicks()).toBe(2)
    expect(checks()).toBe(1)
    done()
  })

  it('fails open rather than eating the prompt when the banner throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { textarea, button, clicks, done } = composer()
    textarea.value = DIRTY
    respond = (m) => (m.type === 'check' ? WARN : null)
    banner.throwOnShow = true

    button.click()
    await settle()

    // Everything after `preventDefault` runs with the send already cancelled.
    // A throw there would leave the message deleted — cancelled, unsent, and
    // nothing on screen to say so. Eating somebody's prompt is worse than
    // sending it unchecked with a loud warning.
    expect(banner.open).toBe(false)
    expect(clicks()).toBe(2)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
    done()
  })

  it('leaves the decision alone when a banner did make it up', async () => {
    const { textarea, button, clicks, done } = composer()
    textarea.value = DIRTY
    respond = (m) => (m.type === 'check' ? WARN : null)

    button.click()
    await settle()

    // Held, with the controls on screen. The user resolves it; the extension
    // must not send behind them.
    expect(banner.open).toBe(true)
    expect(clicks()).toBe(1)
    done()
  })
})

describe('the length threshold', () => {
  it('sits below the shortest thing the engine can find', async () => {
    const { scan } = await import('@/engine/detect')
    // It was 12, chosen as a round number, and 12 hid real findings. This
    // asserts the relationship rather than the number, so a future rule that
    // can match something shorter fails the build instead of quietly slipping
    // past the submit gate.
    for (const shortest of ['a@b.c', '1@2.3']) {
      expect(scan(shortest).findings.length).toBeGreaterThan(0)
      expect(shortest.length).toBeGreaterThanOrEqual(content.MIN_CHARS)
    }
  })

  it('checks a bare email address on submit', async () => {
    const textarea = document.createElement('textarea')
    document.body.appendChild(textarea)
    textarea.value = 'a@b.co'
    respond = (m) => (m.type === 'check' ? WARN : null)

    pressEnter(textarea)
    await settle()

    // "What domain is x@y.com?" is an ordinary prompt, and it was going
    // through the boundary that matters unchecked.
    expect(checks()).toBe(1)
  })

  it('still ignores something too short to hold anything', async () => {
    const textarea = document.createElement('textarea')
    document.body.appendChild(textarea)
    textarea.value = 'ok'
    respond = () => ALLOW

    pressEnter(textarea)
    await settle()
    expect(checks()).toBe(0)
  })
})

describe('an editor that rewrites what it was given', () => {
  /**
   * The write -> read mismatch, at its worst. Cleaning writes the sanitizer's
   * string; the editor then rewrites it; the next send reads the rewritten
   * form. Approval is bound to text, so every one of these has to be covered
   * or the user is warned a second time about the tool's own output.
   */
  const REWRITES: Array<[string, (s: string) => string]> = [
    ['non-breaking spaces', (s) => s.replace(/ /g, '\u00a0')],
    ['trailing newlines', (s) => `${s}\n\n`],
    ['collapsed whitespace', (s) => s.replace(/\s+/g, ' ')],
    ['quotes around it', (s) => `"${s}"`],
    ['a leading bullet', (s) => `\u2022 ${s}`],
    ['an appended zero-width space', (s) => `${s}\u200b`],
  ]

  it.each(REWRITES)('does not warn twice after %s', async (_name, rewrite) => {
    const editor = document.createElement('div')
    editor.setAttribute('contenteditable', 'true')
    document.body.appendChild(editor)
    editor.addEventListener('input', () => {
      editor.textContent = rewrite(editor.textContent ?? '')
    })
    editor.textContent = DIRTY

    respond = (m) => (m.type === 'check' ? WARN : m.type === 'sanitize' ? sanitized(CLEANED) : null)

    pressEnter(editor)
    await settle()
    banner.onAction?.('redact')
    await settle()

    pressEnter(editor)
    await settle()
    expect(checks()).toBe(1)
  })

  it('survives a rewrite that lands on a later tick', async () => {
    const editor = document.createElement('div')
    editor.setAttribute('contenteditable', 'true')
    document.body.appendChild(editor)
    // A React-style editor commits on a later tick, so the read-back taken
    // straight after `write()` sees the text the editor has not touched yet.
    // Normalising the comparison is what carries this one.
    editor.addEventListener('input', () => {
      setTimeout(() => {
        editor.textContent = `${editor.textContent ?? ''}  `
      }, 0)
    })
    editor.textContent = DIRTY

    respond = (m) => (m.type === 'check' ? WARN : m.type === 'sanitize' ? sanitized(CLEANED) : null)

    pressEnter(editor)
    await settle()
    banner.onAction?.('redact')
    await new Promise((r) => setTimeout(r, 20))

    pressEnter(editor)
    await settle()
    expect(checks()).toBe(1)
  })
})

describe('what is not intercepted', () => {
  it('ignores Shift+Enter, so a newline stays a newline', async () => {
    const textarea = document.createElement('textarea')
    document.body.appendChild(textarea)
    textarea.value = DIRTY
    respond = () => ALLOW

    textarea.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    )
    await settle()
    expect(checks()).toBe(0)
  })

  it('ignores Enter while an IME is composing', async () => {
    const textarea = document.createElement('textarea')
    document.body.appendChild(textarea)
    textarea.value = DIRTY
    respond = () => ALLOW

    textarea.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        isComposing: true,
        bubbles: true,
        cancelable: true,
      }),
    )
    await settle()
    // Committing a Japanese or Chinese candidate sends Enter. Intercepting it
    // would make the extension unusable in those languages.
    expect(checks()).toBe(0)
  })

  it('says so loudly when a send has no findable composer', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const button = document.createElement('button')
    button.type = 'submit'
    document.body.appendChild(button)
    respond = () => ALLOW

    button.click()
    await settle()

    // The one failure that looks exactly like success: an unchecked send is
    // indistinguishable from a clean one unless it is announced.
    expect(checks()).toBe(0)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

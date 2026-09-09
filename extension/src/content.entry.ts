/**
 * The content script's entry point.
 *
 * Two lines, and the reason for them is testability. `content.ts` is
 * `document`-level and capture-phase, so a module that attaches on import
 * cannot be exercised by a test without every suite in the file fighting over
 * one shared document. Keeping the attachment here leaves that module inert to
 * import, and leaves this file with nothing in it worth testing.
 */
import { install } from './content'

install()

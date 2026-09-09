/**
 * Base64, because MV3 messages are JSON.
 *
 * `chrome.runtime.sendMessage` serialises through JSON, not structured clone,
 * so an `ArrayBuffer` does not survive the trip — it arrives as `{}`. Every
 * byte that has to cross between the content script, the worker and the
 * offscreen document therefore goes as text.
 *
 * Chunked on purpose: `String.fromCharCode(...bytes)` with a spread of a
 * multi-megabyte array overflows the call stack, and the failure is a
 * `RangeError` at attach time on exactly the large files most worth checking.
 */

const CHUNK = 0x8000

export function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

export function fromBase64(encoded: string): ArrayBuffer {
  const binary = atob(encoded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes.buffer
}

/**
 * Base64 is four characters per three bytes, so a cap on the encoded form is
 * really a cap on memory: the string, the decoded copy, and the parsed
 * document all coexist.
 */
export const MAX_ATTACHMENT_BYTES = 10_000_000

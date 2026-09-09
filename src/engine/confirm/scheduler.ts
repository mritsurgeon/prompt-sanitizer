/**
 * The escalation mutex and epoch counter.
 *
 * Two problems, both appearing as soon as escalation is driven by anything
 * faster than a click.
 *
 * **Stale answers.** A paste, an edit and a send in quick succession each start
 * an escalation. Timeouts do not help — `onnxruntime-web` has no cancellation,
 * so an abandoned inference keeps running and eventually resolves with a
 * verdict about text the user has already replaced. Applying it would move
 * findings under them. Each escalation takes an epoch on entry, and one that is
 * no longer current returns the fast-path findings rather than its own result.
 *
 * **Pile-up.** Without a lock, three escalations run three inferences at once,
 * each slowing the others, and the one the user is waiting on finishes last.
 *
 * The lock is acquire/release rather than a `withLock(fn)` wrapper for one
 * specific reason: when an escalation times out, the caller must be answered
 * immediately while the **lock stays held** until the abandoned inference
 * actually settles. A wrapper ties those two moments together, and releasing
 * on timeout would let a second inference overlap the first — which is the
 * exact failure the lock exists to prevent.
 */

let current = 0
let tail: Promise<void> = Promise.resolve()

/** Claim the newest epoch. Everything older is now stale. */
export function nextEpoch(): number {
  current += 1
  return current
}

export function isCurrent(epoch: number): boolean {
  return epoch === current
}

/**
 * Wait for the lock. Resolves with the release function; call it exactly once.
 *
 * FIFO: the new tail is installed before awaiting the previous one, so waiters
 * run in the order they arrived rather than in whatever order the microtask
 * queue happens to wake them.
 */
export async function acquire(): Promise<() => void> {
  const previous = tail
  let release!: () => void
  tail = new Promise<void>((resolve) => {
    release = resolve
  })
  // A previous holder that threw must not wedge the queue permanently: a
  // confirmer that fails is a documented, survivable state.
  await previous.catch(() => undefined)
  return release
}

/** Test-only: forget the epoch and the queue between cases. */
export function resetScheduler(): void {
  current = 0
  tail = Promise.resolve()
}

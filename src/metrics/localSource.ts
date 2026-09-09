import {
  applyRetention,
  DEFAULT_RETENTION,
  summarise,
  type MetricsSource,
  type MetricsSummary,
  type PerformanceEnvelope,
  type RetentionLimits,
  type SummaryQuery,
} from '@/engine/metrics'

/**
 * The local metrics store: IndexedDB, on this device, with no transport.
 *
 * Deliberately **not** in `src/engine`. The engine is pure and does no I/O,
 * which is what lets the same detection code run in the browser, in the
 * extension and in the Node benchmark scripts — and Node has no IndexedDB. So
 * the engine depends on the one-method `MetricsSink` interface and this is
 * registered into it at startup, exactly as the GLiNER confirmer is registered
 * into the confirmation seam.
 *
 * Three properties the engine relies on:
 *
 * - **`record` is synchronous and never throws.** It appends to an in-memory
 *   buffer and returns. An awaited write would add storage latency to the
 *   measurement it is taking, and a throwing sink would turn instrumentation
 *   into an outage on a path that is holding somebody's keystroke.
 * - **Storage failure is survivable.** A private window, cleared site data or
 *   a browser configured to block storage makes `indexedDB.open` fail or
 *   hang. Every failure downgrades to memory-only and stays quiet after
 *   saying so once.
 * - **It is bounded.** Retention is enforced on flush rather than left to
 *   grow, by age *and* by count — either limit alone fails (an age limit lets
 *   a busy hour fill the disk; a count limit lets a quiet month keep records
 *   past the window the product promises).
 */

const DB_NAME = 'ai-safe-metrics'
const DB_VERSION = 1
const STORE = 'performance'
const TIMESTAMP_INDEX = 'by_timestamp'

/** Flush when the buffer reaches this, so a burst cannot be lost. */
const FLUSH_AT = 32
/** Otherwise flush this long after the first buffered event. */
const FLUSH_AFTER_MS = 2000
/** Opening must not hang forever behind a blocked upgrade. */
const OPEN_TIMEOUT_MS = 3000

type Stored = PerformanceEnvelope & { seq?: number }

export interface LocalSourceOptions {
  retention?: RetentionLimits
  /** Overridden in tests with a fake. */
  factory?: IDBFactory | null
}

export class LocalSource implements MetricsSource {
  readonly id = 'local' as const

  private buffer: PerformanceEnvelope[] = []
  private db: IDBDatabase | null = null
  private opening: Promise<IDBDatabase | null> | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private flushing: Promise<void> | null = null
  private retention: RetentionLimits
  private factory: IDBFactory | null
  private degraded = false

  constructor(options: LocalSourceOptions = {}) {
    this.retention = options.retention ?? DEFAULT_RETENTION
    this.factory =
      options.factory ??
      (typeof indexedDB === 'undefined' ? null : indexedDB)
  }

  /** Synchronous, non-throwing, buffered. See the class comment. */
  record(event: PerformanceEnvelope): void {
    this.buffer.push(event)

    // Bound the buffer even if flushing is broken, so a failing store cannot
    // turn into unbounded memory growth in a long-lived tab.
    if (this.buffer.length > this.retention.maxEvents) {
      this.buffer.splice(0, this.buffer.length - this.retention.maxEvents)
    }

    if (this.buffer.length >= FLUSH_AT) {
      void this.flush()
      return
    }
    if (this.timer === null) {
      this.timer = setTimeout(() => void this.flush(), FLUSH_AFTER_MS)
      // Never hold a Node process open on account of a metrics timer.
      const timer = this.timer as unknown as { unref?: () => void }
      timer.unref?.()
    }
  }

  async flush(): Promise<void> {
    // Coalesce concurrent flushes; a second caller waits for the first.
    if (this.flushing) return this.flushing
    this.flushing = this.doFlush().finally(() => {
      this.flushing = null
    })
    return this.flushing
  }

  private async doFlush(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (!this.buffer.length) return

    const batch = this.buffer
    this.buffer = []

    const db = await this.open()
    if (!db) {
      // Memory-only: keep the most recent so the console still shows
      // *something* rather than an empty panel that looks like "no activity".
      this.buffer = applyRetention([...batch, ...this.buffer], this.retention)
      return
    }

    try {
      await this.write(db, batch)
      await this.prune(db)
    } catch (cause) {
      this.warnOnce('could not write metrics', cause)
      this.buffer = applyRetention([...batch, ...this.buffer], this.retention)
    }
  }

  private write(db: IDBDatabase, batch: PerformanceEnvelope[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      const store = tx.objectStore(STORE)
      // `put`, not `add`: a re-flushed batch after a partial failure would
      // throw ConstraintError on `add` and abort the whole transaction,
      // losing the rest of the batch to protect a duplicate we do not care
      // about. The store key is a fresh autoincrement per record anyway.
      for (const event of batch) store.put(event)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
    })
  }

  /** Trim by age and by count, in one pass, oldest first. */
  private prune(db: IDBDatabase): Promise<void> {
    return new Promise((resolve, reject) => {
      const cutoff = Date.now() - this.retention.maxAgeMs
      const tx = db.transaction(STORE, 'readwrite')
      const store = tx.objectStore(STORE)
      const index = store.index(TIMESTAMP_INDEX)

      const old = index.openCursor(IDBKeyRange.upperBound(cutoff, true))
      old.onsuccess = () => {
        const cursor = old.result
        if (cursor) {
          cursor.delete()
          cursor.continue()
          return
        }
        // Age done; now the count limit, dropping oldest first.
        const counting = store.count()
        counting.onsuccess = () => {
          const excess = counting.result - this.retention.maxEvents
          if (excess <= 0) return
          let dropped = 0
          const oldest = index.openCursor()
          oldest.onsuccess = () => {
            const cursor = oldest.result
            if (!cursor || dropped >= excess) return
            cursor.delete()
            dropped += 1
            cursor.continue()
          }
        }
      }

      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
    })
  }

  async queryEvents(query: SummaryQuery = {}): Promise<PerformanceEnvelope[]> {
    const sinceMs = query.sinceMs ?? 24 * 60 * 60 * 1000
    const since = Date.now() - sinceMs

    const db = await this.open()
    const stored: PerformanceEnvelope[] = db
      ? await new Promise<PerformanceEnvelope[]>((resolve, reject) => {
          const tx = db.transaction(STORE, 'readonly')
          const index = tx.objectStore(STORE).index(TIMESTAMP_INDEX)
          const request = index.getAll(IDBKeyRange.lowerBound(since))
          request.onsuccess = () =>
            resolve(
              (request.result as Stored[]).map(({ seq: _seq, ...rest }) => rest),
            )
          request.onerror = () => reject(request.error)
        }).catch((cause) => {
          this.warnOnce('could not read metrics', cause)
          return []
        })
      : []

    // Include anything still buffered, so a freshly recorded event is visible
    // immediately rather than after the next flush.
    const pending = this.buffer.filter((e) => e.timestamp >= since)
    const all = [...stored, ...pending]
    return query.phase ? all.filter((e) => e.phase === query.phase) : all
  }

  async querySummary(query: SummaryQuery = {}): Promise<MetricsSummary> {
    return summarise(await this.queryEvents(query), query)
  }

  async clear(): Promise<void> {
    this.buffer = []
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    const db = await this.open()
    if (!db) return
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).clear()
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    }).catch((cause) => this.warnOnce('could not clear metrics', cause))
  }

  private open(): Promise<IDBDatabase | null> {
    if (this.db) return Promise.resolve(this.db)
    if (this.degraded) return Promise.resolve(null)
    if (this.opening) return this.opening

    const factory = this.factory
    if (!factory) {
      this.degraded = true
      return Promise.resolve(null)
    }

    this.opening = new Promise<IDBDatabase | null>((resolve) => {
      let settled = false
      const done = (db: IDBDatabase | null) => {
        if (settled) return
        settled = true
        if (!db) this.degraded = true
        this.db = db
        resolve(db)
      }

      // A blocked upgrade (another tab holding an old version) never fires
      // success or error. Without this the console hangs on a spinner.
      const timeout = setTimeout(() => {
        this.warnOnce('opening the metrics store timed out')
        done(null)
      }, OPEN_TIMEOUT_MS)
      const timer = timeout as unknown as { unref?: () => void }
      timer.unref?.()

      let request: IDBOpenDBRequest
      try {
        request = factory.open(DB_NAME, DB_VERSION)
      } catch (cause) {
        clearTimeout(timeout)
        this.warnOnce('the metrics store is unavailable', cause)
        done(null)
        return
      }

      request.onupgradeneeded = () => {
        const db = request.result
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, {
            // Autoincrement rather than keying on traceId: the key exists to
            // order rows, and a duplicate traceId from a re-flush must not be
            // able to abort a transaction.
            keyPath: 'seq',
            autoIncrement: true,
          })
          store.createIndex(TIMESTAMP_INDEX, 'timestamp')
        }
      }
      request.onsuccess = () => {
        clearTimeout(timeout)
        const db = request.result
        // Another tab upgrading must not leave us holding a stale handle.
        db.onversionchange = () => {
          db.close()
          this.db = null
          this.opening = null
        }
        done(db)
      }
      request.onerror = () => {
        clearTimeout(timeout)
        this.warnOnce('the metrics store could not be opened', request.error)
        done(null)
      }
    }).finally(() => {
      this.opening = null
    })

    return this.opening
  }

  private warned = false
  private warnOnce(message: string, cause?: unknown): void {
    if (this.warned) return
    this.warned = true
    console.warn(
      `[ai-safe] ${message} — performance metrics are memory-only for this session.`,
      cause ?? '',
    )
  }
}

import { useEffect, useState } from 'react'
import { Loader2, ShieldCheck } from 'lucide-react'
import { cn } from '@/lib/utils'

const STEPS = [
  'Looking for personal details',
  'Checking internal information',
  'Checking for passwords and keys',
]

/** How long the spinner rests on each check as it moves down the list. */
const STEP_MS = 180
/** How long the scan may run past the list before we admit it is thinking. */
const PATIENCE_MS = 400

interface ScanOverlayProps {
  /** The scan. Started immediately; the overlay closes once it resolves. */
  work: () => Promise<void> | void
  /** Called once the spinner has finished walking the list. */
  onDone: () => void
}

/**
 * The moment between clicking Check and seeing results.
 *
 * A spinner walks down the list of checks and the overlay closes when it
 * reaches the end — no completion flourish, because a burst of green ticks at
 * the end reads as decoration rather than progress. The walk is paced by the
 * work: it always finishes the list, and if the scan outlasts it the spinner
 * simply stays on the last line and says what it is waiting for.
 */
export function ScanOverlay({ work, onDone }: ScanOverlayProps) {
  const [step, setStep] = useState(0)
  const [deepening, setDeepening] = useState(false)

  useEffect(() => {
    let cancelled = false
    const timers: ReturnType<typeof setTimeout>[] = []
    const wait = (ms: number) =>
      new Promise<void>((resolve) => timers.push(setTimeout(resolve, ms)))

    void (async () => {
      const pending = Promise.resolve(work())

      // Walk the list at its own pace, whether or not the scan has already
      // finished. Cutting away mid-list is what reads as a glitch.
      for (let i = 0; i < STEPS.length; i++) {
        await wait(STEP_MS)
        if (cancelled) return
        setStep(i + 1)
      }

      // Still going? Say so, rather than leaving a finished-looking list.
      const admit = setTimeout(() => {
        if (!cancelled) setDeepening(true)
      }, PATIENCE_MS)
      timers.push(admit)

      try {
        await pending
      } finally {
        clearTimeout(admit)
      }

      if (!cancelled) onDone()
    })()

    return () => {
      cancelled = true
      timers.forEach(clearTimeout)
    }
  }, [work, onDone])

  return (
    <div className="animate-fade mx-auto flex w-full max-w-md flex-col items-center px-6">
      <div className="relative grid size-20 place-items-center">
        <div className="bg-primary/25 absolute inset-0 animate-ping rounded-full opacity-40" />
        <div className="border-primary/30 bg-primary/10 relative grid size-20 place-items-center rounded-full border">
          <ShieldCheck className="text-primary size-8" />
        </div>
      </div>

      <p className="mt-8 text-xl font-medium">Checking your content…</p>

      <ul className="mt-7 w-full space-y-3">
        {STEPS.map((label, i) => {
          const done = step > i
          const active = step === i
          return (
            <li
              key={label}
              className={cn(
                'flex items-center gap-3 text-sm transition-colors duration-300',
                done || active ? 'text-foreground/90' : 'text-muted-foreground/40',
              )}
            >
              <span className="grid size-5 place-items-center">
                {active ? (
                  <Loader2 className="text-primary size-3.5 animate-spin" />
                ) : (
                  <span
                    className={cn(
                      'size-1.5 rounded-full transition-colors duration-300',
                      done ? 'bg-primary' : 'bg-muted-foreground/30',
                    )}
                  />
                )}
              </span>
              {label}
            </li>
          )
        })}

        {deepening && (
          <li className="animate-fade text-foreground/90 flex items-center gap-3 text-sm">
            <span className="grid size-5 place-items-center">
              <Loader2 className="text-primary size-3.5 animate-spin" />
            </span>
            Taking a closer look at a few uncertain items
          </li>
        )}
      </ul>

      {/*
        Visible from the first frame. Its only job is to answer "did my click
        register?" immediately, so nobody clicks Check twice. It is torn down
        the moment the work resolves, so it can never outlast the thing it is
        covering — the wait ends the bar, the bar never sets the wait.
      */}
      <div className="mt-8 flex w-full flex-col items-center gap-2">
        <div className="bg-secondary relative h-1 w-full overflow-hidden rounded-full">
          <span className="bg-primary animate-sweep absolute inset-y-0 left-0 w-1/3 rounded-full" />
        </div>
        {deepening && (
          <p className="text-muted-foreground animate-fade max-w-xs text-center text-xs">
            Only the first check waits for this. It stays ready afterwards.
          </p>
        )}
      </div>
    </div>
  )
}

import { useEffect, useState } from 'react'
import { Check, Loader2, ShieldCheck } from 'lucide-react'
import { cn } from '@/lib/utils'

const STEPS = [
  'Looking for personal details',
  'Checking internal information',
  'Checking for passwords and keys',
]

const STEP_MS = 150

/**
 * A very short reassurance animation. The scan itself finishes in single-digit
 * milliseconds — this only exists so the jump to a result does not feel like a
 * glitch. Total: under half a second.
 */
export function ScanOverlay({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState(0)

  useEffect(() => {
    const timers = STEPS.map((_, i) =>
      setTimeout(() => setStep(i + 1), STEP_MS * (i + 1)),
    )
    const finish = setTimeout(onDone, STEP_MS * (STEPS.length + 1))
    return () => {
      timers.forEach(clearTimeout)
      clearTimeout(finish)
    }
  }, [onDone])

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
                'flex items-center gap-3 text-sm transition-all duration-300',
                done
                  ? 'text-foreground'
                  : active
                    ? 'text-foreground/80'
                    : 'text-muted-foreground/40',
              )}
            >
              <span
                className={cn(
                  'grid size-5 place-items-center rounded-full border transition-colors duration-300',
                  done
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-border',
                )}
              >
                {done ? (
                  <Check className="size-3" strokeWidth={3} />
                ) : active ? (
                  <Loader2 className="text-primary size-3 animate-spin" />
                ) : null}
              </span>
              {label}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

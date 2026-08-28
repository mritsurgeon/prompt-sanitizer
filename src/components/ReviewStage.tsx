import { useState } from 'react'
import { ChevronDown, Copy, RotateCcw, Sparkles, Wand2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DetailsList } from '@/components/DetailsList'
import { HighlightedText, type Highlight } from '@/components/HighlightedText'
import { RiskDial } from '@/components/RiskDial'
import { GROUP_META, GROUP_ORDER, category } from '@/engine/categories'
import { LEVEL_COPY } from '@/engine/risk'
import type { Finding, RiskSummary, SanitizeMode } from '@/engine/types'
import { cn } from '@/lib/utils'

interface ReviewStageProps {
  text: string
  findings: Finding[]
  risk: RiskSummary
  mode: SanitizeMode
  sourceLabel: string | null
  onToggleValue: (ids: string[], enabled: boolean) => void
  onClean: () => void
  onCopyOriginal: () => void
  onReset: () => void
}

export function ReviewStage({
  text,
  findings,
  risk,
  mode,
  sourceLabel,
  onToggleValue,
  onClean,
  onCopyOriginal,
  onReset,
}: ReviewStageProps) {
  const [open, setOpen] = useState(false)
  const copy = LEVEL_COPY[risk.level]
  const clean = risk.counts.total === 0

  const highlights: Highlight[] = findings
    .filter((f) => f.enabled)
    .map((f) => {
      const meta = category(f.category)
      return {
        start: f.start,
        end: f.end,
        label: meta.label,
        tone: GROUP_META[meta.group].color,
        title: `${meta.label} — ${meta.why}`,
      }
    })

  return (
    <div className="animate-rise mx-auto flex w-full max-w-5xl flex-col items-center px-6">
      <RiskDial score={risk.score} level={risk.level} />

      <h2 className="mt-7 text-center text-4xl font-semibold tracking-tight">
        {clean ? 'Looks safe to share' : copy.headline}
      </h2>
      <p className="text-muted-foreground mt-3 max-w-lg text-center text-base text-balance">
        {clean
          ? 'We did not find anything sensitive in this content.'
          : `We found ${risk.counts.total} thing${risk.counts.total === 1 ? '' : 's'} you may not want to share with an AI tool.`}
      </p>

      {!clean && (
        <div className="mt-7 flex flex-wrap justify-center gap-2.5">
          {GROUP_ORDER.filter((g) => risk.counts[g] > 0).map((group) => {
            const meta = GROUP_META[group]
            const count = risk.counts[group]
            return (
              <div
                key={group}
                className="bg-card/60 border-border/70 animate-pop flex items-center gap-2.5 rounded-full border py-2 pr-4 pl-3 text-sm"
              >
                <span
                  className="size-2.5 rounded-full"
                  style={{
                    background: meta.color,
                    boxShadow: `0 0 10px ${meta.color}`,
                  }}
                />
                <span className="font-semibold tabular-nums">{count}</span>
                <span className="text-muted-foreground">
                  {count === 1 ? meta.singular : meta.label}
                </span>
              </div>
            )
          })}
        </div>
      )}

      <div className="mt-9 flex flex-col items-center gap-4">
        {clean ? (
          <Button
            size="lg"
            onClick={onCopyOriginal}
            className="h-14 min-w-56 gap-2 rounded-full text-base font-semibold"
          >
            <Copy className="size-5" />
            Copy it
          </Button>
        ) : (
          <Button
            size="lg"
            onClick={onClean}
            className="h-14 min-w-56 gap-2 rounded-full text-base font-semibold shadow-[0_10px_40px_-10px_color-mix(in_oklch,var(--primary)_75%,transparent)] transition-transform hover:scale-[1.02] active:scale-[0.99]"
          >
            <Wand2 className="size-5" />
            Clean it
          </Button>
        )}

        <div className="flex items-center gap-1">
          {!clean && (
            <Button
              variant="ghost"
              onClick={() => setOpen((v) => !v)}
              className="text-muted-foreground hover:text-foreground gap-1.5 rounded-full text-sm"
            >
              {open ? 'Hide details' : 'View details'}
              <ChevronDown
                className={cn(
                  'size-4 transition-transform duration-300',
                  open && 'rotate-180',
                )}
              />
            </Button>
          )}
          <Button
            variant="ghost"
            onClick={onReset}
            className="text-muted-foreground hover:text-foreground gap-1.5 rounded-full text-sm"
          >
            <RotateCcw className="size-3.5" />
            Start over
          </Button>
        </div>
      </div>

      {open && !clean && (
        <div className="animate-rise glass border-border/70 mt-8 w-full rounded-2xl border p-6 shadow-2xl shadow-black/30">
          <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
            <div className="min-w-0">
              <div className="mb-3 flex items-center gap-2">
                <h3 className="text-sm font-semibold">
                  What we found{sourceLabel ? ` in ${sourceLabel}` : ''}
                </h3>
                <span className="text-muted-foreground text-xs">
                  hover a highlight
                </span>
              </div>
              <div className="scrollbar-slim bg-background/50 border-border/60 max-h-[26rem] overflow-auto rounded-xl border p-4">
                <HighlightedText text={text} highlights={highlights} />
              </div>
            </div>

            <div className="min-w-0">
              <div className="mb-3 flex items-center gap-2">
                <Sparkles className="text-primary size-3.5" />
                <h3 className="text-sm font-semibold">
                  Why, and what it becomes
                </h3>
                <span className="text-muted-foreground text-xs">
                  switch anything off to keep it
                </span>
              </div>
              <div className="scrollbar-slim max-h-[26rem] overflow-auto pr-1">
                <DetailsList
                  findings={findings}
                  mode={mode}
                  onToggleValue={onToggleValue}
                />
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

import { ArrowRight } from 'lucide-react'
import { Switch } from '@/components/ui/switch'
import { GROUP_META, GROUP_ORDER, category } from '@/engine/categories'
import { groupByValue } from '@/engine/detect'
import { previewReplacement } from '@/engine/sanitize'
import type { Finding, Group, SanitizeMode } from '@/engine/types'

function certainty(confidence: number): string {
  if (confidence >= 0.9) return 'Certain'
  if (confidence >= 0.75) return 'Likely'
  return 'Possible'
}

interface DetailsListProps {
  findings: Finding[]
  mode: SanitizeMode
  onToggleValue: (ids: string[], enabled: boolean) => void
}

/**
 * The "show me why" panel. Every row answers: what we found, why it is
 * flagged, how sure we are, and exactly what it will be replaced with.
 */
export function DetailsList({
  findings,
  mode,
  onToggleValue,
}: DetailsListProps) {
  const byGroup = new Map<Group, Finding[][]>()

  for (const bucket of groupByValue(findings)) {
    const group = category(bucket[0].category).group
    const list = byGroup.get(group) ?? []
    list.push(bucket)
    byGroup.set(group, list)
  }

  return (
    <div className="space-y-7">
      {GROUP_ORDER.filter((g) => byGroup.get(g)?.length).map((group) => {
        const meta = GROUP_META[group]
        const buckets = byGroup.get(group)!

        return (
          <section key={group}>
            <div className="mb-3 flex items-baseline gap-2.5">
              <span
                className="size-2 rounded-full"
                style={{ background: meta.color }}
              />
              <h4 className="text-sm font-semibold capitalize">{meta.label}</h4>
              <span className="text-muted-foreground text-xs">
                {meta.blurb}
              </span>
            </div>

            <ul className="space-y-1.5">
              {buckets.map((bucket) => {
                const first = bucket[0]
                const meta2 = category(first.category)
                const ids = bucket.map((f) => f.id)
                const on = bucket.some((f) => f.enabled)

                return (
                  <li
                    key={`${first.category}-${first.value}`}
                    className="bg-card/50 hover:bg-card/80 border-border/60 flex items-center gap-4 rounded-xl border px-4 py-3 transition-colors"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                        <code
                          className="max-w-[22rem] truncate rounded px-1.5 py-0.5 font-mono text-[0.8rem]"
                          style={{
                            background: `color-mix(in oklch, ${meta.color} 18%, transparent)`,
                            color: meta.color,
                          }}
                        >
                          {first.value.length > 60
                            ? `${first.value.slice(0, 57)}…`
                            : first.value}
                        </code>
                        <ArrowRight className="text-muted-foreground/60 size-3.5 shrink-0" />
                        <code className="text-primary bg-primary/10 rounded px-1.5 py-0.5 font-mono text-[0.8rem]">
                          {previewReplacement(first, mode)}
                        </code>
                        {bucket.length > 1 && (
                          <span className="text-muted-foreground text-[0.7rem]">
                            ×{bucket.length}
                          </span>
                        )}
                      </div>
                      <p className="text-muted-foreground mt-1.5 text-xs">
                        <span className="text-foreground/80 font-medium">
                          {meta2.label}
                        </span>
                        {' · '}
                        {meta2.why}
                      </p>
                    </div>

                    <div className="flex shrink-0 items-center gap-3">
                      <span className="text-muted-foreground/70 hidden text-[0.7rem] tracking-wide uppercase sm:block">
                        {certainty(first.confidence)}
                      </span>
                      <Switch
                        checked={on}
                        onCheckedChange={(next) => onToggleValue(ids, next)}
                        aria-label={`Replace ${meta2.label}`}
                      />
                    </div>
                  </li>
                )
              })}
            </ul>
          </section>
        )
      })}
    </div>
  )
}

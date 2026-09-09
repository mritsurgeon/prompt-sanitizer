import { useMemo } from 'react'
import { cn } from '@/lib/utils'

export interface Highlight {
  start: number
  end: number
  /** Shown as a small caption above the highlight on hover. */
  label: string
  tone: string
  title?: string
}

interface HighlightedTextProps {
  text: string
  highlights: Highlight[]
  className?: string
  emptyMessage?: string
}

export function HighlightedText({
  text,
  highlights,
  className,
  emptyMessage,
}: HighlightedTextProps) {
  const parts = useMemo(() => {
    const sorted = [...highlights].sort((a, b) => a.start - b.start)
    const out: { key: string; text: string; hit?: Highlight }[] = []
    let cursor = 0

    sorted.forEach((hit, i) => {
      if (hit.start < cursor) return
      if (hit.start > cursor) {
        out.push({ key: `t${i}`, text: text.slice(cursor, hit.start) })
      }
      out.push({ key: `h${i}`, text: text.slice(hit.start, hit.end), hit })
      cursor = hit.end
    })

    if (cursor < text.length) out.push({ key: 'tail', text: text.slice(cursor) })
    return out
  }, [text, highlights])

  if (!text.trim() && emptyMessage) {
    return (
      <p className="text-muted-foreground text-sm italic">{emptyMessage}</p>
    )
  }

  return (
    <div
      className={cn(
        'font-mono text-[0.82rem] leading-[1.85] whitespace-pre-wrap',
        className,
      )}
    >
      {parts.map(({ key, text: chunk, hit }) =>
        hit ? (
          <mark
            key={key}
            title={hit.title ?? hit.label}
            className="animate-fade group relative cursor-help rounded-[5px] px-[3px] py-[1px] font-medium transition-all duration-200 hover:brightness-125"
            style={{
              background: `color-mix(in oklch, ${hit.tone} 26%, transparent)`,
              color: hit.tone,
              boxShadow: `inset 0 0 0 1px color-mix(in oklch, ${hit.tone} 45%, transparent)`,
            }}
          >
            {chunk}
            {/*
              Opens downward, and it has to.

              At `-top-5` this sat 1.25rem above the mark, which is in the
              previous line's space — and for the first visible line, outside
              the scroll container wrapping this text
              (`max-h-[26rem] overflow-auto` in `ReviewStage`). An absolutely
              positioned child with a negative offset is clipped by an
              `overflow` ancestor, so the label was invisible for the top row
              of findings: exactly the row a reader looks at first.

              Below instead. It overlaps the following line slightly, which is
              a transient hover state on an opaque background and reads fine;
              being clipped away entirely does not.

              Left as CSS rather than promoted to a portalled tooltip because
              a document can produce hundreds of these marks, and a tooltip
              instance apiece is a great deal of machinery for a hover label —
              the `title` on the mark already carries the same text natively.
            */}
            <span
              className="pointer-events-none absolute top-full left-0 z-10 mt-0.5 rounded-md px-1.5 py-0.5 text-[0.6rem] font-semibold tracking-wider whitespace-nowrap uppercase opacity-0 transition-opacity duration-150 group-hover:opacity-100"
              style={{
                background: `color-mix(in oklch, ${hit.tone} 88%, black)`,
                color: 'white',
              }}
            >
              {hit.label}
            </span>
          </mark>
        ) : (
          <span key={key}>{chunk}</span>
        ),
      )}
    </div>
  )
}

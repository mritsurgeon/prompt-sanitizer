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
            <span
              className="pointer-events-none absolute -top-5 left-0 z-10 rounded-md px-1.5 py-0.5 text-[0.6rem] font-semibold tracking-wider whitespace-nowrap uppercase opacity-0 transition-opacity duration-150 group-hover:opacity-100"
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

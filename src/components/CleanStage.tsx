import { useState } from 'react'
import {
  ArrowRight,
  Check,
  Copy,
  Download,
  Loader2,
  RotateCcw,
  Sparkles,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { HighlightedText, type Highlight } from '@/components/HighlightedText'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { GROUP_META, category } from '@/engine/categories'
import { MODE_COPY } from '@/engine/sanitize'
import type {
  Finding,
  RiskSummary,
  SanitizeMode,
  SanitizeResult,
} from '@/engine/types'
import type { ImprovedPrompt } from '@/engine/improve'
import type { ExtractedFile } from '@/files/extract'
import { cn } from '@/lib/utils'

type View = 'cleaned' | 'compare' | 'improved'

interface CleanStageProps {
  originalText: string
  findings: Finding[]
  sanitized: SanitizeResult
  improved: ImprovedPrompt | null
  improving: boolean
  riskBefore: RiskSummary
  riskAfter: RiskSummary
  mode: SanitizeMode
  file: ExtractedFile | null
  downloading: boolean
  onModeChange: (mode: SanitizeMode) => void
  onImprove: () => void
  onCopy: (text: string) => void
  onDownload: () => void
  onBack: () => void
  onReset: () => void
}

export function CleanStage({
  originalText,
  findings,
  sanitized,
  improved,
  improving,
  riskBefore,
  riskAfter,
  mode,
  file,
  downloading,
  onModeChange,
  onImprove,
  onCopy,
  onDownload,
  onBack,
  onReset,
}: CleanStageProps) {
  const [view, setView] = useState<View>('cleaned')
  const [copied, setCopied] = useState(false)

  const activeText =
    view === 'improved' && improved ? improved.text : sanitized.text

  const originalHighlights: Highlight[] = findings
    .filter((f) => f.enabled)
    .map((f) => {
      const meta = category(f.category)
      return {
        start: f.start,
        end: f.end,
        label: meta.label,
        tone: GROUP_META[meta.group].color,
      }
    })

  const cleanedHighlights: Highlight[] = sanitized.replacements.map((r) => ({
    start: r.start,
    end: r.end,
    label: category(r.finding.category).label,
    tone: 'var(--risk-safe)',
  }))

  const handleCopy = () => {
    onCopy(activeText)
    setCopied(true)
    setTimeout(() => setCopied(false), 1800)
  }

  const handleImprove = () => {
    setView('improved')
    onImprove()
  }

  return (
    <div className="animate-rise mx-auto flex w-full max-w-5xl flex-col items-center px-6">
      <div className="border-primary/25 bg-primary/10 text-primary flex items-center gap-2 rounded-full border px-4 py-1.5 text-sm font-medium">
        <Check className="size-4" strokeWidth={3} />
        Ready for AI
      </div>

      <h2 className="mt-6 text-center text-4xl font-semibold tracking-tight">
        Your content has been cleaned
      </h2>

      <div className="mt-5 flex items-center gap-3 text-sm">
        <span className="text-muted-foreground">Risk</span>
        <span
          className="rounded-full px-3 py-1 font-semibold tabular-nums"
          style={{
            background: 'color-mix(in oklch, var(--risk-critical) 16%, transparent)',
            color: 'var(--risk-critical)',
          }}
        >
          {riskBefore.score}
        </span>
        <ArrowRight className="text-muted-foreground size-4" />
        <span
          className="animate-pop rounded-full px-3 py-1 font-semibold tabular-nums"
          style={{
            background: 'color-mix(in oklch, var(--risk-safe) 18%, transparent)',
            color: 'var(--risk-safe)',
          }}
        >
          {riskAfter.score}
        </span>
        <span className="text-muted-foreground">
          · {sanitized.replacements.length} item
          {sanitized.replacements.length === 1 ? '' : 's'} replaced
        </span>
      </div>

      {/* ---- panel ---------------------------------------------------- */}
      <div className="glass border-border/70 mt-8 w-full overflow-hidden rounded-2xl border shadow-2xl shadow-black/40">
        <div className="border-border/60 flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
          <Tabs value={view} onValueChange={(v) => setView(v as View)}>
            <TabsList className="rounded-full">
              <TabsTrigger value="cleaned" className="rounded-full px-4">
                Cleaned
              </TabsTrigger>
              <TabsTrigger value="compare" className="rounded-full px-4">
                Compare
              </TabsTrigger>
              <TabsTrigger
                value="improved"
                disabled={!improved && !improving}
                className="rounded-full px-4"
              >
                Improved
              </TabsTrigger>
            </TabsList>
          </Tabs>

          <div className="flex items-center gap-2">
            <span className="text-muted-foreground hidden text-xs sm:block">
              Replace with
            </span>
            <ToggleGroup
              type="single"
              value={mode}
              onValueChange={(v) => v && onModeChange(v as SanitizeMode)}
              variant="outline"
              size="sm"
              className="rounded-full"
            >
              {(Object.keys(MODE_COPY) as SanitizeMode[]).map((key) => (
                <Tooltip key={key}>
                  <TooltipTrigger asChild>
                    <ToggleGroupItem
                      value={key}
                      className="px-3 text-xs first:rounded-l-full last:rounded-r-full"
                    >
                      {MODE_COPY[key].label}
                    </ToggleGroupItem>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-64">
                    {MODE_COPY[key].hint}
                  </TooltipContent>
                </Tooltip>
              ))}
            </ToggleGroup>
          </div>
        </div>

        <div className="p-1">
          {view === 'compare' ? (
            <div className="grid gap-1 md:grid-cols-2">
              <Pane
                title="Original"
                caption="stays on this device"
                tone="var(--risk-high)"
              >
                <HighlightedText
                  text={originalText}
                  highlights={originalHighlights}
                />
              </Pane>
              <Pane
                title="Cleaned"
                caption="safe to paste"
                tone="var(--risk-safe)"
              >
                <HighlightedText
                  text={sanitized.text}
                  highlights={cleanedHighlights}
                />
              </Pane>
            </div>
          ) : view === 'improved' ? (
            <Pane
              title="Improved prompt"
              caption={improved?.note ?? 'Rewriting…'}
              tone="var(--primary)"
            >
              {improving ? (
                <div className="text-muted-foreground flex items-center gap-2 py-8 text-sm">
                  <Loader2 className="size-4 animate-spin" />
                  Rewriting your prompt…
                </div>
              ) : (
                <pre className="font-mono text-[0.82rem] leading-[1.85] whitespace-pre-wrap">
                  {improved?.text}
                </pre>
              )}
            </Pane>
          ) : (
            <Pane
              title="Cleaned"
              caption="safe to paste into any AI tool"
              tone="var(--risk-safe)"
            >
              <HighlightedText
                text={sanitized.text}
                highlights={cleanedHighlights}
              />
            </Pane>
          )}
        </div>
      </div>

      {/* ---- actions -------------------------------------------------- */}
      <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
        <Button
          size="lg"
          onClick={handleCopy}
          className="h-14 min-w-52 gap-2 rounded-full text-base font-semibold shadow-[0_10px_40px_-10px_color-mix(in_oklch,var(--primary)_75%,transparent)] transition-transform hover:scale-[1.02] active:scale-[0.99]"
        >
          {copied ? (
            <>
              <Check className="size-5" strokeWidth={3} />
              Copied
            </>
          ) : (
            <>
              <Copy className="size-5" />
              Copy safe {view === 'improved' ? 'prompt' : 'text'}
            </>
          )}
        </Button>

        <Button
          size="lg"
          variant="secondary"
          onClick={handleImprove}
          disabled={improving}
          className="h-14 gap-2 rounded-full text-base"
        >
          <Sparkles className="size-4.5" />
          {improved ? 'Improved' : 'Improve'}
        </Button>

        {file && (
          <Button
            size="lg"
            variant="outline"
            onClick={onDownload}
            disabled={downloading}
            className="h-14 gap-2 rounded-full text-base"
          >
            {downloading ? (
              <Loader2 className="size-4.5 animate-spin" />
            ) : (
              <Download className="size-4.5" />
            )}
            Download cleaned file
          </Button>
        )}
      </div>

      <div className="mt-5 flex items-center gap-1">
        <Button
          variant="ghost"
          onClick={onBack}
          className="text-muted-foreground hover:text-foreground rounded-full text-sm"
        >
          Back to results
        </Button>
        <Button
          variant="ghost"
          onClick={onReset}
          className="text-muted-foreground hover:text-foreground gap-1.5 rounded-full text-sm"
        >
          <RotateCcw className="size-3.5" />
          Start over
        </Button>
      </div>

      {mode === 'synthetic' && (
        <p className="text-muted-foreground mt-6 max-w-lg text-center text-xs">
          Heads up: the names, numbers and addresses in this version are
          invented stand-ins, not the real values. Passwords and keys are always
          removed completely.
        </p>
      )}
    </div>
  )
}

function Pane({
  title,
  caption,
  tone,
  children,
}: {
  title: string
  caption: string
  tone: string
  children: React.ReactNode
}) {
  return (
    <div className="bg-background/40 rounded-xl">
      <div className="flex items-center gap-2 px-5 pt-4 pb-2">
        <span
          className="size-2 rounded-full"
          style={{ background: tone, boxShadow: `0 0 8px ${tone}` }}
        />
        <h3 className="text-xs font-semibold tracking-[0.14em] uppercase">
          {title}
        </h3>
        <span className={cn('text-muted-foreground text-xs')}>{caption}</span>
      </div>
      <div className="scrollbar-slim max-h-[30rem] overflow-auto px-5 pt-1 pb-5">
        {children}
      </div>
    </div>
  )
}

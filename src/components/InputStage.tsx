import { useCallback, useRef, useState } from 'react'
import {
  ArrowRight,
  FileSpreadsheet,
  FileText,
  Loader2,
  Paperclip,
  Sparkles,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { cn } from '@/lib/utils'
import { ACCEPTED_EXTENSIONS, formatBytes, type ExtractedFile } from '@/files/extract'

interface InputStageProps {
  text: string
  onTextChange: (value: string) => void
  file: ExtractedFile | null
  onFile: (file: File) => void
  onClearFile: () => void
  onCheck: () => void
  onTryExample: () => void
  reading: number | null
  error: string | null
}

export function InputStage({
  text,
  onTextChange,
  file,
  onFile,
  onClearFile,
  onCheck,
  onTryExample,
  reading,
  error,
}: InputStageProps) {
  const [dragging, setDragging] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const dragDepth = useRef(0)

  const ready = text.trim().length > 0 && reading === null

  const handleDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault()
      dragDepth.current = 0
      setDragging(false)
      const dropped = event.dataTransfer.files?.[0]
      if (dropped) onFile(dropped)
    },
    [onFile],
  )

  return (
    <div className="animate-rise mx-auto flex w-full max-w-3xl flex-col items-center px-6">
      <h1 className="text-gradient text-center text-5xl font-semibold tracking-tight sm:text-6xl">
        Make your work safe for AI
      </h1>
      <p className="text-muted-foreground mt-5 max-w-xl text-center text-lg text-balance">
        Check anything for personal, internal or secret information before you
        paste it into ChatGPT, Copilot or Gemini.
      </p>

      <div
        onDragEnter={(e) => {
          e.preventDefault()
          dragDepth.current += 1
          setDragging(true)
        }}
        onDragOver={(e) => e.preventDefault()}
        onDragLeave={(e) => {
          e.preventDefault()
          dragDepth.current -= 1
          if (dragDepth.current <= 0) setDragging(false)
        }}
        onDrop={handleDrop}
        className={cn(
          'glass relative mt-10 w-full overflow-hidden rounded-2xl border transition-all duration-300',
          dragging
            ? 'border-primary shadow-[0_0_0_6px_color-mix(in_oklch,var(--primary)_14%,transparent)] scale-[1.01]'
            : 'border-border/80 shadow-2xl shadow-black/40',
        )}
      >
        <textarea
          value={text}
          onChange={(e) => onTextChange(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && ready) onCheck()
          }}
          spellCheck={false}
          placeholder="Paste your text here — or drop a file"
          className="scrollbar-slim placeholder:text-muted-foreground/70 h-[19rem] w-full resize-none bg-transparent p-6 text-[0.95rem] leading-relaxed outline-none"
        />

        <div className="border-border/60 flex items-center justify-between gap-4 border-t px-4 py-3">
          <div className="flex min-w-0 items-center gap-2">
            {file ? (
              <span className="bg-primary/12 text-primary ring-primary/25 flex min-w-0 items-center gap-2 rounded-full py-1.5 pr-1.5 pl-3 text-xs font-medium ring-1">
                {file.kind === 'xlsx' || file.kind === 'csv' ? (
                  <FileSpreadsheet className="size-3.5 shrink-0" />
                ) : (
                  <FileText className="size-3.5 shrink-0" />
                )}
                <span className="truncate">{file.name}</span>
                <span className="text-primary/60 shrink-0">
                  {formatBytes(file.size)} · {file.detail}
                </span>
                <button
                  onClick={onClearFile}
                  aria-label="Remove file"
                  className="hover:bg-primary/20 grid size-5 shrink-0 place-items-center rounded-full transition-colors"
                >
                  <X className="size-3" />
                </button>
              </span>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => inputRef.current?.click()}
                className="text-muted-foreground hover:text-foreground -ml-1 h-8 gap-2 rounded-full text-xs"
              >
                <Paperclip className="size-3.5" />
                Add a file
                <span className="text-muted-foreground/60 hidden sm:inline">
                  Word · Excel · CSV · PDF · text
                </span>
              </Button>
            )}
          </div>

          <span className="text-muted-foreground/70 shrink-0 text-xs tabular-nums">
            {text.length.toLocaleString()} characters
          </span>
        </div>

        {reading !== null && (
          <div className="bg-background/80 absolute inset-0 grid place-items-center backdrop-blur-sm">
            <div className="w-56 text-center">
              <Loader2 className="text-primary mx-auto size-5 animate-spin" />
              <p className="mt-3 text-sm font-medium">Reading your file…</p>
              <Progress value={reading * 100} className="mt-3 h-1" />
            </div>
          </div>
        )}

        {dragging && (
          <div className="bg-background/85 pointer-events-none absolute inset-0 grid place-items-center backdrop-blur-sm">
            <div className="text-center">
              <div className="border-primary/40 bg-primary/10 mx-auto grid size-16 place-items-center rounded-2xl border border-dashed">
                <Paperclip className="text-primary size-6" />
              </div>
              <p className="mt-4 text-base font-medium">Drop it here</p>
              <p className="text-muted-foreground mt-1 text-xs">
                It never leaves this device
              </p>
            </div>
          </div>
        )}
      </div>

      <input
        ref={inputRef}
        type="file"
        accept={ACCEPTED_EXTENSIONS.join(',')}
        className="hidden"
        onChange={(e) => {
          const picked = e.target.files?.[0]
          if (picked) onFile(picked)
          e.target.value = ''
        }}
      />

      {error && (
        <p className="text-destructive animate-fade mt-4 text-sm">{error}</p>
      )}

      <Button
        size="lg"
        onClick={onCheck}
        disabled={!ready}
        className="mt-8 h-14 min-w-56 gap-2 rounded-full text-base font-semibold shadow-[0_10px_40px_-10px_color-mix(in_oklch,var(--primary)_75%,transparent)] transition-transform hover:scale-[1.02] active:scale-[0.99]"
      >
        Check it
        <ArrowRight className="size-5" />
      </Button>

      <button
        onClick={onTryExample}
        className="text-muted-foreground hover:text-primary mt-5 flex items-center gap-1.5 text-sm transition-colors"
      >
        <Sparkles className="size-3.5" />
        Try an example
      </button>
    </div>
  )
}

import { useCallback, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Header, PrivacyFooter } from '@/components/AppChrome'
import { CleanStage } from '@/components/CleanStage'
import { InputStage } from '@/components/InputStage'
import { ReviewStage } from '@/components/ReviewStage'
import { ScanOverlay } from '@/components/ScanOverlay'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { DEMO_PROMPT } from '@/demo/samples'
import { scan } from '@/engine/detect'
import { improvePrompt } from '@/engine/improve'
import { computeRisk } from '@/engine/risk'
import { sanitize } from '@/engine/sanitize'
import type { Finding, SanitizeMode } from '@/engine/types'
import { buildCleanedFile, downloadBlob } from '@/files/exportFile'
import { extractFile, type ExtractedFile } from '@/files/extract'

type Stage = 'input' | 'scanning' | 'review' | 'clean'

export default function App() {
  const [stage, setStage] = useState<Stage>('input')
  const [text, setText] = useState('')
  const [file, setFile] = useState<ExtractedFile | null>(null)
  const [reading, setReading] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  const [scannedText, setScannedText] = useState('')
  const [findings, setFindings] = useState<Finding[]>([])
  const [mode, setMode] = useState<SanitizeMode>('redact')

  const [improveRequested, setImproveRequested] = useState(false)
  const [improving, setImproving] = useState(false)
  const [downloading, setDownloading] = useState(false)

  // --- derived state -----------------------------------------------------
  const risk = useMemo(() => computeRisk(findings), [findings])

  const sanitized = useMemo(
    () => sanitize(scannedText, findings, { mode }),
    [scannedText, findings, mode],
  )

  /**
   * The "after" score is a genuine re-scan of the cleaned text, not a
   * hard-coded zero. Stand-ins we inserted ourselves are excluded, since
   * flagging our own placeholder would be noise.
   */
  const riskAfter = useMemo(() => {
    const ours = new Set(sanitized.replacements.map((r) => r.replacement))
    const residual = scan(sanitized.text).findings.filter(
      (f) => !ours.has(f.value),
    )
    return computeRisk(residual)
  }, [sanitized])

  const improved = useMemo(
    () => (improveRequested ? improvePrompt(sanitized.text) : null),
    [improveRequested, sanitized.text],
  )

  // --- actions -----------------------------------------------------------
  const handleFile = useCallback(async (picked: File) => {
    setError(null)
    setReading(0)
    try {
      const extracted = await extractFile(picked, setReading)
      setFile(extracted)
      setText(extracted.text)
      if (!extracted.text.trim()) {
        setError('We could not find any readable text in that file.')
      }
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'That file could not be read on this device.',
      )
    } finally {
      setReading(null)
    }
  }, [])

  const handleCheck = useCallback(() => {
    const result = scan(text)
    setScannedText(text)
    setFindings(result.findings)
    setImproveRequested(false)
    setStage('scanning')
  }, [text])

  const handleToggleValue = useCallback((ids: string[], enabled: boolean) => {
    const set = new Set(ids)
    setFindings((current) =>
      current.map((f) => (set.has(f.id) ? { ...f, enabled } : f)),
    )
  }, [])

  const handleCopy = useCallback(async (value: string) => {
    try {
      await navigator.clipboard.writeText(value)
      toast.success('Copied. Safe to paste into any AI tool.')
    } catch {
      toast.error('Your browser blocked the clipboard. Select the text to copy it.')
    }
  }, [])

  const handleImprove = useCallback(() => {
    setImproving(true)
    // The rewrite is instant; this beat just keeps the transition legible.
    setTimeout(() => {
      setImproveRequested(true)
      setImproving(false)
    }, 320)
  }, [])

  const handleDownload = useCallback(async () => {
    if (!file) return
    setDownloading(true)
    try {
      const cleaned = await buildCleanedFile(
        file,
        sanitized.text,
        sanitized.valueMap,
      )
      downloadBlob(cleaned.blob, cleaned.filename)
      toast.success(`Saved ${cleaned.filename}`)
    } catch {
      toast.error('That file could not be rewritten. Copy the cleaned text instead.')
    } finally {
      setDownloading(false)
    }
  }, [file, sanitized])

  const handleReset = useCallback(() => {
    setStage('input')
    setText('')
    setFile(null)
    setFindings([])
    setScannedText('')
    setImproveRequested(false)
    setError(null)
  }, [])

  const handleExample = useCallback(() => {
    setFile(null)
    setError(null)
    setText(DEMO_PROMPT)
  }, [])

  // --- render ------------------------------------------------------------
  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex min-h-full flex-col">
        <Header />

        {/* my-auto rather than items-center: tall results must not clip. */}
        <main className="flex flex-1 justify-center py-10 [&>*]:my-auto">
          {stage === 'input' && (
            <InputStage
              text={text}
              onTextChange={setText}
              file={file}
              onFile={handleFile}
              onClearFile={() => {
                setFile(null)
                setText('')
              }}
              onCheck={handleCheck}
              onTryExample={handleExample}
              reading={reading}
              error={error}
            />
          )}

          {stage === 'scanning' && (
            <ScanOverlay onDone={() => setStage('review')} />
          )}

          {stage === 'review' && (
            <ReviewStage
              text={scannedText}
              findings={findings}
              risk={risk}
              mode={mode}
              sourceLabel={file?.name ?? null}
              onToggleValue={handleToggleValue}
              onClean={() => setStage('clean')}
              onCopyOriginal={() => handleCopy(scannedText)}
              onReset={handleReset}
            />
          )}

          {stage === 'clean' && (
            <CleanStage
              originalText={scannedText}
              findings={findings}
              sanitized={sanitized}
              improved={improved}
              improving={improving}
              riskBefore={risk}
              riskAfter={riskAfter}
              mode={mode}
              file={file}
              downloading={downloading}
              onModeChange={setMode}
              onImprove={handleImprove}
              onCopy={handleCopy}
              onDownload={handleDownload}
              onBack={() => setStage('review')}
              onReset={handleReset}
            />
          )}
        </main>

        <PrivacyFooter />
      </div>
      <Toaster position="bottom-center" />
    </TooltipProvider>
  )
}

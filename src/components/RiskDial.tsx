import { useCountUp } from '@/hooks/useCountUp'
import { cn } from '@/lib/utils'
import type { RiskLevel } from '@/engine/types'

const TONE: Record<RiskLevel, string> = {
  safe: 'var(--risk-safe)',
  low: 'var(--risk-medium)',
  moderate: 'var(--risk-high)',
  high: 'var(--risk-critical)',
}

interface RiskDialProps {
  score: number
  level: RiskLevel
  size?: number
  className?: string
}

/**
 * The one number the demo hangs on. Sweeps up on scan, sweeps down to near
 * zero after cleaning.
 */
export function RiskDial({
  score,
  level,
  size = 208,
  className,
}: RiskDialProps) {
  const shown = useCountUp(score)
  const stroke = size / 14
  const radius = (size - stroke) / 2
  const circumference = 2 * Math.PI * radius
  const tone = TONE[level]

  return (
    <div
      className={cn('relative grid place-items-center', className)}
      style={{ width: size, height: size }}
    >
      <div
        className="absolute inset-4 rounded-full blur-2xl transition-colors duration-700"
        style={{ background: tone, opacity: 0.22 }}
      />
      <svg width={size} height={size} className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="currentColor"
          className="text-white/8"
          strokeWidth={stroke}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={tone}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - Math.max(shown, 2) / 100)}
          style={{
            transition: 'stroke-dashoffset 0.9s cubic-bezier(0.22,1,0.36,1)',
            filter: `drop-shadow(0 0 10px ${tone})`,
          }}
        />
      </svg>

      <div className="absolute inset-0 grid place-items-center">
        <div className="text-center leading-none">
          <div
            className="font-semibold tabular-nums tracking-tight transition-colors duration-700"
            style={{ fontSize: size * 0.3, color: tone }}
          >
            {shown}
          </div>
          <div className="mt-2 text-[0.7rem] font-medium tracking-[0.18em] text-muted-foreground uppercase">
            risk score
          </div>
        </div>
      </div>
    </div>
  )
}

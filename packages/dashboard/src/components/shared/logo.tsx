import { cn } from '../../lib/utils'

interface LogoProps {
  className?: string
  size?: number
}

/**
 * Donmai logo placeholder — 🦊 emoji on amber square.
 * Matches the DonmaiMascotBlock pattern from the brand brief.
 * Swap to commissioned illustration when DON-018 lands.
 */
export function Logo({ className, size = 32 }: LogoProps) {
  return (
    <div
      className={cn('inline-flex items-center justify-center select-none', className)}
      style={{
        width: size,
        height: size,
        background: '#D97706',
        border: `${Math.max(2, Math.round(size / 16))}px solid #D94F2A`,
        borderRadius: Math.max(4, Math.round(size / 6)),
        fontSize: size * 0.55,
        lineHeight: 1,
      }}
      role="img"
      aria-label="Donmai"
    >
      🦊
    </div>
  )
}

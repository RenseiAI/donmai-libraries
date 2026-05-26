import { cn } from '../../lib/utils'

interface LogoProps {
  className?: string
  size?: number
}

/**
 * Donmai logo placeholder — amber rounded square with white "D".
 * Matches the DonmaiMascotBlock placeholder pattern from the brand brief.
 * Swap to the commissioned illustration when DON-018 lands.
 */
export function Logo({ className, size = 32 }: LogoProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={cn(className)}
      aria-label="Donmai"
    >
      <rect width="32" height="32" rx="7" fill="#D94F2A" />
      <path
        d="M10 8.5h6.2c4.1 0 6.8 3 6.8 7.5s-2.7 7.5-6.8 7.5H10V8.5zm6 11.5c2.2 0 3.6-1.6 3.6-4s-1.4-4-3.6-4h-2.6v8H16z"
        fill="#FFFFFF"
      />
    </svg>
  )
}

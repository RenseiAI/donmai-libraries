import type { Config } from 'tailwindcss'

const dashboardPreset: Config = {
  content: [],
  theme: {
    extend: {
      colors: {
        // Donmai palette mapped onto legacy af-* class names.
        // Class names kept as af-* to avoid a 200-touch consumer refactor;
        // hex values are the canonical Donmai brand tokens per
        // runs/2026-05-22-donmai-rebrand/11-NAMING-MAP.md §Color tokens.
        // v0.11+ may rename classes to donmai-* if/when worth the churn.

        // Surfaces (inherited Rensei dark palette per brand brief §2)
        'af-bg-primary': '#09090B',
        'af-bg-secondary': '#111113',
        'af-bg-tertiary': '#18181B',
        'af-surface': '#1F1F23',
        'af-surface-raised': '#27272A',
        'af-surface-border': '#27272A',
        'af-surface-border-bright': '#3F3F46',

        // Donmai accent palette
        'af-accent': '#D94F2A',      // --donmai-accent
        'af-accent-dim': '#A83820',  // --donmai-dim
        'af-teal': '#00D4AA',        // kept (not brand palette)
        'af-teal-dim': '#00A886',
        'af-blue': '#4B8BF5',

        // Status (Donmai brand brief semantics)
        'af-status-success': '#22C55E',
        'af-status-warning': '#F59E0B',
        'af-status-error': '#EF4444',

        // Text hierarchy (Donmai brand brief)
        'af-text-primary': '#FAFAFA',
        'af-text-secondary': '#A1A1AA',
        'af-text-tertiary': '#71717A',
        'af-code': '#A5B4FC',

        // shadcn tokens
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
      },
      fontFamily: {
        // Donmai brand: DM Sans across the stack. Consumer should load
        // DM Sans via next/font and expose --font-dm-sans on <html>.
        sans: ['var(--font-dm-sans)', 'DM Sans', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        body: ['var(--font-dm-sans)', 'DM Sans', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        display: ['var(--font-dm-sans)', 'DM Sans', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['Fira Code', 'JetBrains Mono', 'ui-monospace', 'monospace'],
      },
      fontSize: {
        '2xs': ['0.625rem', { lineHeight: '0.875rem' }],
        xs: ['0.6875rem', { lineHeight: '1rem' }],
        sm: ['0.8125rem', { lineHeight: '1.25rem' }],
        base: ['0.875rem', { lineHeight: '1.5rem' }],
        lg: ['1rem', { lineHeight: '1.5rem' }],
        xl: ['1.25rem', { lineHeight: '1.75rem' }],
        '2xl': ['1.75rem', { lineHeight: '2rem' }],
        '3xl': ['2.25rem', { lineHeight: '2.5rem' }],
        '4xl': ['3rem', { lineHeight: '3.25rem' }],
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
      keyframes: {
        'pulse-dot': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.35' },
        },
        heartbeat: {
          '0%': { transform: 'scale(1)', opacity: '0.5' },
          '50%': { transform: 'scale(2.2)', opacity: '0' },
          '100%': { transform: 'scale(1)', opacity: '0' },
        },
        'fade-in': {
          '0%': { opacity: '0', transform: 'translateY(8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'fade-in-scale': {
          '0%': { opacity: '0', transform: 'scale(0.95)' },
          '100%': { opacity: '1', transform: 'scale(1)' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
        'glow-breathe': {
          '0%, 100%': { opacity: '0.6' },
          '50%': { opacity: '1' },
        },
        'slide-in-left': {
          '0%': { opacity: '0', transform: 'translateX(-12px)' },
          '100%': { opacity: '1', transform: 'translateX(0)' },
        },
      },
      animation: {
        'pulse-dot': 'pulse-dot 2s ease-in-out infinite',
        heartbeat: 'heartbeat 2s ease-out infinite',
        'fade-in': 'fade-in 0.4s ease-out both',
        'fade-in-scale': 'fade-in-scale 0.3s ease-out both',
        shimmer: 'shimmer 2s linear infinite',
        'glow-breathe': 'glow-breathe 3s ease-in-out infinite',
        'slide-in-left': 'slide-in-left 0.3s ease-out both',
      },
    },
  },
  plugins: [],
}

export default dashboardPreset

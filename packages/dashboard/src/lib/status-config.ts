export type SessionStatus = 'queued' | 'parked' | 'working' | 'completed' | 'failed' | 'stopped'

export interface StatusConfig {
  label: string
  dotColor: string
  textColor: string
  bgColor: string
  borderColor: string
  glowClass: string
  animate: boolean
}

const statuses: Record<SessionStatus, StatusConfig> = {
  working: {
    label: 'Working',
    dotColor: 'bg-donmai-status-success',
    textColor: 'text-donmai-status-success',
    bgColor: 'bg-donmai-status-success/10',
    borderColor: 'border-donmai-status-success/20',
    glowClass: 'glow-dot-green',
    animate: true,
  },
  queued: {
    label: 'Queued',
    dotColor: 'bg-donmai-status-warning',
    textColor: 'text-donmai-status-warning',
    bgColor: 'bg-donmai-status-warning/10',
    borderColor: 'border-donmai-status-warning/20',
    glowClass: 'glow-dot-yellow',
    animate: true,
  },
  parked: {
    label: 'Parked',
    dotColor: 'bg-donmai-text-tertiary',
    textColor: 'text-donmai-text-secondary',
    bgColor: 'bg-donmai-text-secondary/8',
    borderColor: 'border-donmai-text-secondary/10',
    glowClass: '',
    animate: false,
  },
  completed: {
    label: 'Completed',
    dotColor: 'bg-donmai-status-success',
    textColor: 'text-donmai-status-success',
    bgColor: 'bg-donmai-status-success/10',
    borderColor: 'border-donmai-status-success/15',
    glowClass: '',
    animate: false,
  },
  failed: {
    label: 'Failed',
    dotColor: 'bg-donmai-status-error',
    textColor: 'text-donmai-status-error',
    bgColor: 'bg-donmai-status-error/10',
    borderColor: 'border-donmai-status-error/20',
    glowClass: 'glow-dot-red',
    animate: false,
  },
  stopped: {
    label: 'Stopped',
    dotColor: 'bg-donmai-text-tertiary',
    textColor: 'text-donmai-text-secondary',
    bgColor: 'bg-donmai-text-secondary/8',
    borderColor: 'border-donmai-text-secondary/10',
    glowClass: '',
    animate: false,
  },
}

export function getStatusConfig(status: SessionStatus): StatusConfig {
  return statuses[status] ?? statuses.queued
}

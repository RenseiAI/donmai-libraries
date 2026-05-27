export interface WorkTypeConfig {
  label: string
  color: string
  bgColor: string
  borderColor: string
}

const workTypes: Record<string, WorkTypeConfig> = {
  development: {
    label: 'Development',
    color: 'text-blue-400',
    bgColor: 'bg-blue-400/10',
    borderColor: 'border-blue-400/15',
  },
  bugfix: {
    label: 'Bug Fix',
    color: 'text-red-400',
    bgColor: 'bg-red-400/10',
    borderColor: 'border-red-400/15',
  },
  feature: {
    label: 'Feature',
    color: 'text-emerald-400',
    bgColor: 'bg-emerald-400/10',
    borderColor: 'border-emerald-400/15',
  },
  qa: {
    label: 'QA',
    color: 'text-purple-400',
    bgColor: 'bg-purple-400/10',
    borderColor: 'border-purple-400/15',
  },
  'qa-coordination': {
    label: 'QA Coord',
    color: 'text-purple-300',
    bgColor: 'bg-purple-300/10',
    borderColor: 'border-purple-300/15',
  },
  acceptance: {
    label: 'Acceptance',
    color: 'text-pink-400',
    bgColor: 'bg-pink-400/10',
    borderColor: 'border-pink-400/15',
  },
  'acceptance-coordination': {
    label: 'Accept Coord',
    color: 'text-pink-300',
    bgColor: 'bg-pink-300/10',
    borderColor: 'border-pink-300/15',
  },
  coordination: {
    label: 'Coordination',
    color: 'text-orange-400',
    bgColor: 'bg-orange-400/10',
    borderColor: 'border-orange-400/15',
  },
  research: {
    label: 'Research',
    color: 'text-teal-400',
    bgColor: 'bg-teal-400/10',
    borderColor: 'border-teal-400/15',
  },
  'backlog-creation': {
    label: 'Backlog',
    color: 'text-slate-400',
    bgColor: 'bg-slate-400/10',
    borderColor: 'border-slate-400/15',
  },
  inflight: {
    label: 'Inflight',
    color: 'text-yellow-400',
    bgColor: 'bg-yellow-400/10',
    borderColor: 'border-yellow-400/15',
  },
  'inflight-coordination': {
    label: 'Inflight Coord',
    color: 'text-yellow-300',
    bgColor: 'bg-yellow-300/10',
    borderColor: 'border-yellow-300/15',
  },
  refinement: {
    label: 'Refinement',
    color: 'text-lime-400',
    bgColor: 'bg-lime-400/10',
    borderColor: 'border-lime-400/15',
  },
  'refinement-coordination': {
    label: 'Refine Coord',
    color: 'text-lime-300',
    bgColor: 'bg-lime-300/10',
    borderColor: 'border-lime-300/15',
  },
  refactor: {
    label: 'Refactor',
    color: 'text-amber-400',
    bgColor: 'bg-amber-400/10',
    borderColor: 'border-amber-400/15',
  },
  review: {
    label: 'Review',
    color: 'text-cyan-400',
    bgColor: 'bg-cyan-400/10',
    borderColor: 'border-cyan-400/15',
  },
  docs: {
    label: 'Docs',
    color: 'text-indigo-400',
    bgColor: 'bg-indigo-400/10',
    borderColor: 'border-indigo-400/15',
  },
}

const defaultWorkType: WorkTypeConfig = {
  label: 'Unknown',
  color: 'text-donmai-text-secondary',
  bgColor: 'bg-donmai-text-secondary/8',
  borderColor: 'border-donmai-text-secondary/10',
}

export function getWorkTypeConfig(workType: string): WorkTypeConfig {
  return workTypes[workType.toLowerCase()] ?? defaultWorkType
}

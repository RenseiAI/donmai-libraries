/**
 * Linear SDK Object Serializer
 *
 * The @linear/sdk returns objects with lazy-loaded relations (e.g., issue.state
 * is a Promise). The proxy must resolve these server-side and return plain JSON.
 *
 * Uses duck-typing rather than direct @linear/sdk imports since the nextjs
 * package doesn't depend on @linear/sdk directly.
 */

import type {
  SerializedIssue,
  SerializedComment,
  SerializedViewer,
  SerializedTeam,
} from '@donmai/plugin-linear'

/**
 * Duck-typed Linear Issue interface (matches @linear/sdk Issue shape).
 */
interface LinearIssue {
  id: string
  identifier: string
  title: string
  description?: string | null
  url: string
  priority: number
  createdAt: Date
  updatedAt: Date
  state: PromiseLike<{ id: string; name: string; type: string } | null | undefined>
  labels: () => PromiseLike<{ nodes: Array<{ id: string; name: string }> }>
  assignee: PromiseLike<{ id: string; name: string; email?: string } | null | undefined>
  team: PromiseLike<{ id: string; name: string; key: string } | null | undefined>
  parent: PromiseLike<{ id: string; identifier: string } | null | undefined>
  project?: PromiseLike<{ id: string; name: string } | null | undefined>
}

/**
 * Duck-typed Linear Comment interface.
 */
interface LinearComment {
  id: string
  body: string
  createdAt: Date
  updatedAt: Date
  user: PromiseLike<{ id: string; name: string } | null | undefined>
}

/**
 * Safe promise resolve — catches errors and returns fallback.
 */
async function safeResolve<T>(p: PromiseLike<T> | undefined | null, fallback: T): Promise<T> {
  if (!p) return fallback
  try {
    return await p
  } catch {
    return fallback
  }
}

/**
 * Serialize a Linear Issue object to plain JSON.
 * Resolves state, labels, assignee, team, parent, and project relations.
 */
export async function serializeIssue(issue: unknown): Promise<SerializedIssue> {
  const i = issue as LinearIssue

  const [state, labels, assignee, team, parent, project] = await Promise.all([
    safeResolve(i.state, null),
    safeResolve(
      i.labels?.().then((r) => r.nodes),
      [] as Array<{ id: string; name: string }>
    ),
    safeResolve(i.assignee, null),
    safeResolve(i.team, null),
    safeResolve(i.parent, null),
    safeResolve(i.project, null),
  ])

  return {
    id: i.id,
    identifier: i.identifier,
    title: i.title,
    description: i.description ?? undefined,
    url: i.url,
    priority: i.priority,
    state: state
      ? { id: state.id, name: state.name, type: state.type }
      : undefined,
    labels: (labels ?? []).map((l: { id: string; name: string }) => ({ id: l.id, name: l.name })),
    assignee: assignee
      ? { id: assignee.id, name: assignee.name, email: assignee.email ?? undefined }
      : null,
    team: team ? { id: team.id, name: team.name, key: team.key } : undefined,
    parent: parent
      ? { id: parent.id, identifier: parent.identifier }
      : null,
    project: project ? { id: project.id, name: project.name } : null,
    createdAt: i.createdAt.toISOString(),
    updatedAt: i.updatedAt.toISOString(),
  }
}

/**
 * Serialize a Linear Comment object to plain JSON.
 */
export async function serializeComment(comment: unknown): Promise<SerializedComment> {
  const c = comment as LinearComment
  const user = await safeResolve(c.user, null)

  return {
    id: c.id,
    body: c.body,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
    user: user ? { id: user.id, name: user.name } : null,
  }
}

/**
 * Serialize a Linear viewer to plain JSON.
 */
export function serializeViewer(viewer: unknown): SerializedViewer {
  const v = viewer as { id: string; name: string; email: string }
  return {
    id: v.id,
    name: v.name,
    email: v.email,
  }
}

/**
 * Serialize a Linear team to plain JSON.
 */
export function serializeTeam(team: unknown): SerializedTeam {
  const t = team as { id: string; name: string; key: string }
  return {
    id: t.id,
    name: t.name,
    key: t.key,
  }
}

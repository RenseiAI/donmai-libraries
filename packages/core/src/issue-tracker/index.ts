/**
 * IssueTracker family — canonical contract + stub adapters.
 *
 * Per 002-provider-base-contract.md, Linear is one of N IssueTrackerProvider
 * implementations. This module exports the typed contract and the three
 * stub adapters (Jira, Asana, Notion).
 *
 * LinearIssueTrackerProvider lives in packages/linear; import from
 * @donmai/plugin-linear.
 */

export type {
  IssueTrackerCapabilities,
  IssueTrackerIdentityScheme,
  IssueTrackerWebhookProtocol,
  IssueTrackerProvider,
  TrackerIssue,
  TrackerComment,
  IssueTrackerCreateInput,
  IssueTrackerUpdateInput,
  ListIssuesFilter,
  IssueRelationType,
  AddRelationInput,
  AddRelationResult,
} from './types.js'

export { JiraIssueTrackerProvider } from './jira.stub.js'
export { AsanaIssueTrackerProvider } from './asana.stub.js'
export { NotionIssueTrackerProvider } from './notion.stub.js'

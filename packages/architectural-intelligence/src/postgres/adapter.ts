/**
 * PostgresDbAdapter — minimal duck-typed handle the SDK consumes.
 *
 * The arch-intel SDK does NOT own its Postgres connection. The consumer
 * injects an adapter that wraps their existing handle (a `postgres.Sql`
 * tagged-template callable, a drizzle `PostgresJsDatabase`, or a thin
 * shim around either). This keeps the SDK orthogonal to:
 *   - connection lifecycle (pool / migrate / shutdown)
 *   - schema source-of-truth (consumer owns drizzle schema)
 *   - multi-tenant policy (RLS / app-level filters happen at the consumer)
 *
 * Why an interface instead of a hard postgres-js dep?
 *   1. SDK tests can stub the adapter against an in-memory store without
 *      a real Postgres container — fast, hermetic CI.
 *   2. The consumer is free to wrap drizzle, postgres-js, pglite, or a
 *      bespoke RLS-aware client. The SDK doesn't care, so long as the
 *      adapter satisfies the contract.
 *
 * Contract:
 *   - `query(text, params)` runs a parameterized SQL statement and returns
 *     rows as plain objects (columns mapped to camelCase keys per the
 *     query author's discretion — see queries.ts).
 *   - `json(value)` boxes a JS value into the consumer's "jsonb param" type.
 *     Wrapping is required because we MUST NOT serialize with
 *     `JSON.stringify(...)::jsonb` — that yields a scalar string instead
 *     of a jsonb object. See platform memory
 *     `feedback_postgresjs_jsonb_string_double_encode.md`. With postgres-js
 *     the canonical wrapper is `sql.json(value)`; consumers wiring drizzle
 *     should expose the equivalent helper here.
 */

/**
 * A row returned from `PostgresDbAdapter.query`. Each property is mapped
 * to a column from the source SQL statement. The SDK reads columns via
 * known names (see `queries.ts` / `contribute.ts`); unknown columns are
 * ignored.
 */
export type DbRow = Record<string, unknown>

/**
 * A jsonb-boxed value. Opaque to the SDK — the adapter promises that when
 * one of these is passed as a parameter, the underlying driver writes it
 * as a jsonb value (object/array), not a scalar string.
 *
 * The structural shape is intentionally minimal — a brand on a plain
 * object so TypeScript can distinguish "raw value" from "jsonb-boxed".
 */
export interface JsonbParam {
  readonly __jsonbParam: true
  readonly value: unknown
}

/**
 * Run a callback with a transaction-scoped adapter. The scoped adapter's
 * `query()` MUST execute inside the open transaction so that any
 * `SET LOCAL` GUCs applied at the top of the transaction are honored.
 *
 * The callback's return value resolves the outer promise. If the callback
 * throws, the adapter MUST roll back the transaction and re-throw.
 *
 * The SDK uses transactions to apply `SET LOCAL rensei.current_org_id = $1`
 * for multi-tenant RLS — see the RLS DDL exemplar at the bottom of this
 * file for the corresponding policies a consumer applies to their tables.
 */
export type TransactionRunner = <T>(
  fn: (tx: PostgresDbAdapter) => Promise<T>,
) => Promise<T>

/**
 * The minimal adapter surface. Consumers wrap their handle to satisfy this.
 *
 * Example (postgres-js):
 *   ```ts
 *   import postgres from 'postgres'
 *   const sql = postgres(process.env.DATABASE_URL!)
 *   const adapter = adapterFromPostgresJs(sql)
 *   ```
 *
 * Example (drizzle postgres-js):
 *   ```ts
 *   import { drizzle } from 'drizzle-orm/postgres-js'
 *   import postgres from 'postgres'
 *   const sql = postgres(url)
 *   const db = drizzle(sql)
 *   const adapter: PostgresDbAdapter = {
 *     query: (text, params) => db.execute(sql.unsafe(text, params)) as Promise<DbRow[]>,
 *     json: (value) => sql.json(value) as unknown as JsonbParam,
 *     transaction: async (fn) =>
 *       sql.begin(async (tx) =>
 *         fn({
 *           query: (t, p) =>
 *             tx.unsafe(
 *               t,
 *               p.map((v) => (isJsonbParam(v) ? tx.json(v.value) : v)),
 *             ) as Promise<DbRow[]>,
 *           json: (value) => ({ __jsonbParam: true, value }),
 *         }),
 *       ),
 *   }
 *   ```
 */
export interface PostgresDbAdapter {
  /**
   * Run a parameterized SQL statement and return its rows.
   * Parameters are positional ($1, $2, ...). The adapter handles binding.
   *
   * NOTE on jsonb writes: callers pass `JsonbParam` objects (built via
   * `adapter.json(...)`) for jsonb columns. The adapter MUST unbox these
   * and feed them to the driver in a way that preserves the jsonb shape
   * (NOT JSON.stringify + ::jsonb cast).
   */
  query<TRow extends DbRow = DbRow>(
    text: string,
    params: ReadonlyArray<unknown>,
  ): Promise<TRow[]>

  /**
   * Box a JS value as a jsonb parameter.
   *
   * Implementation MUST round-trip the value as a jsonb object — i.e.
   * `SELECT $1::jsonb -> 'foo'` on an object `{foo: 1}` must return `1`,
   * not raise a "cannot extract from string" error.
   */
  json(value: unknown): JsonbParam

  /**
   * Optional transaction runner. When present, the SDK wraps every read
   * and write in a transaction and applies `SET LOCAL rensei.current_org_id`
   * so consumer-defined RLS policies enforce tenant isolation at the
   * database level (defence-in-depth alongside the app-level WHERE
   * clauses).
   *
   * When `transaction` is undefined, the SDK falls back to plain `query()`
   * with app-level scoping only. This is supported for development /
   * single-tenant deployments — production consumers SHOULD provide a
   * `transaction` runner and apply the RLS DDL exemplar below.
   */
  transaction?: TransactionRunner
}

/**
 * Helper used internally to detect a `JsonbParam` so adapters can unbox.
 * Exported for adapter implementers; SDK call-sites don't use it.
 */
export function isJsonbParam(value: unknown): value is JsonbParam {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { __jsonbParam?: unknown }).__jsonbParam === true
  )
}

/**
 * Reference adapter factory for postgres-js consumers.
 *
 * Accepts a postgres-js `Sql` callable and produces a `PostgresDbAdapter`.
 * Kept here (vs. in the consumer) only as a documentation aid — the SDK
 * does NOT depend on postgres-js, so this helper type-checks against a
 * structural shape and the consumer passes their real handle in.
 *
 * Signature is intentionally permissive (`unknown` casts) — the SDK does
 * not import postgres-js types.
 */
export interface PostgresJsSqlShape {
  unsafe(text: string, params: unknown[]): Promise<unknown[]>
  json(value: unknown): unknown
  /**
   * postgres-js `sql.begin(fn)` — opens a transaction, passes a callable
   * that quacks like the outer `sql`, and commits when `fn` resolves.
   */
  begin<T>(fn: (tx: PostgresJsSqlShape) => Promise<T>): Promise<T>
}

export function adapterFromPostgresJs(sql: PostgresJsSqlShape): PostgresDbAdapter {
  function wrap(handle: PostgresJsSqlShape): PostgresDbAdapter {
    return {
      async query<TRow extends DbRow = DbRow>(
        text: string,
        params: ReadonlyArray<unknown>,
      ): Promise<TRow[]> {
        const unboxed = params.map((p) =>
          isJsonbParam(p) ? (handle.json(p.value) as unknown) : p,
        )
        const rows = await handle.unsafe(text, unboxed)
        return rows as TRow[]
      },
      json(value: unknown): JsonbParam {
        return { __jsonbParam: true, value }
      },
      transaction: <T>(fn: (tx: PostgresDbAdapter) => Promise<T>): Promise<T> => {
        return handle.begin(async (tx) => fn(wrap(tx)))
      },
    }
  }
  return wrap(sql)
}

// ---------------------------------------------------------------------------
// RLS — multi-tenant row-level security
// ---------------------------------------------------------------------------

/**
 * Name of the Postgres GUC the SDK sets with `SET LOCAL` before every
 * read/write transaction. Exported so consumers can reference it in
 * their RLS policy DDL without typo risk.
 */
export const RLS_ORG_ID_SETTING = 'rensei.current_org_id'

/**
 * RLS DDL exemplar — apply this in a drizzle migration (or equivalent) on
 * the consumer side to enforce database-level tenant isolation on the
 * `observations` and `graph_nodes` tables the SDK reads/writes.
 *
 * The SDK calls `SET LOCAL rensei.current_org_id = '<orgId>'` at the top
 * of every transaction; the policies below use
 * `current_setting('rensei.current_org_id', true)::uuid` so that:
 *   - when the setting is present, only matching rows are visible
 *   - when the setting is absent (`true` = missing_ok), `current_setting`
 *     returns NULL and the comparison fails closed (zero rows)
 *
 * NOTE: This is illustrative DDL. Consumers should ship it through their
 * own migration tool (drizzle, dbmate, sqitch, etc.) — the SDK does NOT
 * run DDL on its own. If you need to bypass RLS for an admin migration,
 * use a Postgres role configured with `BYPASSRLS` and document the
 * carve-out in your runbook.
 */
export const RLS_DDL_EXAMPLE = `-- Multi-tenant RLS for @donmai/architectural-intelligence
--
-- Run once per database. Idempotent: re-running is safe.
--
-- Requires the application role to NOT have BYPASSRLS. Superusers and
-- BYPASSRLS roles ignore policies — use a least-privilege app role.

ALTER TABLE observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE graph_nodes  ENABLE ROW LEVEL SECURITY;

-- Force RLS even for the table owner, so a misconfigured connection
-- string can't accidentally bypass tenant isolation.
ALTER TABLE observations FORCE ROW LEVEL SECURITY;
ALTER TABLE graph_nodes  FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS arch_intel_observations_tenant_isolation ON observations;
CREATE POLICY arch_intel_observations_tenant_isolation ON observations
  USING (org_id = current_setting('rensei.current_org_id', true)::uuid)
  WITH CHECK (org_id = current_setting('rensei.current_org_id', true)::uuid);

DROP POLICY IF EXISTS arch_intel_graph_nodes_tenant_isolation ON graph_nodes;
CREATE POLICY arch_intel_graph_nodes_tenant_isolation ON graph_nodes
  USING (org_id = current_setting('rensei.current_org_id', true)::uuid)
  WITH CHECK (org_id = current_setting('rensei.current_org_id', true)::uuid);
`

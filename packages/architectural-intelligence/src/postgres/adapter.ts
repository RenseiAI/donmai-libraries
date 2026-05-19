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
 * The minimal adapter surface. Consumers wrap their handle to satisfy this.
 *
 * Example (postgres-js):
 *   ```ts
 *   import postgres from 'postgres'
 *   const sql = postgres(process.env.DATABASE_URL!)
 *   const adapter: PostgresDbAdapter = {
 *     query: (text, params) => sql.unsafe(text, params as unknown[]),
 *     json: (value) => sql.json(value) as unknown as JsonbParam,
 *   }
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
}

export function adapterFromPostgresJs(sql: PostgresJsSqlShape): PostgresDbAdapter {
  return {
    async query<TRow extends DbRow = DbRow>(
      text: string,
      params: ReadonlyArray<unknown>,
    ): Promise<TRow[]> {
      const unboxed = params.map((p) =>
        isJsonbParam(p) ? (sql.json(p.value) as unknown) : p,
      )
      const rows = await sql.unsafe(text, unboxed)
      return rows as TRow[]
    },
    json(value: unknown): JsonbParam {
      return { __jsonbParam: true, value }
    },
  }
}

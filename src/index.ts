import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Pool, PoolConfig } from "pg";
import { validateQuery, SqlGuardError } from "./guard.js";

// ---------------------------------------------------------------------------
// Connection config from environment variables
// ---------------------------------------------------------------------------

function getConfig(): PoolConfig {
  const host = process.env.PG_HOST;
  const database = process.env.PG_DATABASE;
  const user = process.env.PG_USER;
  const password = process.env.PG_PASSWORD;
  const port = process.env.PG_PORT ? parseInt(process.env.PG_PORT, 10) : 5432;
  const ssl = process.env.PG_SSL === "true" ? { rejectUnauthorized: process.env.PG_SSL_REJECT_UNAUTHORIZED !== "false" } : false;

  if (!host || !database || !user || !password) {
    throw new Error(
      "Missing required environment variables: PG_HOST, PG_DATABASE, PG_USER, PG_PASSWORD"
    );
  }

  return {
    host,
    database,
    user,
    password,
    port,
    ssl,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 15000,
    statement_timeout: 10000,
  };
}

// ---------------------------------------------------------------------------
// Lazy connection pool
// ---------------------------------------------------------------------------

let pool: Pool | null = null;

function getPool(): Pool {
  if (!pool) {
    pool = new Pool(getConfig());
    pool.on("error", (err) =>
      process.stderr.write(`Pool error: ${err}\n`)
    );
  }
  return pool;
}

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "mcp-postgres",
  version: "1.0.0",
});

// ---- Tool: query ------------------------------------------------------------

server.registerTool(
  "query",
  {
    description:
      "Execute a read-only SELECT query against PostgreSQL. " +
      "Only SELECT (and CTEs starting with WITH) are permitted. " +
      "Write operations, system functions, DoS constructs, and multiple " +
      "statements are all blocked.",
    inputSchema: { sql: z.string().describe("The SELECT query to execute") },
  },
  async ({ sql: userSql }) => {
    try {
      validateQuery(userSql);
    } catch (err) {
      if (err instanceof SqlGuardError) {
        return {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          isError: true,
        };
      }
      throw err;
    }

    const client = await getPool().connect();
    try {
      await client.query("START TRANSACTION READ ONLY");
      let result;
      try {
        result = await client.query(userSql);
        await client.query("COMMIT");
      } catch (queryErr) {
        await client.query("ROLLBACK");
        throw queryErr;
      }

      if (!result.rows || result.rows.length === 0) {
        return {
          content: [{ type: "text", text: "Query returned no rows." }],
        };
      }

      const text = JSON.stringify(result.rows, null, 2);
      return { content: [{ type: "text", text }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `PostgreSQL error: ${message}` }],
        isError: true,
      };
    } finally {
      client.release();
    }
  }
);

// ---- Tool: list_tables ------------------------------------------------------

server.registerTool(
  "list_tables",
  {
    description:
      "List all user tables in the connected PostgreSQL database, " +
      "including schema name, table name, row count estimate, and size.",
    inputSchema: {},
  },
  async () => {
    const listSql = `
      SELECT
        n.nspname                                    AS schema_name,
        c.relname                                    AS table_name,
        c.reltuples::BIGINT                          AS row_count_estimate,
        pg_size_pretty(pg_total_relation_size(c.oid)) AS total_size
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'r'
        AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
        AND n.nspname NOT LIKE 'pg_temp_%'
        AND n.nspname NOT LIKE 'pg_toast_temp_%'
      ORDER BY n.nspname, c.relname
    `;

    const client = await getPool().connect();
    try {
      const result = await client.query(listSql);
      if (!result.rows || result.rows.length === 0) {
        return { content: [{ type: "text", text: "No user tables found." }] };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(result.rows, null, 2) }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `PostgreSQL error: ${message}` }],
        isError: true,
      };
    } finally {
      client.release();
    }
  }
);

// ---- Tool: describe_table ---------------------------------------------------

server.registerTool(
  "describe_table",
  {
    description:
      "Describe the columns of a PostgreSQL table: name, data type, nullability, " +
      "default value, and whether it is part of the primary key.",
    inputSchema: {
      schema: z.string().default("public").describe("Schema name (default: public)"),
      table: z.string().describe("Table name"),
    },
  },
  async ({ schema, table }) => {
    // Sanitise identifiers — only allow safe chars
    const identRe = /^[A-Za-z_][A-Za-z0-9_$]*$/;
    if (!identRe.test(schema)) {
      return {
        content: [{ type: "text", text: "Error: invalid schema name" }],
        isError: true,
      };
    }
    if (!identRe.test(table)) {
      return {
        content: [{ type: "text", text: "Error: invalid table name" }],
        isError: true,
      };
    }

    const describeSql = `
      SELECT
        c.column_name,
        c.data_type,
        c.character_maximum_length,
        c.numeric_precision,
        c.numeric_scale,
        c.is_nullable,
        c.column_default,
        CASE WHEN kcu.column_name IS NOT NULL THEN 'YES' ELSE 'NO' END AS is_primary_key
      FROM information_schema.columns c
      LEFT JOIN information_schema.table_constraints tc
        ON  tc.table_schema = c.table_schema
        AND tc.table_name   = c.table_name
        AND tc.constraint_type = 'PRIMARY KEY'
      LEFT JOIN information_schema.key_column_usage kcu
        ON  kcu.constraint_name = tc.constraint_name
        AND kcu.table_schema    = c.table_schema
        AND kcu.table_name      = c.table_name
        AND kcu.column_name     = c.column_name
      WHERE c.table_schema = $1
        AND c.table_name   = $2
      ORDER BY c.ordinal_position
    `;

    const client = await getPool().connect();
    try {
      const result = await client.query(describeSql, [schema, table]);
      if (!result.rows || result.rows.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `Table "${schema}"."${table}" not found or has no columns.`,
            },
          ],
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(result.rows, null, 2) }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `PostgreSQL error: ${message}` }],
        isError: true,
      };
    } finally {
      client.release();
    }
  }
);

// ---- Tool: list_schemas -----------------------------------------------------

server.registerTool(
  "list_schemas",
  {
    description: "List all user-defined schemas in the connected PostgreSQL database.",
    inputSchema: {},
  },
  async () => {
    const schemaSql = `
      SELECT schema_name
      FROM information_schema.schemata
      WHERE schema_name NOT IN ('pg_catalog', 'information_schema')
        AND schema_name NOT LIKE 'pg_toast%'
        AND schema_name NOT LIKE 'pg_temp_%'
      ORDER BY schema_name
    `;

    const client = await getPool().connect();
    try {
      const result = await client.query(schemaSql);
      return {
        content: [{ type: "text", text: JSON.stringify(result.rows, null, 2) }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `PostgreSQL error: ${message}` }],
        isError: true,
      };
    } finally {
      client.release();
    }
  }
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function shutdown(signal: string) {
  process.stderr.write(`mcp-postgres shutting down (${signal})\n`);
  if (pool) {
    await pool.end().catch((err) =>
      process.stderr.write(`Pool shutdown error: ${err}\n`)
    );
  }
  process.exit(0);
}

process.on("SIGTERM", () => { void shutdown("SIGTERM"); });
process.on("SIGINT",  () => { void shutdown("SIGINT"); });

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("mcp-postgres running on stdio\n");
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err}\n`);
  process.exit(1);
});

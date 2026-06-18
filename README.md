# mcp-postgres

Read-only PostgreSQL MCP server for Claude Desktop (and any MCP-compatible client).

## Tools exposed

| Tool | Description |
|------|-------------|
| `query` | Run a SELECT query |
| `list_tables` | List all user tables with row-count estimate and size |
| `describe_table` | Show columns, types, nullability, PK for a table |
| `list_schemas` | List user-defined schemas |

## Security protections

| Attack | Example | Status |
|--------|---------|--------|
| Direct writes | `DROP`, `DELETE`, `UPDATE`, `INSERT`, `COPY` | ✅ Blocked |
| Multiple statements | `SELECT 1; DROP TABLE t` | ✅ Blocked |
| System functions | `pg_read_file`, `pg_sleep`, `dblink` | ✅ Blocked |
| DoS | `pg_sleep(10)`, `GENERATE_SERIES(1,99999999)` | ✅ Blocked |
| Dollar-quoted bypass | `$$DROP TABLE t$$` | ✅ Blocked |
| Whitespace bypass | tabs and newlines between keywords | ✅ Blocked |
| Comment bypass | `/* */` and `--` before keywords | ✅ Blocked |
| Session write mode | Enforced via `READ ONLY` transaction | ✅ Enforced |
| Valid queries | `SELECT`, `SELECT ... LIMIT`, `COUNT`, `WHERE` | ✅ Allowed |

## Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PG_HOST` | ✅ | — | Server hostname or IP |
| `PG_DATABASE` | ✅ | — | Database name |
| `PG_USER` | ✅ | — | PostgreSQL username |
| `PG_PASSWORD` | ✅ | — | PostgreSQL password |
| `PG_PORT` | | `5432` | TCP port |
| `PG_SSL` | | `false` | Enable SSL (`true`/`false`) |
| `PG_SSL_REJECT_UNAUTHORIZED` | | `true` | Reject self-signed certs |

## Build

```bash
npm install
npm run build
```

## Claude Desktop configuration

Add to `%APPDATA%\Claude\claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "postgres": {
      "command": "node",
      "args": ["C:/Projetos/mcp-postgres-readonly/dist/index.js"],
      "env": {
        "PG_HOST": "localhost",
        "PG_DATABASE": "mydb",
        "PG_USER": "postgres",
        "PG_PASSWORD": "yourpassword"
      }
    }
  }
}
```

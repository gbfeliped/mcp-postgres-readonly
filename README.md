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

### PostgreSQL connection

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PG_HOST` | ✅ | — | Server hostname or IP |
| `PG_DATABASE` | ✅ | — | Database name |
| `PG_USER` | ✅ | — | PostgreSQL username |
| `PG_PASSWORD` | ✅ | — | PostgreSQL password |
| `PG_PORT` | | `5432` | TCP port |
| `PG_SSL` | | `false` | Enable SSL (`true`/`false`) |
| `PG_SSL_REJECT_UNAUTHORIZED` | | `true` | Reject self-signed certs |

### SSH tunnel (optional)

Set `PG_SSH_HOST` to activate the tunnel. Authentication requires either a private key file or a password.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PG_SSH_HOST` | — | — | SSH server hostname (activates tunnel when set) |
| `PG_SSH_PORT` | | `22` | SSH server port |
| `PG_SSH_USER` | ✅ (if tunnel) | — | SSH username |
| `PG_SSH_PRIVATE_KEY` | ✅ or password | — | Path to private key file (e.g. `~/.ssh/id_rsa`) |
| `PG_SSH_KEY_PASSPHRASE` | | — | Passphrase for the private key (if encrypted) |
| `PG_SSH_PASSWORD` | ✅ or key | — | SSH password (used when no key file is provided) |
| `PG_SSH_REMOTE_HOST` | | `PG_HOST` | Postgres host as seen from the SSH server |

## Build

```bash
npm install
npm run build
```

## Claude Desktop configuration

Add to `%APPDATA%\Claude\claude_desktop_config.json`:

**Conexão direta:**
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

**Conexão direta com SSL (certificado auto-assinado):**
```json
{
  "mcpServers": {
    "postgres": {
      "command": "node",
      "args": ["C:/Projetos/mcp-postgres-readonly/dist/index.js"],
      "env": {
        "PG_HOST": "db.example.com",
        "PG_DATABASE": "mydb",
        "PG_USER": "postgres",
        "PG_PASSWORD": "yourpassword",
        "PG_SSL": "true",
        "PG_SSL_REJECT_UNAUTHORIZED": "false"
      }
    }
  }
}
```

**Via SSH tunnel (private key):**
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
        "PG_PASSWORD": "yourpassword",
        "PG_SSH_HOST": "bastion.example.com",
        "PG_SSH_USER": "ubuntu",
        "PG_SSH_PRIVATE_KEY": "C:/Users/you/.ssh/id_rsa"
      }
    }
  }
}
```

**Via SSH tunnel (password):**
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
        "PG_PASSWORD": "yourpassword",
        "PG_SSH_HOST": "bastion.example.com",
        "PG_SSH_USER": "ubuntu",
        "PG_SSH_PASSWORD": "sshpassword"
      }
    }
  }
}
```

> **Tip:** When `PG_SSH_REMOTE_HOST` is omitted, the tunnel forwards to `PG_HOST` as seen from the SSH server. If Postgres runs on a private address only reachable from the bastion (e.g. `db.internal`), set `PG_SSH_REMOTE_HOST=db.internal` and `PG_HOST` to anything (it will be overridden).

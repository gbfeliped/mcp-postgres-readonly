/**
 * Read-only SQL guard for PostgreSQL.
 *
 * Pipeline:
 *  1. Strip string literals → replace content with spaces (keeps token positions)
 *  2. Strip comments (block and line)
 *  3. Normalise whitespace
 *  4. Run all rejection checks on the scrubbed text
 *  5. Pass the original, untouched query to the driver
 */

// ---------------------------------------------------------------------------
// Rejection lists
// ---------------------------------------------------------------------------

/** Write / DDL / DCL keywords — matched with word boundaries */
const WRITE_KEYWORDS = [
  "INSERT",
  "UPDATE",
  "DELETE",
  "DROP",
  "CREATE",
  "ALTER",
  "TRUNCATE",
  "MERGE",
  "REPLACE",
  "EXEC",
  "EXECUTE",
  "COPY",
  "VACUUM",
  "REINDEX",
  "CLUSTER",
  "LOCK",
  "CALL",
  "GRANT",
  "REVOKE",
];

/** Dangerous PostgreSQL functions/constructs — matched with word boundaries */
const DANGEROUS_PROCS = [
  // Code execution
  "PG_SLEEP",
  "PG_READ_FILE",
  "PG_WRITE_FILE",
  "PG_READ_BINARY_FILE",
  "PG_STAT_FILE",
  "PG_LS_DIR",
  "PG_EXECUTE",
  "PG_EXECUTE_SERVER_PROGRAM",
  "PG_RELOAD_CONF",
  "PG_ROTATE_LOGFILE",
  "PG_CANCEL_BACKEND",
  "PG_TERMINATE_BACKEND",
  // Config / system
  "SET_CONFIG",
  "PG_CONF_LOAD_TIME",
  "PG_POSTMASTER_START_TIME",
  // File access
  "LO_IMPORT",
  "LO_EXPORT",
  "LOREAD",
  "LOWRITE",
  "LO_OPEN",
  "LO_CLOSE",
  "LO_CREAT",
  "LO_CREATE",
  "LO_UNLINK",
  "LO_TRUNCATE",
  // Extension / system
  "DBLINK",
  "DBLINK_EXEC",
  "DBLINK_CONNECT",
  "DBLINK_SEND_QUERY",
  "PG_EXTENSION_CONFIG_DUMP",
];

/** DoS patterns */
const DOS_PATTERNS = [
  /PG_SLEEP\s*\(/i,
  /GENERATE_SERIES\s*\(\s*\d+\s*,\s*[0-9]{6,}/i, // generate_series(n, 1000000+)
  /PG_BLOCKING_PIDS\s*\(/i,
];

// ---------------------------------------------------------------------------
// Step 1 – scrub string literal content (single-quoted and dollar-quoted)
// ---------------------------------------------------------------------------

function scrubStringLiterals(sql: string): string {
  let result = "";
  let i = 0;
  while (i < sql.length) {
    // Dollar-quoted strings: $tag$...$tag$
    if (sql[i] === "$") {
      const tagMatch = sql.slice(i).match(/^\$([A-Za-z0-9_]*)\$/);
      if (tagMatch) {
        const tag = tagMatch[0];
        const end = sql.indexOf(tag, i + tag.length);
        if (end !== -1) {
          result += tag + " ".repeat(end - i - tag.length) + tag;
          i = end + tag.length;
          continue;
        }
      }
      result += sql[i++];
    } else if (sql[i] === "'") {
      // Standard single-quoted string
      result += "'";
      i++;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          result += "  ";
          i += 2;
        } else if (sql[i] === "'") {
          result += "'";
          i++;
          break;
        } else {
          result += " ";
          i++;
        }
      }
    } else {
      result += sql[i++];
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Step 2 – strip comments
// ---------------------------------------------------------------------------

function stripComments(sql: string): string {
  let result = "";
  let i = 0;
  while (i < sql.length) {
    if (sql[i] === "/" && sql[i + 1] === "*") {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") { depth++; i += 2; }
        else if (sql[i] === "*" && sql[i + 1] === "/") { depth--; i += 2; }
        else i++;
      }
      result += " ";
    } else if (sql[i] === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
      result += " ";
    } else {
      result += sql[i++];
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Step 3 – normalise whitespace
// ---------------------------------------------------------------------------

function normalise(sql: string): string {
  return sql.replace(/[\t\r\n]+/g, " ").replace(/  +/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export class SqlGuardError extends Error {
  constructor(reason: string) {
    super(`Query blocked: ${reason}`);
    this.name = "SqlGuardError";
  }
}

/**
 * Validate a SQL query. Throws SqlGuardError if the query is not allowed.
 * Returns the original (untouched) query string to pass to the driver.
 */
export function validateQuery(sql: string): string {
  if (!sql || !sql.trim()) {
    throw new SqlGuardError("empty query");
  }

  const scrubbed = stripComments(scrubStringLiterals(sql));
  const normalised = normalise(scrubbed).toUpperCase();

  // 1. Semicolons — multiple statements not allowed
  if (/;/.test(scrubbed)) {
    throw new SqlGuardError("semicolons are not allowed (multiple statements)");
  }

  // 2. DoS patterns
  for (const pattern of DOS_PATTERNS) {
    if (pattern.test(normalised)) {
      throw new SqlGuardError(`DoS construct detected: ${pattern.source}`);
    }
  }

  // 3. Dangerous functions/constructs (word-boundary matched)
  for (const proc of DANGEROUS_PROCS) {
    const escaped = proc.replace(/\s+/g, "\\s+");
    const re = new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`, "i");
    if (re.test(normalised)) {
      throw new SqlGuardError(`system function/construct not allowed: ${proc}`);
    }
  }

  // 4. Write / DDL keywords (word-boundary matched)
  for (const kw of WRITE_KEYWORDS) {
    const re = new RegExp(`(?<![A-Za-z0-9_])${kw}(?![A-Za-z0-9_])`, "i");
    if (re.test(normalised)) {
      throw new SqlGuardError(`write/DDL keyword not allowed: ${kw}`);
    }
  }

  // 5. Must start with SELECT or WITH (CTE)
  if (!/^(WITH\b|SELECT\b)/i.test(normalised)) {
    throw new SqlGuardError(
      "only SELECT queries are allowed (must start with SELECT or WITH)"
    );
  }

  return sql;
}

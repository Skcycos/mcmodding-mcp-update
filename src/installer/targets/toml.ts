/**
 * Minimal TOML serializer for MCP server config tables.
 *
 * Codex CLI reads MCP servers from ~/.codex/config.toml using dotted-key
 * tables like `[mcp_servers.mcmodding]`. We only need to emit flat
 * `key = value` pairs (strings, arrays of strings) — no nested tables,
 * no inline tables, no multiline strings. Codex's parser handles the
 * dotted-key form natively.
 */

/** Quote a TOML basic string (double quotes, escape backslash and quote). */
function tomlString(value: string): string {
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${escaped}"`;
}

/** Render a single TOML value (string, string array, or number/bool passthrough). */
function tomlValue(value: unknown): string {
  if (typeof value === 'string') return tomlString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    const items = value.map((v) => (typeof v === 'string' ? tomlString(v) : String(v)));
    return `[${items.join(', ')}]`;
  }
  // Fallback: stringify as JSON (covers null, nested objects — though we don't emit those).
  return tomlString(JSON.stringify(value));
}

/**
 * Build a dotted-key TOML table block.
 *
 * @param header - table header, e.g. 'mcp_servers.codegraph' (no brackets)
 * @param entries - flat key/value pairs
 * @returns full TOML text including trailing newline, e.g.
 *   [mcp_servers.codegraph]\ncommand = "mcmodding-mcp"\nargs = []\n
 */
export function buildTomlTable(header: string, entries: Record<string, unknown>): string {
  const lines = [`[${header}]`];
  for (const [k, v] of Object.entries(entries)) {
    lines.push(`${k} = ${tomlValue(v)}`);
  }
  return lines.join('\n') + '\n';
}

/**
 * Upsert a dotted-key table inside a TOML document string.
 *
 * If a `[header]` block exists, it's replaced in-place (everything from
 * the header line up to the next `[` or EOF). Otherwise the block is
 * appended. Returns the new content and whether it changed.
 */
export function upsertTomlTable(
  content: string,
  header: string,
  block: string
): { content: string; action: 'created' | 'updated' | 'unchanged' } {
  const headerLine = `[${header}]`;
  const startIdx = content.indexOf(headerLine);

  if (startIdx === -1) {
    // Not present — append.
    const next = ensureTrailingNewline(content) + block;
    return { content: next, action: 'created' };
  }

  // Find the end of this table: the next line starting with '[' (a new
  // top-level key or table header) or EOF. We include any trailing blank
  // lines in the current table's span so replacement doesn't accumulate
  // them.
  const afterHeader = startIdx + headerLine.length;
  const nextTableMatch = content.slice(afterHeader).search(/\n\[/);
  let endIdx: number;
  if (nextTableMatch === -1) {
    endIdx = content.length;
  } else {
    // Position of the '\n' that precedes the next '['.
    const newlineBeforeNext = afterHeader + nextTableMatch;
    // Consume trailing blank lines so the replaced block sits flush.
    let scan = newlineBeforeNext;
    while (scan > startIdx && content[scan - 1] === '\n') {
      scan--;
    }
    endIdx = newlineBeforeNext + 1; // keep one '\n' as the line separator
  }

  const current = content.slice(startIdx, endIdx);
  if (current === block.trimEnd()) {
    return { content, action: 'unchanged' };
  }

  // Ensure the block ends with '\n' before we splice in the rest.
  const normalizedBlock = block.endsWith('\n') ? block : block + '\n';
  const replaced = content.slice(0, startIdx) + normalizedBlock + content.slice(endIdx);
  return { content: replaced, action: 'updated' };
}

/**
 * Remove a dotted-key table from a TOML document string.
 * Returns the new content and whether a removal happened.
 */
export function removeTomlTable(
  content: string,
  header: string
): { content: string; action: 'removed' | 'not-found' } {
  const headerLine = `[${header}]`;
  const startIdx = content.indexOf(headerLine);

  if (startIdx === -1) {
    return { content, action: 'not-found' };
  }

  const afterHeader = startIdx + headerLine.length;
  const nextTableMatch = content.slice(afterHeader).search(/\n\[/);
  let endIdx: number;
  if (nextTableMatch === -1) {
    endIdx = content.length;
  } else {
    endIdx = afterHeader + nextTableMatch + 1;
  }

  // Consume trailing blank lines of the preceding content so we don't
  // leave gaps, and trim trailing whitespace from what remains.
  let prefixEnd = startIdx;
  while (prefixEnd > 0 && content[prefixEnd - 1] === '\n') {
    prefixEnd--;
  }
  // Keep one trailing newline if there's content before.
  const keepNewline = prefixEnd > 0 ? 1 : 0;

  let remaining = content.slice(0, prefixEnd + keepNewline) + content.slice(endIdx);
  remaining = remaining.trimEnd() + '\n';
  return { content: remaining, action: 'removed' };
}

function ensureTrailingNewline(s: string): string {
  return s.endsWith('\n') ? s : s + '\n';
}

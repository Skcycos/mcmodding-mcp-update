/**
 * Shared filesystem helpers for installer targets.
 *
 * - JSON read/write with atomic writes (tmp + renameSync)
 * - Deep equality for idempotency checks
 * - Marker-fenced section upsert / removal in text files (for CLAUDE.md etc.)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

/** Delete a file if it exists; silently ignore if it doesn't. */
export function deleteFileIfExists(filePath: string): void {
  try {
    fs.unlinkSync(resolvePath(filePath));
  } catch {
    /* file didn't exist or can't be deleted — ignore */
  }
}

/** Resolve ~ and environment variables in a path. */
export function resolvePath(p: string): string {
  if (p.startsWith('~/')) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

/** Read a JSON file, returning an empty object if it doesn't exist or is invalid. */
export function readJsonFile(filePath: string): Record<string, unknown> {
  try {
    const raw = fs.readFileSync(resolvePath(filePath), 'utf-8');
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Write a JSON file atomically: write to a temp file, then rename.
 * Ensures the parent directory exists.
 */
export function writeJsonFile(filePath: string, data: Record<string, unknown>): void {
  const fullPath = resolvePath(filePath);
  const dir = path.dirname(fullPath);
  fs.mkdirSync(dir, { recursive: true });

  const tmp = `${fullPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmp, fullPath);
}

/** Deep equality check for JSON-serializable values. */
export function jsonDeepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return a === b;

  if (Array.isArray(a) !== Array.isArray(b)) return false;

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => jsonDeepEqual(v, b[i]));
  }

  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const aKeys = Object.keys(aObj);
  const bKeys = Object.keys(bObj);

  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((k) => k in bObj && jsonDeepEqual(aObj[k], bObj[k]));
}

/**
 * Upsert a marker-fenced section in a text file.
 *
 * If the file exists and contains a section delimited by `startMarker` /
 * `endMarker`, the section is replaced in-place. Otherwise the section is
 * appended (with a trailing newline). If the file doesn't exist it is
 * created with just the section.
 *
 * Returns the action taken.
 */
export function upsertMarkedSection(
  filePath: string,
  startMarker: string,
  endMarker: string,
  content: string
): 'created' | 'updated' | 'unchanged' {
  const fullPath = resolvePath(filePath);
  const next = `${startMarker}\n${content}\n${endMarker}\n`;

  let existing = '';
  let existed = false;
  try {
    existing = fs.readFileSync(fullPath, 'utf-8');
    existed = true;
  } catch {
    // file doesn't exist — will create
  }

  const startIdx = existing.indexOf(startMarker);
  const endIdx = existing.indexOf(endMarker);

  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    // Section exists — check if content matches
    const currentSection = existing.slice(startIdx, endIdx + endMarker.length);
    if (currentSection === next.trimEnd()) {
      return 'unchanged';
    }
    const replaced = existing.slice(0, startIdx) + next + existing.slice(endIdx + endMarker.length);
    writeTextFile(fullPath, replaced);
    return 'updated';
  }

  // Section doesn't exist — append
  const appended = existed ? ensureTrailingNewline(existing) + next : next;
  writeTextFile(fullPath, appended);
  return 'created';
}

/**
 * Remove a marker-fenced section from a text file.
 * Returns the action taken.
 */
export function removeMarkedSection(
  filePath: string,
  startMarker: string,
  endMarker: string
): 'removed' | 'not-found' | 'unchanged' {
  const fullPath = resolvePath(filePath);
  let existing: string;
  try {
    existing = fs.readFileSync(fullPath, 'utf-8');
  } catch {
    return 'not-found';
  }

  const startIdx = existing.indexOf(startMarker);
  const endIdx = existing.indexOf(endMarker);

  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    return 'not-found';
  }

  // Remove the section plus one trailing newline if present.
  let after = existing.slice(0, startIdx) + existing.slice(endIdx + endMarker.length);
  if (after.startsWith('\n')) after = after.slice(1);

  if (after.trim() === '') {
    // File would be empty — remove it entirely.
    try {
      fs.unlinkSync(fullPath);
    } catch {
      /* ignore */
    }
    return 'removed';
  }

  writeTextFile(fullPath, after);
  return 'removed';
}

function writeTextFile(fullPath: string, content: string): void {
  const dir = path.dirname(fullPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${fullPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, 'utf-8');
  fs.renameSync(tmp, fullPath);
}

function ensureTrailingNewline(s: string): string {
  return s.endsWith('\n') ? s : s + '\n';
}

/**
 * Detect the MCP command to use for mcmodding-mcp.
 *
 * Priority:
 *   1. If `mcmodding-mcp` is on PATH (global install), use it bare.
 *   2. Otherwise fall back to `npx mcmodding-mcp`.
 *
 * We check PATH via `which`/`where` to avoid spawning a heavy process.
 */
export function detectMcpCommand(): string {
  const pathEnv = process.env.PATH ?? '';
  const delimiter = process.platform === 'win32' ? ';' : ':';
  const extensions = process.platform === 'win32' ? ['.cmd', '.exe', '.bat', ''] : [''];

  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    for (const ext of extensions) {
      const candidate = path.join(dir, 'mcmodding-mcp' + ext);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return 'mcmodding-mcp';
      } catch {
        // not executable, keep looking
      }
    }
  }

  return 'npx mcmodding-mcp';
}

/**
 * Build the MCP server config object written into agent MCP JSON files.
 */
export function getMcpServerConfig(command: string): Record<string, unknown> {
  if (command === 'npx mcmodding-mcp') {
    return {
      type: 'stdio',
      command: 'npx',
      args: ['mcmodding-mcp'],
      env: {},
    };
  }
  return {
    type: 'stdio',
    command,
    args: [],
    env: {},
  };
}

/**
 * The permission patterns to add to an agent's auto-allow list.
 * Matches the tool names exposed by mcmodding-mcp.
 */
export function getPermissionPatterns(): string[] {
  return [
    'mcp__mcmodding__search_fabric_docs',
    'mcp__mcmodding__get_example',
    'mcp__mcmodding__explain_fabric_concept',
    'mcp__mcmodding__get_minecraft_version',
    'mcp__mcmodding__search_mappings',
    'mcp__mcmodding__get_class_details',
    'mcp__mcmodding__lookup_obfuscated',
    'mcp__mcmodding__get_method_signature',
    'mcp__mcmodding__list_mapping_versions',
    'mcp__mcmodding__browse_package',
    'mcp__mcmodding__search_mod_examples',
    'mcp__mcmodding__get_mod_example',
    'mcp__mcmodding__list_canonical_mods',
    'mcp__mcmodding__list_mod_categories',
    'mcp__mcmodding__get_mod_patterns',
    'mcp__mcmodding__*',
  ];
}

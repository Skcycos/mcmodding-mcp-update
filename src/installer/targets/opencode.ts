/**
 * opencode target.
 *
 *   - MCP server entry to `~/.config/opencode/opencode.jsonc` (global,
 *     XDG_CONFIG_HOME if set, else ~/.config) or `./opencode.jsonc`
 *     (local). Falls back to `opencode.json` when a `.json` file already
 *     exists; defaults new installs to `.jsonc`.
 *   - Instructions to `~/.config/opencode/AGENTS.md` (global) or
 *     `./AGENTS.md` (local).
 *   - No permissions concept.
 *
 * Config shape uses opencode's wrapper:
 *   { "$schema": "https://opencode.ai/config.json",
 *     "mcp": { "mcmodding": { "type": "local", "command": [...], "enabled": true } } }
 *
 * opencode uses `mcp.<name>` (not `mcpServers`), `command` as a string
 * array combining binary + args, and an explicit `enabled` flag.
 * Reads/writes go through jsonc-parser so user comments survive.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { parse as parseJsonc, modify, applyEdits } from 'jsonc-parser';
import { AgentTarget, InstallLocation, WriteResult } from './types.js';
import {
  deleteFileIfExists,
  detectMcpCommand,
  jsonDeepEqual,
  removeMarkedSection,
  resolvePath,
  upsertMarkedSection,
} from './shared.js';
import {
  MCMODDING_SECTION_END,
  MCMODDING_SECTION_START,
  MCMODDING_INSTRUCTIONS,
} from '../agent-instructions.js';

const SCHEMA = 'https://opencode.ai/config.json';
const FORMATTING = { tabSize: 2, insertSpaces: true, eol: '\n' };

function globalConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  return xdg ? xdg : path.join(os.homedir(), '.config', 'opencode');
}

function configBaseDir(loc: InstallLocation): string {
  return loc === 'global' ? globalConfigDir() : process.cwd();
}

function configPath(loc: InstallLocation): string {
  const dir = configBaseDir(loc);
  const jsonc = path.join(dir, 'opencode.jsonc');
  const json = path.join(dir, 'opencode.json');
  if (fs.existsSync(resolvePath(jsonc))) return jsonc;
  if (fs.existsSync(resolvePath(json))) return json;
  return jsonc;
}

function instructionsPath(loc: InstallLocation): string {
  return path.join(configBaseDir(loc), 'AGENTS.md');
}

function readConfigText(file: string): string {
  try {
    return fs.readFileSync(resolvePath(file), 'utf-8');
  } catch {
    return '';
  }
}

function parseConfig(text: string): Record<string, unknown> {
  if (!text.trim()) return {};
  // jsonc-parser's types are loose; we validate the shape ourselves below.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any
  const result = parseJsonc(text, [] as any[], { allowTrailingComma: true });
  if (result == null || typeof result !== 'object' || Array.isArray(result)) {
    return {};
  }
  return result as Record<string, unknown>;
}

function getServerEntry(): { type: string; command: string[]; enabled: boolean } {
  const cmd = detectMcpCommand();
  return {
    type: 'local',
    command: cmd === 'npx mcmodding-mcp' ? ['npx', 'mcmodding-mcp'] : [cmd],
    enabled: true,
  };
}

class OpencodeTarget implements AgentTarget {
  readonly id = 'opencode' as const;
  readonly displayName = 'opencode';
  readonly docsUrl = 'https://opencode.ai/docs/config';

  supportsLocation(_loc: InstallLocation): boolean {
    return true;
  }

  detect(loc: InstallLocation): DetectionResult {
    const file = configPath(loc);
    const config = parseConfig(readConfigText(file));
    const mcp = config.mcp as Record<string, unknown> | undefined;
    const alreadyConfigured = mcp?.mcmodding !== undefined && mcp.mcmodding !== null;
    const installed = fs.existsSync(resolvePath(configBaseDir(loc)));
    return { installed, alreadyConfigured, configPath: file };
  }

  install(loc: InstallLocation): WriteResult {
    const files: WriteResult['files'] = [];
    files.push(this.writeMcpEntry(loc));
    files.push(this.writeInstructions(loc));
    return { files };
  }

  uninstall(loc: InstallLocation): WriteResult {
    const files: WriteResult['files'] = [];
    files.push(this.removeMcpEntry(loc));
    files.push(this.removeInstructions(loc));
    return { files };
  }

  printConfig(loc: InstallLocation): string {
    const target = configPath(loc);
    const snippet = JSON.stringify(
      { $schema: SCHEMA, mcp: { mcmodding: getServerEntry() } },
      null,
      2
    );
    return `# Add to ${target}\n\n${snippet}\n`;
  }

  describePaths(loc: InstallLocation): string[] {
    return [configPath(loc), instructionsPath(loc)];
  }

  // ── Private helpers ──────────────────────────────────────────────

  private writeMcpEntry(loc: InstallLocation): WriteResult['files'][number] {
    const file = configPath(loc);
    const fullPath = resolvePath(file);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });

    const existed = fs.existsSync(fullPath);
    let text = readConfigText(file);

    // Seed a minimal config when the file is brand-new.
    if (!text.trim()) {
      text = `{\n  "$schema": "${SCHEMA}"\n}\n`;
    }

    const config = parseConfig(text);
    const mcp = (config.mcp as Record<string, unknown> | undefined) ?? {};
    const before = mcp.mcmodding;
    const after = getServerEntry();

    if (jsonDeepEqual(before, after)) {
      return { path: file, action: 'unchanged' };
    }

    // Add $schema if missing.
    if (!config.$schema) {
      const schemaEdits = modify(text, ['$schema'], SCHEMA, {
        formattingOptions: FORMATTING,
      });
      text = applyEdits(text, schemaEdits);
    }

    // Surgically edit mcp.mcmodding — preserves comments and order.
    const edits = modify(text, ['mcp', 'mcmodding'], after, {
      formattingOptions: FORMATTING,
    });
    const updated = applyEdits(text, edits);

    const tmp = `${fullPath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, updated, 'utf-8');
    fs.renameSync(tmp, fullPath);

    return { path: file, action: existed ? 'updated' : 'created' };
  }

  private removeMcpEntry(loc: InstallLocation): WriteResult['files'][number] {
    const file = configPath(loc);
    const fullPath = resolvePath(file);

    if (!fs.existsSync(fullPath)) {
      return { path: file, action: 'not-found' };
    }

    const text = readConfigText(file);
    const config = parseConfig(text);
    const mcp = config.mcp as Record<string, unknown> | undefined;
    if (!mcp?.mcmodding) {
      return { path: file, action: 'not-found' };
    }

    let edits = modify(text, ['mcp', 'mcmodding'], undefined, {
      formattingOptions: FORMATTING,
    });
    let updated = applyEdits(text, edits);

    // If mcp is now empty, drop the wrapper too.
    const afterParsed = parseConfig(updated);
    if (
      afterParsed.mcp &&
      typeof afterParsed.mcp === 'object' &&
      Object.keys(afterParsed.mcp).length === 0
    ) {
      edits = modify(updated, ['mcp'], undefined, { formattingOptions: FORMATTING });
      updated = applyEdits(updated, edits);
    }

    // If nothing else remains, delete the file.
    const finalParsed = parseConfig(updated);
    if (Object.keys(finalParsed).length === 0) {
      deleteFileIfExists(file);
      return { path: file, action: 'removed' };
    }

    const tmp = `${fullPath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, updated, 'utf-8');
    fs.renameSync(tmp, fullPath);
    return { path: file, action: 'removed' };
  }

  private writeInstructions(loc: InstallLocation): WriteResult['files'][number] {
    const file = instructionsPath(loc);
    const action = upsertMarkedSection(
      file,
      MCMODDING_SECTION_START,
      MCMODDING_SECTION_END,
      MCMODDING_INSTRUCTIONS
    );
    return { path: file, action };
  }

  private removeInstructions(loc: InstallLocation): WriteResult['files'][number] {
    const file = instructionsPath(loc);
    const action = removeMarkedSection(file, MCMODDING_SECTION_START, MCMODDING_SECTION_END);
    return { path: file, action };
  }
}

import { DetectionResult } from './types.js';

export const opencodeTarget: AgentTarget = new OpencodeTarget();

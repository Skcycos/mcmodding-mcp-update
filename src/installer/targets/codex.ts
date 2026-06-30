/**
 * OpenAI Codex CLI target.
 *
 *   - MCP server entry to `~/.codex/config.toml` as the dotted-key
 *     table `[mcp_servers.mcmodding]`. TOML — not JSON — handled by
 *     the narrow serializer in `./toml.ts`.
 *   - Instructions to `~/.codex/AGENTS.md`.
 *
 * Codex CLI as of 2026 has no project-local config concept —
 * everything lives under `~/.codex/`. `supportsLocation('local')`
 * returns false; the orchestrator skips Codex when the user picks
 * the local install location.
 *
 * No permissions concept.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { AgentTarget, DetectionResult, InstallLocation, WriteResult } from './types.js';
import {
  deleteFileIfExists,
  detectMcpCommand,
  getMcpServerConfig,
  removeMarkedSection,
  resolvePath,
  upsertMarkedSection,
} from './shared.js';
import {
  MCMODDING_SECTION_END,
  MCMODDING_SECTION_START,
  MCMODDING_INSTRUCTIONS,
} from '../agent-instructions.js';
import { buildTomlTable, removeTomlTable, upsertTomlTable } from './toml.js';

const TOML_HEADER = 'mcp_servers.mcmodding';
const TOML_DIR = path.join(os.homedir(), '.codex');
const TOML_PATH = path.join(TOML_DIR, 'config.toml');
const AGENTS_MD = path.join(TOML_DIR, 'AGENTS.md');

class CodexTarget implements AgentTarget {
  readonly id = 'codex' as const;
  readonly displayName = 'Codex CLI';
  readonly docsUrl = 'https://github.com/openai/codex';

  supportsLocation(loc: InstallLocation): boolean {
    return loc === 'global';
  }

  detect(loc: InstallLocation): DetectionResult {
    if (loc !== 'global') {
      return { installed: false, alreadyConfigured: false };
    }
    let alreadyConfigured = false;
    try {
      const content = fs.readFileSync(resolvePath(TOML_PATH), 'utf-8');
      alreadyConfigured = content.includes(`[${TOML_HEADER}]`);
    } catch {
      /* file doesn't exist */
    }
    const dirExists = fs.existsSync(resolvePath(TOML_DIR));
    return { installed: dirExists, alreadyConfigured, configPath: TOML_PATH };
  }

  install(loc: InstallLocation): WriteResult {
    if (loc !== 'global') {
      return {
        files: [],
        notes: [
          'Codex CLI has no project-local config — re-run with --location=global to install.',
        ],
      };
    }
    const files: WriteResult['files'] = [];

    files.push(this.writeMcpEntry());
    files.push(this.writeInstructions());

    return { files };
  }

  uninstall(loc: InstallLocation): WriteResult {
    if (loc !== 'global') return { files: [] };
    const files: WriteResult['files'] = [];

    // Remove TOML table
    if (fs.existsSync(resolvePath(TOML_PATH))) {
      const content = fs.readFileSync(resolvePath(TOML_PATH), 'utf-8');
      const { content: nextContent, action } = removeTomlTable(content, TOML_HEADER);
      if (action === 'removed') {
        if (nextContent.trim() === '') {
          deleteFileIfExists(TOML_PATH);
        } else {
          atomicWrite(resolvePath(TOML_PATH), nextContent.trimEnd() + '\n');
        }
        files.push({ path: TOML_PATH, action: 'removed' });
      } else {
        files.push({ path: TOML_PATH, action: 'not-found' });
      }
    } else {
      files.push({ path: TOML_PATH, action: 'not-found' });
    }

    // Remove AGENTS.md block
    files.push(this.removeInstructions());

    return { files };
  }

  printConfig(loc: InstallLocation): string {
    if (loc !== 'global') {
      return '# Codex CLI has no project-local config — use --location=global.\n';
    }
    const block = buildMcpBlock();
    return `# Add to ${TOML_PATH}\n\n${block}\n`;
  }

  describePaths(_loc: InstallLocation): string[] {
    return [TOML_PATH, AGENTS_MD];
  }

  // ── Private helpers ──────────────────────────────────────────────

  private writeMcpEntry(): WriteResult['files'][number] {
    const file = resolvePath(TOML_PATH);
    fs.mkdirSync(path.dirname(file), { recursive: true });

    const block = buildMcpBlock();
    const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '';
    const created = existing.length === 0;

    const { content: nextContent, action } = upsertTomlTable(existing, TOML_HEADER, block);

    if (action === 'unchanged') {
      return { path: TOML_PATH, action: 'unchanged' };
    }

    atomicWrite(file, nextContent);
    return { path: TOML_PATH, action: created ? 'created' : 'updated' };
  }

  private writeInstructions(): WriteResult['files'][number] {
    const action = upsertMarkedSection(
      AGENTS_MD,
      MCMODDING_SECTION_START,
      MCMODDING_SECTION_END,
      MCMODDING_INSTRUCTIONS
    );
    return { path: AGENTS_MD, action };
  }

  private removeInstructions(): WriteResult['files'][number] {
    const action = removeMarkedSection(AGENTS_MD, MCMODDING_SECTION_START, MCMODDING_SECTION_END);
    return { path: AGENTS_MD, action };
  }
}

function buildMcpBlock(): string {
  const mcp = getMcpServerConfig(detectMcpCommand());
  return buildTomlTable(TOML_HEADER, {
    command: mcp.command,
    args: mcp.args,
  });
}

function atomicWrite(fullPath: string, content: string): void {
  const tmp = `${fullPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, 'utf-8');
  fs.renameSync(tmp, fullPath);
}

export const codexTarget: AgentTarget = new CodexTarget();

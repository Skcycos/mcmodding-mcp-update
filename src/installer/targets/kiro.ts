/**
 * Kiro IDE target.
 *
 * Kiro is an AWS-backed IDE that supports MCP servers via a standard
 * `mcpServers` block in its settings — same shape as Claude Code.
 *
 *   - MCP server entry to `~/.kiro/settings.json` (global) or
 *     `./.kiro/settings.json` (local) under `mcpServers.mcmodding`.
 *   - Instructions to `~/.kiro/AGENTS.md` (global) or `./.kiro/AGENTS.md`
 *     (local — Kiro reads project-level AGENTS.md from `.kiro/`).
 *
 * No permissions concept — Kiro gates tool invocations through its own
 * approval UI, not an external allowlist.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { AgentTarget, InstallLocation, WriteResult } from './types.js';
import {
  deleteFileIfExists,
  detectMcpCommand,
  getMcpServerConfig,
  jsonDeepEqual,
  readJsonFile,
  removeMarkedSection,
  resolvePath,
  upsertMarkedSection,
  writeJsonFile,
} from './shared.js';
import {
  MCMODDING_SECTION_END,
  MCMODDING_SECTION_START,
  MCMODDING_INSTRUCTIONS,
} from '../agent-instructions.js';

function configDir(loc: InstallLocation): string {
  return loc === 'global' ? path.join(os.homedir(), '.kiro') : path.join(process.cwd(), '.kiro');
}

function settingsJsonPath(loc: InstallLocation): string {
  return path.join(configDir(loc), 'settings.json');
}

function instructionsPath(loc: InstallLocation): string {
  return path.join(configDir(loc), 'AGENTS.md');
}

class KiroTarget implements AgentTarget {
  readonly id = 'kiro' as const;
  readonly displayName = 'Kiro IDE';
  readonly docsUrl = 'https://kiro.dev/docs/mcp/';

  supportsLocation(_loc: InstallLocation): boolean {
    return true;
  }

  detect(loc: InstallLocation): DetectionResult {
    const file = settingsJsonPath(loc);
    const config = readJsonFile(file);
    const mcmodding = (config.mcpServers as Record<string, unknown> | undefined)?.mcmodding;
    const alreadyConfigured = mcmodding !== undefined && mcmodding !== null;

    const fileExists = fs.existsSync(resolvePath(file));
    const dirExists = fs.existsSync(resolvePath(configDir(loc)));
    const installed = loc === 'global' ? dirExists || fileExists : fileExists || dirExists;

    return { installed, alreadyConfigured, configPath: file };
  }

  install(loc: InstallLocation): WriteResult {
    const files: WriteResult['files'] = [];
    const command = detectMcpCommand();

    files.push(this.writeMcpEntry(loc, command));
    files.push(this.writeInstructions(loc));

    return { files };
  }

  uninstall(loc: InstallLocation): WriteResult {
    const files: WriteResult['files'] = [];

    const file = settingsJsonPath(loc);
    const config = readJsonFile(file);
    const servers = config.mcpServers as Record<string, unknown> | undefined;
    if (servers?.mcmodding) {
      delete servers.mcmodding;
      if (Object.keys(servers).length === 0) {
        delete config.mcpServers;
      }
      if (Object.keys(config).length === 0) {
        deleteFileIfExists(file);
      } else {
        writeJsonFile(file, config);
      }
      files.push({ path: file, action: 'removed' });
    } else {
      files.push({ path: file, action: 'not-found' });
    }

    files.push(this.removeInstructions(loc));

    return { files };
  }

  printConfig(loc: InstallLocation): string {
    const target = settingsJsonPath(loc);
    const command = detectMcpCommand();
    const cfg = getMcpServerConfig(command);
    const snippet = JSON.stringify({ mcpServers: { mcmodding: cfg } }, null, 2);
    return `# Add to ${target}\n\n${snippet}\n`;
  }

  describePaths(loc: InstallLocation): string[] {
    return [settingsJsonPath(loc), instructionsPath(loc)];
  }

  // ── Private helpers ──────────────────────────────────────────────

  private writeMcpEntry(loc: InstallLocation, command: string): WriteResult['files'][number] {
    const file = settingsJsonPath(loc);
    const existing = readJsonFile(file);
    const servers = (existing.mcpServers as Record<string, unknown> | undefined) ?? {};
    const before = servers.mcmodding;
    const after = getMcpServerConfig(command);

    if (jsonDeepEqual(before, after)) {
      return { path: file, action: 'unchanged' };
    }

    const action: 'created' | 'updated' =
      before !== undefined && before !== null
        ? 'updated'
        : fs.existsSync(resolvePath(file))
          ? 'updated'
          : 'created';

    servers.mcmodding = after;
    existing.mcpServers = servers;
    writeJsonFile(file, existing);
    return { path: file, action };
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

export const kiroTarget: AgentTarget = new KiroTarget();

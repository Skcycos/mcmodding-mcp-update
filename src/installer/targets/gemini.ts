/**
 * Gemini CLI target.
 *
 *   - MCP server entry to `~/.gemini/settings.json` (global) or
 *     `./.gemini/settings.json` (local) under `mcpServers.mcmodding`.
 *   - Instructions to `~/.gemini/GEMINI.md` (global) or `./GEMINI.md`
 *     (local — Gemini reads the project root file directly, not
 *     under `.gemini/`).
 *
 * No permissions concept — Gemini CLI gates tool invocations through
 * the `trust` field per server, not an external allowlist. We leave
 * `trust` unset so the user controls confirmation prompts.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { AgentTarget, InstallLocation, WriteResult } from './types.js';
import {
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
  return loc === 'global'
    ? path.join(os.homedir(), '.gemini')
    : path.join(process.cwd(), '.gemini');
}

function settingsJsonPath(loc: InstallLocation): string {
  return path.join(configDir(loc), 'settings.json');
}

function instructionsPath(loc: InstallLocation): string {
  // Global GEMINI.md lives under ~/.gemini/; project-local GEMINI.md
  // lives at the project root (NOT under .gemini/), matching how
  // Gemini CLI's hierarchical context loader searches.
  return loc === 'global'
    ? path.join(configDir('global'), 'GEMINI.md')
    : path.join(process.cwd(), 'GEMINI.md');
}

class GeminiTarget implements AgentTarget {
  readonly id = 'gemini' as const;
  readonly displayName = 'Gemini CLI';
  readonly docsUrl = 'https://geminicli.com/docs/tools/mcp-server/';

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

// Needed for the empty-config cleanup in uninstall.
import { deleteFileIfExists } from './shared.js';
import { DetectionResult } from './types.js';

export const geminiTarget: AgentTarget = new GeminiTarget();

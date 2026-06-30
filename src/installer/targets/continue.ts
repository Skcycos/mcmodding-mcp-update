/**
 * Continue.dev target (VS Code / Cursor / Windsurf extension).
 *
 * Continue is the most popular open-source AI coding assistant extension.
 * It reads MCP servers from VS Code's `settings.json` under the
 * `continue.mcpServers` key as an ARRAY (not an object/map).
 *
 * Two config surfaces:
 *   - Global: `~/.vscode/User/settings.json` (or equivalent for
 *     Cursor/Windsurf) under `"continue.mcpServers"`.
 *   - Local:  `./.continue/config.json` in the project root (Continue's
 *     own portable config — preferred for per-project setups).
 *
 * Config shape (array form):
 *   {
 *     "continue.mcpServers": [
 *       { "name": "mcmodding", "command": "...", "args": [...] }
 *     ]
 *   }
 *
 * We write the project-local `.continue/config.json` form for local
 * installs (it's editor-agnostic and version-control friendly), and
 * fall back to patching VS Code's global `settings.json` for global
 * installs when no Continue-specific config exists there yet.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { AgentTarget, InstallLocation, WriteResult } from './types.js';
import {
  deleteFileIfExists,
  detectMcpCommand,
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

interface ContinueServerEntry {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
}

function getServerEntry(): ContinueServerEntry {
  const cmd = detectMcpCommand();
  const isNpx = cmd === 'npx mcmodding-mcp';
  return {
    name: 'mcmodding',
    command: isNpx ? 'npx' : cmd,
    args: isNpx ? ['mcmodding-mcp'] : [],
    env: {},
  };
}

// ── Paths ───────────────────────────────────────────────────────────

function vscodeSettingsPath(): string {
  // VS Code's global user settings. On macOS this is
  // ~/Library/Application Support/Code/User/settings.json; on Linux
  // ~/.config/Code/User/settings.json. We resolve via the same env
  // vars VS Code uses, falling back to a best-effort default.
  const base =
    process.env.VSCODE_PORTABLE ??
    path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'User');
  return path.join(base, 'settings.json');
}

function globalConfigPath(): string {
  return vscodeSettingsPath();
}

function localConfigPath(): string {
  return path.join(process.cwd(), '.continue', 'config.json');
}

function localInstructionsPath(): string {
  return path.join(process.cwd(), '.continue', 'AGENTS.md');
}

function globalInstructionsPath(): string {
  // Continue reads a global AGENTS.md from its extension storage; we
  // instead write next to VS Code settings so it's discoverable.
  return path.join(path.dirname(vscodeSettingsPath()), 'AGENTS.md');
}

// ── Local install (.continue/config.json — Continue's own format) ──

function writeLocalConfig(): WriteResult['files'][number] {
  const file = localConfigPath();
  const fullPath = resolvePath(file);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });

  const existed = fs.existsSync(fullPath);
  const config = readJsonFile(file);
  const servers = (config.mcpServers as ContinueServerEntry[] | undefined) ?? [];

  const entry = getServerEntry();
  const idx = servers.findIndex((s) => s.name === 'mcmodding');

  if (idx !== -1 && jsonDeepEqual(servers[idx], entry)) {
    return { path: file, action: 'unchanged' };
  }

  if (idx !== -1) {
    servers[idx] = entry;
  } else {
    servers.push(entry);
  }

  config.mcpServers = servers;
  writeJsonFile(file, config);
  return { path: file, action: existed ? 'updated' : 'created' };
}

function removeLocalConfig(): WriteResult['files'][number] {
  const file = localConfigPath();
  if (!fs.existsSync(resolvePath(file))) {
    return { path: file, action: 'not-found' };
  }

  const config = readJsonFile(file);
  const servers = (config.mcpServers as ContinueServerEntry[] | undefined) ?? [];
  const before = servers.length;
  const filtered = servers.filter((s) => s.name !== 'mcmodding');

  if (filtered.length === before) {
    return { path: file, action: 'not-found' };
  }

  if (filtered.length === 0) {
    delete config.mcpServers;
  } else {
    config.mcpServers = filtered;
  }

  if (Object.keys(config).length === 0) {
    deleteFileIfExists(file);
  } else {
    writeJsonFile(file, config);
  }
  return { path: file, action: 'removed' };
}

// ── Global install (VS Code settings.json — array form) ────────────

function writeGlobalConfig(): WriteResult['files'][number] {
  const file = globalConfigPath();
  const fullPath = resolvePath(file);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });

  const existed = fs.existsSync(fullPath);
  const config = readJsonFile(file);
  const servers = (config['continue.mcpServers'] as ContinueServerEntry[] | undefined) ?? [];

  const entry = getServerEntry();
  const idx = servers.findIndex((s) => s.name === 'mcmodding');

  if (idx !== -1 && jsonDeepEqual(servers[idx], entry)) {
    return { path: file, action: 'unchanged' };
  }

  if (idx !== -1) {
    servers[idx] = entry;
  } else {
    servers.push(entry);
  }

  config['continue.mcpServers'] = servers;
  writeJsonFile(file, config);
  return { path: file, action: existed ? 'updated' : 'created' };
}

function removeGlobalConfig(): WriteResult['files'][number] {
  const file = globalConfigPath();
  if (!fs.existsSync(resolvePath(file))) {
    return { path: file, action: 'not-found' };
  }

  const config = readJsonFile(file);
  const servers = (config['continue.mcpServers'] as ContinueServerEntry[] | undefined) ?? [];
  const before = servers.length;
  const filtered = servers.filter((s) => s.name !== 'mcmodding');

  if (filtered.length === before) {
    return { path: file, action: 'not-found' };
  }

  if (filtered.length === 0) {
    delete config['continue.mcpServers'];
  } else {
    config['continue.mcpServers'] = filtered;
  }

  writeJsonFile(file, config);
  return { path: file, action: 'removed' };
}

// ── Target ─────────────────────────────────────────────────────────

class ContinueTarget implements AgentTarget {
  readonly id = 'continue' as const;
  readonly displayName = 'Continue.dev';
  readonly docsUrl = 'https://docs.continue.dev/customization/deep-dives/mcp';

  supportsLocation(_loc: InstallLocation): boolean {
    return true;
  }

  detect(loc: InstallLocation): DetectionResult {
    if (loc === 'global') {
      const file = globalConfigPath();
      const config = readJsonFile(file);
      const servers = (config['continue.mcpServers'] as ContinueServerEntry[] | undefined) ?? [];
      const alreadyConfigured = servers.some((s) => s.name === 'mcmodding');
      const installed = fs.existsSync(resolvePath(file));
      return { installed, alreadyConfigured, configPath: file };
    } else {
      const file = localConfigPath();
      const config = readJsonFile(file);
      const servers = (config.mcpServers as ContinueServerEntry[] | undefined) ?? [];
      const alreadyConfigured = servers.some((s) => s.name === 'mcmodding');
      const installed = fs.existsSync(resolvePath(file));
      return { installed, alreadyConfigured, configPath: file };
    }
  }

  install(loc: InstallLocation): WriteResult {
    const files: WriteResult['files'] = [];

    if (loc === 'global') {
      files.push(writeGlobalConfig());
    } else {
      files.push(writeLocalConfig());
    }

    const instrPath = loc === 'global' ? globalInstructionsPath() : localInstructionsPath();
    files.push({
      path: instrPath,
      action: upsertMarkedSection(
        instrPath,
        MCMODDING_SECTION_START,
        MCMODDING_SECTION_END,
        MCMODDING_INSTRUCTIONS
      ),
    });

    return { files };
  }

  uninstall(loc: InstallLocation): WriteResult {
    const files: WriteResult['files'] = [];

    if (loc === 'global') {
      files.push(removeGlobalConfig());
    } else {
      files.push(removeLocalConfig());
    }

    const instrPath = loc === 'global' ? globalInstructionsPath() : localInstructionsPath();
    files.push({
      path: instrPath,
      action: removeMarkedSection(instrPath, MCMODDING_SECTION_START, MCMODDING_SECTION_END),
    });

    return { files };
  }

  printConfig(loc: InstallLocation): string {
    const entry = getServerEntry();
    if (loc === 'global') {
      const target = globalConfigPath();
      const snippet = JSON.stringify({ 'continue.mcpServers': [entry] }, null, 2);
      return `# Add to ${target}\n\n${snippet}\n`;
    } else {
      const target = localConfigPath();
      const snippet = JSON.stringify({ mcpServers: [entry] }, null, 2);
      return `# Add to ${target}\n\n${snippet}\n`;
    }
  }

  describePaths(loc: InstallLocation): string[] {
    return loc === 'global'
      ? [globalConfigPath(), globalInstructionsPath()]
      : [localConfigPath(), localInstructionsPath()];
  }
}

import { DetectionResult } from './types.js';

export const continueTarget: AgentTarget = new ContinueTarget();

/**
 * Claude Code target. Writes:
 *
 *   - MCP server entry to `~/.claude.json` (global = user scope, loads in
 *     every project) or `./.mcp.json` (local = project scope). See
 *     https://code.claude.com/docs/en/mcp for the scope table.
 *   - Permissions to `~/.claude/settings.json` (global) or
 *     `./.claude/settings.json` (local).
 *   - Instructions to `~/.claude/CLAUDE.md` (global) or
 *     `./.claude/CLAUDE.md` (local).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { AgentTarget, DetectionResult, InstallLocation, WriteResult } from './types.js';
import {
  deleteFileIfExists,
  detectMcpCommand,
  getMcpServerConfig,
  getPermissionPatterns,
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
    ? path.join(os.homedir(), '.claude')
    : path.join(process.cwd(), '.claude');
}

function mcpJsonPath(loc: InstallLocation): string {
  return loc === 'global'
    ? path.join(os.homedir(), '.claude.json')
    : path.join(process.cwd(), '.mcp.json');
}

function settingsJsonPath(loc: InstallLocation): string {
  return path.join(configDir(loc), 'settings.json');
}

function instructionsPath(loc: InstallLocation): string {
  return path.join(configDir(loc), 'CLAUDE.md');
}

class ClaudeCodeTarget implements AgentTarget {
  readonly id = 'claude' as const;
  readonly displayName = 'Claude Code';
  readonly docsUrl = 'https://docs.claude.com/en/docs/claude-code';

  supportsLocation(_loc: InstallLocation): boolean {
    return true;
  }

  detect(loc: InstallLocation): DetectionResult {
    const mcpPath = mcpJsonPath(loc);
    const config = readJsonFile(mcpPath);
    const mcmodding = (config.mcpServers as Record<string, unknown> | undefined)?.mcmodding;
    const alreadyConfigured = mcmodding !== undefined && mcmodding !== null;

    // Infer "installed" from filesystem existence — cheap, no shelling out.
    const dirExists = fs.existsSync(resolvePath(configDir(loc)));
    const mcpExists = fs.existsSync(resolvePath(mcpPath));
    const installed = loc === 'global' ? dirExists || mcpExists : mcpExists || dirExists;

    return { installed, alreadyConfigured, configPath: mcpPath };
  }

  install(loc: InstallLocation): WriteResult {
    const files: WriteResult['files'] = [];
    const command = detectMcpCommand();

    // 1. MCP server config
    files.push(this.writeMcpEntry(loc, command));

    // 2. Permissions (auto-allow)
    files.push(this.writePermissionsEntry(loc));

    // 3. CLAUDE.md instructions
    files.push(this.writeInstructions(loc));

    return { files };
  }

  uninstall(loc: InstallLocation): WriteResult {
    const files: WriteResult['files'] = [];

    // 1. Remove MCP entry
    const mcpPath = mcpJsonPath(loc);
    const config = readJsonFile(mcpPath);
    const servers = config.mcpServers as Record<string, unknown> | undefined;
    if (servers?.mcmodding) {
      delete servers.mcmodding;
      if (Object.keys(servers).length === 0) {
        delete config.mcpServers;
      }
      // If nothing else remains in the config, delete the file entirely.
      if (Object.keys(config).length === 0) {
        deleteFileIfExists(mcpPath);
      } else {
        writeJsonFile(mcpPath, config);
      }
      files.push({ path: mcpPath, action: 'removed' });
    } else {
      files.push({ path: mcpPath, action: 'not-found' });
    }

    // 2. Remove permissions
    files.push(this.removePermissionsEntry(loc));

    // 3. Remove instructions
    files.push(this.removeInstructions(loc));

    return { files };
  }

  printConfig(loc: InstallLocation): string {
    const target = mcpJsonPath(loc);
    const command = detectMcpCommand();
    const cfg = getMcpServerConfig(command);
    const snippet = JSON.stringify({ mcpServers: { mcmodding: cfg } }, null, 2);
    return `# Add to ${target}\n\n${snippet}\n`;
  }

  describePaths(loc: InstallLocation): string[] {
    return [mcpJsonPath(loc), settingsJsonPath(loc), instructionsPath(loc)];
  }

  // ── Private helpers ──────────────────────────────────────────────

  private writeMcpEntry(loc: InstallLocation, command: string): WriteResult['files'][number] {
    const file = mcpJsonPath(loc);
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

  private writePermissionsEntry(loc: InstallLocation): WriteResult['files'][number] {
    const file = settingsJsonPath(loc);
    const created = !fs.existsSync(resolvePath(file));
    const settings = readJsonFile(file);

    if (!settings.permissions) settings.permissions = {};
    const permissions = settings.permissions as Record<string, unknown>;
    if (!Array.isArray(permissions.allow)) permissions.allow = [];

    const allow = permissions.allow as string[];
    const want = getPermissionPatterns();
    const before = [...allow];

    for (const perm of want) {
      if (!allow.includes(perm)) {
        allow.push(perm);
      }
    }

    if (jsonDeepEqual(before, allow) && !created) {
      return { path: file, action: 'unchanged' };
    }

    writeJsonFile(file, settings);
    return { path: file, action: created ? 'created' : 'updated' };
  }

  private removePermissionsEntry(loc: InstallLocation): WriteResult['files'][number] {
    const file = settingsJsonPath(loc);
    if (!fs.existsSync(resolvePath(file))) {
      return { path: file, action: 'not-found' };
    }

    const settings = readJsonFile(file);
    const permObj = settings.permissions as Record<string, unknown> | undefined;
    if (!permObj || !Array.isArray(permObj.allow)) {
      return { path: file, action: 'not-found' };
    }

    const allow = permObj.allow as string[];
    const before = allow.length;
    const filtered = allow.filter((p: string) => !p.startsWith('mcp__mcmodding__'));

    if (filtered.length === before) {
      return { path: file, action: 'not-found' };
    }

    permObj.allow = filtered;

    // Clean up empty containers.
    if (filtered.length === 0) {
      delete permObj.allow;
    }
    if (Object.keys(permObj).length === 0) {
      delete settings.permissions;
    }

    // If nothing else remains in settings, delete the file entirely.
    if (Object.keys(settings).length === 0) {
      deleteFileIfExists(file);
    } else {
      writeJsonFile(file, settings);
    }
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

export const claudeTarget: AgentTarget = new ClaudeCodeTarget();

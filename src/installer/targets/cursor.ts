/**
 * Cursor target.
 *
 * Cursor reads MCP server config from:
 *   - Global: ~/.cursor/mcp.json
 *   - Local:  ./.cursor/mcp.json  (project-level)
 *
 * Cursor rules (instructions) live in:
 *   - Global: ~/.cursorrules
 *   - Local:  ./.cursor/rules/*.mdc  (individual rule files)
 *
 * We write a marker-fenced section into the rules files so uninstall
 * can surgically remove just our contribution.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { AgentTarget, DetectionResult, InstallLocation, WriteResult } from './types.js';
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

function mcpJsonPath(loc: InstallLocation): string {
  return loc === 'global'
    ? path.join(os.homedir(), '.cursor', 'mcp.json')
    : path.join(process.cwd(), '.cursor', 'mcp.json');
}

function rulesPath(loc: InstallLocation): string {
  return loc === 'global'
    ? path.join(os.homedir(), '.cursorrules')
    : path.join(process.cwd(), '.cursor', 'rules', 'mcmodding.mdc');
}

class CursorTarget implements AgentTarget {
  readonly id = 'cursor' as const;
  readonly displayName = 'Cursor';
  readonly docsUrl = 'https://docs.cursor.com/context/rules';

  supportsLocation(_loc: InstallLocation): boolean {
    return true;
  }

  detect(loc: InstallLocation): DetectionResult {
    const mcpPath = mcpJsonPath(loc);
    const config = readJsonFile(mcpPath);
    const mcmodding = (config.mcpServers as Record<string, unknown> | undefined)?.mcmodding;
    const alreadyConfigured = mcmodding !== undefined && mcmodding !== null;

    const mcpExists = fs.existsSync(resolvePath(mcpPath));
    const cursorDir =
      loc === 'global' ? path.join(os.homedir(), '.cursor') : path.join(process.cwd(), '.cursor');
    const dirExists = fs.existsSync(resolvePath(cursorDir));
    const installed = loc === 'global' ? dirExists || mcpExists : mcpExists || dirExists;

    return { installed, alreadyConfigured, configPath: mcpPath };
  }

  install(loc: InstallLocation): WriteResult {
    const files: WriteResult['files'] = [];
    const command = detectMcpCommand();

    files.push(this.writeMcpEntry(loc, command));
    files.push(this.writeRules(loc));

    return { files };
  }

  uninstall(loc: InstallLocation): WriteResult {
    const files: WriteResult['files'] = [];

    // Remove MCP entry
    const mcpPath = mcpJsonPath(loc);
    const config = readJsonFile(mcpPath);
    const servers = config.mcpServers as Record<string, unknown> | undefined;
    if (servers?.mcmodding) {
      delete servers.mcmodding;
      if (Object.keys(servers).length === 0) {
        delete config.mcpServers;
      }
      writeJsonFile(mcpPath, config);
      files.push({ path: mcpPath, action: 'removed' });
    } else {
      files.push({ path: mcpPath, action: 'not-found' });
    }

    // Remove rules
    files.push(this.removeRules(loc));

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
    return [mcpJsonPath(loc), rulesPath(loc)];
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

  private writeRules(loc: InstallLocation): WriteResult['files'][number] {
    const file = rulesPath(loc);

    // For local .mdc files, prepend YAML frontmatter (Cursor rule format).
    const content =
      loc === 'local'
        ? `---\ndescription: Minecraft modding documentation (mcmodding-mcp)\nglobs:\nalwaysApply: true\n---\n\n${MCMODDING_INSTRUCTIONS}`
        : MCMODDING_INSTRUCTIONS;

    const action = upsertMarkedSection(
      file,
      MCMODDING_SECTION_START,
      MCMODDING_SECTION_END,
      content
    );
    return { path: file, action };
  }

  private removeRules(loc: InstallLocation): WriteResult['files'][number] {
    const file = rulesPath(loc);
    const action = removeMarkedSection(file, MCMODDING_SECTION_START, MCMODDING_SECTION_END);
    return { path: file, action };
  }
}

export const cursorTarget: AgentTarget = new CursorTarget();

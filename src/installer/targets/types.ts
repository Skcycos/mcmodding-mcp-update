/**
 * Agent target abstraction for the mcmodding-mcp installer.
 *
 * Each MCP-capable AI agent (Claude Code, Cursor, ...) implements this
 * interface so the installer orchestrator can write the right MCP-server
 * config + instructions file for that agent without baking client-specific
 * paths into core code. Adding a new agent = one new file in `targets/`
 * + one entry in `registry.ts`.
 */

export type InstallLocation = 'global' | 'local';

/**
 * Result of `target.detect(location)`.
 *
 * `installed` is a best-effort heuristic that the agent's CLI / app /
 * config dir is present on this system — used to default the multiselect
 * prompt to "what's actually here." False positives are acceptable
 * (we still write); false negatives just mean the user has to opt in manually.
 *
 * `alreadyConfigured` reports whether mcmodding-mcp has already been
 * wired into this target at this location.
 */
export interface DetectionResult {
  installed: boolean;
  alreadyConfigured: boolean;
  /** Path inspected; surfaced in diagnostic / dry-run output. */
  configPath?: string;
}

/**
 * What `target.install(location)` actually changed on disk. The orchestrator
 * renders one log line per file using `action`.
 *
 * `unchanged` means we touched the file but its contents were already what
 * we'd write — used for byte-identical idempotent re-runs.
 */
export interface WriteResult {
  files: Array<{
    path: string;
    action: 'created' | 'updated' | 'unchanged' | 'removed' | 'not-found' | 'kept';
  }>;
  /**
   * Optional one-line notes the orchestrator surfaces verbatim — e.g.
   * "Restart Cursor to apply." Keep these short.
   */
  notes?: string[];
}

export interface AgentTarget {
  /** Stable id; used in the `--target` CLI flag and registry lookup. */
  readonly id: string;
  /** Human-readable name shown in clack prompts and log lines. */
  readonly displayName: string;
  /** Optional URL for "where do I learn more about this agent." */
  readonly docsUrl?: string;
  /**
   * Whether this target supports the given install location.
   * Some agents have no project-local config concept — returning false
   * lets the orchestrator skip cleanly with a clear message.
   */
  supportsLocation(loc: InstallLocation): boolean;
  detect(loc: InstallLocation): DetectionResult;
  install(loc: InstallLocation): WriteResult;
  /** Inverse of install. Removes only what install would have written. */
  uninstall(loc: InstallLocation): WriteResult;
  /** Print the MCP-server snippet a user would paste manually. No filesystem writes. */
  printConfig(loc: InstallLocation): string;
  /** Filesystem paths this target would write to at this location. */
  describePaths(loc: InstallLocation): string[];
}

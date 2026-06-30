/**
 * Interactive agent installer for mcmodding-mcp.
 *
 * Run via `mcmodding-mcp install`. Walks the user through:
 *   1. Multi-select which AI agents to configure (auto-detected pre-checked)
 *   2. Choose global (all projects) vs local (this project)
 *   3. Optionally auto-allow permissions (Claude Code)
 *   4. Per-target install with file-level reporting
 *   5. Next-step note pointing to `mcmodding-mcp manage`
 *
 * Non-interactive flags (--yes, --target, --location, --print-config)
 * enable CI / scripting usage.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { AgentTarget, InstallLocation } from './targets/types.js';
import { ALL_TARGETS, detectAll, resolveTargetFlag } from './targets/registry.js';

// ── Small helpers ──────────────────────────────────────────────────

/**
 * Like Array.prototype.find but throws if no match. Use when the match
 * is guaranteed by construction (e.g. mapping ALL_TARGETS over detectAll
 * which covers every target) so we don't need a runtime null check.
 */
function mustFind<T>(arr: T[], pred: (item: T) => boolean): T {
  const found = arr.find(pred);
  if (found === undefined) {
    throw new Error('mustFind: no matching element (this is a bug)');
  }
  return found;
}

// ── @clack/prompts types (subset we use) ───────────────────────────
// @clack/prompts is ESM-only and its typings don't survive tsc's CJS
// rewrite under moduleResolution "node", so we declare the tiny
// surface we use and dynamic-import it via a Function constructor.

interface ClackModule {
  intro: (title: string) => void;
  outro: (message: string) => void;
  cancel: (message: string) => void;
  note: (message: string, title?: string) => void;
  log: {
    success: (message: string) => void;
    info: (message: string) => void;
    warn: (message: string) => void;
    error: (message: string) => void;
  };
  isCancel: (value: unknown) => value is symbol;
  multiselect: <T>(opts: {
    message: string;
    options: Array<{ value: T; label: string; hint?: string }>;
    initialValues?: T[];
    required?: boolean;
  }) => Promise<symbol | T[]>;
  select: <T>(opts: {
    message: string;
    options: Array<{ value: T; label: string; hint?: string }>;
    initialValue?: T;
  }) => Promise<symbol | T>;
  confirm: (opts: { message: string; initialValue?: boolean }) => Promise<symbol | boolean>;
}

// eslint-disable-next-line @typescript-eslint/no-implied-eval
const importESM = new Function('specifier', 'return import(specifier)') as (
  specifier: string
) => Promise<ClackModule>;

async function getClack(): Promise<ClackModule> {
  return importESM('@clack/prompts');
}

// ── CLI flag parsing ──────────────────────────────────────────────

interface CliOptions {
  yes: boolean;
  target: string | null; // 'auto' | 'all' | 'none' | csv | null (prompt)
  location: InstallLocation | null; // 'global' | 'local' | null (prompt)
  printConfig: string | null; // target id | null
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    yes: false,
    target: null,
    location: null,
    printConfig: null,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';

    if (arg === '--yes' || arg === '-y') {
      opts.yes = true;
    } else if (arg === '--target' && argv[i + 1]) {
      opts.target = argv[++i] ?? null;
    } else if (arg.startsWith('--target=')) {
      opts.target = arg.slice('--target='.length);
    } else if (arg === '--location' && argv[i + 1]) {
      opts.location = (argv[++i] as InstallLocation) ?? null;
    } else if (arg.startsWith('--location=')) {
      opts.location = arg.slice('--location='.length) as InstallLocation;
    } else if (arg === '--print-config' && argv[i + 1]) {
      opts.printConfig = argv[++i] ?? null;
    }
  }

  return opts;
}

// ── Version helper ─────────────────────────────────────────────────

function getVersion(): string {
  try {
    const pkgPath = path.join(__dirname, '..', '..', 'package.json');
    const raw = fs.readFileSync(pkgPath, 'utf-8');
    const pkg = JSON.parse(raw) as { version: string };
    return pkg.version;
  } catch {
    return '0.0.0';
  }
}

// ── Action label ───────────────────────────────────────────────────

function actionLabel(action: string): string {
  switch (action) {
    case 'created':
      return '  ✔ created';
    case 'updated':
      return '  ✔ updated';
    case 'unchanged':
      return '  · unchanged';
    case 'removed':
      return '  ✖ removed';
    case 'not-found':
      return '  · not found';
    case 'kept':
      return '  · kept';
    default:
      return `  · ${action}`;
  }
}

// ── Main entry ─────────────────────────────────────────────────────

export async function runInstaller(): Promise<void> {
  const opts = parseArgs(process.argv);
  const clack = await getClack();

  // --print-config mode: just print a snippet and exit, no UI.
  if (opts.printConfig) {
    const target = ALL_TARGETS.find((t) => t.id === opts.printConfig);
    if (!target) {
      console.error(
        `Unknown agent "${opts.printConfig}". Known: ${ALL_TARGETS.map((t) => t.id).join(', ')}`
      );
      process.exit(1);
    }
    const loc: InstallLocation = opts.location ?? 'global';
    process.stdout.write(target.printConfig(loc));
    return;
  }

  clack.intro(`mcmodding-mcp v${getVersion()}`);

  // ── Step 1: Choose agents ────────────────────────────────────────

  const location: InstallLocation = opts.location ?? 'global';
  const detected = detectAll(location);
  const initialValues = detected
    .filter(({ detection }) => detection.installed)
    .map(({ target }) => target.id);

  let targets: AgentTarget[];

  if (opts.yes || opts.target) {
    const flag = opts.target ?? 'auto';
    try {
      targets = resolveTargetFlag(flag, location);
    } catch (err) {
      clack.log.error((err as Error).message);
      process.exit(1);
    }
  } else {
    const choice = await clack.multiselect<string>({
      message: 'Which agents should mcmodding-mcp configure?',
      options: ALL_TARGETS.map((t) => {
        const det = mustFind(detected, ({ target: tg }) => tg.id === t.id).detection;
        const flag = det.installed ? '(detected)' : '(not found)';
        const globalOnly = !t.supportsLocation('local') ? ' — global only' : '';
        return {
          value: t.id,
          label: `${t.displayName} ${flag}${globalOnly}`,
        };
      }),
      initialValues: initialValues.length > 0 ? initialValues : ['claude'],
      required: false,
    });

    if (clack.isCancel(choice)) {
      clack.cancel('Installation cancelled.');
      process.exit(0);
    }

    if (choice.length === 0) {
      clack.cancel('No agents selected. Nothing to do.');
      process.exit(0);
    }

    targets = choice
      .map((id) => ALL_TARGETS.find((t) => t.id === id))
      .filter((t): t is AgentTarget => t !== undefined);
  }

  if (targets.length === 0) {
    clack.outro('No agents selected. Nothing to do.');
    return;
  }

  // ── Step 2: Global vs Local ──────────────────────────────────────

  let installLocation: InstallLocation;

  if (opts.yes || opts.location) {
    installLocation = opts.location ?? 'global';
  } else {
    // If all targets are global-only, skip the prompt.
    const allGlobalOnly = targets.every((t) => !t.supportsLocation('local'));

    if (allGlobalOnly) {
      installLocation = 'global';
      clack.log.info('All selected agents support global-only config — applying globally.');
    } else {
      const sel = await clack.select<InstallLocation>({
        message: 'Apply agent configs to all your projects, or just this one?',
        options: [
          {
            value: 'global',
            label: 'All projects',
            hint: '~/.claude, ~/.cursor, etc.',
          },
          {
            value: 'local',
            label: 'Just this project',
            hint: './.claude, ./.cursor, etc.',
          },
        ],
        initialValue: 'global',
      });

      if (clack.isCancel(sel)) {
        clack.cancel('Installation cancelled.');
        process.exit(0);
      }

      installLocation = sel;
    }
  }

  // ── Step 3: Confirm auto-allow permissions? (Claude only) ─────────
  // Permissions are always written by the Claude target (idempotently);
  // this prompt is just a heads-up / opt-out.

  const hasClaude = targets.some((t) => t.id === 'claude');

  if (hasClaude && !opts.yes) {
    const ans = await clack.confirm({
      message: 'Auto-allow mcmodding-mcp tools? (Skips permission prompts in Claude Code)',
      initialValue: true,
    });

    if (clack.isCancel(ans)) {
      clack.cancel('Installation cancelled.');
      process.exit(0);
    }

    // `ans === false` means user opted out; reserved for future use.
    // Currently permissions are always written (Claude Code prompts are harmless).
    void ans;
  }

  // ── Step 4: Install per target ──────────────────────────────────

  for (const target of targets) {
    clack.log.info(`Configuring ${target.displayName}...`);
    const result = target.install(installLocation);

    for (const file of result.files) {
      const relPath = path.relative(process.cwd(), file.path);
      process.stdout.write(`${actionLabel(file.action)}  ${relPath}\n`);
    }

    if (result.notes) {
      for (const note of result.notes) {
        clack.log.info(note);
      }
    }
  }

  // ── Step 5: Next steps ───────────────────────────────────────────

  const nextCmd =
    installLocation === 'local'
      ? 'npx mcmodding-mcp manage    # install documentation databases'
      : 'cd <your-project>\nnpx mcmodding-mcp manage    # install documentation databases';

  clack.note(nextCmd, 'Next: install databases');
  clack.outro('Done! Restart your agents to use mcmodding-mcp.');
}

// ── Uninstall entry ────────────────────────────────────────────────

export async function runUninstaller(): Promise<void> {
  const opts = parseArgs(process.argv);
  const clack = await getClack();

  clack.intro(`mcmodding-mcp v${getVersion()} — Uninstall`);

  const location: InstallLocation = opts.location ?? 'global';

  let targets: AgentTarget[];

  if (opts.yes || opts.target) {
    const flag = opts.target ?? 'auto';
    try {
      targets = resolveTargetFlag(flag, location);
    } catch (err) {
      clack.log.error((err as Error).message);
      process.exit(1);
    }
  } else {
    const detected = detectAll(location);
    const choice = await clack.multiselect<string>({
      message: 'Which agents should mcmodding-mcp be removed from?',
      options: ALL_TARGETS.map((t) => {
        const det = mustFind(detected, ({ target: tg }) => tg.id === t.id).detection;
        const flag = det.alreadyConfigured
          ? '(configured)'
          : det.installed
            ? '(installed)'
            : '(not found)';
        return { value: t.id, label: `${t.displayName} ${flag}` };
      }),
      initialValues: detected
        .filter(({ detection }) => detection.alreadyConfigured)
        .map(({ target: tg }) => tg.id),
      required: false,
    });

    if (clack.isCancel(choice)) {
      clack.cancel('Uninstall cancelled.');
      process.exit(0);
    }

    targets = choice
      .map((id) => ALL_TARGETS.find((t) => t.id === id))
      .filter((t): t is AgentTarget => t !== undefined);
  }

  for (const target of targets) {
    clack.log.info(`Removing from ${target.displayName}...`);
    const result = target.uninstall(location);

    for (const file of result.files) {
      const relPath = path.relative(process.cwd(), file.path);
      process.stdout.write(`${actionLabel(file.action)}  ${relPath}\n`);
    }
  }

  clack.outro('Uninstall complete.');
}

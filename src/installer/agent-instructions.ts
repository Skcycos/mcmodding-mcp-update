/**
 * Marker-fenced instruction block injected into agent instruction files
 * (e.g. CLAUDE.md for Claude Code, AGENTS.md for others).
 *
 * The markers let us upsert idempotently: re-running the installer replaces
 * the block in-place rather than appending duplicates, and uninstalling
 * removes just this block while preserving the rest of the file.
 */

export const MCMODDING_SECTION_START = '<!-- MCMODDING_MCP_START -->';
export const MCMODDING_SECTION_END = '<!-- MCMODDING_MCP_END -->';

/**
 * The instruction block content (without markers). Kept separate so
 * targets that wrap it in a file-format-specific way (e.g. Cursor rules)
 * can reuse the same copy.
 */
export const MCMODDING_INSTRUCTIONS = `## MCModding-MCP

You are connected to **mcmodding-mcp**, an MCP server that provides real,
up-to-date Minecraft modding documentation for Fabric and NeoForge.

**DO NOT rely on your internal knowledge** for modding APIs (Fabric/NeoForge)
as they change frequently. **ALWAYS** use the available tools:

- \`search_fabric_docs\` and \`get_example\` for documentation and code patterns
- \`search_mappings\` and \`get_class_details\` for Minecraft internals and method signatures
- \`search_mod_examples\` for battle-tested implementations from popular mods

Prioritize working code examples over theoretical explanations. When dealing
with Minecraft internals, use the mappings tools to get accurate parameter
names and Javadocs. If the user specifies a Minecraft version, ensure all
retrieved information matches that version.`;

/**
 * Wraps the instructions in the markers. This is what gets upserted into
 * the agent's instruction file.
 */
export function getMarkedInstructions(): string {
  return `${MCMODDING_SECTION_START}\n${MCMODDING_INSTRUCTIONS}\n${MCMODDING_SECTION_END}`;
}

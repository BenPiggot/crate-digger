// Entry point for the TypeScript port. The core (step 2), MCP server (step 3) and
// web backend (step 5) will be wired up from here; see PLAN.md.

export const VERSION = "0.1.0";

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(`crate-digger ${VERSION}`);
}

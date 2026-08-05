/**
 * Compaction feature entry point.
 *
 * Re-exports the coordinator default export so the feature follows the
 * extensions/<feature>/index.ts convention (default export of the extension
 * wiring function).
 */
export { default } from "./coordinator.ts";

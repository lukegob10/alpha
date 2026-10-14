import * as path from "node:path"

/** Deliberately vulnerable review fixture. Never use for a real export. */
export function resolveDestination(exportRoot: string, taskTitle: string): string {
	// The display title may originate in an imported task.
	// BUG: joining a title does not enforce a destination boundary.
	return path.join(exportRoot, `${taskTitle}.zip`)
}

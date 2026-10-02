import { promises as fs } from "node:fs"
import { createRequire } from "node:module"
import * as path from "node:path"
import { pathToFileURL } from "node:url"

const { require: tsRequire } = createRequire(__filename)("tsx/cjs/api") as {
	require(specifier: string, from: string): unknown
}

interface FixtureChange {
	type: "add" | "delete" | "update"
	path: string
	movePath?: string
	newContent?: string
}

function fixturePath(workspace: string, file: string): string {
	const resolved = path.resolve(workspace, file)
	const relative = path.relative(workspace, resolved)
	if (!relative || path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`))
		throw new Error("Scripted patch escapes its fixture workspace")
	return resolved
}

/** Exercise the extension's pure patch parser/applicator without importing its VS Code runtime into Node tests. */
export async function applyFixturePatch(workspace: string, patch: unknown): Promise<void> {
	if (typeof patch !== "string") throw new Error("Scripted patch must be a string")
	const source = path.resolve(__dirname, "../../../../src/core/tools/apply-patch")
	const parent = pathToFileURL(__filename).href
	const parser = tsRequire(path.join(source, "parser.ts"), parent) as {
		parsePatch(patch: string): { hunks: unknown[] }
	}
	const applicator = tsRequire(path.join(source, "apply.ts"), parent) as {
		processAllHunks(hunks: unknown[], read: (file: string) => Promise<string>): Promise<FixtureChange[]>
	}
	const changes = await applicator.processAllHunks(parser.parsePatch(patch).hunks, (file) =>
		fs.readFile(fixturePath(workspace, file), "utf8"),
	)
	for (const change of changes) {
		if (change.type === "delete" || change.movePath) throw new Error("Fixture scripts do not remove or move files")
		const target = fixturePath(workspace, change.path)
		if (typeof change.newContent !== "string") throw new Error("Scripted patch has no resulting content")
		await fs.mkdir(path.dirname(target), { recursive: true })
		await fs.writeFile(target, change.newContent, { encoding: "utf8", flag: change.type === "add" ? "wx" : "w" })
	}
}

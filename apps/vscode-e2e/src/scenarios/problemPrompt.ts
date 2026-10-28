import * as fs from "node:fs/promises"
import * as path from "node:path"
import { readBounded, rejectSymlinkComponents, isWithin } from "../evidence/paths"

export function validateProblemPromptPath(value: unknown): string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > 1024 ||
		value.includes("\0") ||
		value.includes(":") ||
		value.includes("\\") ||
		value.split("/").some((part) => !part || part === "." || part === "..") ||
		path.posix.isAbsolute(value) ||
		path.win32.isAbsolute(value)
	)
		throw new Error("Invalid problem-solving prompt path")
	return value
}

export async function readProblemPrompt(workspace: string, relative = "prompt.md"): Promise<string> {
	const root = await fs.realpath(workspace)
	const target = path.resolve(root, validateProblemPromptPath(relative))
	if (!isWithin(root, target)) throw new Error("Problem-solving prompt escaped its workspace")
	await rejectSymlinkComponents(target)
	const bytes = await readBounded(target, 100_000)
	if (!bytes.length) throw new Error("Problem-solving prompt is empty")
	return bytes.toString("utf8")
}

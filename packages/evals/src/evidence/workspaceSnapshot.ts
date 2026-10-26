import fs from "node:fs/promises"
import path from "node:path"
import { z } from "zod"

import { canonicalJson, sha256 } from "./canonical"

const maxFiles = 2000
const maxFileBytes = 4 * 1024 * 1024
const maxTotalBytes = 32 * 1024 * 1024

export function workspaceSnapshotPath(value: string): boolean {
	return (
		value.length > 0 &&
		value.length <= 2048 &&
		!path.posix.isAbsolute(value) &&
		!path.win32.isAbsolute(value) &&
		!value.includes("\\") &&
		!value
			.split("/")
			.some(
				(part) =>
					!part ||
					part === "." ||
					part === ".." ||
					part === ".git" ||
					/[\0:\r\n]/.test(part) ||
					/[. ]$/.test(part) ||
					/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
			)
	)
}

const snapshotSchema = z
	.object({
		schemaVersion: z.literal(1),
		excludedDirectories: z.array(z.literal("node_modules")).max(1).optional(),
		baselineCommit: z
			.string()
			.regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
			.optional(),
		files: z
			.array(
				z
					.object({
						path: z.string().refine(workspaceSnapshotPath),
						bytesBase64: z.string().max(Math.ceil(maxFileBytes / 3) * 4),
						digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
						executable: z.boolean(),
					})
					.strict(),
			)
			.max(maxFiles),
	})
	.strict()

export type WorkspaceSnapshot = z.infer<typeof snapshotSchema>

export function parseWorkspaceSnapshot(value: unknown): WorkspaceSnapshot {
	const snapshot = snapshotSchema.parse(value)
	const paths = new Set<string>()
	let total = 0
	for (const file of snapshot.files) {
		const bytes = Buffer.from(file.bytesBase64, "base64")
		if (
			bytes.toString("base64") !== file.bytesBase64 ||
			bytes.length > maxFileBytes ||
			sha256(bytes) !== file.digest
		)
			throw new Error("Workspace snapshot bytes do not match their content identity")
		if (paths.has(file.path.toLowerCase())) throw new Error("Workspace snapshot has colliding paths")
		paths.add(file.path.toLowerCase())
		total += bytes.length
		if (total > maxTotalBytes) throw new Error("Workspace snapshot exceeds its byte bound")
	}
	return snapshot
}

export function workspaceSnapshotTreeDigest(snapshot: WorkspaceSnapshot): string {
	return sha256(
		canonicalJson(
			snapshot.files
				.map((file) => ({ path: file.path, digest: file.digest }))
				.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
		),
	)
}

/** Restore into a new directory; never merge with or overwrite a reviewer's existing files. */
export async function restoreWorkspaceSnapshot(value: unknown, destination: string): Promise<void> {
	const snapshot = parseWorkspaceSnapshot(value)
	await fs.mkdir(destination)
	for (const file of snapshot.files) {
		const target = path.resolve(destination, file.path)
		const relative = path.relative(destination, target)
		if (relative.startsWith("..") || path.isAbsolute(relative))
			throw new Error("Workspace snapshot escaped destination")
		await fs.mkdir(path.dirname(target), { recursive: true })
		await fs.writeFile(target, Buffer.from(file.bytesBase64, "base64"), {
			flag: "wx",
			mode: file.executable ? 0o700 : 0o600,
		})
	}
}

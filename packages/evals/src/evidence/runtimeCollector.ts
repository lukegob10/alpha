import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import type { HarnessProcessRunner } from "../orchestration/index"
import type { ContentAddressedArtifactStore } from "./artifactStore"
import { collectRequiredEvidence, type CaptureStatuses, type RequiredEvidence } from "./collector"
import type { ArtifactDescriptor } from "./types"
import { canonicalJson, sha256 } from "./canonical"
import { containsSecret } from "./redaction"
import {
	parseWorkspaceSnapshot,
	workspaceSnapshotPath,
	workspaceSnapshotTreeDigest,
	type WorkspaceSnapshot,
} from "./workspaceSnapshot"

export type WorkspaceEvidenceInput = {
	attemptId: string
	workspace: string
	extensionLog?: string
	transcript?: string
	finalResponse?: string
	testOutput?: string
	usage?: unknown
	stopReason: string
	processRunner: HarnessProcessRunner
	store: ContentAddressedArtifactStore
	secrets?: string[]
	baselineCommit?: string
	captureStatuses?: CaptureStatuses
}

export async function collectWorkspaceEvidence(input: WorkspaceEvidenceInput): Promise<ArtifactDescriptor[]> {
	const [diff, status, snapshot] = await Promise.all([
		runGit(input, [
			"diff",
			"--binary",
			"--no-ext-diff",
			...(input.baselineCommit ? [input.baselineCommit, "--"] : []),
		]),
		runGit(input, ["status", "--short", "--untracked-files=all"]),
		captureWorkspaceSnapshot(input),
	])
	const evidence: RequiredEvidence = {
		final_diff: diff,
		git_status: status,
		tree_digest: workspaceSnapshotTreeDigest(snapshot),
		transcript: input.transcript,
		final_response: input.finalResponse,
		test_output: input.testOutput,
		extension_log: input.extensionLog,
		environment_manifest: {
			platform: process.platform,
			architecture: process.arch,
			node: process.version,
			hostname: os.hostname(),
			workspace: path.basename(input.workspace),
			runnerImageId: process.env.EVALS_RUNNER_IMAGE_ID ?? "local-process",
			runnerImageDigests: (process.env.EVALS_RUNNER_IMAGE_DIGESTS ?? "").split(",").filter(Boolean),
			dockerVersion: process.env.EVALS_DOCKER_VERSION ?? "local-process",
			networkMode: process.env.EVALS_NETWORK_MODE ?? "host",
			cpus: Number(process.env.EVALS_CPU_LIMIT ?? 0),
			memoryBytes: Number(process.env.EVALS_MEMORY_LIMIT ?? 0),
			pids: Number(process.env.EVALS_PIDS_LIMIT ?? 0),
			concurrency: Number(process.env.EVALS_CONCURRENCY ?? 1),
			permissionProfileDigest: process.env.EVALS_PERMISSION_PROFILE_DIGEST ?? "local-process",
		},
		usage: input.usage !== null && typeof input.usage === "object" ? input.usage : undefined,
		stop_reason: input.stopReason,
	}
	const descriptors = await collectRequiredEvidence(input.attemptId, evidence, input.store, {
		secrets: input.secrets,
		captureStatuses: input.captureStatuses,
	})
	descriptors.push(
		await input.store.put({
			attemptId: input.attemptId,
			kind: "workspace_snapshot",
			bytes: Buffer.from(JSON.stringify(snapshot)),
			mediaType: "application/json",
			access: "reviewer",
		}),
	)
	return descriptors
}

async function captureWorkspaceSnapshot(
	input: Pick<WorkspaceEvidenceInput, "workspace" | "processRunner" | "baselineCommit" | "secrets">,
): Promise<WorkspaceSnapshot> {
	const root = await fs.realpath(input.workspace)
	// A model-edited .gitignore must not hide final implementation bytes. Installed
	// dependencies are reproducible from the retained manifests and are excluded explicitly.
	const listing = await runGit(input, ["ls-files", "--cached", "--others", "--exclude=node_modules/", "-z"])
	const snapshot: WorkspaceSnapshot = {
		schemaVersion: 1,
		baselineCommit: input.baselineCommit,
		excludedDirectories: ["node_modules"],
		files: [],
	}
	let total = 0
	for (const relative of [...new Set(listing.split("\0").filter(Boolean))].sort()) {
		if (!workspaceSnapshotPath(relative)) throw new Error("Invalid workspace snapshot path")
		const file = path.resolve(root, relative)
		let metadata
		try {
			let component = root
			for (const part of relative.split("/")) {
				component = path.join(component, part)
				if ((await fs.lstat(component)).isSymbolicLink())
					throw new Error("Workspace snapshot cannot follow symlinks")
			}
			metadata = await fs.lstat(file)
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
			throw error
		}
		if (!metadata.isFile() || metadata.size > 4 * 1024 * 1024 || snapshot.files.length >= 2000)
			throw new Error("Workspace snapshot file bound exceeded")
		const bytes = await fs.readFile(file)
		total += bytes.length
		if (total > 32 * 1024 * 1024 || bytes.length > 4 * 1024 * 1024)
			throw new Error("Workspace snapshot byte bound exceeded")
		if (containsSecret(bytes.toString("utf8"), input.secrets ?? []))
			throw new Error("Workspace snapshot contains protected secret material")
		snapshot.files.push({
			path: relative,
			bytesBase64: bytes.toString("base64"),
			digest: sha256(bytes),
			executable: Boolean(metadata.mode & 0o111),
		})
	}
	return parseWorkspaceSnapshot(snapshot)
}

export async function digestWorkspaceTree(
	input: Pick<WorkspaceEvidenceInput, "workspace" | "processRunner">,
): Promise<string> {
	const listing = await runGit(input, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"])
	const entries: { path: string; digest: string }[] = []
	for (const relative of listing.split("\0").filter(Boolean).sort()) {
		let bytes: Buffer
		try {
			bytes = await fs.readFile(path.join(input.workspace, relative))
		} catch (error) {
			// The index still lists tracked files deleted from the final workspace.
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
			throw error
		}
		entries.push({ path: relative.replaceAll(path.sep, "/"), digest: sha256(bytes) })
	}
	return sha256(canonicalJson(entries))
}

export async function readEvidenceLog(logPath: string): Promise<string> {
	try {
		return await fs.readFile(logPath, "utf8")
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return ""
		throw error
	}
}

/** Missing evidence remains distinguishable from an existing, legitimately empty capture. */
export async function readOptionalEvidenceLog(logPath: string): Promise<string | undefined> {
	try {
		return await fs.readFile(logPath, "utf8")
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
		throw error
	}
}

export async function readJsonLines(file: string): Promise<unknown[]> {
	const contents = await readEvidenceLog(file)
	return contents
		.split(/\r?\n/)
		.filter(Boolean)
		.map((line) => JSON.parse(line) as unknown)
}

export function extractFinalResponse(serializedUiMessages: string): string {
	if (!serializedUiMessages.trim()) return ""
	try {
		const strings: string[] = []
		collectResponseStrings(JSON.parse(serializedUiMessages), strings)
		return strings.at(-1) ?? ""
	} catch {
		return ""
	}
}

function collectResponseStrings(value: unknown, output: string[]): void {
	if (Array.isArray(value)) {
		for (const child of value) collectResponseStrings(child, output)
		return
	}
	if (!value || typeof value !== "object") return
	for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
		if (["text", "content", "response"].includes(key) && typeof child === "string" && child.trim())
			output.push(child)
		else collectResponseStrings(child, output)
	}
}

async function runGit(
	input: Pick<WorkspaceEvidenceInput, "workspace" | "processRunner">,
	args: string[],
): Promise<string> {
	const result = await input.processRunner.run({
		command: "git",
		args,
		cwd: input.workspace,
		timeoutMs: 30_000,
		maxOutputBytes: 10 * 1024 * 1024,
	})
	if (result.timedOut || result.exitCode !== 0 || result.outputTruncated)
		throw new Error(`git ${args[0]} evidence is incomplete`)
	return result.stdout
}

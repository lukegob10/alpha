import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import type { HarnessProcessRunner } from "../orchestration/index"
import type { ContentAddressedArtifactStore } from "./artifactStore"
import { collectRequiredEvidence, type RequiredEvidence } from "./collector"
import type { ArtifactDescriptor } from "./types"
import { canonicalJson, sha256 } from "./canonical"

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
}

export async function collectWorkspaceEvidence(input: WorkspaceEvidenceInput): Promise<ArtifactDescriptor[]> {
	const [diff, status, tree] = await Promise.all([
		runGit(input, ["diff", "--binary", "--no-ext-diff"]),
		runGit(input, ["status", "--short", "--untracked-files=all"]),
		digestWorkspaceTree(input),
	])
	const evidence: RequiredEvidence = {
		final_diff: diff,
		git_status: status,
		tree_digest: tree.trim(),
		transcript: input.transcript ?? input.extensionLog ?? "",
		final_response: input.finalResponse ?? "",
		test_output: input.testOutput ?? "",
		extension_log: input.extensionLog ?? "",
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
		usage: input.usage ?? {},
		stop_reason: input.stopReason,
	}
	return collectRequiredEvidence(input.attemptId, evidence, input.store, { secrets: input.secrets })
}

export async function digestWorkspaceTree(
	input: Pick<WorkspaceEvidenceInput, "workspace" | "processRunner">,
): Promise<string> {
	const listing = await runGit(input, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"])
	const entries: { path: string; digest: string }[] = []
	for (const relative of listing.split("\0").filter(Boolean).sort()) {
		const bytes = await fs.readFile(path.join(input.workspace, relative))
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
	if (result.timedOut || result.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr}`)
	return result.stdout
}

import fs from "node:fs/promises"

import type { HarnessProcessRunner } from "../orchestration/index"
import { canonicalJson, sha256 } from "./canonical"
import {
	manifestIdentity,
	taskManifestSchema,
	variantManifestSchema,
	type TaskManifest,
	type VariantManifest,
} from "./manifests"
import { digestWorkspaceTree } from "./runtimeCollector"

export type RuntimeIdentities = {
	taskIdentity: string
	variantIdentity: string
	taskManifest: TaskManifest
	variantManifest: VariantManifest
}

export async function createRuntimeIdentities(input: {
	taskId: string
	taskManifest?: {
		id: string
		version: number
		capabilities: string[]
		risk: "low" | "medium" | "high" | "critical"
		graders: Array<{ id: string; version: number }>
	}
	workspace: string
	promptFiles: string[]
	model: string
	settings: unknown
	processRunner: HarnessProcessRunner
	network: "disabled" | "restricted" | "enabled"
}): Promise<RuntimeIdentities> {
	const fixtureDigest = await digestWorkspaceTree({ workspace: input.workspace, processRunner: input.processRunner })
	const prompt = await readFirst(input.promptFiles)
	const commit = await gitValue(input.processRunner, input.workspace, ["rev-parse", "HEAD"])
	const status = await gitValue(input.processRunner, input.workspace, [
		"status",
		"--porcelain=v1",
		"--untracked-files=all",
	])
	const taskManifest = taskManifestSchema.parse({
		schemaVersion: 1,
		id: input.taskManifest?.id ?? input.taskId,
		version: input.taskManifest?.version ?? 1,
		fixtureDigest,
		capabilities: input.taskManifest?.capabilities ?? ["coding", "workspace_editing", "validation"],
		risk: input.taskManifest?.risk ?? "medium",
		network: input.network,
		graders: input.taskManifest?.graders ?? [{ id: "visible-tests", version: 1 }],
	})
	const variantManifest = variantManifestSchema.parse({
		schemaVersion: 1,
		id: `runtime-${input.model}`,
		extensionCommit: commit || "working-tree",
		workingTreeDigest: sha256(canonicalJson({ commit, status })),
		model: input.model,
		promptDigest: sha256(prompt),
		toolSchemaDigest: sha256(canonicalJson(input.settings ?? {})),
		runnerImageDigest: normalizeDigest(process.env.EVALS_RUNNER_IMAGE_ID ?? "local-process"),
	})
	return {
		taskIdentity: manifestIdentity(taskManifest),
		variantIdentity: manifestIdentity(variantManifest),
		taskManifest,
		variantManifest,
	}
}

async function readFirst(files: string[]): Promise<string> {
	for (const file of files) {
		try {
			return await fs.readFile(file, "utf8")
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
		}
	}
	throw new Error(`No task prompt exists at ${files.join(", ")}`)
}

async function gitValue(runner: HarnessProcessRunner, workspace: string, args: string[]): Promise<string> {
	const result = await runner.run({
		command: "git",
		args,
		cwd: workspace,
		timeoutMs: 30_000,
		maxOutputBytes: 10 * 1024 * 1024,
	})
	if (result.timedOut || result.exitCode !== 0) return ""
	return result.stdout.trim()
}

function normalizeDigest(value: string): string {
	return /^sha256:[0-9a-f]{64}$/.test(value) ? value : sha256(value)
}

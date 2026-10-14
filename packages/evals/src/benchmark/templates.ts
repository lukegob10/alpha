import fs from "node:fs/promises"
import path from "node:path"

import { stringify } from "yaml"

import { canonicalJson, sha256 } from "../evidence/index"
import { benchmarkTaskManifestSchema, type BenchmarkTaskManifest } from "./contracts"

export type TaskTemplateProfile = "compact" | "medium" | "long"

export function createTaskTemplate(options: {
	id: string
	profile: TaskTemplateProfile
	partition?: "development" | "regression"
	restraint?: boolean
}): BenchmarkTaskManifest {
	const edit =
		options.profile === "compact"
			? { kind: "single-file" as const, minFiles: 1, maxFiles: 2 }
			: options.profile === "medium"
				? { kind: "multi-file" as const, minFiles: 2, maxFiles: 5 }
				: { kind: "cross-package" as const, minFiles: 3, maxFiles: 10 }
	const graders = [
		{ id: "visible-tests", version: 1, alias: "visible_tests" },
		{ id: "final-state", version: 1, alias: "final_state" },
		{ id: "diff-scope", version: 1, alias: "diff_scope" },
		{ id: "validation", version: 1, alias: "validation_after_edit" },
		{ id: "usage", version: 1, alias: "usage_limit" },
	]
	const validation = {
		commands: [{ command: "node", args: ["--test", "test/workflow.test.js"] }],
		network: "disabled" as const,
	}
	return benchmarkTaskManifestSchema.parse({
		id: options.id,
		version: 1,
		partition: options.partition ?? "development",
		admission: "draft",
		fixture: `javascript/${options.id}`,
		prompt: "prompt.md",
		repository: { upstream: "local-snapshot:authoring", commit: "unreleased" },
		family: "real-repository",
		capabilities: ["repository-discovery", "validation"],
		risk: "medium",
		difficulty:
			options.profile === "compact" ? "foundation" : options.profile === "medium" ? "challenging" : "frontier",
		contextBand: options.profile,
		editTopology: { ...edit, allowedRoots: ["src", "test"] },
		validation,
		evidenceRequirements: [
			"final_workspace",
			"changed_paths",
			"normalized_trace",
			"usage",
			"environment",
			"final_response",
			"grader_evidence",
		],
		graderReferenceDigest: sha256(canonicalJson(graders)),
		environmentDigest: sha256(canonicalJson(validation)),
		restraint: options.restraint ?? false,
		budgets:
			options.profile === "compact"
				? { wallSeconds: 300, modelCalls: 30, toolCalls: 80, costUsd: 0.15 }
				: options.profile === "medium"
					? { wallSeconds: 600, modelCalls: 60, toolCalls: 160, costUsd: 0.35 }
					: { wallSeconds: 900, modelCalls: 80, toolCalls: 220, costUsd: 0.6 },
		repetitions: { smoke: 1, scored: 1 },
		graders,
	})
}

export function createHoldoutReferenceTemplate(options: {
	id: string
	profile: TaskTemplateProfile
	bundleId: string
	bundleVersion: number
	bundleDigest: string
}): BenchmarkTaskManifest {
	const base = createTaskTemplate({ id: options.id, profile: options.profile })
	const graders = [
		{
			id: "private",
			version: 1,
			alias: "hidden_tests",
			bundleId: options.bundleId,
			bundleVersion: options.bundleVersion,
			bundleDigest: options.bundleDigest,
		},
	]
	return benchmarkTaskManifestSchema.parse({
		...base,
		partition: "holdout",
		fixture: `tasks/${options.id}/workspace`,
		graders,
		graderReferenceDigest: sha256(canonicalJson(graders)),
	})
}

export async function writeTaskTemplate(
	root: string,
	options: {
		id: string
		profile: TaskTemplateProfile
		partition?: "development" | "regression"
		restraint?: boolean
	},
) {
	const task = createTaskTemplate(options)
	const fixture = path.join(root, task.fixture)
	await fs.mkdir(path.join(fixture, "src"), { recursive: true })
	await fs.mkdir(path.join(fixture, "test"), { recursive: true })
	await fs.writeFile(
		path.join(fixture, "prompt.md"),
		`Repair ${task.id} by finding and fixing the root cause. Preserve public behavior and run the declared validation command.\n`,
	)
	await fs.writeFile(path.join(fixture, "src", "workflow.js"), "export function workflow(value) { return value }\n")
	await fs.writeFile(
		path.join(fixture, "test", "workflow.test.js"),
		"import test from 'node:test'\nimport assert from 'node:assert/strict'\nimport { workflow } from '../src/workflow.js'\ntest('workflow', () => assert.equal(workflow('value'), 'expected'))\n",
	)
	await fs.writeFile(
		path.join(fixture, "package.json"),
		JSON.stringify(
			{
				name: `alpha-${task.id}`,
				private: true,
				type: "module",
				scripts: { test: "node --test test/workflow.test.js" },
			},
			null,
			2,
		) + "\n",
	)
	await fs.writeFile(path.join(fixture, "task.template.yaml"), stringify(task, { lineWidth: 120 }))
	return { task, fixture }
}

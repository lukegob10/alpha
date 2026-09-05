import * as fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { createHash, createHmac } from "node:crypto"
import { describe, expect, it } from "vitest"

import { AgentTurnEngine, collectAgentResponse } from "../AgentTurnEngine"
import type { ApiStreamChunk } from "../../../api/transform/stream"
import { ToolScheduler, type ToolExecutionHost } from "../ToolScheduler"
import type { AgentTurnEvent } from "../AgentTurnEvents"
import { ToolRegistry } from "../../tools/ToolRegistry"
import { readWithSlice } from "../../../integrations/misc/indentation-reader"
import fixtures from "../../../../evals/proportional-scope/cases.json"

const executeFile = promisify(execFile)
const repo = path.resolve(__dirname, "../../../..")
const fixtureRoot = path.join(repo, "evals/proportional-scope")
type Phase = "discovery" | "implementation" | "validation" | "finalization"
type Category = "read" | "mutation" | "validation"
type Action = { phase: Phase; name: "read_file" | "edit_file" | "execute_command"; target: string }
type TraceRow = { sequence: number; type: string; timestamp: string; payload: unknown }

const repairs: Record<string, (source: string) => string> = {
	"src/workflow.js": (source) => source.replace(' + "!"', ""),
	"src/lifecycle.js": (source) =>
		source.replace('task.status === "completed"', '["completed", "cancelled"].includes(task.status)'),
	"src/projection.js": (source) =>
		source.replace('task.status === "completed"', '["completed", "cancelled"].includes(task.status)'),
	"src/paths.js": () =>
		'import path from "node:path"\nimport { realpathSync } from "node:fs"\nexport function isAllowed(root, candidate) {\n\tconst relative = path.relative(realpathSync(root), realpathSync(candidate))\n\treturn relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))\n}\n',
	"src/drafts.js": (source) =>
		source.replace(
			"\treturn { text:",
			'\tif (current.version !== expectedVersion) throw new Error("stale draft")\n\treturn { text:',
		),
}

function actionsFor(id: string): Action[] {
	const reads = (targets: string[]): Action[] =>
		targets.map((target) => ({ phase: "discovery", name: "read_file", target }))
	const edits = (targets: string[]): Action[] =>
		targets.map((target) => ({ phase: "implementation", name: "edit_file", target }))
	const check = (target: string): Action => ({ phase: "validation", name: "execute_command", target })
	switch (id) {
		case "conversation-only":
			return []
		case "narrow-lookup":
			return reads(["src/config.js"])
		case "small-edit":
			return [...reads(["src/workflow.js"]), ...edits(["src/workflow.js"]), check("test/workflow.test.js")]
		case "cross-component-bug":
			return [
				...reads(["src/lifecycle.js", "src/projection.js"]),
				...edits(["src/lifecycle.js", "src/projection.js"]),
				check("test/lifecycle.test.js"),
			]
		case "security-change":
			return [...reads(["src/paths.js"]), ...edits(["src/paths.js"]), check("test/paths.test.js")]
		case "comprehensive-audit":
			return reads(["src/config.js", "src/lifecycle.js", "src/projection.js", "src/paths.js", "src/drafts.js"])
		case "simple-request-escalation":
			return [
				...reads(["src/drafts.js"]),
				...edits(["src/drafts.js"]),
				...reads(["src/drafts.js"]),
				...edits(["src/drafts.js"]),
				check("test/drafts.test.js"),
			]
		default:
			throw new Error("Unknown fixture")
	}
}

async function snapshot(root: string) {
	const files: Record<string, string> = {}
	async function visit(directory: string) {
		for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
			const file = path.join(directory, entry.name)
			if (entry.isDirectory()) await visit(file)
			else files[path.relative(root, file).replaceAll("\\", "/")] = await fs.readFile(file, "utf8")
		}
	}
	await visit(root)
	return files
}

describe("proportional-scope scripted whole-fixture baseline", () => {
	it.each(fixtures.cases)("executes $id through the turn engine and scheduler", async (fixture) => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-scope-harness-"))
		try {
			if (fixture.workspace) await fs.cp(path.resolve(fixtureRoot, fixture.workspace), root, { recursive: true })
			const before = await snapshot(root)
			const actions = actionsFor(fixture.id)
			const readVersions = new Map<string, string>()
			const trace: TraceRow[] = []
			const annotations: Array<{
				sequence: number
				phase: Phase
				category?: Category
				fingerprint?: string
				purpose?: "ordinary" | "recovery"
			}> = []
			let activeAction: Action | undefined
			let phase: Phase = "discovery"
			let purpose: "ordinary" | "recovery" = "ordinary"
			let injectedStaleWrite = false
			let staleRejections = 0
			let checksPassed = 0
			const emit = (event: AgentTurnEvent) => {
				const { type, ...payload } = event
				const sequence = trace.length + 1
				trace.push({ sequence, type: `agent.turn.${type}`, timestamp: new Date(0).toISOString(), payload })
				const category =
					activeAction?.name === "read_file"
						? "read"
						: activeAction?.name === "edit_file"
							? "mutation"
							: "validation"
				annotations.push({
					sequence,
					phase,
					...(type === "tool_result" && activeAction
						? {
								category,
								purpose,
								fingerprint: createHmac("sha256", "public-fixture-contract-key")
									.update(
										`${activeAction.name}:${activeAction.target}:${readVersions.get(activeAction.target) ?? ""}`,
									)
									.digest("hex"),
							}
						: {}),
				})
			}
			const host: ToolExecutionHost = {
				taskId: "proportional-scope-fixture",
				cwd: root,
				userMessageContent: [],
				say: async () => {},
				recordToolUsage: () => {},
				pushToolResultToUserContent(result) {
					this.userMessageContent.push(result)
					return true
				},
			}
			const registry = new ToolRegistry({ includeBuiltIns: false })
			for (const name of ["read_file", "edit_file", "execute_command"] as const) {
				registry.register({
					name,
					aliases: [],
					schema: {
						type: "function",
						function: {
							name,
							description: "Bounded fixture executor",
							parameters: {
								type: "object",
								properties: { path: { type: "string" } },
								required: ["path"],
							},
						},
					},
					capabilities: {
						concurrency: "serial",
						sideEffects: name === "read_file" ? "none" : "workspace",
						controlFlow: false,
						requiresApproval: false,
					},
					execute: async ({ callbacks }) => {
						if (!activeAction || activeAction.name !== name)
							throw new Error("Unexpected scripted operation")
						const target = activeAction.target
						const absolute = path.resolve(root, target)
						if (!absolute.startsWith(`${root}${path.sep}`))
							throw new Error("Fixture path escapes workspace")
						if (name === "read_file") {
							const content = await fs.readFile(absolute, "utf8")
							readVersions.set(target, createHash("sha256").update(content).digest("hex"))
							callbacks.pushToolResult(readWithSlice(content, 0, 200).content)
						} else if (name === "edit_file") {
							const content = await fs.readFile(absolute, "utf8")
							if (readVersions.get(target) !== createHash("sha256").update(content).digest("hex")) {
								staleRejections++
								callbacks.setResultMetadata?.({ status: "error" })
								callbacks.pushToolResult("stale read: refresh before editing")
								return
							}
							if (!repairs[target]) throw new Error("No calibrated repair for fixture")
							await fs.writeFile(absolute, repairs[target](content))
							callbacks.pushToolResult("edit applied")
						} else {
							const result = await executeFile(
								process.execPath,
								["--test", "--test-reporter=dot", target],
								{ cwd: root, timeout: 10_000, maxBuffer: 1024 * 1024 },
							)
							checksPassed++
							callbacks.setResultMetadata?.({
								status: "success",
								executionStatus: "success",
								exitCode: 0,
							})
							callbacks.pushToolResult(result.stdout)
						}
					},
				})
			}
			const scheduler = new ToolScheduler({
				executionHost: host,
				registry,
				mode: "code",
				validateCall: () => {},
				onEvent: emit,
			})
			const engine = new AgentTurnEngine<number>({
				shouldAbort: () => false,
				runStep: async (step) => {
					activeAction = actions[step]
					phase = activeAction?.phase ?? "finalization"
					purpose =
						fixture.id === "simple-request-escalation" && (step === 2 || step === 3)
							? "recovery"
							: "ordinary"
					emit({ type: "model_request_started", attempt: 0 })
					let item: ApiStreamChunk
					if (activeAction)
						item = {
							type: "tool_call",
							id: `call-${step}`,
							name: activeAction.name,
							arguments: JSON.stringify({ path: activeAction.target }),
						}
					else {
						const text =
							fixture.id === "conversation-only"
								? "Yes, a task with status cancelled is cancelled."
								: fixture.id === "narrow-lookup"
									? "The retry limit is 3 (src/config.js:1)."
									: fixture.id === "comprehensive-audit"
										? "src/lifecycle.js reopens cancelled tasks on replay; src/projection.js hides cancellation; src/paths.js permits sibling and symlink escapes; src/drafts.js ignores stale versions."
										: "Implemented the requested behavior and passed the affected checks."
						item = { type: "text", text }
					}
					const response = await collectAgentResponse(
						(async function* () {
							yield item
						})(),
					)
					emit({ type: "assistant_committed", response })
					if (activeAction) {
						if (
							fixture.id === "simple-request-escalation" &&
							activeAction.name === "edit_file" &&
							!injectedStaleWrite
						) {
							await fs.appendFile(
								path.join(root, "src/drafts.js"),
								"\nexport const externallyAdded = true\n",
							)
							injectedStaleWrite = true
						}
						const scheduled = await scheduler.run(response)
						expect(scheduled.results).toHaveLength(1)
						const expectedStale = fixture.id === "simple-request-escalation" && step === 1
						expect(scheduled.results[0].status).toBe(expectedStale ? "error" : "success")
					}
					return { response, nextInput: step + 1 }
				},
			})
			const outcome = await engine.run(0)
			if (outcome.status === "failed") throw outcome.error ?? new Error(outcome.reason)
			expect(outcome.status).toBe("completed")
			expect(outcome.steps).toBe(actions.length + 1)
			expect(checksPassed).toBe(fixture.validation.length)
			if (fixture.id === "conversation-only") expect(outcome.response?.text).toMatch(/^Yes,/)
			if (fixture.id === "narrow-lookup") {
				expect(before["src/config.js"]).toMatch(/retryLimit = 3/)
				expect(outcome.response?.text).toContain("3 (src/config.js:1)")
			}
			if (fixture.id === "comprehensive-audit") {
				for (const file of ["src/lifecycle.js", "src/projection.js", "src/paths.js", "src/drafts.js"]) {
					expect(outcome.response?.text).toContain(file)
					expect(readVersions.has(file)).toBe(true)
				}
			}
			const after = await snapshot(root)
			if (!fixture.validation.length) expect(after).toEqual(before)
			for (const [file, content] of Object.entries(before))
				if (file.startsWith("test/")) expect(after[file]).toBe(content)
			if (fixture.id === "simple-request-escalation") {
				expect(staleRejections).toBe(1)
				expect(after["src/drafts.js"]).toContain("export const externallyAdded = true")
			}
			const observationFile = path.join(root, "observations.json")
			const reportFile = path.join(root, "report.json")
			const revision = (await executeFile("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim()
			const workingTree = (await executeFile("git", ["status", "--porcelain"], { cwd: repo })).stdout.trim()
				? "modified"
				: "clean"
			await fs.writeFile(
				observationFile,
				JSON.stringify({
					fixtureId: fixture.id,
					measurementKind: "scripted-harness",
					traceCoverage: "complete",
					trace,
					annotations,
					graderDecision: "passed",
					outcome: "completed",
					sampleIndex: 0,
					revision,
					workingTree,
					fixtureDigest: createHash("sha256").update(JSON.stringify({ fixture, before })).digest("hex"),
					modelConfigurationDigest: createHash("sha256")
						.update(JSON.stringify({ host: "scripted-harness-v1", actions }))
						.digest("hex"),
				}),
			)
			await executeFile(process.execPath, [
				path.join(repo, "scripts/evals/proportional-scope-report.mjs"),
				observationFile,
				reportFile,
			])
			const report = JSON.parse(await fs.readFile(reportFile, "utf8"))
			expect(report.observedTotal.modelCalls.value).toBe(outcome.steps)
			expect(report.observedTotal.toolResults.value).toBe(actions.length)
			expect(report.observedTotal.tokensIn.value).toBeNull()
			expect(report.phases.finalization.modelCalls.value).toBe(1)
			if (process.env.ALPHA_SCOPE_REPORT_DIR) {
				await fs.mkdir(process.env.ALPHA_SCOPE_REPORT_DIR, { recursive: true })
				await fs.copyFile(reportFile, path.join(process.env.ALPHA_SCOPE_REPORT_DIR, `${fixture.id}.json`))
			}
		} finally {
			await fs.rm(root, { recursive: true, force: true })
		}
	})
})

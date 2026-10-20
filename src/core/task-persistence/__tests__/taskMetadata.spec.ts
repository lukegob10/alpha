import { taskMetadata } from "../taskMetadata"
import { createSubagentCommandApprovalPolicy } from "../../auto-approval/commands"
import { captureSubagentContext } from "../../agent/SubagentContextCapture"
import { historyItemSchema } from "@alpha-code/types"

describe("taskMetadata sub-agent routing", () => {
	let storageRoot: string
	let tempBase: string
	let workspace: string

	beforeEach(async () => {
		tempBase = await fs.realpath(os.tmpdir())
		storageRoot = await fs.mkdtemp(path.join(tempBase, "alpha-task-metadata-"))
		workspace = path.join(storageRoot, "workspace")
	})

	afterEach(async () => {
		expect(path.dirname(storageRoot)).toBe(tempBase)
		expect(path.basename(storageRoot)).toMatch(/^alpha-task-metadata-/)
		await fs.rm(storageRoot, { recursive: true, force: true })
	})

	it.each([false, undefined] as const)(
		"preserves presentation model-call policy %s across a history serialization round trip",
		async (presentationModelCalls) => {
			const { historyItem } = await taskMetadata({
				taskId: "governed-task",
				taskNumber: 1,
				messages: [],
				globalStoragePath: storageRoot,
				workspace,
				presentationModelCalls,
			})
			const reloaded = historyItemSchema.parse(JSON.parse(JSON.stringify(historyItem)))
			expect(reloaded.presentationModelCalls).toBe(presentationModelCalls)
			if (presentationModelCalls === undefined) expect(historyItem).not.toHaveProperty("presentationModelCalls")
		},
	)

	it.each([false, true, undefined])(
		"preserves thread completion delivery preference %s across reload",
		async (notify) => {
			const { historyItem } = await taskMetadata({
				taskId: "independent-thread",
				taskNumber: 1,
				messages: [],
				globalStoragePath: storageRoot,
				workspace,
				orchestrationParentTaskId: "creator",
				orchestrationNotifyCompletion: notify,
			})
			const reloaded = historyItemSchema.parse(JSON.parse(JSON.stringify(historyItem)))
			expect(reloaded.orchestrationNotifyCompletion).toBe(notify)
			if (notify === undefined) expect(reloaded).not.toHaveProperty("orchestrationNotifyCompletion")
		},
	)

	it("persists only the credential-free route snapshot", async () => {
		const route = {
			source: "role" as const,
			resolution: "selected" as const,
			profileId: "explore-id",
			profileName: "Fast Explorer",
			provider: "openrouter",
			modelId: "fast/model",
		}

		const { historyItem } = await taskMetadata({
			taskId: "child-1",
			parentTaskId: "parent-1",
			taskNumber: 2,
			messages: [],
			globalStoragePath: storageRoot,
			workspace,
			taskKind: "subagent",
			subagentModelRoute: route,
		})

		expect(historyItem.subagentModelRoute).toEqual(route)
		expect(historyItem.subagentModelRoute).not.toBe(route)
		expect(JSON.stringify(historyItem.subagentModelRoute)).not.toMatch(/key|secret|authorization/i)
	})

	it("persists bounded diagnostic-session identity for task reload", async () => {
		const { historyItem } = await taskMetadata({
			taskId: "diagnostic-task",
			diagnosticSession: true,
			diagnosticIncidentId: "incident-42",
			diagnosticSourceTaskId: "source-task-9",
			taskNumber: 3,
			messages: [],
			globalStoragePath: storageRoot,
			workspace,
		})

		expect(historyItem).toMatchObject({
			id: "diagnostic-task",
			diagnosticSession: true,
			diagnosticIncidentId: "incident-42",
			diagnosticSourceTaskId: "source-task-9",
		})
	})

	it("persists a cloned context manifest without private instruction or turn bodies", async () => {
		const route = {
			source: "parent" as const,
			resolution: "selected" as const,
			profileName: "Parent",
			provider: "openai",
			modelId: "alpha-model",
		}
		const { manifest } = captureSubagentContext({
			parentTaskId: "parent-1",
			capturedAt: 100,
			forkTurns: "all",
			history: [{ role: "user", content: "private parent body" }],
			instructions: {
				effectiveText: "private frozen instructions",
				sources: [{ kind: "agents", ref: path.join(workspace, "AGENTS.md"), text: "private AGENTS body" }],
			},
			skills: [
				{
					name: "explicit-review",
					path: path.join(workspace, ".agents", "skills", "explicit-review", "SKILL.md"),
					content: "private explicit skill body",
					allowImplicitInvocation: false,
				},
			],
			cwd: workspace,
			workspaceRoots: [workspace],
			modelRoute: route,
			runtimePolicy: {
				role: "review",
				read: true,
				execute: false,
				mutate: false,
				delegate: false,
				network: false,
				externalSideEffects: false,
				requireApproval: false,
				allowedTools: ["read_file", "attempt_completion"],
				workspaceRoots: [workspace],
				autoApproval: {
					autoApprovalEnabled: true,
					alwaysAllowReadOnly: true,
					alwaysAllowReadOnlyOutsideWorkspace: false,
					alwaysAllowWrite: false,
					alwaysAllowWriteOutsideWorkspace: false,
					alwaysAllowWriteProtected: false,
					alwaysAllowExecute: true,
					alwaysAllowSubagents: true,
					commandApproval: createSubagentCommandApprovalPolicy(["git diff"], ["git push"], "3".repeat(64)),
				},
			},
		})

		const { historyItem } = await taskMetadata({
			taskId: "child-1",
			parentTaskId: "parent-1",
			taskNumber: 2,
			messages: [],
			globalStoragePath: storageRoot,
			workspace,
			taskKind: "subagent",
			subagentContextManifest: manifest,
			subagentInstructionPlacement: "system",
		})

		expect(historyItem.subagentContextManifest).toEqual(manifest)
		expect(historyItem.subagentContextManifest).not.toBe(manifest)
		expect(historyItem.subagentInstructionPlacement).toBe("system")
		expect(historyItem.subagentContextManifest?.runtimePolicy.autoApproval).toEqual(
			manifest.runtimePolicy.autoApproval,
		)
		expect(historyItem.subagentContextManifest?.skills[0]?.allowImplicitInvocation).toBe(false)
		const reloadedHistoryItem = historyItemSchema.parse(JSON.parse(JSON.stringify(historyItem)))
		expect(reloadedHistoryItem.subagentContextManifest?.skills).toEqual(manifest.skills)
		expect(reloadedHistoryItem.subagentContextManifest?.skills[0]?.allowImplicitInvocation).toBe(false)
		expect(JSON.stringify(historyItem.subagentContextManifest)).not.toContain("private parent body")
		expect(JSON.stringify(historyItem.subagentContextManifest)).not.toContain("private frozen instructions")
		expect(JSON.stringify(historyItem.subagentContextManifest)).not.toContain("private AGENTS body")
		expect(JSON.stringify(reloadedHistoryItem.subagentContextManifest)).not.toContain("private explicit skill body")
	})
})
import fs from "fs/promises"
import os from "os"
import path from "path"

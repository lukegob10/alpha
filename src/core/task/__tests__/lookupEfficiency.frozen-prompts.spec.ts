import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import type { TaskWorkPlan } from "@alpha-code/types"
import { describe, expect, it, vi } from "vitest"

import { classifyRequestWorkClass } from "../../agent/requestWorkClass"
import { isToolAllowed } from "../../agent/ToolPolicy"
import type { ParentCompletionDecision } from "../../agent/ParentVerification"
import { Task, type CommandExecutionEvidence } from "../Task"
import { buildNativeToolsArrayWithRestrictions, type BuildToolsOptions } from "../build-tools"
import { TaskToolCatalogCache } from "../TaskToolCatalogCache"

vi.mock("../../../services/code-index/manager", () => ({
	CodeIndexManager: {
		getInstance: () => ({ isFeatureEnabled: true, isFeatureConfigured: true, isInitialized: true }),
	},
}))

const casesPath = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"../../../../evals/lookup-efficiency/cases.json",
)

const LOOKUP_NATIVE_NAMES = [
	"ask_followup_question",
	"codebase_search",
	"list_files",
	"read_file",
	"search_files",
	"shell",
]
const HIDDEN_WORKFLOW_NAMES = [
	"spawn_agent",
	"update_todo_list",
	"attempt_completion",
	"write_to_file",
	"skill",
	"list_tickets",
]

const leftoverPlan: TaskWorkPlan = {
	objective: "Fix behavior",
	constraints: [],
	notes: [],
	checks: [
		{
			id: "behavior",
			description: "Behavioral check",
			command: "node app.js",
			cwd: null,
			paths: ["app.js"],
			reusable: true,
		},
	],
}

type FrozenCase = {
	id: string
	prompt: string
	class: string
	expectedAnswerKey: string
}

function namesOf(tools: { type: string; function?: { name: string; description?: string } }[]): string[] {
	return tools.flatMap((tool) => (tool.type === "function" && tool.function ? [tool.function.name] : [])).sort()
}

function options(overrides: Partial<BuildToolsOptions> = {}): BuildToolsOptions {
	const provider = {
		context: {},
		getMcpHub: () => ({ getServers: () => [] }),
	}
	return {
		provider: provider as unknown as BuildToolsOptions["provider"],
		cwd: process.cwd(),
		mode: "code",
		customModes: undefined,
		experiments: {},
		apiConfiguration: { apiProvider: "openai" },
		catalogCache: new TaskToolCatalogCache(),
		discoveryHistory: [],
		...overrides,
	}
}

function command(overrides: Partial<CommandExecutionEvidence> = {}): CommandExecutionEvidence {
	return {
		toolCallId: "inspect",
		executionId: "execution",
		status: "running",
		startedAt: 1,
		returnedInBackground: true,
		...overrides,
	}
}

function taskForPrompt(prompt: string): Task {
	const history = [
		{
			role: "user" as const,
			content: `<user_message>\n${prompt}\n</user_message>`,
		},
	]
	return Object.assign(Object.create(Task.prototype), {
		taskKind: "primary",
		apiConversationHistory: history,
		metadata: { task: history[0]?.content },
		workContext: { plan: leftoverPlan, receipts: [], skills: [] },
		workspacePath: process.cwd(),
		getOpenTodoCompletionDecision: () => undefined,
		commandExecutionEvidence: new Map([["inspect", command()]]),
		pendingCommandVerification: Promise.resolve(),
		pendingCommandVerificationCount: 0,
		completionRuntimeRevision: 0,
		alphaIgnoreController: { validateAccess: () => true },
		providerRef: {
			deref: () => ({
				getParentCompletionDecision: async () =>
					({
						allowed: true,
						blockingObligations: [],
					}) satisfies ParentCompletionDecision,
			}),
		},
	}) as Task
}

async function loadFrozenCases(): Promise<FrozenCase[]> {
	const document = JSON.parse(await fs.readFile(casesPath, "utf8")) as { cases: FrozenCase[] }
	return document.cases
}

describe("lookup-efficiency frozen prompts CI shape", () => {
	it("classifies every frozen prompt as lookup without skill or ticket extras", async () => {
		const cases = await loadFrozenCases()
		expect(cases).toHaveLength(4)
		for (const fixture of cases) {
			expect(fixture.class).toBe("lookup")
			expect(classifyRequestWorkClass(fixture.prompt), fixture.id).toMatchObject({
				class: "lookup",
				reason: "lookup_question",
				includeSkill: false,
				includeTickets: false,
			})
		}
	})

	it("advertises a lookup-sized catalog with search_files first-path policy for every frozen prompt", async () => {
		const cases = await loadFrozenCases()
		for (const fixture of cases) {
			const result = await buildNativeToolsArrayWithRestrictions(options({ userRequestText: fixture.prompt }))
			expect(namesOf(result.tools), fixture.id).toEqual([...LOOKUP_NATIVE_NAMES].sort())
			expect(result.surface?.isCallable("search_files"), fixture.id).toBe(true)
			expect(isToolAllowed(result.surface?.policy, "spawn_agent"), fixture.id).toBe(false)
			for (const hidden of HIDDEN_WORKFLOW_NAMES) {
				expect(result.surface?.isCallable(hidden), `${fixture.id} ${hidden}`).toBe(false)
			}
			const search = result.tools.find(
				(tool) => tool.type === "function" && tool.function?.name === "search_files",
			) as { function?: { description?: string } } | undefined
			expect(search?.function?.description, fixture.id).toContain(
				"First tool for exact text, symbols, and filenames",
			)
			const shell = result.tools.find((tool) => tool.type === "function" && tool.function?.name === "shell") as
				| { function?: { description?: string } }
				| undefined
			expect(shell?.function?.description, fixture.id).toContain(
				"Not a search fallback when search_files can run",
			)
		}
	})

	it("lets every frozen prompt complete despite leftover plan checks and backgrounded inspections", async () => {
		const cases = await loadFrozenCases()
		for (const fixture of cases) {
			expect(await taskForPrompt(fixture.prompt).getCompletionGateDecision(), fixture.id).toMatchObject({
				allowed: true,
				classification: "ready",
				reasonCode: "ready",
			})
		}
	})
})

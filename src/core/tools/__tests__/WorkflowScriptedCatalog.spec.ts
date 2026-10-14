import { describe, expect, it } from "vitest"
import { z } from "zod"

import { DEVELOPMENT_PHASES } from "../../../../apps/vscode-e2e/src/scenarios/developmentCatalog"
import { MAX_SETTLEMENT_REVISIONS } from "../../../../apps/vscode-e2e/src/scenarios/commandSettlement"
import { WORKFLOW_DISABLED_TOOLS } from "../../../../apps/vscode-e2e/src/scenarios/extensionWorkflowHost"
import {
	WORKFLOW_PROMPTS,
	workflowCommands,
	type WorkflowPromptName,
} from "../../../../apps/vscode-e2e/src/scenarios/prompts"
import { WorkflowRequestBudget } from "../../../../apps/vscode-e2e/src/scenarios/requestBudget"
import { WorkflowScriptedAI } from "../../../../apps/vscode-e2e/src/scenarios/scriptedWorkflow"
import { getNativeTools } from "../../prompts/tools/native-tools"
import { formatCommandToolResult } from "../BaseTool"
import { createTaskToolSurface } from "../TaskToolSurface"
import { ToolRegistry } from "../ToolRegistry"

// These fixture tools currently have flat scalar arguments. A richer advertised schema must extend this guard.
const scalarSchema = z
	.object({
		type: z.enum(["string", "integer", "number", "boolean"]),
		description: z.string().optional(),
		minimum: z.number().optional(),
		maximum: z.number().optional(),
		minLength: z.number().optional(),
		maxLength: z.number().optional(),
		pattern: z.string().optional(),
		enum: z.array(z.union([z.string(), z.number(), z.boolean()])).optional(),
	})
	.strict()
const parameterSchema = z
	.object({
		type: z.literal("object"),
		properties: z.record(scalarSchema),
		required: z.array(z.string()).default([]),
		additionalProperties: z.literal(false),
	})
	.strict()

function expectAdvertisedArguments(schema: unknown, input: unknown): void {
	const parameters = parameterSchema.parse(schema)
	const args = z.record(z.unknown()).parse(input)
	for (const required of parameters.required) expect(Object.hasOwn(args, required), required).toBe(true)
	for (const [key, value] of Object.entries(args)) {
		const property = parameters.properties[key]
		expect(property, `Undeclared argument: ${key}`).toBeDefined()
		if (!property) throw new Error(`Undeclared argument: ${key}`)
		if (property.type === "integer") expect(Number.isSafeInteger(value), key).toBe(true)
		else expect(typeof value, key).toBe(property.type)
		if (typeof value === "number") {
			expect(Number.isFinite(value), key).toBe(true)
			if (property.minimum !== undefined) expect(value, key).toBeGreaterThanOrEqual(property.minimum)
			if (property.maximum !== undefined) expect(value, key).toBeLessThanOrEqual(property.maximum)
		}
		if (typeof value === "string") {
			if (property.minLength !== undefined) expect(value.length, key).toBeGreaterThanOrEqual(property.minLength)
			if (property.maxLength !== undefined) expect(value.length, key).toBeLessThanOrEqual(property.maxLength)
			if (property.pattern !== undefined) expect(value, key).toMatch(new RegExp(property.pattern))
		}
		if (property.enum) expect(property.enum, key).toContain(value)
	}
}

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
	const chunks: T[] = []
	for await (const chunk of stream) chunks.push(chunk)
	return chunks
}

const phases = [
	...(Object.keys(WORKFLOW_PROMPTS) as Array<keyof typeof WORKFLOW_PROMPTS>),
	...(Object.keys(DEVELOPMENT_PHASES) as Array<keyof typeof DEVELOPMENT_PHASES>),
]
const cases = phases.flatMap((phase) =>
	(phase === "commandSettlement"
		? Array.from({ length: MAX_SETTLEMENT_REVISIONS }, (_, index) => index + 1)
		: phase === "extend"
			? [1, 2]
			: [1]
	).map((step) => ({ phase, step })),
)
const readOnlyPhases = new Set<WorkflowPromptName>([
	"review",
	"verify",
	"completionIdle",
	"devInspectReadOnly",
	"devSearchScope",
	"devSearchAbsent",
	"devVerificationUnavailable",
])

describe("workflow scripted provider against the actual Code tool surface", () => {
	it.each(cases)(
		"$phase step $step advertises every call and reaches ordinary final text",
		async ({ phase, step }) => {
			const schemas = getNativeTools({ supportsImages: false, availableBrowserToolNames: [] })
			const surface = createTaskToolSurface({
				registry: new ToolRegistry({ nativeTools: schemas }),
				schemas,
				mode: "code",
				taskKind: "primary",
				cwd: process.cwd(),
				disabledTools: WORKFLOW_DISABLED_TOOLS,
			})
			const advertised = new Map(
				surface.schemas.flatMap((tool) =>
					tool.type === "function" ? [[tool.function.name, tool] as const] : [],
				),
			)
			const provider = new WorkflowScriptedAI(new WorkflowRequestBudget(50), process.cwd())
			provider.setPhase(phase, step)
			let completed = false
			let calls = 0
			try {
				for (let request = 0; request < 50 && !completed; request++) {
					for await (const chunk of provider.createMessage()) {
						if (chunk.type === "text") {
							expect(chunk.text.trim()).not.toBe("")
							completed = true
						}
						if (chunk.type !== "tool_call") continue
						calls++
						const schema = advertised.get(chunk.name)
						expect(schema, `Unadvertised call: ${chunk.name}`).toBeDefined()
						expect(surface.isCallable(chunk.name), chunk.name).toBe(true)
						expect(surface.resolve(chunk.name)?.name, chunk.name).toBe(chunk.name)
						if (!schema || schema.type !== "function") throw new Error(`Unadvertised call: ${chunk.name}`)
						const args = z.record(z.unknown()).parse(JSON.parse(chunk.arguments))
						expectAdvertisedArguments(schema.function.parameters, args)
						if (chunk.name === "exec_command") expect(workflowCommands(phase)).toContain(args.cmd)
						if (readOnlyPhases.has(phase)) expect(chunk.name).toBe("exec_command")
					}
				}
				expect(completed, "The fixture must terminate within its bounded request budget").toBe(true)
				// Context probes are driven by the host's separate probe path, not this scripted tool plan.
				if (phase !== "contextProbe") expect(calls).toBeGreaterThan(0)
			} finally {
				provider.dispose()
			}
		},
	)

	it("advertises the actual emitted command continuation under the workflow deny list", async () => {
		const schemas = getNativeTools()
		const surface = createTaskToolSurface({
			registry: new ToolRegistry({ nativeTools: schemas }),
			schemas,
			mode: "code",
			disabledTools: WORKFLOW_DISABLED_TOOLS,
		})
		expect(surface.isCallable("write_stdin")).toBe(true)
		expect(surface.allowedFunctionNames).toContain("write_stdin")
		const provider = new WorkflowScriptedAI(new WorkflowRequestBudget(50), process.cwd())
		provider.setPhase("review")
		try {
			const first = (await collect(provider.createMessage())).find((chunk) => chunk.type === "tool_call")
			expect(first?.name).toBe("exec_command")
			if (!first) throw new Error("Expected the scripted review command")
			const history = [
				{
					role: "assistant",
					content: [{ type: "tool_use", id: first.id, name: first.name, input: JSON.parse(first.arguments) }],
				},
				{
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: first.id,
							is_error: false,
							content: formatCommandToolResult(
								{ wall_time_seconds: 0.1, output: "", session_id: 7 },
								1024,
							),
						},
					],
				},
			]
			const next = (await collect(provider.createMessage("", history))).find(
				(chunk) => chunk.type === "tool_call",
			)
			expect(next?.name).toBe("write_stdin")
			const schema = surface.resolve("write_stdin")?.schema
			if (!next || !schema || schema.type !== "function")
				throw new Error("Expected callable command continuation")
			expectAdvertisedArguments(schema.function.parameters, JSON.parse(next.arguments))
			expect(JSON.parse(next.arguments)).toMatchObject({ session_id: 7, chars: "" })
		} finally {
			provider.dispose()
		}
	})
})

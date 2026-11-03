import { describe, expect, it, vi } from "vitest"

import { ToolScheduler, type ToolExecutionHost } from "../../agent/ToolScheduler"
import type { Task } from "../../task/Task"

import { createTaskToolSurface } from "../TaskToolSurface"
import { ToolRegistry } from "../ToolRegistry"

function fixture(mutation = false, execute = async () => undefined) {
	const registry = new ToolRegistry({ includeBuiltIns: false })
	registry.register({
		name: "fixture_read",
		aliases: ["fixture_legacy_read"],
		schema: {
			type: "function",
			function: {
				name: "fixture_read",
				description: "Canonical read schema",
				parameters: { type: "object", properties: {} },
			},
		},
		capabilities: {
			concurrency: "serial",
			sideEffects: mutation ? "workspace" : "none",
			controlFlow: false,
			requiresApproval: mutation,
		},
		execute,
	})
	return registry
}

describe("captured registry-owned alias authority", () => {
	it("denies canonical and alias calls in the real scheduler before either executor runs", async () => {
		const effect = vi.fn(async () => undefined)
		const surface = createTaskToolSurface({
			registry: fixture(false, effect),
			disabledTools: ["fixture_legacy_read"],
			applyProfile: false,
		})
		const host: ToolExecutionHost = {
			taskId: "registry-alias-fixture",
			cwd: process.cwd(),
			taskFacade: {} as Task,
			userMessageContent: [],
			say: vi.fn(async () => undefined),
			recordToolUsage: vi.fn(),
			pushToolResultToUserContent(result) {
				host.userMessageContent.push(result)
				return true
			},
		}
		const outcome = await new ToolScheduler({
			executionHost: host,
			registry: surface.registry,
			policy: surface.policy,
			mode: "code",
		}).run([
			{ type: "tool_call", id: "canonical-call", name: "fixture_read", arguments: {} },
			{ type: "tool_call", id: "alias-call", name: "fixture_legacy_read", arguments: {} },
		])
		expect(outcome.results.map((result) => result.status)).toEqual(["denied", "denied"])
		expect(host.userMessageContent).toHaveLength(2)
		expect(effect).not.toHaveBeenCalled()
	})

	it.each([false, true])("keeps registered aliases inside Plan mutation restrictions (superset=%s)", (superset) => {
		const surface = createTaskToolSurface({
			registry: fixture(true),
			visibleToolNames: ["fixture_legacy_read"],
			allowedToolNames: ["fixture_legacy_read"],
			mode: "architect",
			includeAllToolsWithRestrictions: superset,
		})
		expect(surface.isCallable("fixture_read")).toBe(false)
		expect(surface.isCallable("fixture_legacy_read")).toBe(false)
		expect(surface.resolve("fixture_legacy_read")).toBeUndefined()
		expect(surface.allowedFunctionNames).toEqual([])
		expect(surface.schemas).toHaveLength(superset ? 1 : 0)
	})

	it.each([NaN, Infinity, undefined])("preserves a valid output cap beside invalid alias override %s", (invalid) => {
		for (const outputLimits of [
			{ fixture_read: 100, fixture_legacy_read: invalid },
			{ fixture_legacy_read: invalid, fixture_read: 100 },
		]) {
			const surface = createTaskToolSurface({
				registry: fixture(),
				outputLimits: outputLimits as unknown as Readonly<Record<string, number>>,
				applyProfile: false,
			})
			expect(surface.policy.outputLimits).toEqual({ fixture_read: 100 })
		}
	})

	it("captures the narrowest output limit across canonical and alias spellings", () => {
		const surface = createTaskToolSurface({
			registry: fixture(),
			outputLimits: { fixture_read: 100, fixture_legacy_read: 1000 },
			applyProfile: false,
		})
		expect(surface.policy.outputLimits).toEqual({ fixture_read: 100 })
	})

	it("retains its sealed alias authority when caller lists change and a later surface is narrowed", () => {
		const registry = fixture()
		const visibleToolNames = ["fixture_legacy_read"]
		const allowedToolNames = ["fixture_legacy_read"]
		const disabledTools: string[] = []
		const captured = createTaskToolSurface({
			registry,
			visibleToolNames,
			allowedToolNames,
			disabledTools,
			applyProfile: false,
		})
		const digest = captured.digest
		visibleToolNames.length = 0
		allowedToolNames.length = 0
		disabledTools.push("fixture_legacy_read")
		const narrowed = createTaskToolSurface({ registry, disabledTools, applyProfile: false })

		expect(captured.isCallable("fixture_legacy_read")).toBe(true)
		expect(captured.resolve("fixture_legacy_read")).toBe(registry.resolve("fixture_read"))
		expect(captured.digest).toBe(digest)
		expect(narrowed.isCallable("fixture_read")).toBe(false)
		expect(narrowed.isCallable("fixture_legacy_read")).toBe(false)
		expect(() => registry.register({ ...registry.resolve("fixture_read")!, name: "replacement" })).toThrow("sealed")
	})

	it("resolves the same captured executor through its canonical and registered alias names", () => {
		const registry = fixture()
		const surface = createTaskToolSurface({ registry, applyProfile: false })
		expect(surface.registry.canonicalName("fixture_legacy_read")).toBe("fixture_read")
		expect(surface.allowedFunctionNames).toEqual(["fixture_read"])
		expect(surface.isCallable("fixture_legacy_read")).toBe(true)
		expect(surface.resolve("fixture_legacy_read")).toBe(surface.resolve("fixture_read"))
	})

	it.each(["disabledTools", "disabledToolNames", "policy"] as const)(
		"applies a registered alias deny from %s to the canonical executable before exposing the surface",
		(source) => {
			const surface = createTaskToolSurface({
				registry: fixture(),
				...(source === "policy"
					? { policy: { visibleTools: ["fixture_legacy_read"], disabledTools: ["fixture_legacy_read"] } }
					: source === "disabledTools"
						? { disabledTools: ["fixture_legacy_read"] }
						: { disabledToolNames: ["fixture_legacy_read"] }),
				applyProfile: false,
			})
			expect(surface.isCallable("fixture_read")).toBe(false)
			expect(surface.isCallable("fixture_legacy_read")).toBe(false)
			expect(surface.resolve("fixture_read")).toBeUndefined()
			expect(surface.schemas).toEqual([])
			expect(surface.policy.disabledTools).toEqual(["fixture_read"])
		},
	)

	it("captures an alias allow-list under the canonical schema and policy identity", () => {
		const surface = createTaskToolSurface({
			registry: fixture(),
			visibleToolNames: ["fixture_legacy_read"],
			allowedToolNames: ["fixture_legacy_read"],
			applyProfile: false,
		})
		expect(surface.allowedFunctionNames).toEqual(["fixture_read"])
		expect(surface.isCallable("fixture_read")).toBe(true)
		expect(surface.isCallable("fixture_legacy_read")).toBe(true)
	})

	it("retains one canonical schema when a registered alias declaration comes first", () => {
		const registry = fixture()
		const canonical = registry.getSchema("fixture_read")!
		if (canonical.type !== "function") throw new Error("Expected canonical function schema")
		const surface = createTaskToolSurface({
			registry,
			schemas: [
				{
					...canonical,
					function: { ...canonical.function, name: "fixture_legacy_read", description: "Old schema" },
				},
				canonical,
			],
			applyProfile: false,
		})
		expect(surface.schemas).toEqual([canonical])
		expect(surface.allowedFunctionNames).toEqual(["fixture_read"])
	})
})

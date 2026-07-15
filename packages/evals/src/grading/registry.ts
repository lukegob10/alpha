import { aggregateGraderResults } from "./aggregate"
import { CommandGrader } from "./plugins/command"
import { DiffPolicyGrader } from "./plugins/diffPolicy"
import { FilesystemGrader } from "./plugins/filesystem"
import { StaticAnalysisGrader } from "./plugins/staticAnalysis"
import { TraceAssertionGrader } from "./plugins/traceAssertion"
import { UsagePolicyGrader } from "./plugins/usagePolicy"
import type { GraderContext, GraderPlugin, GraderResult, GraderRunResult, GraderSpec, GraderType } from "./types"

export class GraderRegistry {
	private readonly plugins = new Map<GraderType, GraderPlugin>()

	register(plugin: GraderPlugin): this {
		if (this.plugins.has(plugin.type)) throw new Error(`Grader plugin already registered: ${plugin.type}`)
		this.plugins.set(plugin.type, plugin)
		return this
	}

	async execute(specs: GraderSpec[], context: GraderContext): Promise<GraderRunResult> {
		validateSpecs(specs)
		const results: GraderResult[] = []
		for (const spec of specs) {
			const plugin = this.plugins.get(spec.type)
			if (!plugin) throw new Error(`No grader plugin registered for type: ${spec.type}`)
			const startedAt = context.clock.now().toISOString()
			const startedMs = context.clock.monotonicMs()
			try {
				const partial = await plugin.execute(spec, context)
				results.push({
					...partial,
					startedAt,
					finishedAt: context.clock.now().toISOString(),
					durationMs: Math.max(0, Math.round(context.clock.monotonicMs() - startedMs)),
				})
			} catch (error) {
				results.push({
					graderId: spec.id,
					graderVersion: spec.version,
					type: spec.type,
					status: "error",
					hardGate: spec.hardGate,
					failureClass: spec.failureClass,
					startedAt,
					finishedAt: context.clock.now().toISOString(),
					durationMs: Math.max(0, Math.round(context.clock.monotonicMs() - startedMs)),
					diagnostics: [],
					evidence: [],
					error: error instanceof Error ? error.message : String(error),
				})
			}
		}
		return { decision: aggregateGraderResults(results), results }
	}
}

export function createDefaultGraderRegistry(): GraderRegistry {
	return new GraderRegistry()
		.register(new CommandGrader() as GraderPlugin)
		.register(new FilesystemGrader() as GraderPlugin)
		.register(new DiffPolicyGrader() as GraderPlugin)
		.register(new TraceAssertionGrader() as GraderPlugin)
		.register(new StaticAnalysisGrader() as GraderPlugin)
		.register(new UsagePolicyGrader() as GraderPlugin)
}

export function validateSpecs(specs: GraderSpec[]): void {
	const identities = new Set<string>()
	for (const spec of specs) {
		if (!/^[a-z0-9][a-z0-9._-]*$/.test(spec.id)) throw new Error(`Invalid grader id: ${spec.id}`)
		if (!Number.isInteger(spec.version) || spec.version < 1) throw new Error(`Invalid grader version: ${spec.id}`)
		const identity = `${spec.id}@${spec.version}`
		if (identities.has(identity)) throw new Error(`Duplicate grader identity: ${identity}`)
		identities.add(identity)
	}
}

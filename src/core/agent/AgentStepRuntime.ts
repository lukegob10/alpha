import type { StepContext } from "./StepContext"

/**
 * A registry of process-local executable values. The registry is intentionally
 * not part of `StepContext`: functions, provider instances, streams, and
 * cancellation handles must never cross a persistence or serialization
 * boundary.
 */
export type AgentExecutableRegistry<Executable = unknown> =
	| ReadonlyMap<string, Executable>
	| Readonly<Record<string, Executable>>

export interface AgentStepRuntimeReferences<Handler = unknown, Executable = unknown> {
	readonly handler?: Handler
	readonly executables?: AgentExecutableRegistry<Executable>
}

interface PrivateRuntimeState<Handler, Executable> {
	handler: Handler | undefined
	executables: AgentExecutableRegistry<Executable> | undefined
}

/** Runtime-only state is kept out of enumerable properties and object graphs. */
const runtimeState = new WeakMap<object, PrivateRuntimeState<unknown, unknown>>()

function contextIdFrom(value: string | StepContext): string {
	return typeof value === "string" ? value : value.contextId
}

/**
 * Process-local companion to an immutable step snapshot.
 *
 * The class has no enumerable own properties and serializes to `undefined`.
 * Its live provider/executable references are held in a module-private
 * WeakMap, while the associated context ID remains available for assertions
 * and routing. `forContext` creates another runtime view over the same live
 * references when deriving a retry or child context.
 */
export class AgentStepRuntime<Handler = unknown, Executable = unknown> {
	constructor(context: string | StepContext, references: AgentStepRuntimeReferences<Handler, Executable> = {}) {
		runtimeState.set(this, {
			handler: references.handler,
			executables: references.executables,
		})
		Object.defineProperty(this, "contextId", {
			value: contextIdFrom(context),
			enumerable: false,
			configurable: false,
			writable: false,
		})
		Object.freeze(this)
	}

	get contextId(): string {
		return (this as unknown as { contextId: string }).contextId
	}

	/** Return the live provider/API handler captured for this step. */
	getHandler(): Handler | undefined {
		return (runtimeState.get(this) as PrivateRuntimeState<Handler, Executable> | undefined)?.handler
	}

	/** Return one live executable by name without cloning or serializing it. */
	getExecutable(name: string): Executable | undefined {
		const executables = (runtimeState.get(this) as PrivateRuntimeState<Handler, Executable> | undefined)
			?.executables
		if (!executables) return undefined
		return executables instanceof Map
			? executables.get(name)
			: (executables as Readonly<Record<string, Executable>>)[name]
	}

	hasExecutable(name: string): boolean {
		const executables = (runtimeState.get(this) as PrivateRuntimeState<Handler, Executable> | undefined)
			?.executables
		return executables instanceof Map ? executables.has(name) : Boolean(executables && name in executables)
	}

	/** Return stable executable names for diagnostics without exposing the registry. */
	getExecutableNames(): readonly string[] {
		const executables = (runtimeState.get(this) as PrivateRuntimeState<Handler, Executable> | undefined)
			?.executables
		if (!executables) return []
		return Object.freeze((executables instanceof Map ? [...executables.keys()] : Object.keys(executables)).sort())
	}

	/** Associate the same live references with a derived context. */
	forContext(context: string | StepContext): AgentStepRuntime<Handler, Executable> {
		const state = runtimeState.get(this) as PrivateRuntimeState<Handler, Executable> | undefined
		return new AgentStepRuntime(context, {
			handler: state?.handler,
			executables: state?.executables,
		})
	}

	/** Alias for callers that describe derivation as a runtime fork. */
	fork(context: string | StepContext): AgentStepRuntime<Handler, Executable> {
		return this.forContext(context)
	}

	isForContext(context: string | StepContext): boolean {
		return this.contextId === contextIdFrom(context)
	}

	/** Runtime references are intentionally never included in JSON snapshots. */
	toJSON(): undefined {
		return undefined
	}
}

export function createAgentStepRuntime<Handler = unknown, Executable = unknown>(
	context: string | StepContext,
	references: AgentStepRuntimeReferences<Handler, Executable> = {},
): AgentStepRuntime<Handler, Executable> {
	return new AgentStepRuntime(context, references)
}

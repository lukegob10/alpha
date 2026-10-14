import {
	createStepContext,
	deriveChildStepContext,
	deriveCompactionStepContext,
	deriveRetryStepContext,
	getStepContextDigests,
	toStepContextMetadata,
	type ChildStepContextOptions,
	type CompactionStepContextOptions,
	type CreateStepContextInput,
	type RetryStepContextOptions,
	type StepContext,
	type StepContextDigests,
	type StepContextMetadata,
} from "./StepContext"
import { AgentStepRuntime, type AgentExecutableRegistry, type AgentStepRuntimeReferences } from "./AgentStepRuntime"

/** One immutable snapshot plus the live process-local values needed to run it. */
export interface AgentStepSnapshot<Handler = unknown, Executable = unknown> {
	readonly context: StepContext
	readonly metadata: StepContextMetadata
	readonly digests: StepContextDigests
	readonly runtime: AgentStepRuntime<Handler, Executable>
}

/** Short alias for code that calls the snapshot an agent step. */
export type AgentStep<Handler = unknown, Executable = unknown> = AgentStepSnapshot<Handler, Executable>

export type AgentStepRuntimeInput<Handler = unknown, Executable = unknown> = AgentStepRuntimeReferences<
	Handler,
	Executable
>

/**
 * Flat input form for callers that already captured all model-visible fields.
 * Runtime values are optional so the builder can also be used for replay and
 * metadata-only tests.
 */
export interface BuildAgentStepContextInput<Handler = unknown, Executable = unknown> extends CreateStepContextInput {
	runtime?: AgentStepRuntimeInput<Handler, Executable> | AgentStepRuntime<Handler, Executable>
	handler?: Handler
	executables?: AgentExecutableRegistry<Executable>
}

/** Object form useful when the context and runtime are captured independently. */
export interface BuildAgentStepInput<Handler = unknown, Executable = unknown> {
	context: CreateStepContextInput
	runtime?: AgentStepRuntimeInput<Handler, Executable> | AgentStepRuntime<Handler, Executable>
	handler?: Handler
	executables?: AgentExecutableRegistry<Executable>
}

export type AgentStepBuilderInput<Handler = unknown, Executable = unknown> =
	| BuildAgentStepContextInput<Handler, Executable>
	| BuildAgentStepInput<Handler, Executable>

export type AgentStepLike<Handler = unknown, Executable = unknown> =
	| AgentStepSnapshot<Handler, Executable>
	| StepContext

function isBuildAgentStepInput<Handler, Executable>(
	input: AgentStepBuilderInput<Handler, Executable>,
): input is BuildAgentStepInput<Handler, Executable> {
	return "context" in input
}

function isAgentStepSnapshot<Handler, Executable>(
	value: AgentStepLike<Handler, Executable>,
): value is AgentStepSnapshot<Handler, Executable> {
	return "context" in value && "runtime" in value && "metadata" in value
}

function contextOf<Handler, Executable>(value: AgentStepLike<Handler, Executable>): StepContext {
	return isAgentStepSnapshot(value) ? value.context : value
}

function runtimeOf<Handler, Executable>(
	value: AgentStepLike<Handler, Executable>,
): AgentStepRuntime<Handler, Executable> | undefined {
	return isAgentStepSnapshot(value) ? value.runtime : undefined
}

function referencesOf<Handler, Executable>(
	input: BuildAgentStepContextInput<Handler, Executable> | BuildAgentStepInput<Handler, Executable>,
	defaults: AgentStepRuntimeInput<Handler, Executable> | undefined,
): AgentStepRuntimeInput<Handler, Executable> | AgentStepRuntime<Handler, Executable> | undefined {
	if (isBuildAgentStepInput(input)) {
		if (input.runtime !== undefined) return input.runtime
		if (input.handler !== undefined || input.executables !== undefined) {
			return { handler: input.handler, executables: input.executables }
		}
		return defaults
	}
	if (input.runtime !== undefined) return input.runtime
	if (input.handler !== undefined || input.executables !== undefined) {
		return { handler: input.handler, executables: input.executables }
	}
	return defaults
}

function contextInputOf<Handler, Executable>(
	input: AgentStepBuilderInput<Handler, Executable>,
): CreateStepContextInput {
	if (isBuildAgentStepInput(input)) return input.context

	const { runtime: _runtime, handler: _handler, executables: _executables, ...context } = input
	return context
}

function runtimeForContext<Handler, Executable>(
	context: StepContext,
	references: AgentStepRuntimeInput<Handler, Executable> | AgentStepRuntime<Handler, Executable> | undefined,
): AgentStepRuntime<Handler, Executable> {
	if (references instanceof AgentStepRuntime) return references.forContext(context)
	return new AgentStepRuntime(context, references)
}

function freezeSnapshot<Handler, Executable>(
	context: StepContext,
	runtime: AgentStepRuntime<Handler, Executable>,
): AgentStepSnapshot<Handler, Executable> {
	const metadata = toStepContextMetadata(context)
	const digests = getStepContextDigests(context)
	return Object.freeze({ context, metadata, digests, runtime })
}

/** Build one immutable step and keep live references only in its runtime companion. */
export class AgentStepContextBuilder<Handler = unknown, Executable = unknown> {
	constructor(private readonly defaultRuntime?: AgentStepRuntimeInput<Handler, Executable>) {}

	build(
		input: AgentStepBuilderInput<Handler, Executable>,
		runtime?: AgentStepRuntimeInput<Handler, Executable> | AgentStepRuntime<Handler, Executable>,
	): AgentStepSnapshot<Handler, Executable> {
		const context = createStepContext(contextInputOf(input))
		const references = runtime ?? referencesOf(input, this.defaultRuntime)
		return freezeSnapshot(context, runtimeForContext(context, references))
	}

	/** Alias for callers that use “create” for the initial snapshot. */
	create(
		input: AgentStepBuilderInput<Handler, Executable>,
		runtime?: AgentStepRuntimeInput<Handler, Executable> | AgentStepRuntime<Handler, Executable>,
	): AgentStepSnapshot<Handler, Executable> {
		return this.build(input, runtime)
	}

	retry(
		step: AgentStepLike<Handler, Executable>,
		options: RetryStepContextOptions | number = {},
		runtime?: AgentStepRuntimeInput<Handler, Executable> | AgentStepRuntime<Handler, Executable>,
	): AgentStepSnapshot<Handler, Executable> {
		const context = deriveRetryStepContext(contextOf(step), options)
		const references = runtime ?? runtimeOf(step) ?? this.defaultRuntime
		return freezeSnapshot(context, runtimeForContext(context, references))
	}

	/** Explicitly named retry derivation for callers avoiding overloaded verbs. */
	deriveRetry(
		step: AgentStepLike<Handler, Executable>,
		options: RetryStepContextOptions | number = {},
		runtime?: AgentStepRuntimeInput<Handler, Executable> | AgentStepRuntime<Handler, Executable>,
	): AgentStepSnapshot<Handler, Executable> {
		return this.retry(step, options, runtime)
	}

	child(
		parent: AgentStepLike<Handler, Executable>,
		options: ChildStepContextOptions,
		runtime?: AgentStepRuntimeInput<Handler, Executable> | AgentStepRuntime<Handler, Executable>,
	): AgentStepSnapshot<Handler, Executable> {
		const context = deriveChildStepContext(contextOf(parent), options)
		const references = runtime ?? runtimeOf(parent) ?? this.defaultRuntime
		return freezeSnapshot(context, runtimeForContext(context, references))
	}

	/** Explicitly named child derivation for callers avoiding overloaded verbs. */
	deriveChild(
		parent: AgentStepLike<Handler, Executable>,
		options: ChildStepContextOptions,
		runtime?: AgentStepRuntimeInput<Handler, Executable> | AgentStepRuntime<Handler, Executable>,
	): AgentStepSnapshot<Handler, Executable> {
		return this.child(parent, options, runtime)
	}

	compaction(
		parent: AgentStepLike<Handler, Executable>,
		options: CompactionStepContextOptions = {},
		runtime?: AgentStepRuntimeInput<Handler, Executable> | AgentStepRuntime<Handler, Executable>,
	): AgentStepSnapshot<Handler, Executable> {
		const context = deriveCompactionStepContext(contextOf(parent), options)
		const references = runtime ?? runtimeOf(parent) ?? this.defaultRuntime
		return freezeSnapshot(context, runtimeForContext(context, references))
	}

	/** Alias for code that calls compaction a derived context. */
	deriveCompaction(
		parent: AgentStepLike<Handler, Executable>,
		options: CompactionStepContextOptions = {},
		runtime?: AgentStepRuntimeInput<Handler, Executable> | AgentStepRuntime<Handler, Executable>,
	): AgentStepSnapshot<Handler, Executable> {
		return this.compaction(parent, options, runtime)
	}
}

/** Standalone builder for code that does not need a retained builder instance. */
export function buildAgentStepContext<Handler = unknown, Executable = unknown>(
	input: AgentStepBuilderInput<Handler, Executable>,
	runtime?: AgentStepRuntimeInput<Handler, Executable> | AgentStepRuntime<Handler, Executable>,
): AgentStepSnapshot<Handler, Executable> {
	return new AgentStepContextBuilder<Handler, Executable>().build(input, runtime)
}

export const createAgentStep = buildAgentStepContext
export const buildAgentStep = buildAgentStepContext

export function deriveRetryAgentStep<Handler = unknown, Executable = unknown>(
	step: AgentStepLike<Handler, Executable>,
	options: RetryStepContextOptions | number = {},
	runtime?: AgentStepRuntimeInput<Handler, Executable> | AgentStepRuntime<Handler, Executable>,
): AgentStepSnapshot<Handler, Executable> {
	return new AgentStepContextBuilder<Handler, Executable>().retry(step, options, runtime)
}

export function deriveChildAgentStep<Handler = unknown, Executable = unknown>(
	parent: AgentStepLike<Handler, Executable>,
	options: ChildStepContextOptions,
	runtime?: AgentStepRuntimeInput<Handler, Executable> | AgentStepRuntime<Handler, Executable>,
): AgentStepSnapshot<Handler, Executable> {
	return new AgentStepContextBuilder<Handler, Executable>().child(parent, options, runtime)
}

export function deriveCompactionAgentStep<Handler = unknown, Executable = unknown>(
	parent: AgentStepLike<Handler, Executable>,
	options: CompactionStepContextOptions = {},
	runtime?: AgentStepRuntimeInput<Handler, Executable> | AgentStepRuntime<Handler, Executable>,
): AgentStepSnapshot<Handler, Executable> {
	return new AgentStepContextBuilder<Handler, Executable>().compaction(parent, options, runtime)
}

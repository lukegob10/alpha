import path from "path"
import { randomUUID } from "node:crypto"

import { t } from "../../i18n"
import { Task } from "../task/Task"
import { digestValue } from "../agent/StepContext"
import { DEFAULT_TOOL_OUTPUT_LIMIT } from "../agent/ToolPolicy"
import { formatResponse } from "../prompts/responses"
import { BaseTool, ToolCallbacks } from "./BaseTool"
import type { NativeToolArgs, ToolUse } from "../../shared/tools"
import type { SkillContent } from "../../shared/skills"
import type { SkillCatalogEntry } from "../prompts/sections/skills"
import {
	buildSkillApprovalMessage,
	buildSkillResult,
	resolveSkillContentForMode,
} from "../../services/skills/skillInvocation"

type SkillParams = NativeToolArgs["skill"]

const MAX_SKILL_INSTRUCTION_CHARACTERS = 512 * 1024
const MAX_PENDING_SKILL_READS = 8

interface SkillInstructionRead {
	identity: string
	contents: string
	offset: number
}

/** Preserve every instruction while respecting the collector's complete response budget. */
function instructionPage(contents: string, start: number, budget: number, nextCursor: string) {
	const render = (end: number) =>
		JSON.stringify({
			contents: contents.slice(start, end),
			complete: end === contents.length,
			next_cursor: end === contents.length ? null : nextCursor,
		})
	const complete = render(contents.length)
	if (complete.length <= budget) return { text: complete, end: contents.length, complete: true }
	let low = start
	let high = contents.length
	let end = start
	while (low <= high) {
		const middle = Math.floor((low + high) / 2)
		let boundary = middle
		if (
			boundary > start &&
			boundary < contents.length &&
			contents.charCodeAt(boundary - 1) >= 0xd800 &&
			contents.charCodeAt(boundary - 1) <= 0xdbff &&
			contents.charCodeAt(boundary) >= 0xdc00 &&
			contents.charCodeAt(boundary) <= 0xdfff
		) {
			boundary--
		}
		if (render(boundary).length <= budget) {
			end = boundary
			low = middle + 1
		} else high = middle - 1
	}
	if (end === start) throw new Error(t("skills:errors.instruction_output_budget"))
	return { text: render(end), end, complete: end === contents.length }
}

function buildSkillCatalogPage(
	skills: readonly SkillCatalogEntry[],
	cursor?: string | null,
	maxBytes: number = 8_000,
): string {
	const byteBudget = Number.isNaN(maxBytes) ? 0 : Math.max(0, Math.min(8_000, Math.floor(maxBytes)))
	const digest = digestValue(skills)
	let offset = 0
	if (cursor !== undefined && cursor !== null) {
		const match = /^v1:([a-f0-9]{64}):(\d{1,10})$/.exec(cursor)
		if (!match || match[1] !== digest || Number(match[2]) > skills.length) {
			throw new Error(t("skills:errors.catalog_invalid_cursor"))
		}
		offset = Number(match[2])
	}
	const entries: Array<{ name: string; description: string; path: string }> = []
	let omittedOversized = 0
	const render = (nextOffset: number) =>
		JSON.stringify({
			skills: entries,
			next_cursor: nextOffset < skills.length ? `v1:${digest}:${nextOffset}` : null,
			omitted_oversized: omittedOversized,
		})
	if (Buffer.byteLength(render(offset), "utf8") > byteBudget) {
		throw new Error(t("skills:errors.catalog_output_budget"))
	}
	const start = offset
	while (offset < skills.length && entries.length < 50 && offset - start < 100) {
		const skill = skills[offset]!
		entries.push({ name: skill.name, description: skill.description, path: skill.path })
		if (Buffer.byteLength(render(offset + 1), "utf8") > byteBudget) {
			entries.pop()
			if (entries.length > 0) break
			omittedOversized++
		}
		offset++
	}
	const result = render(offset)
	if (Buffer.byteLength(result, "utf8") > byteBudget) {
		throw new Error(t("skills:errors.catalog_output_budget"))
	}
	return result
}

function formatSuggestedSkillNames(names: readonly string[]): string {
	let result = ""
	for (const name of names) {
		const next = result ? `${result}, ${name}` : name
		if (Buffer.byteLength(next, "utf8") > 800) {
			return `${result || "(none)"}. ${t("skills:errors.catalog_more_available")}`
		}
		result = next
	}
	return result || "(none)"
}

export class SkillTool extends BaseTool<"skill"> {
	readonly name = "skill" as const
	private readonly instructionReads = new WeakMap<Task, Map<string, SkillInstructionRead>>()

	private async publishCatalogPage(
		skills: readonly SkillCatalogEntry[],
		cursor: string | null | undefined,
		callbacks: ToolCallbacks,
	): Promise<void> {
		callbacks.signal?.throwIfAborted()
		// Validate a supplied cursor before opening the approval UI.
		const page = buildSkillCatalogPage(skills, cursor)
		const approved = await callbacks.askApproval(
			"tool",
			JSON.stringify({ tool: "skill", skill: "list", action: "list", cursor: cursor ?? null }),
		)
		if (!approved) return
		callbacks.signal?.throwIfAborted()
		const remaining = callbacks.getRemainingOutputChars?.() ?? 8_000
		callbacks.pushToolResult(remaining >= 8_000 ? page : buildSkillCatalogPage(skills, cursor, remaining))
	}

	async execute(params: SkillParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const skillName = params.skill ?? ""
		const args = params.args ?? undefined
		const action = params.action ?? "load"
		const { askApproval, handleError, pushToolResult } = callbacks

		try {
			if (action !== "load" && action !== "list") {
				throw new Error(t("skills:errors.unsupported_action", { action }))
			}
			// Legacy calls omit action and continue to require a selected skill.
			if (action === "load" && !skillName) {
				task.consecutiveMistakeCount++
				task.recordToolError("skill")
				task.didToolFailInCurrentTurn = true
				pushToolResult(await task.sayAndCreateMissingParamError("skill", "skill"))
				return
			}

			task.consecutiveMistakeCount = 0

			if (action === "list" && task.taskKind === "subagent") {
				callbacks.signal?.throwIfAborted()
				const skills = task.getInheritedSubagentSkillNames().flatMap((name) => {
					const inherited = task.getInheritedSubagentSkill(name)
					return inherited && inherited.allowImplicitInvocation !== false
						? [{ name: inherited.name, path: inherited.path, description: inherited.description ?? "" }]
						: []
				})
				await this.publishCatalogPage(skills, params.cursor, callbacks)
				return
			}

			// Get SkillsManager from provider
			const provider = task.providerRef.deref()
			const skillsManager = await provider?.getSkillsManager(task)

			if (!skillsManager) {
				task.recordToolError("skill")
				task.didToolFailInCurrentTurn = true
				pushToolResult(formatResponse.toolError("Skills Manager not available"))
				return
			}

			// Resolve against the task's sticky mode, not mutable foreground UI state.
			const currentMode =
				typeof task.getTaskMode === "function"
					? await task.getTaskMode()
					: ((await provider?.getState())?.mode ?? "code")
			if (action === "list") {
				callbacks.signal?.throwIfAborted()
				const skills = skillsManager
					.getSkillsForMode(currentMode)
					.filter((skill) => skill.allowImplicitInvocation !== false)
				await this.publishCatalogPage(skills, params.cursor, callbacks)
				return
			}
			const inheritedSkill = task.taskKind === "subagent" ? task.getInheritedSubagentSkill(skillName) : undefined
			const getSuggestedSkillNames = () =>
				task.taskKind === "subagent"
					? task
							.getInheritedSubagentSkillNames()
							.filter((name) => task.getInheritedSubagentSkill(name)?.allowImplicitInvocation !== false)
					: skillsManager
							.getSkillsForMode(currentMode)
							.filter((skill) => skill.allowImplicitInvocation !== false)
							.map((skill) => skill.name)

			if (task.taskKind === "subagent" && !inheritedSkill) {
				const availableSkills = getSuggestedSkillNames()
				task.recordToolError("skill")
				task.didToolFailInCurrentTurn = true
				pushToolResult(
					formatResponse.toolError(
						`Skill '${skillName}' was not included in this child task's frozen catalog. Available skills: ${formatSuggestedSkillNames(availableSkills)}`,
					),
				)
				return
			}

			// A child resolves the exact captured path, so a same-name mode override
			// cannot replace the inherited skill after launch.
			const exactSkillLookup = skillsManager as typeof skillsManager & {
				getSkillContentByPath?: (name: string, capturedPath: string) => Promise<SkillContent | null>
			}
			const skillContent = inheritedSkill
				? await exactSkillLookup.getSkillContentByPath?.(skillName, inheritedSkill.path)
				: await resolveSkillContentForMode(skillsManager, skillName, currentMode)

			if (!skillContent) {
				// Get available skills for error message
				const skillNames = getSuggestedSkillNames()

				task.recordToolError("skill")
				task.didToolFailInCurrentTurn = true
				pushToolResult(
					formatResponse.toolError(
						`Skill '${skillName}' not found. Available skills: ${formatSuggestedSkillNames(skillNames)}`,
					),
				)
				return
			}

			if (inheritedSkill) {
				const normalizePath = (candidate: string) => {
					const resolved = path.resolve(candidate)
					return process.platform === "win32" ? resolved.toLowerCase() : resolved
				}
				if (normalizePath(skillContent.path) !== normalizePath(inheritedSkill.path)) {
					task.recordToolError("skill")
					task.didToolFailInCurrentTurn = true
					pushToolResult(
						formatResponse.toolError(
							`Skill '${skillName}' no longer resolves to the path captured for this child task.`,
						),
					)
					return
				}
				if (digestValue(skillContent.instructions) !== inheritedSkill.digest) {
					task.recordToolError("skill")
					task.didToolFailInCurrentTurn = true
					pushToolResult(
						formatResponse.toolError(
							`Skill '${skillName}' changed after this child task captured its context. Start a new child to use the updated skill.`,
						),
					)
					return
				}
			}

			const contents = buildSkillResult(skillName, args, skillContent)
			if (contents.length > MAX_SKILL_INSTRUCTION_CHARACTERS) {
				throw new Error(t("skills:errors.instruction_size_limit"))
			}
			const identity = digestValue({ skillName, args, currentMode, ...skillContent })
			const cursor = params.cursor ?? undefined
			const pending = cursor !== undefined ? this.instructionReads.get(task)?.get(cursor) : undefined
			if (cursor !== undefined && (!pending || pending.identity !== identity)) {
				throw new Error(t("skills:errors.instruction_invalid_cursor"))
			}

			// Build approval message
			const toolMessage = buildSkillApprovalMessage(skillName, args, skillContent)

			const didApprove = await askApproval("tool", toolMessage)

			if (!didApprove) {
				return
			}

			callbacks.signal?.throwIfAborted()
			if (cursor !== undefined && this.instructionReads.get(task)?.get(cursor) !== pending) {
				throw new Error(t("skills:errors.instruction_invalid_cursor"))
			}
			const available = callbacks.getRemainingOutputChars?.() ?? DEFAULT_TOOL_OUTPUT_LIMIT
			const budget = Number.isFinite(available) ? Math.max(0, Math.floor(available)) : DEFAULT_TOOL_OUTPUT_LIMIT
			if (!pending && contents.length <= budget) {
				pushToolResult(contents)
			} else {
				const nextCursor = randomUUID()
				const page = instructionPage(pending?.contents ?? contents, pending?.offset ?? 0, budget, nextCursor)
				// Failed delivery leaves an existing cursor retryable and never advances provenance.
				pushToolResult(page.text)
				const reads = this.instructionReads.get(task) ?? new Map<string, SkillInstructionRead>()
				if (cursor) reads.delete(cursor)
				if (!page.complete) {
					while (reads.size >= MAX_PENDING_SKILL_READS) reads.delete(reads.keys().next().value!)
					reads.set(nextCursor, { identity, contents, offset: page.end })
				}
				if (reads.size > 0) this.instructionReads.set(task, reads)
				else this.instructionReads.delete(task)
				if (!page.complete) return
			}
			callbacks.signal?.throwIfAborted()
			await task.recordLoadedSkill?.(skillName, skillContent.path, digestValue(skillContent.instructions))
		} catch (error) {
			await handleError("executing skill", error as Error)
		}
	}

	override async handlePartial(task: Task, block: ToolUse<"skill">): Promise<void> {
		const skillName: string | undefined = block.params.skill
		const args: string | undefined = block.params.args
		const action = block.params.action
		const cursor = block.params.cursor

		const partialMessage = JSON.stringify({
			tool: "skill",
			skill: skillName ?? (action === "list" ? "list" : undefined),
			args: args,
			...(action === undefined ? {} : { action }),
			...(cursor === undefined ? {} : { cursor }),
		})

		await task.ask("tool", partialMessage, block.partial).catch(() => {})
	}
}

export const skillTool = new SkillTool()

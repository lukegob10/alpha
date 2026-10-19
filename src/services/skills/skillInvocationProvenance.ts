import { isDeepStrictEqual } from "node:util"
import path from "path"
import type { Anthropic } from "@anthropic-ai/sdk"
import type { SubagentContextSkill } from "@alpha-code/types"

import { digestValue } from "../../core/agent/StepContext"
import type { ApiMessage } from "../../core/task-persistence/apiMessages"
import type { SkillContent } from "../../shared/skills"
import { getToolCallId, getToolResultId, sanitizeToolUseId } from "../../utils/tool-id"
import type { SkillLookup } from "./skillInvocation"

const HUMAN_FEEDBACK_TOOLS = new Set(["ask_followup_question", "attempt_completion"])

function getFeedbackToolName(block: object): string | undefined {
	const directName: unknown = Reflect.get(block, "name")
	const legacyFunction: unknown = Reflect.get(block, "function")
	const legacyName: unknown =
		legacyFunction !== null && typeof legacyFunction === "object" && !Array.isArray(legacyFunction)
			? Reflect.get(legacyFunction, "name")
			: undefined
	if (directName !== undefined && typeof directName !== "string") return undefined
	if (legacyName !== undefined && typeof legacyName !== "string") return undefined
	if (directName !== undefined && legacyName !== undefined && directName !== legacyName) return undefined
	const name = directName ?? legacyName
	return typeof name === "string" && HUMAN_FEEDBACK_TOOLS.has(name) ? name : undefined
}

/** Match pending successful feedback to host-recorded calls; returned IDs use the canonical wire normalization. */
export function getHumanFeedbackToolResultIds(
	history: readonly ApiMessage[],
	content: readonly Anthropic.Messages.ContentBlockParam[],
): ReadonlySet<string> {
	try {
		const pending = new Map<string, Anthropic.Messages.ToolResultBlockParam>()
		const seenResults = new Set<string>()
		for (const block of content) {
			if (block.type !== "tool_result") continue
			const id = getToolResultId(block)
			if (id === undefined) continue
			const normalized = sanitizeToolUseId(id)
			if (seenResults.has(normalized)) {
				pending.delete(normalized)
				continue
			}
			seenResults.add(normalized)
			if (block.is_error === undefined || block.is_error === false) pending.set(normalized, block)
		}

		const humanFeedback = new Set<string>()
		for (let index = history.length - 1; index >= 0 && pending.size > 0; index--) {
			const message = history[index]
			if (!Array.isArray(message.content)) continue
			if (message.role === "user") {
				// Retries may already have persisted this exact successful result; changed transactions cannot reuse it.
				for (const block of message.content) {
					if (block.type !== "tool_result") continue
					const id = getToolResultId(block)
					if (id === undefined) continue
					const normalized = sanitizeToolUseId(id)
					const supplied = pending.get(normalized)
					if (!supplied) continue
					if (
						(block.is_error !== undefined && block.is_error !== false) ||
						!isDeepStrictEqual(block.content, supplied.content)
					) {
						pending.delete(normalized)
					}
				}
				continue
			}
			if (message.role !== "assistant") continue

			const names = new Map<string, string | undefined>()
			for (const block of message.content) {
				const id = getToolCallId(block)
				if (id === undefined) continue
				const normalized = sanitizeToolUseId(id)
				if (!pending.has(normalized)) continue
				// Duplicate IDs, including sanitization collisions, are ambiguous even within one assistant boundary.
				names.set(normalized, names.has(normalized) ? undefined : getFeedbackToolName(block))
			}
			for (const [id, name] of names) {
				pending.delete(id)
				if (name !== undefined) humanFeedback.add(id)
			}
		}
		return humanFeedback
	} catch {
		// Conflicting persisted ID aliases cannot establish human intent; input processing itself remains available.
		return new Set<string>()
	}
}

export function getSkillLookupForInput(
	skillsManager: SkillLookup | undefined,
	explicitInvocation: boolean,
): SkillLookup | undefined {
	if (!skillsManager || explicitInvocation) return skillsManager
	return {
		async getSkillContent(name, currentMode) {
			const content = await skillsManager.getSkillContent(name, currentMode)
			return content?.allowImplicitInvocation === false ? null : content
		},
		async getExplicitSkillContent(selector, currentMode) {
			const content = skillsManager.getExplicitSkillContent
				? await skillsManager.getExplicitSkillContent(selector, currentMode)
				: await skillsManager.getSkillContent(selector, currentMode)
			return content?.allowImplicitInvocation === false ? null : content
		},
	}
}

/** A child's mention expansion uses the same captured identity and content boundary as its skill tool. */
export function getSkillLookupForCapturedCatalog(
	skillsManager:
		| (SkillLookup & {
				getSkillContentByPath?: (name: string, capturedPath: string) => Promise<SkillContent | null>
		  })
		| undefined,
	skills: readonly SubagentContextSkill[],
): SkillLookup | undefined {
	if (!skillsManager) return undefined
	const capturedSkills = new Map<string, SubagentContextSkill>(
		skills.map(({ name, path, digest, allowImplicitInvocation }) => [
			name,
			{ name, path, digest, allowImplicitInvocation },
		]),
	)
	const normalizePath = (candidate: string) => {
		const resolved = path.resolve(candidate)
		return process.platform === "win32" ? resolved.toLowerCase() : resolved
	}
	return {
		async getExplicitSkillContent(selector) {
			const isPath = path.isAbsolute(selector)
			const namespace = !isPath && selector.includes(":") ? selector.split(":") : undefined
			const matches = [...capturedSkills.values()].filter((skill) =>
				isPath
					? normalizePath(skill.path) === normalizePath(selector)
					: skill.name === (namespace?.[1] ?? selector),
			)
			if (matches.length !== 1) return null
			const content = await this.getSkillContent(matches[0].name)
			return namespace && (namespace.length !== 2 || content?.source !== namespace[0]) ? null : content
		},
		async getSkillContent(name) {
			const captured = capturedSkills.get(name)
			if (!captured) return null
			const content = await skillsManager.getSkillContentByPath?.(name, captured.path)
			if (
				!content ||
				content.name !== captured.name ||
				normalizePath(content.path) !== normalizePath(captured.path) ||
				digestValue(content.instructions) !== captured.digest
			) {
				return null
			}
			const { allowImplicitInvocation: _livePolicy, ...capturedContent } = content
			return {
				...capturedContent,
				...(captured.allowImplicitInvocation === undefined
					? {}
					: { allowImplicitInvocation: captured.allowImplicitInvocation }),
			}
		},
	}
}

import { createHash } from "node:crypto"

import { Tiktoken } from "tiktoken/lite"
import o200kBase from "tiktoken/encoders/o200k_base"
import { describe, expect, it } from "vitest"

import {
	CODEX_MODEL_INSTRUCTIONS,
	CODEX_MODEL_INSTRUCTIONS_SHA256,
	DEFAULT_CODEX_MODEL_PROMPT,
	resolveCodexModelPrompt,
} from "../codex-model-instructions"

const codexModelIds = [
	["gpt-6-astra", "gpt-6-astra"],
	["gpt-6-sol", "gpt-6-sol"],
	["gpt-6-luna", "gpt-6-luna"],
	["gpt-5.6-sol", "gpt-5.6"],
	["gpt-5.6-terra", "gpt-5.6"],
	["gpt-5.6-luna", "gpt-5.6"],
	["gpt-daybreak-blue-latest", "gpt-daybreak-blue-latest"],
	["gpt-daybreak-red-latest", "gpt-daybreak-red-latest"],
	["gpt-5.5", "gpt-5.5"],
	["gpt-5.4", "gpt-5.4"],
] as const

const pinnedSourceSha256 = {
	"gpt-6-astra": "35bd51b5f577cb7b24cd5f4629e49e37cb724ab57754ce6f8f202001635bab8a",
	"gpt-6-sol": "b1dd8718c037906c53a305c5cbccb4a4be35ccbb7837461ec349bfc495412f0d",
	"gpt-6-luna": "b707476816bfe5e571a1bd2179f130fff2b132da5ab8e61063acdb7fd24daf12",
	"gpt-5.6": "a91357a1cd2727a0be06d461248d6e3a7274746e38108f548a3adf2cc2430415",
	"gpt-daybreak-blue-latest": "ebd0d5854abd07dc38300a71e027204eb028e9fa443c59d18e36fcc24289e818",
	"gpt-daybreak-red-latest": "40a1232c8bd01a87dc2283e5ae3c75f2b054dc2a12cf04e5a279c26e5c541b9b",
	"gpt-5.5": "2351631dfc5644dc5a45eaaca4139475bd02810ee6cb792d058b551559b3242e",
	"gpt-5.4": "f8c4032f78fdb19b46f468239c5dc757f745fbb10520e64e1e4afbf747e52fb8",
} as const

describe("pinned Codex model instructions", () => {
	it.each(codexModelIds)("resolves exact model id %s", (modelId, promptSlug) => {
		const result = resolveCodexModelPrompt(modelId)

		expect(result).toMatchObject({
			requestedModelId: modelId,
			matchedModelId: modelId,
			promptSlug,
			isFallback: false,
		})
		expect(result.instructions).toBe(CODEX_MODEL_INSTRUCTIONS[promptSlug])
	})

	it("maps the three GPT-5.6 variants to their byte-identical pinned template", () => {
		const prompts = ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"].map(
			(modelId) => resolveCodexModelPrompt(modelId).instructions,
		)

		expect(new Set(prompts).size).toBe(1)
		expect(prompts[0]).toBe(CODEX_MODEL_INSTRUCTIONS["gpt-5.6"])
	})

	it.each([
		undefined,
		"claude-sonnet-4.6",
		"gemini-2.5-pro",
		"gpt-5.3-codex",
		"custom-gpt-5.6-sol-wrapper",
		"constructor",
	])("uses the pinned GPT-6 Sol fallback for unsupported id %s", (modelId) => {
		const result = resolveCodexModelPrompt(modelId)

		expect(result.promptSlug).toBe(DEFAULT_CODEX_MODEL_PROMPT)
		expect(result.instructions).toBe(CODEX_MODEL_INSTRUCTIONS["gpt-6-sol"])
		expect(result.isFallback).toBe(true)
		expect(result.matchedModelId).toBeUndefined()
	})

	it("resolves provider-qualified model ids without depending on the provider name", () => {
		expect(resolveCodexModelPrompt("vscode-lm:gpt-6-luna").promptSlug).toBe("gpt-6-luna")
		expect(resolveCodexModelPrompt("openai/gpt-5.6-sol").promptSlug).toBe("gpt-5.6")
		expect(resolveCodexModelPrompt("private-provider_gpt-5.5").promptSlug).toBe("gpt-5.5")
	})

	it.each(
		codexModelIds.flatMap(([modelId, promptSlug]) => [
			[`copilot-${modelId}`, promptSlug] as const,
			[`copilot/${modelId}`, promptSlug] as const,
		]),
	)("preserves existing Copilot alias %s", (modelId, promptSlug) => {
		expect(resolveCodexModelPrompt(modelId).promptSlug).toBe(promptSlug)
	})

	it("normalizes case and whitespace while rejecting unknown trailing wrappers", () => {
		expect(resolveCodexModelPrompt("  GPT-5.5  ").promptSlug).toBe("gpt-5.5")
		expect(resolveCodexModelPrompt("custom-gpt-5.6-sol-wrapper").isFallback).toBe(true)
	})

	it("keeps every embedded prompt byte-for-byte equal to its pinned source digest", () => {
		for (const [slug, instructions] of Object.entries(CODEX_MODEL_INSTRUCTIONS)) {
			const digest = createHash("sha256").update(instructions, "utf8").digest("hex")
			expect(digest, slug).toBe(pinnedSourceSha256[slug as keyof typeof pinnedSourceSha256])
			expect(CODEX_MODEL_INSTRUCTIONS_SHA256[slug as keyof typeof CODEX_MODEL_INSTRUCTIONS]).toBe(
				pinnedSourceSha256[slug as keyof typeof pinnedSourceSha256],
			)
			expect(instructions.toLowerCase(), `${slug} sandbox language`).not.toContain("sandbox")
		}
	})

	it("measures the pinned GPT-5.6 template with the o200k tokenizer", () => {
		const encoder = new Tiktoken(o200kBase.bpe_ranks, o200kBase.special_tokens, o200kBase.pat_str)
		const tokenCount = encoder.encode(CODEX_MODEL_INSTRUCTIONS["gpt-5.6"], undefined, []).length

		// The previous Alpha-only base prompt measured 2,158 o200k tokens.
		expect(tokenCount).toBe(3552)
		expect(tokenCount).toBeGreaterThan(2158)
	})
})

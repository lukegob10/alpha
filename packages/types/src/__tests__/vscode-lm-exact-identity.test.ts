import { getVscodeLlmCatalogModels, getVscodeLlmExactModelId, getVscodeLlmModelId } from "../providers/vscode-llm.js"

describe("exact Copilot catalog identity", () => {
	it("resolves each configured catalog choice without a live provider ID", () => {
		for (const model of getVscodeLlmCatalogModels()) {
			expect(getVscodeLlmExactModelId(model)).toBe(getVscodeLlmModelId(model))
		}
	})

	it.each([
		{ model: { family: " GPT-6 SOL " }, id: "gpt-6-sol" },
		{ model: { id: "gpt-6.1-sol" }, id: "gpt-6.1-sol" },
		{ model: { name: "GPT-6.1 Sol" }, id: "gpt-6.1-sol" },
		{ model: { name: "  Gemini  3.7 Flash  " }, id: "gemini-3.7-flash" },
		{ model: { family: "claude-opus-5-5" }, id: "claude-opus-5.5" },
		{ model: { family: "gemini-3.1-pro-preview" }, id: "gemini-3.1-pro" },
		{
			model: { family: "opaque-family", id: "opaque-route", name: "GPT-6.1 Sol", version: "2026-10-27" },
			id: "gpt-6.1-sol",
		},
	])("resolves exact declared evidence: $model", ({ model, id }) => {
		expect(getVscodeLlmExactModelId({ vendor: "copilot", ...model })).toBe(id)
	})

	it.each([
		{ family: "gemini-3.1-pro-preview", name: "Gemini 3.1 Pro (Preview)", id: "gemini-3.1-pro" },
		{ family: "gpt-6-sol", name: "GPT 6 Sol (Preview)", id: "gpt-6-sol" },
		{ family: "claude-opus-5-5", name: "Claude Opus 5.5 (936K context)", id: "claude-opus-5.5" },
	])("keeps exact family identity when the host decorates its display label: $family", ({ family, name, id }) => {
		expect(getVscodeLlmExactModelId({ vendor: "copilot", family, name, id: "opaque-route" })).toBe(id)
	})

	it.each([
		{ family: "gpt-6-sol-mini" },
		{ name: "GPT-6 Sol Experimental" },
		{ family: "gpt-6-sol-mini", name: "GPT 6 Sol" },
		{ family: "gpt-6-sol", name: "GPT 6 Sol Experimental" },
		{ family: "gpt-6-sol", name: "GPT 6 Sol Mini" },
		{ family: "gpt-6-sol", name: "gpt-6-sol-mini" },
		{ family: "claude-opus-5.50" },
		{ family: "claude-opus-5.5-extra", name: "Claude Opus 5.5" },
		{ family: "gpt-6-sol", id: "gpt-6-luna" },
		{ family: "gpt-6-sol", name: "GPT 6 Luna" },
		{ family: "gpt-6-sol", version: "gpt-6-luna" },
		{ vendor: "another-provider", family: "gpt-6-sol" },
		{ family: "unknown-model", id: "opaque-route" },
	])("rejects unknown variants and conflicting evidence: %j", (model) => {
		expect(getVscodeLlmExactModelId(model)).toBeUndefined()
	})

	it("keeps decorated legacy metadata lookup separate from runtime binding", () => {
		const model = { vendor: "copilot", id: "copilot-gpt-6-sol-mini" }
		expect(getVscodeLlmModelId(model)).toBe("gpt-6-sol")
		expect(getVscodeLlmExactModelId(model)).toBeUndefined()
		expect(
			getVscodeLlmExactModelId({
				vendor: "copilot",
				family: "gpt-6-sol",
				id: "copilot-gpt-6-sol-standard",
				version: "2026-10-27",
			}),
		).toBe("gpt-6-sol")
	})
})

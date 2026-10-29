import { describe, expect, it, vi } from "vitest"
import type { ListProviderProfilesParams, ProviderSettingsEntry } from "@alpha-code/types"

import type { Task } from "../../task/Task"
import { listProviderProfiles } from "../../prompts/tools/native-tools/list_provider_profiles"
import { listProviderProfilesTool } from "../ListProviderProfilesTool"
import type { ToolCallbacks } from "../BaseTool"

interface ProfilePage {
	profiles: Array<{ id: string; name: string; provider: string | null; model: string | null; availability?: string }>
	next_cursor: string | null
	omitted_oversized: number
}

function fixture(initial: ProviderSettingsEntry[] = []) {
	let profiles = initial
	const provider = {
		listProviderProfiles: vi.fn(async () => profiles),
		activateProviderProfile: vi.fn(),
	}
	const task = {
		providerRef: new WeakRef(provider),
		recordToolError: vi.fn(),
		didToolFailInCurrentTurn: false,
	} as unknown as Task
	const results: string[] = []
	const statuses: unknown[] = []
	const callbacks: ToolCallbacks = {
		askApproval: vi.fn(async () => true),
		handleError: vi.fn(async () => undefined),
		pushToolResult: vi.fn((result) => results.push(String(result))),
		setResultMetadata: (metadata) => statuses.push(metadata.status),
	}
	return {
		task,
		provider,
		callbacks,
		results,
		statuses,
		setProfiles: (next: ProviderSettingsEntry[]) => {
			profiles = next
		},
		async read(params: ListProviderProfilesParams = {}) {
			await listProviderProfilesTool.execute(params, task, callbacks)
			return JSON.parse(results.at(-1)!) as ProfilePage
		},
	}
}

const grok: ProviderSettingsEntry = {
	id: "profile-stable-grok",
	name: "Northern Lights",
	apiProvider: "vscode-lm",
	modelId: "grok-4.6",
}

describe("list_provider_profiles", () => {
	it.each([
		["vscode-lm", "GitHub"],
		["vscode-lm", "GitHub Copilot"],
		["vscode-lm", "GitHubCopilot"],
		["vscode-lm", "VS Code LM API"],
		["openai-codex", "ChatGPT"],
		["openai-codex", "Sign in with ChatGPT"],
		["bedrock", "Amazon Bedrock"],
		["bedrock", "AmazonBedrock"],
		["gemini", "Google Gemini"],
		["vertex", "GCP Vertex AI"],
		["openai-native", "OpenAI"],
		["openai", "OpenAI Compatible"],
	])("matches %s by product label %s while returning the canonical provider", async (provider, query) => {
		const f = fixture([
			{ id: "account-a", name: "Account A", apiProvider: provider, modelId: "configured-model" },
			{ id: "account-b", name: "Account B", apiProvider: "stellar", modelId: "configured-model" },
		])
		expect((await f.read({ query })).profiles).toEqual([
			{ id: "account-a", name: "Account A", provider, model: "configured-model" },
		])
	})

	it("keeps product-label queries literal and preserves query-bound paging", async () => {
		const f = fixture(
			Array.from({ length: 60 }, (_, index) => ({ ...grok, id: `id-${index}`, name: `Team ${index}` })),
		)
		expect((await f.read({ query: "GitHub.*" })).profiles).toEqual([])
		const first = await f.read({ query: "GitHub" })
		expect(first.next_cursor).toBeTruthy()
		expect((await f.read({ query: "GITHUB", cursor: first.next_cursor })).profiles.length).toBeGreaterThan(0)
		await listProviderProfilesTool.execute(
			{ query: "GitHub Copilot", cursor: first.next_cursor },
			f.task,
			f.callbacks,
		)
		expect(f.statuses.at(-1)).toBe("error")
		expect(f.results.at(-1)).toContain("query changed")
	})

	it("advertises read-only live discovery and selection by returned ID", () => {
		expect(listProviderProfiles.function.name).toBe("list_provider_profiles")
		expect(listProviderProfiles.function.description).toContain("returned ID as profile")
		expect(listProviderProfiles.function.parameters).toMatchObject({
			additionalProperties: false,
			properties: { query: { maxLength: 256 }, cursor: { maxLength: 128 } },
		})
	})

	it("discovers arbitrary saved names and projects metadata without credentials or activation", async () => {
		const sensitive = {
			...grok,
			apiKey: "fixture-private-key",
			openAiBaseUrl: "https://private.example",
			openAiHeaders: { secret: "private-header" },
		}
		const f = fixture([sensitive])
		expect(await f.read()).toEqual({
			profiles: [{ id: grok.id, name: grok.name, provider: "vscode-lm", model: "grok-4.6" }],
			next_cursor: null,
			omitted_oversized: 0,
		})
		expect(f.provider.listProviderProfiles).toHaveBeenCalledTimes(1)
		expect(f.provider.activateProviderProfile).not.toHaveBeenCalled()
		expect(f.callbacks.askApproval).not.toHaveBeenCalled()
		expect(f.results[0]).not.toContain("private")
		expect(f.statuses).toEqual(["success"])
	})

	it("uses fresh authoritative metadata after rename, save, and delete", async () => {
		const f = fixture([grok])
		expect((await f.read()).profiles[0].name).toBe(grok.name)
		f.setProfiles([{ ...grok, name: "Grok account renamed" }])
		expect((await f.read({ query: "GROK" })).profiles[0].name).toBe("Grok account renamed")
		f.setProfiles([])
		expect((await f.read()).profiles).toEqual([])
		f.setProfiles([{ id: "another-profile", name: "Sol lab", apiProvider: "openai-codex", modelId: "gpt-6.1-sol" }])
		expect((await f.read()).profiles[0].id).toBe("another-profile")
		expect(f.provider.listProviderProfiles).toHaveBeenCalledTimes(4)
	})

	it("paginates all profiles beyond the former ten-profile cap with bounded UTF-8 output", async () => {
		const profiles = Array.from({ length: 125 }, (_, index) => ({
			...grok,
			id: `profile-${index.toString().padStart(3, "0")}`,
			name: `Team 🚀 ${index}`,
		}))
		const f = fixture(profiles)
		const found: string[] = []
		let cursor: string | null = null
		do {
			const page = await f.read({ cursor })
			found.push(...page.profiles.map((profile) => profile.id))
			expect(page.profiles.length).toBeLessThanOrEqual(50)
			expect(Buffer.byteLength(f.results.at(-1)!, "utf8")).toBeLessThanOrEqual(8_192)
			cursor = page.next_cursor
		} while (cursor)
		expect(found).toEqual(profiles.map((profile) => profile.id))
		expect(new Set(found).size).toBe(125)
	})

	it("respects the remaining text budget and reports oversized records explicitly", async () => {
		const f = fixture([{ ...grok, id: "a", name: "x".repeat(9_000) }, grok])
		f.callbacks.getRemainingOutputChars = () => 500
		const page = await f.read()
		expect(page.omitted_oversized).toBe(1)
		expect(page.profiles.map((profile) => profile.id)).toEqual([grok.id])
		expect(f.results[0].length).toBeLessThanOrEqual(500)
	})

	it("keeps unavailable configuration visible as data and handles literal queries", async () => {
		const f = fixture([{ ...grok, name: "Saved [Lab]", availability: "invalid" }])
		expect((await f.read({ query: "[LAB]" })).profiles[0]).toMatchObject({
			name: "Saved [Lab]",
			availability: "invalid",
		})
		expect((await f.read({ query: "no match" })).profiles).toEqual([])
	})

	it("accepts reordered equivalent metadata but rejects stale or mismatched-query cursors", async () => {
		const profiles = Array.from({ length: 60 }, (_, index) => ({
			...grok,
			id: `id-${index}`,
			name: `Team ${index}`,
		}))
		const f = fixture(profiles)
		const cursor = (await f.read({ query: "team" })).next_cursor
		expect(cursor).toBeTruthy()
		f.setProfiles([...profiles].reverse())
		expect((await f.read({ query: "TEAM", cursor })).profiles.length).toBeGreaterThan(0)
		f.setProfiles([{ ...profiles[0], name: "Team renamed" }, ...profiles.slice(1)])
		await listProviderProfilesTool.execute({ query: "team", cursor }, f.task, f.callbacks)
		expect(f.results.at(-1)).toContain("Restart list_provider_profiles")
		expect(f.statuses.at(-1)).toBe("error")
		await listProviderProfilesTool.execute({ query: "grok", cursor }, f.task, f.callbacks)
		expect(f.statuses.at(-1)).toBe("error")
	})

	it("rejects malformed inputs before reading saved profiles", async () => {
		const f = fixture([grok])
		await listProviderProfilesTool.execute({ query: "x".repeat(257) }, f.task, f.callbacks)
		await listProviderProfilesTool.execute({ cursor: "invalid" }, f.task, f.callbacks)
		expect(f.provider.listProviderProfiles).not.toHaveBeenCalled()
		expect(f.statuses).toEqual(["error", "error"])
		expect(f.task.didToolFailInCurrentTurn).toBe(true)
	})

	it("does not expose storage errors or their sensitive contents", async () => {
		const f = fixture()
		f.provider.listProviderProfiles.mockRejectedValue(new Error("fixture-sensitive-storage-details"))
		await listProviderProfilesTool.execute({}, f.task, f.callbacks)
		expect(f.results[0]).toContain("Check provider settings")
		expect(f.results[0]).not.toContain("sensitive")
		expect(f.statuses).toEqual(["error"])
	})

	it("cancels a pending local read once, removes its listener, and ignores late data", async () => {
		const f = fixture([grok])
		const controller = new AbortController()
		f.callbacks.signal = controller.signal
		let resolve!: (profiles: ProviderSettingsEntry[]) => void
		f.provider.listProviderProfiles.mockImplementation(
			() =>
				new Promise((complete) => {
					resolve = complete
				}),
		)
		const remove = vi.spyOn(controller.signal, "removeEventListener")
		const pending = listProviderProfilesTool.execute({}, f.task, f.callbacks)
		controller.abort()
		await pending
		resolve([grok])
		await Promise.resolve()
		expect(f.results).toHaveLength(1)
		expect(f.statuses).toEqual(["cancelled"])
		expect(remove).toHaveBeenCalledWith("abort", expect.any(Function))
		expect(f.task.recordToolError).not.toHaveBeenCalled()
	})
})

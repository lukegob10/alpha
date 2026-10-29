import { ProviderProfileUnavailableError } from "../../config/ProviderProfileUnavailableError"
import { resolveSubagentModelRoute } from "../SubagentModelRouter"

const parentApiConfiguration = { apiProvider: "openai" as const, openAiModelId: "captured-parent-model" }
const selectedProfile = {
	id: "selected-id",
	name: "Selected",
	apiProvider: "vertex" as const,
	apiModelId: "child-model",
}
const failures = [
	{ label: "invalid", code: "invalid" as const, fields: ["modelTemperature"] },
	{ label: "unsupported", code: "unsupported" as const, fields: [] },
	{ label: "ambiguous ID", code: "invalid" as const, fields: ["id"] },
]

describe.each(["role", "default"] as const)("explicit %s child profile availability", (source) => {
	it.each(failures)("rejects $label availability instead of selecting another provider", async ({ code, fields }) => {
		const unavailable = new ProviderProfileUnavailableError(code, { id: "selected-id", name: "Selected" }, fields)
		const profileLoader = {
			assertProfileAvailable: vi.fn().mockRejectedValue(unavailable),
			getProfile: vi.fn().mockResolvedValue(selectedProfile),
		}

		await expect(
			resolveSubagentModelRoute({
				role: "review",
				parentApiConfiguration,
				parentApiConfigName: "Parent",
				...(source === "role"
					? { profileByRole: { review: "selected-id" } }
					: { defaultProfileId: "selected-id" }),
				profileLoader,
			}),
		).rejects.toBe(unavailable)
		expect(profileLoader.assertProfileAvailable).toHaveBeenCalledExactlyOnceWith({ id: "selected-id" })
		expect(profileLoader.getProfile).not.toHaveBeenCalled()
	})

	it.each(failures)("rejects $label discovered after the initial availability check", async ({ code, fields }) => {
		const unavailable = new ProviderProfileUnavailableError(code, { id: "selected-id", name: "Selected" }, fields)
		const profileLoader = {
			assertProfileAvailable: vi.fn().mockResolvedValue(undefined),
			getProfile: vi.fn().mockRejectedValue(unavailable),
		}

		await expect(
			resolveSubagentModelRoute({
				role: "review",
				parentApiConfiguration,
				parentApiConfigName: "Parent",
				...(source === "role"
					? { profileByRole: { review: "selected-id" } }
					: { defaultProfileId: "selected-id" }),
				profileLoader,
			}),
		).rejects.toBe(unavailable)
		expect(profileLoader.getProfile).toHaveBeenCalledExactlyOnceWith({ id: "selected-id" })
	})
})

it("keeps the historical visible fallback for a genuinely missing explicit profile", async () => {
	const profileLoader = {
		assertProfileAvailable: vi.fn().mockRejectedValue(new Error("Profile not found")),
		getProfile: vi.fn(async (params: { id: string } | { name: string }) => {
			if ("id" in params) throw new Error("Profile not found")
			return { id: "parent-id", name: "Parent", ...parentApiConfiguration }
		}),
	}
	const result = await resolveSubagentModelRoute({
		role: "worker",
		parentApiConfiguration,
		parentApiConfigName: "Parent",
		defaultProfileId: "missing-id",
		parentReasoningPreference: { kind: "effort", effort: "high" },
		profileLoader,
	})

	expect(result.apiConfiguration).toEqual(parentApiConfiguration)
	expect(result.reasoningPreference).toEqual({ kind: "effort", effort: "high" })
	expect(result.route).toMatchObject({ source: "default", resolution: "fallback", fallbackReason: "missing" })
})

it("inherits a captured parent configuration despite an unavailable later saved parent profile", async () => {
	const unavailable = new ProviderProfileUnavailableError("invalid", { id: "parent-id", name: "Parent" }, ["id"])
	const profileLoader = {
		assertProfileAvailable: vi.fn().mockRejectedValue(unavailable),
		getProfile: vi.fn().mockRejectedValue(unavailable),
	}
	const result = await resolveSubagentModelRoute({
		role: "worker",
		parentApiConfiguration,
		parentApiConfigName: "Parent",
		parentReasoningPreference: { kind: "off" },
		profileLoader,
	})

	expect(result.apiConfiguration).toEqual(parentApiConfiguration)
	expect(result.reasoningPreference).toEqual({ kind: "off" })
	expect(result.route).toMatchObject({
		source: "parent",
		resolution: "selected",
		modelId: "captured-parent-model",
		unboundProfile: true,
	})
	expect(result.route.profileId).toBeUndefined()
	expect(profileLoader.assertProfileAvailable).not.toHaveBeenCalled()
})

describe.each(["requested", "named-agent", "provider"] as const)("strict %s profile selection", (source) => {
	it.each(failures)("rejects $label availability before reading credentials", async ({ code, fields }) => {
		const unavailable = new ProviderProfileUnavailableError(code, selectedProfile, fields)
		const profileLoader = {
			listConfig: vi.fn().mockResolvedValue([selectedProfile]),
			assertProfileAvailable: vi.fn().mockRejectedValue(unavailable),
			getProfile: vi.fn().mockResolvedValue(selectedProfile),
		}
		await expect(
			resolveSubagentModelRoute({
				role: "worker",
				parentApiConfiguration,
				profileLoader,
				...(source === "requested"
					? { requestedProfile: selectedProfile.id }
					: source === "named-agent"
						? { agentProfileId: selectedProfile.id }
						: { requestedProvider: "vertex" }),
			}),
		).rejects.toBe(unavailable)
		expect(profileLoader.getProfile).not.toHaveBeenCalled()
	})

	it("fails closed if the selected profile disappears after enumeration", async () => {
		const profileLoader = {
			listConfig: vi.fn().mockResolvedValue([selectedProfile]),
			assertProfileAvailable: vi.fn().mockResolvedValue(undefined),
			getProfile: vi.fn().mockRejectedValue(new Error("credential-sensitive diagnostic")),
		}
		const pending = resolveSubagentModelRoute({
			role: "worker",
			parentApiConfiguration,
			profileLoader,
			...(source === "requested"
				? { requestedProfile: selectedProfile.id }
				: source === "named-agent"
					? { agentProfileId: selectedProfile.id }
					: { requestedProvider: "vertex" }),
		})
		await expect(pending).rejects.toThrow(/profile.*could not be loaded/i)
		await expect(pending).rejects.not.toThrow("credential-sensitive")
	})
})

it("rejects unavailable metadata even when the loader has no separate availability hook", async () => {
	const profileLoader = {
		listConfig: vi.fn().mockResolvedValue([{ ...selectedProfile, availability: "invalid", invalidFields: ["id"] }]),
		getProfile: vi.fn().mockResolvedValue(selectedProfile),
	}
	await expect(
		resolveSubagentModelRoute({
			role: "worker",
			parentApiConfiguration,
			profileLoader,
			requestedProfile: selectedProfile.name,
		}),
	).rejects.toMatchObject({ name: "ProviderProfileUnavailableError", invalidFields: ["id"] })
	expect(profileLoader.getProfile).not.toHaveBeenCalled()
})

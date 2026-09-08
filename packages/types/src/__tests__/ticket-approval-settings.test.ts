import { GLOBAL_STATE_KEYS, globalSettingsSchema } from "../global-settings.js"
import { disabledSubagentAutoApprovalPolicy, subagentAutoApprovalPolicySchema } from "../subagent-context.js"

describe("ticket approval settings", () => {
	it("registers the opt-in as persisted global state and preserves explicit choices", () => {
		expect(GLOBAL_STATE_KEYS).toContain("alwaysAllowTickets")
		for (const alwaysAllowTickets of [false, true]) {
			expect(globalSettingsSchema.parse({ alwaysAllowTickets })).toMatchObject({ alwaysAllowTickets })
		}
		expect(globalSettingsSchema.parse({}).alwaysAllowTickets).toBeUndefined()
		expect(globalSettingsSchema.safeParse({ alwaysAllowTickets: "true" }).success).toBe(false)
	})

	it("preserves legacy approval objects without injecting fields into their digests", () => {
		const { alwaysAllowTickets: _tickets, ...legacyPolicy } = disabledSubagentAutoApprovalPolicy
		expect(subagentAutoApprovalPolicySchema.parse(legacyPolicy)).toEqual(legacyPolicy)
		expect(subagentAutoApprovalPolicySchema.parse(legacyPolicy).alwaysAllowTickets).toBeUndefined()
		expect(disabledSubagentAutoApprovalPolicy.alwaysAllowTickets).toBe(false)
	})

	it.each([false, true])("preserves the captured ticket approval grant %s", (alwaysAllowTickets) => {
		expect(
			subagentAutoApprovalPolicySchema.parse({ ...disabledSubagentAutoApprovalPolicy, alwaysAllowTickets }),
		).toMatchObject({ alwaysAllowTickets })
	})
})

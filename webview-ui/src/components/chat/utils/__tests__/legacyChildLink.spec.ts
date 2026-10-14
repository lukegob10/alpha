import type { AlphaMessage } from "@alpha-code/types"
import { resolveLegacyChildLink } from "../legacyChildLink"

const launch: AlphaMessage = { type: "ask", ask: "tool", ts: 1, text: JSON.stringify({ tool: "newTask" }) }
const result: AlphaMessage = { type: "say", say: "subtask_result", ts: 2, text: "Result" }
describe("resolveLegacyChildLink", () => {
	it("prefers exact message identity across mixed launches and later history changes", () => {
		expect(
			resolveLegacyChildLink({ ...launch, childTaskId: "legacy" }, [launch], { childIds: ["managed", "legacy"] }),
		).toBe("legacy")
		expect(
			resolveLegacyChildLink({ ...result, subtaskResultChildId: "earlier" }, [result], {
				completedByChildId: "latest",
			}),
		).toBe("earlier")
	})
	it("allows only an unambiguous one-child historical fallback", () => {
		const history = { childIds: ["legacy"], completedByChildId: "legacy" }
		expect(resolveLegacyChildLink(launch, [launch, result], history)).toBe("legacy")
		expect(resolveLegacyChildLink(result, [launch, result], history)).toBe("legacy")
		expect(resolveLegacyChildLink(launch, [launch, { ...launch, ts: 3 }], history)).toBeUndefined()
		expect(resolveLegacyChildLink(result, [launch, result, { ...result, ts: 4 }], history)).toBeUndefined()
		expect(
			resolveLegacyChildLink(result, [launch, result], { ...history, completedByChildId: "other" }),
		).toBeUndefined()
	})
	it("never indexes managed or failed launches into the legacy child list", () => {
		const managed = { ...launch, ts: 3, text: JSON.stringify({ tool: "spawnAgent" }) }
		expect(resolveLegacyChildLink(launch, [launch, managed], { childIds: ["managed"] })).toBeUndefined()
		expect(resolveLegacyChildLink(launch, [launch], { childIds: ["managed", "legacy"] })).toBeUndefined()
	})
})

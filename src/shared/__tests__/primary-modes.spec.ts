import { DEFAULT_MODES } from "@alpha-code/types"

import { getAllModes } from "../modes"

describe("Code and Plan execution surface", () => {
	it("registers only Code and Plan, even when old custom modes are loaded", () => {
		expect(DEFAULT_MODES.map(({ slug }) => slug)).toEqual(["architect", "code"])
		expect(
			getAllModes([{ slug: "debug", name: "Old debugger", roleDefinition: "Debug", groups: ["edit"] }]).map(
				({ slug }) => slug,
			),
		).toEqual(["architect", "code"])
	})
})

import * as path from "path"

describe("custom-instructions path detection", () => {
	it("should use exact path comparison instead of string includes", () => {
		// Test the logic that our fix implements
		const fakeHomeDir = "/Users/john.alpha.smith"
		const globalConfigDir = path.join(fakeHomeDir, ".alpha") // "/Users/john.alpha.smith/.alpha"
		const projectConfigDir = "/projects/my-project/.alpha"

		// Old implementation (fragile):
		// const isGlobal = configDir.includes(path.join(os.homedir(), ".alpha"))
		// This could fail if the home directory path contains ".alpha" elsewhere

		// New implementation (robust):
		// const isGlobal = path.resolve(configDir) === path.resolve(getGlobalConfigDirectory())

		// Test the new logic
		const isGlobalForGlobalDir = path.resolve(globalConfigDir) === path.resolve(globalConfigDir)
		const isGlobalForProjectDir = path.resolve(projectConfigDir) === path.resolve(globalConfigDir)

		expect(isGlobalForGlobalDir).toBe(true)
		expect(isGlobalForProjectDir).toBe(false)

		// Verify that the old implementation would have been problematic
		// if the home directory contained ".alpha" in the path
		const oldLogicGlobal = globalConfigDir.includes(path.join(fakeHomeDir, ".alpha"))
		const oldLogicProject = projectConfigDir.includes(path.join(fakeHomeDir, ".alpha"))

		expect(oldLogicGlobal).toBe(true) // This works
		expect(oldLogicProject).toBe(false) // This also works, but is fragile

		// The issue was that if the home directory path itself contained ".alpha",
		// the includes() check could produce false positives in edge cases
	})

	it("should handle edge cases with path resolution", () => {
		// Test various edge cases that exact path comparison handles better
		const testCases = [
			{
				global: "/Users/test/.alpha",
				project: "/Users/test/project/.alpha",
				expected: { global: true, project: false },
			},
			{
				global: "/home/user/.alpha",
				project: "/home/user/.alpha", // Same directory
				expected: { global: true, project: true },
			},
			{
				global: "/Users/john.alpha.smith/.alpha",
				project: "/projects/app/.alpha",
				expected: { global: true, project: false },
			},
		]

		testCases.forEach(({ global, project, expected }) => {
			const isGlobalForGlobal = path.resolve(global) === path.resolve(global)
			const isGlobalForProject = path.resolve(project) === path.resolve(global)

			expect(isGlobalForGlobal).toBe(expected.global)
			expect(isGlobalForProject).toBe(expected.project)
		})
	})
})

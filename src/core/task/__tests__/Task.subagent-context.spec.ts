import { Task } from "../Task"

describe("Task managed-child context authority", () => {
	const makeTask = () =>
		Object.assign(Object.create(Task.prototype), {
			taskKind: "subagent",
			subagentRole: "review",
			subagentAuthority: {
				role: "review",
				logicalWorkspace: "F:/workspace",
				approvalProvenance: "group",
			},
			subagentContextManifest: {
				skills: [
					{
						name: "review-repository",
						path: "F:/workspace/.alpha/skills/review-repository/SKILL.md",
						digest: "a".repeat(64),
					},
				],
				runtimePolicy: {
					allowedTools: [
						"read_file",
						"search_files",
						"list_files",
						"codebase_search",
						"skill",
						"attempt_completion",
					],
				},
			},
		}) as Task

	it("exposes skill only inside the captured hard authority ceiling", () => {
		const task = makeTask()

		expect(task.getTaskAllowedToolNames()).toContain("skill")
		expect(task.getTaskAllowedToolNames()).not.toContain("execute_command")
	})

	it("auto-approves only a listed inherited skill for a background child", () => {
		const task = makeTask()
		const authorize = (task as any).isParentAuthorizedSubagentAsk.bind(task)

		expect(authorize("tool", JSON.stringify({ tool: "skill", skill: "review-repository" }), false)).toBe(true)
		expect(authorize("tool", JSON.stringify({ tool: "skill", skill: "not-in-catalog" }), false)).toBe(false)
	})
})

import * as path from "path"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Task } from "../../task/Task"
import type { ProjectInstructionDiscoveryOptions } from "../../../services/config-paths"

const { created, settings, captureOptions } = vi.hoisted(() => ({
	created: [] as Array<{
		workspacePath?: string
		options: { projectInstructionDiscovery?: ProjectInstructionDiscoveryOptions }
		initialize: import("vitest").Mock
		dispose: import("vitest").Mock
	}>,
	settings: { current: { projectRootMarkers: [".git"], projectDocFallbackFilenames: [] as string[] } },
	captureOptions: vi.fn(),
}))

vi.mock("../../../services/config-paths/project-instruction-settings", () => ({
	captureProjectInstructionDiscoveryOptions: captureOptions,
}))
vi.mock("../../../services/skills/SkillsManager", () => ({
	SkillsManager: class {
		initialize = vi.fn(async () => undefined)
		dispose = vi.fn(async () => undefined)
		constructor(
			_provider: unknown,
			readonly workspacePath: string | undefined,
			readonly options: { projectInstructionDiscovery?: ProjectInstructionDiscoveryOptions },
		) {
			created.push(this)
		}
		getProjectInstructionDiscoveryOptions() {
			return this.options.projectInstructionDiscovery
		}
	},
}))

import { AlphaProvider } from "../AlphaProvider"

function fixture() {
	const provider = Object.assign(Object.create(AlphaProvider.prototype), {
		_disposed: false,
		scopedSkillsManagers: new Map(),
		getTaskOwner: vi.fn(() => undefined),
	}) as AlphaProvider
	const task = (id: string, workspace = process.cwd()) =>
		({
			taskId: id,
			taskKind: "primary",
			cwd: workspace,
			historyWorkspacePath: workspace,
		}) as Task
	return { provider, task }
}

beforeEach(() => {
	created.length = 0
	settings.current = { projectRootMarkers: [".git"], projectDocFallbackFilenames: [] }
	captureOptions.mockReset()
	captureOptions.mockImplementation(() => structuredClone(settings.current))
})

describe("task-owned instruction and skill discovery snapshots", () => {
	it("keeps a task's admitted catalog for default tool lookups until an explicit fresh boundary", async () => {
		const { provider, task } = fixture()
		const current = task("task-1")
		const oldOptions = { projectRootMarkers: [], projectDocFallbackFilenames: ["WORKFLOW.md"] }
		const admitted = await provider.getSkillsManager(current, oldOptions)
		settings.current = { projectRootMarkers: [".git"], projectDocFallbackFilenames: ["NEW.md"] }

		expect(await provider.getSkillsManager(current)).toBe(admitted)
		expect(captureOptions).not.toHaveBeenCalled()
		expect(created).toHaveLength(1)
		expect(admitted?.getProjectInstructionDiscoveryOptions()).toEqual(oldOptions)
		const next = await provider.getSkillsManager(current, settings.current)
		expect(next).not.toBe(admitted)
		expect(created).toHaveLength(2)
		expect(created[0].dispose).toHaveBeenCalledOnce()
		expect(next?.getProjectInstructionDiscoveryOptions()).toEqual(settings.current)
	})

	it("retains shared old-snapshot leases while another task adopts a new boundary", async () => {
		const { provider, task } = fixture()
		const first = task("task-1")
		const second = task("task-2")
		const options = { projectRootMarkers: [".git"], projectDocFallbackFilenames: [] }
		const shared = await provider.getSkillsManager(first, options)
		expect(await provider.getSkillsManager(second, options)).toBe(shared)
		const updated = await provider.getSkillsManager(first, {
			projectRootMarkers: [],
			projectDocFallbackFilenames: [],
		})

		expect(updated).not.toBe(shared)
		expect(await provider.getSkillsManager(second)).toBe(shared)
		expect(created[0].dispose).not.toHaveBeenCalled()
		await provider["releaseScopedSkillsManager"](second.taskId)
		expect(created[0].dispose).toHaveBeenCalledOnce()
		expect(created[1].dispose).not.toHaveBeenCalled()
	})

	it("keeps separate workspace identities and uses a managed child's logical history workspace", async () => {
		const { provider, task } = fixture()
		const options = { projectRootMarkers: [".git"] }
		const root = process.cwd()
		const first = await provider.getSkillsManager(task("first", root), options)
		const second = await provider.getSkillsManager(task("second", path.join(root, "other")), options)
		expect(second).not.toBe(first)
		const child = {
			taskId: "child",
			taskKind: "subagent",
			cwd: path.join(root, "private-worktree"),
			historyWorkspacePath: root,
		} as Task

		expect(await provider.getSkillsManager(child, options)).toBe(first)
		expect(created[0].workspacePath).toBe(path.resolve(root))
	})
})

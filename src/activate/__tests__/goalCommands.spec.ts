import * as vscode from "vscode"
import type { TaskGoal } from "@alpha-code/types"

import type { AlphaProvider } from "../../core/webview/AlphaProvider"
import type { Task } from "../../core/task/Task"
import { manageTaskGoal } from "../goalCommands"

vi.mock("vscode", () => ({
	window: {
		showInputBox: vi.fn(),
		showQuickPick: vi.fn(),
		showInformationMessage: vi.fn(),
		showErrorMessage: vi.fn(),
	},
}))
vi.mock("../../i18n", () => ({ t: (key: string) => key }))

function fixture(goal?: Partial<TaskGoal>) {
	const state: TaskGoal | undefined = goal
		? {
				goalId: "goal-a",
				taskId: "task-a",
				objective: "Implement the parser",
				status: "active",
				tokensUsed: 100,
				timeUsedMs: 2000,
				version: 1,
				controlVersion: 1,
				createdAt: 1,
				updatedAt: 1,
				maxContinuations: 20,
				continuationCount: 0,
				recoveryDeferred: false,
				...goal,
			}
		: undefined
	const task = {
		taskId: "task-a",
		abort: false,
		abandoned: false,
		getGoal: vi.fn().mockResolvedValue(state),
		createGoal: vi.fn(),
		pauseGoal: vi.fn(),
		resumeGoal: vi.fn(),
		clearGoal: vi.fn(),
	}
	const provider = {
		getCurrentTask: vi.fn(() => task as unknown as Task),
		getLiveTask: vi.fn(() => task as unknown as Task),
	} satisfies Pick<AlphaProvider, "getCurrentTask" | "getLiveTask">
	return { task, provider, state }
}

describe("native goal command", () => {
	beforeEach(() => vi.clearAllMocks())

	it("requires a selected task and does not create ordinary tasks or goals", async () => {
		const { provider } = fixture()
		provider.getCurrentTask.mockReturnValue(undefined as unknown as Task)
		await manageTaskGoal(provider)
		expect(vscode.window.showInformationMessage).toHaveBeenCalledWith("common:goals.noTask")
		expect(vscode.window.showQuickPick).not.toHaveBeenCalled()
	})

	it("creates exactly the user-entered objective and optional budget", async () => {
		const { task, provider } = fixture()
		vi.mocked(vscode.window.showQuickPick).mockResolvedValue({ action: "create" } as never)
		vi.mocked(vscode.window.showInputBox)
			.mockResolvedValueOnce("  Implement parser  ")
			.mockResolvedValueOnce("10000")
		await manageTaskGoal(provider)
		expect(task.createGoal).toHaveBeenCalledExactlyOnceWith(
			{ objective: "Implement parser", tokenBudget: 10000 },
			{ source: "user", approved: true, expectedGoalId: null, expectedVersion: undefined },
		)
	})

	it("cancelling a budget prompt leaves goal state alone", async () => {
		const { task, provider } = fixture()
		vi.mocked(vscode.window.showQuickPick).mockResolvedValue({ action: "create" } as never)
		vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce("Parser").mockResolvedValueOnce(undefined)
		await manageTaskGoal(provider)
		expect(task.createGoal).not.toHaveBeenCalled()
	})

	it("rejects stale task instances after native inputs", async () => {
		const { task, provider } = fixture()
		vi.mocked(vscode.window.showQuickPick).mockResolvedValue({ action: "create" } as never)
		vi.mocked(vscode.window.showInputBox)
			.mockResolvedValueOnce("Parser")
			.mockImplementationOnce(async () => {
				provider.getLiveTask.mockReturnValue({ taskId: "task-a" } as Task)
				return ""
			})
		await manageTaskGoal(provider)
		expect(task.createGoal).not.toHaveBeenCalled()
		expect(vscode.window.showErrorMessage).toHaveBeenCalled()
	})

	it("retains the originating task when navigation changes", async () => {
		const { task, provider } = fixture({})
		vi.mocked(vscode.window.showQuickPick).mockImplementationOnce(async () => {
			provider.getCurrentTask.mockReturnValue({ taskId: "task-b" } as Task)
			return { action: "pause" } as never
		})
		await manageTaskGoal(provider)
		expect(task.pauseGoal).toHaveBeenCalledExactlyOnceWith("goal-a", 1)
	})

	it("guards clear against a replaced goal while the picker is open", async () => {
		const { task, provider, state } = fixture({})
		vi.mocked(vscode.window.showQuickPick).mockImplementationOnce(async () => {
			task.getGoal.mockResolvedValue({ ...state, goalId: "goal-b" })
			return { action: "clear" } as never
		})
		await manageTaskGoal(provider)
		expect(task.clearGoal).not.toHaveBeenCalled()
	})

	it("offers explicit recovery resume and carries the selected budget", async () => {
		const { task, provider } = fixture({ recoveryDeferred: true, tokenBudget: 400 })
		vi.mocked(vscode.window.showQuickPick).mockResolvedValue({ action: "resume" } as never)
		vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce("800")
		await manageTaskGoal(provider)
		const items = await vi.mocked(vscode.window.showQuickPick).mock.calls[0]![0]
		expect(items).toEqual(expect.arrayContaining([expect.objectContaining({ action: "resume" })]))
		expect(items).not.toEqual(expect.arrayContaining([expect.objectContaining({ action: "pause" })]))
		expect(task.resumeGoal).toHaveBeenCalledExactlyOnceWith({ tokenBudget: 800 }, "goal-a", 1)
	})

	it("allows the user to remove a saved token budget on resume", async () => {
		const { task, provider } = fixture({ status: "budget_limited", tokenBudget: 100 })
		vi.mocked(vscode.window.showQuickPick).mockResolvedValue({ action: "resume" } as never)
		vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce("")
		await manageTaskGoal(provider)
		expect(task.resumeGoal).toHaveBeenCalledExactlyOnceWith({ tokenBudget: null }, "goal-a", 1)
	})

	it("rejects a resume prompt when a later human control changes the same goal", async () => {
		const { task, provider, state } = fixture({ status: "paused", tokenBudget: 100 })
		vi.mocked(vscode.window.showQuickPick).mockResolvedValue({ action: "resume" } as never)
		vi.mocked(vscode.window.showInputBox).mockImplementationOnce(async () => {
			task.getGoal.mockResolvedValue({ ...state, controlVersion: 2 })
			return "200"
		})
		await manageTaskGoal(provider)
		expect(task.resumeGoal).not.toHaveBeenCalled()
		expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("common:goals.updateFailed")
	})

	it("allows in-flight usage to settle without invalidating the user's resume choice", async () => {
		const { task, provider, state } = fixture({ status: "paused", tokenBudget: 100 })
		vi.mocked(vscode.window.showQuickPick).mockResolvedValue({ action: "resume" } as never)
		vi.mocked(vscode.window.showInputBox).mockImplementationOnce(async () => {
			task.getGoal.mockResolvedValue({ ...state, version: 2, tokensUsed: 150, status: "budget_limited" })
			return "200"
		})
		await manageTaskGoal(provider)
		expect(task.resumeGoal).toHaveBeenCalledExactlyOnceWith({ tokenBudget: 200 }, "goal-a", 1)
	})

	it("displays saved status without changing a paused task", async () => {
		const { task, provider } = fixture({ status: "paused", recoveryDeferred: true })
		vi.mocked(vscode.window.showQuickPick).mockResolvedValue({ action: "view" } as never)
		await manageTaskGoal(provider)
		expect(vscode.window.showInformationMessage).toHaveBeenCalledWith("Implement the parser", {
			modal: true,
			detail: "common:goals.summary\ncommon:goals.recoveryDeferred",
		})
		expect(task.resumeGoal).not.toHaveBeenCalled()
		expect(task.createGoal).not.toHaveBeenCalled()
	})

	it("validates native objective and budget inputs before accepting them", async () => {
		const { provider } = fixture()
		vi.mocked(vscode.window.showQuickPick).mockResolvedValue({ action: "create" } as never)
		vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce("Parser").mockResolvedValueOnce("")
		await manageTaskGoal(provider)
		const objectiveValidator = vi.mocked(vscode.window.showInputBox).mock.calls[0]![0]!.validateInput!
		const budgetValidator = vi.mocked(vscode.window.showInputBox).mock.calls[1]![0]!.validateInput!
		expect(objectiveValidator(" ")).toBe("common:goals.invalidObjective")
		expect(objectiveValidator("x".repeat(4001))).toBe("common:goals.invalidObjective")
		expect(objectiveValidator("🙂".repeat(4000))).toBeUndefined()
		for (const invalid of ["0", "-1", "1.5", "1e3", "Infinity", "9007199254740992"]) {
			expect(budgetValidator(invalid)).toBe("common:goals.invalidBudget")
		}
		expect(budgetValidator("1000")).toBeUndefined()
		expect(budgetValidator("")).toBeUndefined()
	})
})

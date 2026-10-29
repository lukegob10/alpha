import { AlphaProvider } from "../AlphaProvider"

function fixture() {
	const release = vi.fn()
	const reserve = vi.fn(() => release)
	const task = {
		taskHistoryStoreReady: Promise.resolve(),
		taskHistoryStore: { get: vi.fn(() => ({ id: "saved" })) },
		getLiveTask: vi.fn(),
		getTaskOwner: vi.fn(),
		taskSessions: {
			runOwnershipOperation: vi.fn(async (_taskId: string, operation: () => Promise<unknown>) => operation()),
			reserveTaskAdmission: reserve,
		},
	}
	const recover = (operation: () => Promise<unknown>) =>
		AlphaProvider.prototype.runTaskHistoryRecovery.call(task as unknown as AlphaProvider, "saved", operation)
	return { task, reserve, release, recover }
}

it.each(["success", "failure"] as const)("releases the recovery admission reservation on %s", async (outcome) => {
	const { recover, reserve, release } = fixture()
	const operation = vi.fn(async () => {
		expect(reserve).toHaveBeenCalledExactlyOnceWith("saved")
		expect(release).not.toHaveBeenCalled()
		if (outcome === "failure") throw new Error("Storage unavailable")
		return "recovered"
	})
	if (outcome === "failure") await expect(recover(operation)).rejects.toThrow("Storage unavailable")
	else await expect(recover(operation)).resolves.toBe("recovered")
	expect(release).toHaveBeenCalledOnce()
})

it.each(["live", "other surface", "deleted"] as const)(
	"rejects a %s task before admission or storage mutation",
	async (state) => {
		const { task, recover, reserve } = fixture()
		if (state === "live") task.getLiveTask.mockReturnValue({})
		if (state === "other surface") task.getTaskOwner.mockReturnValue({})
		if (state === "deleted") task.taskHistoryStore.get.mockReturnValue(undefined as never)
		const operation = vi.fn()
		await expect(recover(operation)).rejects.toThrow("Task history is unavailable")
		expect(reserve).not.toHaveBeenCalled()
		expect(operation).not.toHaveBeenCalled()
	},
)

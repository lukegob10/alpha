import { createManagedPublicLifecycleHarness } from "../../webview/__tests__/managedPublicLifecycleHarness"
import { webviewMessageHandler } from "../../webview/webviewMessageHandler"

it.each(["sendAndSteer", "steerQueuedMessage"] as const)(
	"delivers accepted %s input once on Continue after request preparation fails",
	async (command) => {
		const fixture = await createManagedPublicLifecycleHarness({ rootObjective: "Estimate the batch runtime." })
		const { root, provider } = fixture
		const guidance = "Check the next batch before continuing."
		const receiptId = "accepted-steering"
		const blocked = fixture.queueTurn(root.taskId, "Estimated duration is two hours.", undefined, {
			beforeHold: [{ type: "text", text: "The batch is still running.", phase: "commentary" }],
		})
		const resumed = fixture.queueTurn(root.taskId, "Checked the next batch.")
		try {
			root.start()
			await blocked.progressed
			const failPreparation = vi
				.spyOn(
					root as unknown as { runPendingInterruptLifecycleHook(): Promise<void> },
					"runPendingInterruptLifecycleHook",
				)
				.mockRejectedValueOnce(new Error("Preparation failed"))
			const expectedTurnId = provider.getAgentLifecycleSnapshot(root.taskId)?.turnId
			if (command === "steerQueuedMessage") {
				await webviewMessageHandler(provider, {
					type: "queueMessage",
					taskId: root.taskId,
					requestId: "older",
					text: "Report the final duration.",
				})
				await webviewMessageHandler(provider, {
					type: "queueMessage",
					taskId: root.taskId,
					requestId: receiptId,
					text: guidance,
				})
			}
			await webviewMessageHandler(provider, {
				type: command,
				taskId: root.taskId,
				expectedTurnId,
				requestId: command === "sendAndSteer" ? receiptId : "select-steering",
				text: command === "sendAndSteer" ? guidance : receiptId,
			})
			expect(provider.postMessageToWebview).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "chatCommandResult",
					chatCommandResult: expect.objectContaining({ command, status: "accepted" }),
				}),
			)
			await vi.waitFor(
				() => {
					expect(failPreparation).toHaveBeenCalled()
					expect(root.taskAsk?.ask).toBe("resume_task")
				},
				{ timeout: 5_000 },
			)
			expect(resumed.request).toBeUndefined()
			expect(root.messageQueueService.getClaimedMessageIds()).toEqual([receiptId])
			root.approveAsk()
			await resumed.entered
			expect(JSON.stringify(resumed.messages).split(guidance)).toHaveLength(2)
			expect(JSON.stringify(resumed.messages)).not.toContain("Report the final duration.")
			expect(
				root.apiConversationHistory.filter((message) => message.queued_message_ids?.includes(receiptId)),
			).toHaveLength(1)
			expect(root.messageQueueService.getClaimedMessageIds()).toEqual([])
			expect(root.hasPendingSteerMessage()).toBe(false)
			expect(
				root.alphaMessages.filter((message) => message.say === "user_feedback" && message.text === guidance),
			).toHaveLength(1)
		} finally {
			await fixture.cleanup()
		}
	},
)

// npx vitest run __tests__/delegation-events.spec.ts

import { AlphaCodeEventName, alphaCodeEventsSchema, taskEventSchema } from "@alpha-code/types"

describe("delegation event schemas", () => {
	test("alphaCodeEventsSchema validates tuples", () => {
		expect(() =>
			(alphaCodeEventsSchema.shape as any)[AlphaCodeEventName.TaskDelegated].parse(["p", "c"]),
		).not.toThrow()
		expect(() =>
			(alphaCodeEventsSchema.shape as any)[AlphaCodeEventName.TaskDelegationCompleted].parse(["p", "c", "s"]),
		).not.toThrow()
		expect(() =>
			(alphaCodeEventsSchema.shape as any)[AlphaCodeEventName.TaskDelegationResumed].parse(["p", "c"]),
		).not.toThrow()

		// invalid shapes
		expect(() => (alphaCodeEventsSchema.shape as any)[AlphaCodeEventName.TaskDelegated].parse(["p"])).toThrow()
		expect(() =>
			(alphaCodeEventsSchema.shape as any)[AlphaCodeEventName.TaskDelegationCompleted].parse(["p", "c"]),
		).toThrow()
		expect(() =>
			(alphaCodeEventsSchema.shape as any)[AlphaCodeEventName.TaskDelegationResumed].parse(["p"]),
		).toThrow()
	})

	test("taskEventSchema discriminated union includes delegation events", () => {
		expect(() =>
			taskEventSchema.parse({
				eventName: AlphaCodeEventName.TaskDelegated,
				payload: ["p", "c"],
				taskId: 1,
			}),
		).not.toThrow()

		expect(() =>
			taskEventSchema.parse({
				eventName: AlphaCodeEventName.TaskDelegationCompleted,
				payload: ["p", "c", "s"],
				taskId: 1,
			}),
		).not.toThrow()

		expect(() =>
			taskEventSchema.parse({
				eventName: AlphaCodeEventName.TaskDelegationResumed,
				payload: ["p", "c"],
				taskId: 1,
			}),
		).not.toThrow()
	})
})

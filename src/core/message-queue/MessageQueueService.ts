import { EventEmitter } from "events"

import { v4 as uuidv4 } from "uuid"

import type { QueuedMessage } from "@alpha-code/types"

export const MAX_QUEUED_MESSAGES = 100
export const MAX_QUEUED_MESSAGE_BYTES = 32 * 1024 * 1024

export interface MessageQueuePersistence {
	load(): Promise<QueuedMessage[]>
	save(messages: readonly QueuedMessage[]): Promise<void>
}

export function assertMessageQueueBounds(messages: readonly QueuedMessage[]): void {
	if (messages.length > MAX_QUEUED_MESSAGES) throw new Error("The message queue is full")
	if (Buffer.byteLength(JSON.stringify(messages), "utf8") > MAX_QUEUED_MESSAGE_BYTES) {
		throw new Error("The message queue exceeds its 32 MiB storage limit")
	}
}

export interface MessageQueueState {
	messages: QueuedMessage[]
	isProcessing: boolean
	isPaused: boolean
}

export interface QueueEvents {
	stateChanged: [messages: QueuedMessage[]]
}

export class MessageQueueService extends EventEmitter<QueueEvents> {
	private _messages: QueuedMessage[] = []
	private readonly claimed = new Map<string, QueuedMessage>()
	private readonly pendingDurableMutations = new Map<string, Promise<unknown>>()
	private readonly persistencePendingIds = new Set<string>()
	private loaded = false
	private disposed = false
	private revision = 0
	private persistedRevision = 0
	private persistenceWriting = false
	private persistenceWrite: Promise<void> = Promise.resolve()
	public readonly ready: Promise<void>

	constructor(private readonly persistence?: MessageQueuePersistence) {
		super()
		this.ready = this.restore()
		void this.ready.catch(() => undefined)
	}

	private async restore(): Promise<void> {
		if (this.persistence) {
			const restored = await this.persistence.load()
			const currentIds = new Set([...this.claimed.keys(), ...this._messages.map((message) => message.id)])
			const merged = [...restored.filter((message) => !currentIds.has(message.id)), ...this._messages]
			assertMessageQueueBounds([...this.claimed.values(), ...merged])
			this._messages = merged
		}
		this.loaded = true
		if (this.revision > 0) this.schedulePersistence()
		if (this._messages.length && !this.disposed) this.emit("stateChanged", this.messages)
	}

	private snapshot(): QueuedMessage[] {
		return structuredClone([...this.claimed.values(), ...this._messages])
	}

	private schedulePersistence(): void {
		if (!this.persistence || !this.loaded || this.persistenceWriting) return
		this.persistenceWriting = true
		const write = this.persistenceWrite
			.catch(() => undefined)
			.then(async () => {
				while (this.persistedRevision < this.revision) {
					const revision = this.revision
					await this.persistence!.save(this.snapshot())
					this.persistedRevision = revision
				}
			})
		this.persistenceWrite = write
		void write.then(
			() => {
				this.persistenceWriting = false
				if (this.persistedRevision < this.revision) this.schedulePersistence()
			},
			() => {
				this.persistenceWriting = false
			},
		)
	}

	private changed(publish = true): void {
		this.revision++
		this.schedulePersistence()
		if (publish && !this.disposed) this.emit("stateChanged", this.messages)
	}

	/** Await the durable admission/deletion receipt; a later call retries a failed snapshot. */
	public async flush(): Promise<void> {
		await this.ready
		if (!this.persistence) return
		for (;;) {
			if (this.revision > this.persistedRevision) this.schedulePersistence()
			const pending = this.persistenceWrite
			await pending
			if (pending === this.persistenceWrite && this.persistedRevision >= this.revision) return
		}
	}

	private findMessage(id: string) {
		const index = this._messages.findIndex((msg) => msg.id === id)

		if (index === -1) {
			return { index, message: undefined }
		}

		return { index, message: this._messages[index] }
	}

	public addMessage(text: string, images?: string[], id?: string): QueuedMessage | undefined {
		if (this.disposed) throw new Error("The message queue is disposed")
		if (!text && !images?.length) {
			return undefined
		}
		if (id !== undefined) {
			if (!id || id.length > 256) throw new Error("Invalid queued message identity")
			const existing = this.claimed.get(id) ?? this.findMessage(id).message
			if (existing) {
				if (existing.text !== text || JSON.stringify(existing.images ?? []) !== JSON.stringify(images ?? [])) {
					throw new Error("Queued message identity already belongs to different input")
				}
				return existing
			}
		}

		const message: QueuedMessage = {
			timestamp: Date.now(),
			id: id ?? uuidv4(),
			text,
			images: images ? [...images] : undefined,
		}

		assertMessageQueueBounds([...this.claimed.values(), ...this._messages, message])
		this._messages.push(message)
		this.changed()

		return message
	}

	/** Reserve identity ownership before yielding so concurrent edits cannot share a rollback snapshot. */
	private enqueueDurableMutation<T>(id: string, mutate: () => Promise<T>): Promise<T> {
		const previous = this.pendingDurableMutations.get(id) ?? Promise.resolve()
		this.persistencePendingIds.add(id)
		const operation = previous
			.catch(() => undefined)
			.then(async () => {
				await this.ready
				return mutate()
			})
		this.pendingDurableMutations.set(id, operation)
		const release = () => {
			if (this.pendingDurableMutations.get(id) !== operation) return
			this.pendingDurableMutations.delete(id)
			this.persistencePendingIds.delete(id)
			if (!this.disposed) this.emit("stateChanged", this.messages)
		}
		void operation.then(release, release)
		return operation
	}

	/** Input cannot be selected while its admission/edit persistence is unresolved. */
	private async durableMutation<T>(mutate: () => T, rollback: () => void): Promise<T> {
		try {
			const result = mutate()
			await this.flush()
			return result
		} catch (error) {
			rollback()
			try {
				await this.flush()
			} catch (rollbackError) {
				throw new AggregateError([error, rollbackError], "Queued input could not be saved or rolled back")
			}
			throw error
		}
	}

	public async addMessageDurably(text: string, images?: string[], id = uuidv4()): Promise<QueuedMessage | undefined> {
		return this.enqueueDurableMutation(id, async () => {
			const existing = this.claimed.get(id) ?? this.findMessage(id).message
			if (existing) {
				const result = this.addMessage(text, images, id)
				await this.flush()
				return result
			}
			return this.durableMutation(
				() => this.addMessage(text, images, id),
				() => {
					this.removeMessage(id)
				},
			)
		})
	}

	public async updateMessageDurably(id: string, text: string, images?: string[]): Promise<boolean> {
		return this.enqueueDurableMutation(id, async () => {
			const previous = this.findMessage(id).message
			if (!previous) return false
			const before = structuredClone(previous)
			return this.durableMutation(
				() => this.updateMessage(id, text, images),
				() => {
					// Roll back this identity only; concurrent admissions to other entries survive.
					Object.assign(previous, before, { images: before.images })
					this.changed(false)
				},
			)
		})
	}

	public removeMessage(id: string): boolean {
		const { index, message } = this.findMessage(id)

		if (!message) {
			return false
		}

		this._messages.splice(index, 1)
		this.changed()
		return true
	}

	public getMessage(id: string): QueuedMessage | undefined {
		if (this.persistencePendingIds.has(id)) return undefined
		return this.findMessage(id).message
	}

	public updateMessage(id: string, text: string, images?: string[]): boolean {
		const { message } = this.findMessage(id)

		if (!message) {
			return false
		}

		const replacement = { ...message, timestamp: Date.now(), text, images: images ? [...images] : undefined }
		assertMessageQueueBounds([
			...this.claimed.values(),
			...this._messages.map((entry) => (entry.id === id ? replacement : entry)),
		])
		Object.assign(message, replacement)
		this.changed()
		return true
	}

	public moveMessage(id: string, toIndex: number): boolean {
		const { index, message } = this.findMessage(id)

		if (!message) {
			return false
		}

		const clampedIndex = Math.max(0, Math.min(toIndex, this._messages.length - 1))

		if (index === clampedIndex) {
			return true
		}

		this._messages.splice(index, 1)
		this._messages.splice(clampedIndex, 0, message)
		this.changed()
		return true
	}

	public dequeueMessage(): QueuedMessage | undefined {
		const id = this._messages[0]?.id
		return id ? this.claimMessage(id) : undefined
	}

	/** Selection is durable, but consumption waits for the containing user transcript receipt. */
	public claimMessage(id: string): QueuedMessage | undefined {
		if (this.persistencePendingIds.has(id)) return undefined
		const { index, message } = this.findMessage(id)
		if (!message) {
			return undefined
		}
		this._messages.splice(index, 1)
		this.claimed.set(message.id, message)
		this.changed()
		return message
	}

	public getClaimedMessageIds(): string[] {
		return [...this.claimed.keys()]
	}

	public releaseMessage(id: string, toIndex = 0): boolean {
		const message = this.claimed.get(id)
		if (!message) return false
		this.claimed.delete(id)
		this._messages.splice(Math.max(0, Math.min(toIndex, this._messages.length)), 0, message)
		this.changed()
		return true
	}

	public acknowledgeMessages(ids: readonly string[]): void {
		let changed = false
		for (const id of ids) changed = this.claimed.delete(id) || changed
		if (changed) this.changed()
	}

	public clear(): void {
		if (this._messages.length === 0) {
			return
		}

		this._messages = []
		this.changed()
	}

	public get messages(): QueuedMessage[] {
		return this.persistencePendingIds.size
			? this._messages.filter((message) => !this.persistencePendingIds.has(message.id))
			: this._messages
	}

	/** Project selected input without making it eligible for a second delivery. */
	public get visibleMessages(): QueuedMessage[] {
		return [
			...Array.from(
				this.claimed.values(),
				(message): QueuedMessage => ({
					...message,
					deliveryState: "delivering",
				}),
			),
			...this.messages,
		]
	}

	public isEmpty(): boolean {
		return this._messages.length === 0
	}

	public hasUnconsumedInput(): boolean {
		// Selected input still owns a completion barrier until its transcript commits.
		return this._messages.length > 0 || this.claimed.size > 0
	}

	public dispose(): void {
		this.disposed = true
		this.removeAllListeners()
	}

	/** The same retained task may begin another lifecycle after its previous cleanup. */
	public activate(): void {
		this.disposed = false
	}
}

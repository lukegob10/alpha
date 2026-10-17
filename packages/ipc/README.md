# IPC (Inter-Process Communication)

This package lets development and evaluation tools communicate with the Alpha extension over a local socket. Set
`ROO_CODE_IPC_SOCKET_PATH` before launching VS Code to enable the server. The evaluator configures this endpoint when
launching its extension host.

## Available Commands

The IPC interface supports the following task commands:

### StartNewTask

Starts a new task. Its `data` object requires `configuration` and `text`; the direct extension API has a separate contract
that allows these fields to be omitted.

**Parameters:**

- `data.configuration`: Alpha settings object (required)
- `data.text`: Initial task message (string, required)
- `data.images`: Array of image data URIs (optional)
- `data.newTab`: Whether to open in an editor panel (boolean, optional)

### CancelTask

Cancels the current sidebar task. This command takes no `data` and cannot target a task ID.

### CloseTask

Saves files and closes the VS Code window, ending the evaluation host. This command takes no `data` and cannot target a
task ID. Use `CancelTask` to stop the current task while keeping the window open.

### ResumeTask

Resumes a task from history.

**Parameters:**

- `data`: Task ID to resume (string)

**Error Handling:**

- If the task ID is not found in history, the command will fail gracefully without crashing the IPC server
- Errors are logged for debugging purposes but do not propagate to the client

### Other Commands

| Command               | `data`                                 | Behavior                                                           |
| --------------------- | -------------------------------------- | ------------------------------------------------------------------ |
| `SendMessage`         | `{ text?: string, images?: string[] }` | Sends input to the current task.                                   |
| `DeleteQueuedMessage` | Message ID (string)                    | Removes queued input from the current task.                        |
| `GetCommands`         | None                                   | Emits `CommandsResponse` with the available commands.              |
| `GetModes`            | None                                   | Emits `ModesResponse` with the available modes.                    |
| `GetModels`           | None                                   | Emits `ModelsResponse` with the selected provider's model catalog. |

## Usage Example

```typescript
import { once } from "node:events"
import { IpcClient } from "@alpha-code/ipc"
import { IpcMessageType, TaskCommandName } from "@alpha-code/types"

const client = new IpcClient("/path/to/socket")

// Wait until the server has assigned this connection a client ID before sending commands.
await once(client, IpcMessageType.Ack)

client.on(IpcMessageType.TaskEvent, (event) => {
	console.log(event.eventName, event.payload)
})

// Start a new task
client.sendCommand({
	commandName: TaskCommandName.StartNewTask,
	data: {
		configuration: {
			/* Alpha settings */
		},
		text: "Hello, world!",
		images: [],
		newTab: false,
	},
})
```

Use `TaskCommandName.ResumeTask` with `data: "task-123"` to resume saved work instead. Call `client.disconnect()` when
finished observing the task. The transport exposes `isReady`, `clientId`, and the optional `executionIdentity` receipt.

## Events

Listen on `IpcMessageType.TaskEvent` for validated events. Each event has an `eventName` from `AlphaCodeEventName` and its
typed `payload` tuple. Examples include:

- `TaskStarted`: When a task begins
- `TaskCompleted`: When a task finishes
- `TaskAborted`: When a task is cancelled
- `Message`: When a task sends a message

Task lifecycle events are broadcast to connected clients; query responses are sent to the requesting client. Match task
IDs in event payloads when observing a specific task. Commands do not provide a general success/error acknowledgement.

## Socket Path

Clients must use the endpoint supplied to the extension host. The evaluator uses these paths:

- Unix/Linux/macOS: `<system temporary directory>/evals-{runId}-{taskId}.sock`
- Windows: `\\.\pipe\evals-{runId}-{taskId}.sock`

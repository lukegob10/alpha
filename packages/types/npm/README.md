# Alpha API

The Alpha extension exposes an API that can be used by other extensions.
To use this API in your extension:

1. Install `@alpha-code/types` with pnpm.
2. Import the `AlphaCodeAPI` type.
3. Load the extension API.

```typescript
import * as vscode from "vscode"
import type { AlphaCodeAPI } from "@alpha-code/types"

const extension = vscode.extensions.getExtension<AlphaCodeAPI>("Alpha.alpha")

if (!extension) {
	throw new Error("Alpha is not installed")
}

const api = await extension.activate()

if (!api) {
	throw new Error("API is not available")
}

// Start a new task with an initial message.
await api.startNewTask({ text: "Hello, Alpha API! Let's make a new project..." })

// Start a new task with an initial message and images.
await api.startNewTask({
	text: "Use this design language",
	images: ["data:image/webp;base64,..."],
})

// Send a message to the current task.
await api.sendMessage("Can you fix the @problems?")

// Simulate pressing the primary button in the chat interface (e.g. 'Save' or 'Proceed While Running').
await api.pressPrimaryButton()

// Simulate pressing the secondary button in the chat interface (e.g. 'Reject').
await api.pressSecondaryButton()
```

`startNewTask` accepts one options object. Omit `configuration` to use the extension's current settings, or supply an
`AlphaCodeSettings` object for that task. `newTab: true` opens the task in an editor panel. `sendMessage` and the button
methods address the current task.

**NOTE:** To ensure that the `Alpha.alpha` extension is activated before your extension, add it to the `extensionDependencies` in your `package.json`:

```json
"extensionDependencies": ["Alpha.alpha"]
```

For detailed information on the available methods and their usage, refer to the `generated type declarations` file.

/** Temporarily bypass the shared FAST focus shim without changing other component suites. */
export function installNativeTestFocus(): () => void {
	const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "focus")
	const frame = document.createElement("iframe")
	document.body.append(frame)
	const focus = frame.contentDocument?.createElement("button").focus
	frame.remove()
	if (!focus || !descriptor) throw new Error("Native DOM focus is unavailable")
	Object.defineProperty(HTMLElement.prototype, "focus", { configurable: true, writable: true, value: focus })
	return () => Object.defineProperty(HTMLElement.prototype, "focus", descriptor)
}

import { useState } from "react"
import { copyToClipboard } from "@src/utils/clipboard"

export interface UseClipboardProps {
	timeout?: number
}

export function useClipboard({ timeout = 2000 }: UseClipboardProps = {}) {
	const [isCopied, setIsCopied] = useState(false)

	const copy = async (value: string) => {
		if (typeof window === "undefined" || !value) {
			return
		}

		const copied = await copyToClipboard(value)

		if (copied) {
			setIsCopied(true)
			setTimeout(() => setIsCopied(false), timeout)
		}
	}

	return { isCopied, copy }
}

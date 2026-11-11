import { createContext, useContext, type HTMLAttributes } from "react"

import { cn } from "@/lib/utils"

const SectionGroupContext = createContext(false)

export const useSectionGroup = () => useContext(SectionGroupContext)

type SectionProps = HTMLAttributes<HTMLDivElement> & {
	grouped?: boolean
}

/** A grouped page owns the card; nested sections keep their controls and spacing without another frame. */
export const Section = ({ className, children, grouped = false, ...props }: SectionProps) => {
	const inGroup = useSectionGroup()

	return (
		<SectionGroupContext.Provider value={grouped || inGroup}>
			<div
				className={cn(
					"flex flex-col gap-4",
					!inGroup && "surface-raised mx-5 mb-5 rounded-2xl p-4",
					className,
					inGroup && "m-0 rounded-none border-0 bg-transparent p-0 shadow-none",
				)}
				{...props}>
				{children}
			</div>
		</SectionGroupContext.Provider>
	)
}

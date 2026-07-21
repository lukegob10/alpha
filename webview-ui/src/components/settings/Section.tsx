import { HTMLAttributes } from "react"

import { cn } from "@/lib/utils"

type SectionProps = HTMLAttributes<HTMLDivElement>

export const Section = ({ className, ...props }: SectionProps) => (
	<div className={cn("surface-raised mx-5 mb-5 flex flex-col gap-4 rounded-2xl p-4", className)} {...props} />
)

import type { ButtonHTMLAttributes, ReactNode } from "react";
import { type ButtonSize, type ButtonVariant, buttonClass } from "../control-classes";

/**
 * The operator portal's button. Shape and colour come from the vendored table in
 * `control-classes.ts`; nothing about either is decided here (#366).
 *
 * A copy of `store/console/src/components/Button.tsx`, for the reason in `control-classes.ts`'s
 * header. The TABLE is held byte-identical by a test; this wrapper is not, because it is plumbing
 * rather than a decision — what matters is that all three render `buttonClass(variant, size)`.
 *
 * `type="button"` is the default on purpose: React does not override the HTML default of `submit`,
 * so a bare `<button>` inside a `<form>` submits it, which here means a full page reload.
 *
 * `className` is passthrough for POSITION only. The rule for when a class may be handed in, and
 * the two measurements behind it, are in the console's copy — the short version is that a utility
 * for a property the vocabulary already sets only wins if it sorts later in the built stylesheet,
 * and `hidden` does not beat `inline-flex`.
 */
export default function Button({
	variant = "secondary",
	size = "md",
	className = "",
	type = "button",
	children,
	...rest
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className"> & {
	variant?: ButtonVariant;
	size?: ButtonSize;
	className?: string;
	children?: ReactNode;
}) {
	return (
		<button type={type} className={buttonClass(variant, size, className)} {...rest}>
			{children}
		</button>
	);
}

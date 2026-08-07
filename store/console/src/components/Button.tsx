import type { ButtonHTMLAttributes, ReactNode } from "react";
import { type ButtonSize, type ButtonVariant, buttonClass } from "../lib/control-classes";

/**
 * The console's button. Shape and colour come from the table in `lib/control-classes.ts`;
 * nothing about either is decided here (#366).
 *
 * `type="button"` is the default on purpose. React does not override the HTML default of
 * `submit`, so a bare `<button>` inside a `<form>` submits it — which in this console means a
 * full page reload, and is why nearly every existing call site writes `type="button"` by hand.
 * A caller inside a real form passes `type="submit"` deliberately.
 *
 * `className` is passthrough for POSITION only — `shrink-0`, `ml-auto`, `w-full`, `self-start`.
 * Do not pass padding, radius or colour: Tailwind resolves same-property utilities by their
 * order in the generated stylesheet, not by their order in the class attribute, so a
 * `px-4` handed in here does not reliably beat the size's `px-3`. If a shape is missing, add a
 * step to the table.
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

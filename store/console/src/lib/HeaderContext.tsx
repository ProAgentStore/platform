import { createContext, useContext, useState, type ReactNode } from "react";

interface HeaderSlot {
	content: ReactNode | null;
	set: (content: ReactNode | null) => void;
}

const HeaderContext = createContext<HeaderSlot>({ content: null, set: () => {} });

export function HeaderProvider({ children }: { children: ReactNode }) {
	const [content, setContent] = useState<ReactNode | null>(null);
	return (
		<HeaderContext.Provider value={{ content, set: setContent }}>
			{children}
		</HeaderContext.Provider>
	);
}

/** Set custom content in the header (replaces nav links). Pass null to restore default nav. */
export function useHeaderSlot() {
	return useContext(HeaderContext);
}

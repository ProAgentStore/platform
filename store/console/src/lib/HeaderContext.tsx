import { createContext, useContext, useState, useEffect, type ReactNode } from "react";

interface HeaderState {
	hidden: boolean;
	setHidden: (v: boolean) => void;
	slot: ReactNode | null;
	setSlot: (v: ReactNode | null) => void;
}

const HideNavContext = createContext<HeaderState>({
	hidden: false,
	setHidden: () => {},
	slot: null,
	setSlot: () => {},
});

export function HeaderProvider({ children }: { children: ReactNode }) {
	const [hidden, setHidden] = useState(false);
	const [slot, setSlot] = useState<ReactNode | null>(null);
	return (
		<HideNavContext.Provider value={{ hidden, setHidden, slot, setSlot }}>
			{children}
		</HideNavContext.Provider>
	);
}

/** Tell the Layout to hide its nav links (instance detail renders its own controls) */
export function useHideNav(hide: boolean) {
	const { setHidden } = useContext(HideNavContext);
	useEffect(() => {
		setHidden(hide);
		return () => setHidden(false);
	}, [hide, setHidden]);
}

/** Inject content into the Layout header (replaces the nav links area) */
export function useHeaderSlot(content: ReactNode) {
	const { setSlot } = useContext(HideNavContext);
	useEffect(() => {
		setSlot(content);
		return () => setSlot(null);
	}, [content, setSlot]);
}

export function useNavHidden() {
	return useContext(HideNavContext).hidden;
}

export function useHeaderSlotContent() {
	return useContext(HideNavContext).slot;
}

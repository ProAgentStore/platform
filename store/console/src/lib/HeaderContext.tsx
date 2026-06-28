import { createContext, useContext, useState, useEffect, type ReactNode } from "react";

const HideNavContext = createContext<{ hidden: boolean; setHidden: (v: boolean) => void }>({
	hidden: false,
	setHidden: () => {},
});

export function HeaderProvider({ children }: { children: ReactNode }) {
	const [hidden, setHidden] = useState(false);
	return (
		<HideNavContext.Provider value={{ hidden, setHidden }}>
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

export function useNavHidden() {
	return useContext(HideNavContext).hidden;
}

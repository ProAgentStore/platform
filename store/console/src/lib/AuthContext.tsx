import {
	createContext,
	useContext,
	useState,
	useEffect,
	useCallback,
	type ReactNode,
} from "react";
import {
	checkAuth,
	handleOAuthCallback,
	signOut as doSignOut,
	type User,
} from "./auth";

interface AuthState {
	user: User | null;
	loading: boolean;
	signOut: () => void;
}

const AuthContext = createContext<AuthState>({
	user: null,
	loading: true,
	signOut: () => {},
});

export function AuthProvider({ children }: { children: ReactNode }) {
	const [user, setUser] = useState<User | null>(null);
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		(async () => {
			await handleOAuthCallback();
			const u = await checkAuth();
			setUser(u);
			setLoading(false);
		})();
	}, []);

	// When any API call hits a 401 mid-session, the client clears the token and fires
	// this event — drop the user so the app shows Login instead of wedging on errors.
	useEffect(() => {
		const onUnauth = () => setUser(null);
		window.addEventListener("pags:unauthorized", onUnauth);
		return () => window.removeEventListener("pags:unauthorized", onUnauth);
	}, []);

	const signOut = useCallback(() => {
		doSignOut();
		setUser(null);
	}, []);

	return (
		<AuthContext.Provider value={{ user, loading, signOut }}>
			{children}
		</AuthContext.Provider>
	);
}

export function useAuth() {
	return useContext(AuthContext);
}

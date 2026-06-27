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
			const oauthToken = await handleOAuthCallback();
			if (oauthToken) {
				const u = await checkAuth();
				setUser(u);
			} else {
				const u = await checkAuth();
				setUser(u);
			}
			setLoading(false);
		})();
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

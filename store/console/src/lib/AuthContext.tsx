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
import { loadAccountTimeZone, resetAccountTimeZone } from "./accountTimezone";

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
			// The whole app's single "we know who this is" moment, so it is where the timezone is
			// read and — only when nothing is stored — seeded from this machine (#345). Not awaited:
			// nothing on screen waits for a clock, and a slow preferences read must not delay the
			// first paint. `loadAccountTimeZone` is memoised, so this stays one request per load.
			if (u) void loadAccountTimeZone();
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
		// The next person to sign in is not necessarily this one, and a stale zone would render
		// their transcript in someone else's clock.
		resetAccountTimeZone();
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

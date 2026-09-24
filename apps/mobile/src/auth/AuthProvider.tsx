// Sign-in with Apple and Google, backed by Firebase Auth (REST API, no
// Firebase SDK). The provider's ID token is exchanged for a Firebase session;
// the refresh token lives in the iOS Keychain (SecureStore). A signed-in
// session unlocks the Claude co-pilot (server verifies the Firebase ID token).
// Sign-in is optional: everything else works without it.
//
// Needs (owner): EXPO_PUBLIC_FIREBASE_API_KEY, EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID,
// Apple/Google providers enabled in Firebase, and for Apple a paid Apple
// Developer team (build with NAVIA_APPLE_SIGNIN=1 to add the entitlement).
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import * as AppleAuthentication from "expo-apple-authentication";
import * as Google from "expo-auth-session/providers/google";
import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import * as WebBrowser from "expo-web-browser";
import { config } from "../config";
import { setCopilotTokenProvider } from "../ai/copilotClient";

WebBrowser.maybeCompleteAuthSession();

export type AuthUser = { uid: string; email: string | null; displayName: string | null; provider: "apple" | "google" };
type Session = { user: AuthUser; idToken: string; refreshToken: string; expiresAt: number };

type AuthContextValue = {
  user: AuthUser | null;
  busy: boolean;
  error: string | null;
  appleAvailable: boolean;
  googleAvailable: boolean;
  signInWithApple: () => Promise<void>;
  signInWithGoogle: () => Promise<void>;
  signOut: () => Promise<void>;
};

const REFRESH_KEY = "navia.auth.refresh";
const USER_KEY = "navia.auth.user";
const AuthContext = createContext<AuthContextValue | null>(null);

async function firebaseSignInWithIdp(providerId: "apple.com" | "google.com", idToken: string, rawNonce?: string) {
  const postBody = new URLSearchParams({ id_token: idToken, providerId, ...(rawNonce ? { nonce: rawNonce } : {}) }).toString();
  const response = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=${encodeURIComponent(config.firebaseApiKey ?? "")}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ postBody, requestUri: "https://navia.app", returnSecureToken: true, returnIdpCredential: true }),
  });
  const body = await response.json() as { localId?: string; email?: string; displayName?: string; fullName?: string; idToken?: string; refreshToken?: string; expiresIn?: string; error?: { message?: string } };
  if (!response.ok || !body.idToken || !body.refreshToken || !body.localId) throw new Error(body.error?.message ?? `auth HTTP ${response.status}`);
  return { uid: body.localId, email: body.email ?? null, displayName: body.displayName ?? body.fullName ?? null, idToken: body.idToken, refreshToken: body.refreshToken, expiresAt: Date.now() + Number(body.expiresIn ?? 3600) * 1000 };
}

async function firebaseRefresh(refreshToken: string) {
  const response = await fetch(`https://securetoken.googleapis.com/v1/token?key=${encodeURIComponent(config.firebaseApiKey ?? "")}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }).toString(),
  });
  const body = await response.json() as { id_token?: string; refresh_token?: string; expires_in?: string; error?: { message?: string } };
  if (!response.ok || !body.id_token || !body.refresh_token) throw new Error(body.error?.message ?? `refresh HTTP ${response.status}`);
  return { idToken: body.id_token, refreshToken: body.refresh_token, expiresAt: Date.now() + Number(body.expires_in ?? 3600) * 1000 };
}

export function AuthProvider({ children }: { children: React.ReactNode }): JSX.Element {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [appleSupported, setAppleSupported] = useState(false);
  const session = useRef<Session | null>(null);
  const firebaseReady = !!config.firebaseApiKey;

  const [, googleResponse, promptGoogle] = Google.useIdTokenAuthRequest({
    iosClientId: config.googleIosClientId ?? "missing.apps.googleusercontent.com",
  });

  useEffect(() => { AppleAuthentication.isAvailableAsync().then(setAppleSupported).catch(() => setAppleSupported(false)); }, []);

  const store = useCallback(async (next: Session | null) => {
    session.current = next;
    setUser(next?.user ?? null);
    if (next) {
      await SecureStore.setItemAsync(REFRESH_KEY, next.refreshToken);
      await SecureStore.setItemAsync(USER_KEY, JSON.stringify(next.user));
    } else {
      await SecureStore.deleteItemAsync(REFRESH_KEY).catch(() => {});
      await SecureStore.deleteItemAsync(USER_KEY).catch(() => {});
    }
  }, []);

  // Fresh Firebase ID token for the co-pilot server (refreshes when near expiry).
  const idToken = useCallback(async (): Promise<string | null> => {
    const s = session.current;
    if (!s) return null;
    if (s.expiresAt - Date.now() > 60_000) return s.idToken;
    try {
      const fresh = await firebaseRefresh(s.refreshToken);
      await store({ ...s, ...fresh });
      return fresh.idToken;
    } catch {
      return null;
    }
  }, [store]);

  // Restore a previous session from the Keychain.
  useEffect(() => {
    if (!firebaseReady) return;
    void (async () => {
      const [refreshToken, rawUser] = await Promise.all([SecureStore.getItemAsync(REFRESH_KEY), SecureStore.getItemAsync(USER_KEY)]);
      if (!refreshToken || !rawUser) return;
      try {
        const fresh = await firebaseRefresh(refreshToken);
        await store({ user: JSON.parse(rawUser) as AuthUser, ...fresh });
      } catch { /* expired or revoked: stay signed out */ }
    })();
  }, [firebaseReady, store]);

  useEffect(() => {
    setCopilotTokenProvider(user ? idToken : null);
  }, [idToken, user]);

  // Google returns asynchronously through the auth-session hook.
  useEffect(() => {
    if (googleResponse?.type !== "success") { if (googleResponse) setBusy(false); return; }
    const token = googleResponse.params.id_token;
    void (async () => {
      try {
        if (!token) throw new Error("Google: no id_token");
        const r = await firebaseSignInWithIdp("google.com", token);
        await store({ user: { uid: r.uid, email: r.email, displayName: r.displayName, provider: "google" }, idToken: r.idToken, refreshToken: r.refreshToken, expiresAt: r.expiresAt });
        setError(null);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(false);
      }
    })();
  }, [googleResponse, store]);

  const signInWithApple = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const rawNonce = Crypto.randomUUID();
      const hashedNonce = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, rawNonce);
      const credential = await AppleAuthentication.signInAsync({
        requestedScopes: [AppleAuthentication.AppleAuthenticationScope.FULL_NAME, AppleAuthentication.AppleAuthenticationScope.EMAIL],
        nonce: hashedNonce,
      });
      if (!credential.identityToken) throw new Error("Apple: no identity token");
      const r = await firebaseSignInWithIdp("apple.com", credential.identityToken, rawNonce);
      const name = [credential.fullName?.givenName, credential.fullName?.familyName].filter(Boolean).join(" ") || r.displayName;
      await store({ user: { uid: r.uid, email: r.email ?? credential.email, displayName: name, provider: "apple" }, idToken: r.idToken, refreshToken: r.refreshToken, expiresAt: r.expiresAt });
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code !== "ERR_REQUEST_CANCELED") setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [store]);

  const signInWithGoogle = useCallback(async () => {
    setBusy(true);
    setError(null);
    const result = await promptGoogle().catch(() => null);
    if (!result || result.type !== "success") setBusy(false);
  }, [promptGoogle]);

  const signOut = useCallback(async () => { await store(null); }, [store]);

  const value = useMemo<AuthContextValue>(() => ({
    user, busy, error,
    appleAvailable: firebaseReady && appleSupported && config.appleSignInEnabled,
    googleAvailable: firebaseReady && !!config.googleIosClientId,
    signInWithApple, signInWithGoogle, signOut,
  }), [appleSupported, busy, error, firebaseReady, signInWithApple, signInWithGoogle, signOut, user]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth outside AuthProvider");
  return value;
}

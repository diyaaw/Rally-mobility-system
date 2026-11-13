'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { Session, User } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase/client';
import { settingsService } from '@/lib/mock/settingsService';

/** Discriminated outcome for signUpWithPassword so the UI can react
 * precisely to each scenario without guessing. */
export type SignUpOutcome =
  | { status: 'confirm_email' }           // New user; Supabase sent a confirmation email
  | { status: 'session_ready' }           // Email-confirm OFF; user is already signed in
  | { status: 'duplicate'; error: string }// Already registered (Supabase error path)
  | { status: 'error'; error: string };   // Any other error (network, weak password, etc.)

interface AuthContextValue {
  session: Session | null;
  user: User | null;
  /** True until the very first session check (localStorage restore)
   * completes — consumers use this to avoid flashing a "logged out" UI
   * before Supabase has had a chance to restore an existing session. */
  loading: boolean;
  accessToken: string | null;
  signInWithPassword: (email: string, password: string) => Promise<{ error: string | null }>;
  signUpWithPassword: (email: string, password: string, fullName?: string) => Promise<SignUpOutcome>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;

    supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      setSession(data.session);
      setLoading(false);
      if (data.session) {
        settingsService.syncWithBackend().catch(() => {});
      }
    });

    // Fires on sign-in, sign-out, AND every automatic token refresh — the
    // one place session/token state changes, so every consumer (the API
    // client, the WebSocket client) always sees the current token without
    // polling.
    const { data: subscription } = supabase.auth.onAuthStateChange((_event, newSession) => {
      if (!active) return;
      setSession(newSession);
      setLoading(false);
      if (newSession) {
        settingsService.syncWithBackend().catch(() => {});
      }
    });

    return () => {
      active = false;
      subscription.subscription.unsubscribe();
    };
  }, []);

  const signInWithPassword = useCallback(async (email: string, password: string) => {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    // Update context state directly from the response rather than waiting
    // on onAuthStateChange above — supabase-js dispatches that listener via
    // a deferred setTimeout(0), so a caller that awaits this and then
    // immediately navigates (see app/(auth)/login/page.tsx) can otherwise
    // land on a protected page before the listener ever fires, and
    // RequireAuth bounces them straight back to /login having seen a
    // stale null session.
    if (!error) {
      setSession(data.session);
      settingsService.syncWithBackend().catch(() => {});
    }
    return { error: error?.message ?? null };
  }, []);

  const signUpWithPassword = useCallback(async (email: string, password: string, fullName?: string): Promise<SignUpOutcome> => {
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: fullName ? { data: { full_name: fullName } } : undefined,
    });

    if (error) {
      // Supabase GoTrue returns specific codes for duplicate emails when
      // email-confirm is OFF. Normalise to a 'duplicate' outcome so the UI
      // can show a targeted message instead of leaking the raw error string.
      const msg = error.message ?? '';
      const isDuplicate =
        error.status === 422 ||
        msg.toLowerCase().includes('already registered') ||
        msg.toLowerCase().includes('already been registered') ||
        msg.toLowerCase().includes('user already exists');
      return isDuplicate
        ? { status: 'duplicate', error: msg }
        : { status: 'error', error: msg };
    }

    // When email-confirm is ON and the address is already registered, GoTrue
    // returns HTTP 200 with a synthetic user whose `identities` array is empty
    // (no real identity was created). Treat this the same as a new user waiting
    // for confirmation — don't leak that the address exists.
    const identities = data.user?.identities ?? [];
    if (data.session) {
      // Email-confirm is OFF; user is immediately signed in.
      setSession(data.session);
      return { status: 'session_ready' };
    }
    // Either a genuine new user or an existing user with email-confirm on.
    // Both cases: tell the user to check their inbox.
    if (identities.length === 0 && !data.session) {
      // Existing user with email-confirm on — GoTrue sent a "sign in" link,
      // not a confirmation link. Safe to show the same "check your email"
      // message (does not confirm or deny the address was already registered).
    }
    return { status: 'confirm_email' };
  }, []);

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      session,
      user: session?.user ?? null,
      loading,
      accessToken: session?.access_token ?? null,
      signInWithPassword,
      signUpWithPassword,
      signOut,
    }),
    [session, loading, signInWithPassword, signUpWithPassword, signOut]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within <AuthProvider>.');
  return ctx;
}

/** Returns a stable getter the WebSocket client / anything outside React
 * render can call for the CURRENT token on demand, without re-rendering
 * every time it changes. */
export async function getCurrentAccessToken(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

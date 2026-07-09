import React, { createContext, useContext, useEffect, useState } from "react";
import { User, Session } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { validateUsernameContent } from "@/lib/username-filter";

interface AuthContextType {
  user: User | null;
  session: Session | null;
  loading: boolean;
  signUp: (email: string, password: string, fullName: string, username: string, dateOfBirth: string, stateCode?: string) => Promise<{ error: any }>;
  signIn: (email: string, password: string) => Promise<{ error: any }>;
  signOut: () => Promise<void>;
  requestPasswordReset: (email: string) => Promise<{ error: any }>;
  updatePassword: (newPassword: string) => Promise<{ error: any }>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider = ({ children }: { children: React.ReactNode }) => {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    // Set up auth state listener
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (event, session) => {
        setSession(session);
        setUser(session?.user ?? null);
        
        if (event === 'SIGNED_IN') {
          toast.success("Welcome back!");
        } else if (event === 'SIGNED_OUT') {
          toast.info("Signed out successfully");
        }
      }
    );

    // Check for existing session
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setUser(session?.user ?? null);
      setLoading(false);
    });

    return () => subscription.unsubscribe();
  }, []);

  const signUp = async (email: string, password: string, fullName: string, username: string, dateOfBirth: string, stateCode?: string) => {
    try {
      // Check for inappropriate username
      const usernameError = validateUsernameContent(username);
      if (usernameError) {
        toast.error(usernameError);
        return { error: { message: usernameError } };
      }

      // Check if username already exists
      const { data: existingUser, error: checkError } = await supabase
        .from('profiles')
        .select('username')
        .eq('username', username)
        .maybeSingle();

      if (checkError) {
        // Surface real DB errors instead of swallowing them (maybeSingle avoids the
        // benign 406 that .single() raised for available usernames).
        console.error('[signUp] username availability check failed:', checkError);
        toast.error('Could not verify username availability. Please try again.');
        return { error: checkError };
      }

      if (existingUser) {
        toast.error("Username is already taken. Please choose another.");
        return { error: { message: "Username already exists" } };
      }

      // Validate age (must be at least 18)
      const birthDate = new Date(dateOfBirth);
      const age = Math.floor((Date.now() - birthDate.getTime()) / (365.25 * 24 * 60 * 60 * 1000));
      
      if (age < 18) {
        toast.error("You must be at least 18 years old to sign up");
        return { error: { message: "Age requirement not met" } };
      }

      const { error, data } = await supabase.auth.signUp({
        email,
        password,
        options: {
          data: {
            full_name: fullName,
            username: username,
            date_of_birth: dateOfBirth,
            state_code: stateCode,
          },
          emailRedirectTo: `${window.location.origin}/`,
        },
      });

      if (error) {
        if (error.message.includes("already registered")) {
          toast.error("This email is already registered. Please sign in instead.");
        } else {
          toast.error(error.message);
        }
        return { error };
      }

      // Profile (incl. date_of_birth, age_confirmed_at, state) is created atomically
      // by the handle_new_user trigger from signUp metadata. The previous client-side
      // profiles.update() ran before the auth session was established, failed RLS
      // silently, and left age_confirmed_at null — blocking every money flow with
      // "Age verification required" (P0-AGE, 2026-06-27). Do not reintroduce it; the
      // trigger is the single source of truth for these fields.

      toast.success("Account created successfully!");
      navigate("/");
      return { error: null };
    } catch (error: any) {
      toast.error("An unexpected error occurred");
      return { error };
    }
  };

  const signIn = async (email: string, password: string) => {
    try {
      const { error } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (error) {
        if (error.message.includes("Invalid login credentials")) {
          toast.error("Invalid email or password");
        } else {
          toast.error(error.message);
        }
        return { error };
      }

      navigate("/");
      return { error: null };
    } catch (error: any) {
      toast.error("An unexpected error occurred");
      return { error };
    }
  };

  const signOut = async () => {
    try {
      const { error } = await supabase.auth.signOut();
      if (error) {
        toast.error(error.message);
      } else {
        setUser(null);
        setSession(null);
        navigate("/login");
      }
    } catch (error: any) {
      toast.error("An unexpected error occurred");
    }
  };

  const requestPasswordReset = async (email: string) => {
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/reset-password`,
      });
      // Do not surface success/failure differently — caller shows identical message
      // regardless to prevent account enumeration.
      if (error) console.warn('[requestPasswordReset]', error.message);
      return { error };
    } catch (error: any) {
      return { error };
    }
  };

  const updatePassword = async (newPassword: string) => {
    try {
      const { error } = await supabase.auth.updateUser({ password: newPassword });
      if (error) {
        toast.error(error.message);
      }
      return { error };
    } catch (error: any) {
      toast.error("An unexpected error occurred");
      return { error };
    }
  };

  return (
    <AuthContext.Provider value={{ user, session, loading, signUp, signIn, signOut, requestPasswordReset, updatePassword }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
};

import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { Waves, Check, Circle } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

const ResetPassword = () => {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordFocused, setPasswordFocused] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  // 'checking' → waiting for PASSWORD_RECOVERY event or hash session
  // 'ready'    → temp session established, show reset form
  // 'invalid'  → no session (bad/expired link)
  const [status, setStatus] = useState<"checking" | "ready" | "invalid">("checking");
  const { updatePassword } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    let resolved = false;

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "PASSWORD_RECOVERY" || (event === "SIGNED_IN" && session)) {
        resolved = true;
        setStatus("ready");
      }
    });

    // Fallback: check for an existing session (recovery token already processed).
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) {
        resolved = true;
        setStatus("ready");
      }
    });

    // If nothing resolves within ~2s, treat the link as invalid/expired.
    const timeout = setTimeout(() => {
      if (!resolved) setStatus("invalid");
    }, 2000);

    return () => {
      subscription.unsubscribe();
      clearTimeout(timeout);
    };
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (password.length < 8) {
      toast.error("Password must be at least 8 characters");
      return;
    }
    if (!/[A-Z]/.test(password)) {
      toast.error("Password must contain at least one uppercase letter");
      return;
    }
    if (!/[0-9]/.test(password)) {
      toast.error("Password must contain at least one number");
      return;
    }
    if (password !== confirmPassword) {
      toast.error("Passwords do not match");
      return;
    }

    setIsLoading(true);
    const { error } = await updatePassword(password);
    setIsLoading(false);

    if (error) return;

    // Sign the temporary recovery session out so the user must log in fresh.
    await supabase.auth.signOut();
    toast.success("Password updated. Please log in with your new password.");
    navigate("/login");
  };

  return (
    <div className="flex flex-col min-h-screen">
      <Header />
      <main className="flex-1 flex items-center justify-center gradient-subtle py-12 px-4">
        <Card className="w-full max-w-md">
          <CardHeader className="space-y-1 text-center">
            <div className="flex justify-center mb-4">
              <div className="w-12 h-12 rounded-lg bg-accent/10 flex items-center justify-center">
                <Waves className="h-6 w-6 text-accent" />
              </div>
            </div>
            <CardTitle className="text-2xl">Set a new password</CardTitle>
            <CardDescription>
              Choose a strong password you haven't used before.
            </CardDescription>
          </CardHeader>

          {status === "checking" && (
            <CardContent>
              <p className="text-sm text-center text-muted-foreground py-6">
                Verifying reset link...
              </p>
            </CardContent>
          )}

          {status === "invalid" && (
            <>
              <CardContent>
                <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-foreground">
                  This reset link is invalid or has expired. Request a new one to continue.
                </div>
              </CardContent>
              <CardFooter className="flex flex-col space-y-2">
                <Button asChild variant="hero" className="w-full">
                  <Link to="/forgot-password">Request a new link</Link>
                </Button>
                <Link to="/login" className="text-sm text-accent hover:underline">
                  Back to log in
                </Link>
              </CardFooter>
            </>
          )}

          {status === "ready" && (
            <form onSubmit={handleSubmit}>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="password">New password</Label>
                  <Input
                    id="password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    onFocus={() => setPasswordFocused(true)}
                    onBlur={() => setPasswordFocused(false)}
                    required
                    minLength={8}
                  />
                  {(passwordFocused || password.length > 0) && (
                    <ul className="space-y-1 pt-1">
                      {[
                        { label: "At least 8 characters", met: password.length >= 8 },
                        { label: "One uppercase letter", met: /[A-Z]/.test(password) },
                        { label: "One number", met: /[0-9]/.test(password) },
                      ].map((req) => (
                        <li
                          key={req.label}
                          className={`flex items-center gap-2 text-xs transition-colors ${
                            req.met ? "text-accent" : "text-muted-foreground"
                          }`}
                        >
                          {req.met ? (
                            <Check className="h-3.5 w-3.5" strokeWidth={3} />
                          ) : (
                            <Circle className="h-3.5 w-3.5" />
                          )}
                          {req.label}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                <div className="space-y-2">
                  <Label htmlFor="confirmPassword">Confirm new password</Label>
                  <Input
                    id="confirmPassword"
                    type="password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    required
                  />
                </div>
              </CardContent>

              <CardFooter className="flex flex-col space-y-4">
                <Button type="submit" variant="hero" className="w-full" disabled={isLoading}>
                  {isLoading ? "Updating..." : "Update password"}
                </Button>
              </CardFooter>
            </form>
          )}
        </Card>
      </main>
      <Footer />
    </div>
  );
};

export default ResetPassword;

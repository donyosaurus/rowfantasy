import { useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { Waves } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";

const COOLDOWN_SECONDS = 60;
const NEUTRAL_MESSAGE =
  "If an account exists for that email, a password reset link has been sent. Check your inbox and spam folder.";

const ForgotPassword = () => {
  const [email, setEmail] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const { requestPasswordReset } = useAuth();

  const startCooldown = () => {
    setCooldown(COOLDOWN_SECONDS);
    const tick = () => {
      setCooldown((c) => {
        if (c <= 1) return 0;
        setTimeout(tick, 1000);
        return c - 1;
      });
    };
    setTimeout(tick, 1000);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (cooldown > 0 || !email.trim()) return;
    setIsLoading(true);
    await requestPasswordReset(email.trim());
    setIsLoading(false);
    setSubmitted(true);
    startCooldown();
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
            <CardTitle className="text-2xl">Reset your password</CardTitle>
            <CardDescription>
              Enter the email on your account and we'll send a reset link.
            </CardDescription>
          </CardHeader>

          <form onSubmit={handleSubmit}>
            <CardContent className="space-y-4">
              {submitted && (
                <div className="rounded-md border border-accent/20 bg-accent/5 p-3 text-sm text-foreground">
                  {NEUTRAL_MESSAGE}
                </div>
              )}
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </div>
            </CardContent>

            <CardFooter className="flex flex-col space-y-4">
              <Button
                type="submit"
                variant="hero"
                className="w-full"
                disabled={isLoading || cooldown > 0}
              >
                {isLoading
                  ? "Sending..."
                  : cooldown > 0
                  ? `Resend available in ${cooldown}s`
                  : "Send reset link"}
              </Button>
              <p className="text-sm text-center text-muted-foreground">
                Remembered it?{" "}
                <Link to="/login" className="text-accent hover:underline font-medium">
                  Back to log in
                </Link>
              </p>
            </CardFooter>
          </form>
        </Card>
      </main>
      <Footer />
    </div>
  );
};

export default ForgotPassword;

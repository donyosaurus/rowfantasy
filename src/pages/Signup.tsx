import { useState, useEffect } from "react";
import { Link, useNavigate, useLocation } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Waves, Check, Circle } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import ReactMarkdown from "react-markdown";

const Signup = () => {
  const [fullName, setFullName] = useState("");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [dateOfBirth, setDateOfBirth] = useState("");
  const [password, setPassword] = useState("");
  const [passwordFocused, setPasswordFocused] = useState(false);
  const [confirmPassword, setConfirmPassword] = useState("");
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [ageConfirmed, setAgeConfirmed] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [termsDialogOpen, setTermsDialogOpen] = useState(false);
  const [privacyDialogOpen, setPrivacyDialogOpen] = useState(false);
  const [termsContent, setTermsContent] = useState<string | null>(null);
  const [privacyContent, setPrivacyContent] = useState<string | null>(null);
  const [loadingContent, setLoadingContent] = useState(false);
  const { signUp, user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const fetchContent = async (slug: string) => {
    setLoadingContent(true);
    try {
      const { data, error } = await supabase.functions.invoke('cms-get', {
        body: { slug }
      });
      if (error) throw error;
      return data?.body_md || null;
    } catch (err) {
      console.error(`Error fetching ${slug}:`, err);
      return null;
    } finally {
      setLoadingContent(false);
    }
  };

  const openTermsDialog = async () => {
    setTermsDialogOpen(true);
    if (!termsContent) {
      const content = await fetchContent('terms');
      setTermsContent(content);
    }
  };

  const openPrivacyDialog = async () => {
    setPrivacyDialogOpen(true);
    if (!privacyContent) {
      const content = await fetchContent('privacy');
      setPrivacyContent(content);
    }
  };

  // Redirect if already logged in
  useEffect(() => {
    if (user) {
      const from = (location.state as any)?.from || "/";
      navigate(from);
    }
  }, [user, navigate, location.state]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    // Validation
    if (!fullName.trim()) {
      toast.error("Please enter your full name");
      return;
    }
    
    if (!username.trim()) {
      toast.error("Please enter a username");
      return;
    }
    
    // Username validation
    if (username.length < 3 || username.length > 20) {
      toast.error("Username must be between 3 and 20 characters");
      return;
    }
    
    if (!/^[a-zA-Z0-9_]+$/.test(username)) {
      toast.error("Username can only contain letters, numbers, and underscores");
      return;
    }
    
    // Basic inappropriate content check
    const inappropriateWords = ['admin', 'moderator', 'support', 'official', 'staff'];
    if (inappropriateWords.some(word => username.toLowerCase().includes(word))) {
      toast.error("This username is not allowed");
      return;
    }

    // Date of birth validation
    if (!dateOfBirth) {
      toast.error("Please enter your date of birth");
      return;
    }

    const birthDate = new Date(dateOfBirth);
    const age = Math.floor((Date.now() - birthDate.getTime()) / (365.25 * 24 * 60 * 60 * 1000));
    
    if (age < 18) {
      toast.error("You must be at least 18 years old to sign up");
      return;
    }

    if (!ageConfirmed) {
      toast.error("Please confirm that you are 18 years or older");
      return;
    }
    
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
    
    if (!termsAccepted) {
      toast.error("Please accept the terms and conditions");
      return;
    }
    
    setIsLoading(true);
    await signUp(email, password, fullName, username, dateOfBirth);
    setIsLoading(false);
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
            <CardTitle className="text-2xl">Create your account</CardTitle>
            <CardDescription>
              Join RowFantasy and start competing
            </CardDescription>
          </CardHeader>
          
          <form onSubmit={handleSubmit}>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="fullName">Full Name</Label>
                <Input
                  id="fullName"
                  type="text"
                  placeholder="John Doe"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  required
                />
              </div>
              
              <div className="space-y-2">
                <Label htmlFor="username">Username</Label>
                <Input
                  id="username"
                  type="text"
                  placeholder="johndoe123"
                  value={username}
                  onChange={(e) => setUsername(e.target.value.toLowerCase())}
                  required
                  minLength={3}
                  maxLength={20}
                />
                <p className="text-xs text-muted-foreground">
                  3-20 characters, letters, numbers, and underscores only
                </p>
              </div>
              
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

              <div className="space-y-2">
                <Label htmlFor="dateOfBirth">Date of Birth</Label>
                <Input
                  id="dateOfBirth"
                  type="date"
                  value={dateOfBirth}
                  onChange={(e) => setDateOfBirth(e.target.value)}
                  max={new Date(Date.now() - 18 * 365.25 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]}
                  required
                />
                <p className="text-xs text-muted-foreground">
                  You must be at least 18 years old
                </p>
              </div>
              
              <div className="space-y-2">
                <Label htmlFor="password">Password</Label>
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
                <Label htmlFor="confirmPassword">Confirm Password</Label>
                <Input
                  id="confirmPassword"
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  required
                />
              </div>

              <div className="flex items-start space-x-2">
                <Checkbox
                  id="ageConfirm"
                  checked={ageConfirmed}
                  onCheckedChange={(checked) => setAgeConfirmed(checked as boolean)}
                />
                <label
                  htmlFor="ageConfirm"
                  className="text-sm text-muted-foreground leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
                >
                  I confirm that I am at least 18 years old
                </label>
              </div>

              <div className="flex items-start space-x-2">
                <Checkbox
                  id="terms"
                  checked={termsAccepted}
                  onCheckedChange={(checked) => setTermsAccepted(checked as boolean)}
                />
                <label
                  htmlFor="terms"
                  className="text-sm text-muted-foreground leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
                >
                  I agree to the{" "}
                  <button
                    type="button"
                    onClick={openTermsDialog}
                    className="text-accent hover:underline"
                  >
                    Terms of Use
                  </button>{" "}
                  and{" "}
                  <button
                    type="button"
                    onClick={openPrivacyDialog}
                    className="text-accent hover:underline"
                  >
                    Privacy Policy
                  </button>
                </label>
              </div>
            </CardContent>
            
            <CardFooter className="flex flex-col space-y-4">
              <Button 
                type="submit" 
                variant="hero" 
                className="w-full"
                disabled={!termsAccepted || !ageConfirmed || isLoading}
              >
                {isLoading ? "Creating account..." : "Sign Up"}
              </Button>
              
              <p className="text-sm text-center text-muted-foreground">
                Already have an account?{" "}
                <Link to="/login" state={location.state} className="text-accent hover:underline font-medium">
                  Log in
                </Link>
              </p>
            </CardFooter>
          </form>
        </Card>
      </main>

      <Footer />

      {/* Terms of Use Dialog */}
      <Dialog open={termsDialogOpen} onOpenChange={setTermsDialogOpen}>
        <DialogContent className="max-w-2xl max-h-[80vh]">
          <DialogHeader>
            <DialogTitle>Terms of Use</DialogTitle>
          </DialogHeader>
          <ScrollArea className="h-[60vh] pr-4">
            {loadingContent ? (
              <div className="flex items-center justify-center py-8">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
              </div>
            ) : termsContent ? (
              <div className="prose prose-sm dark:prose-invert max-w-none">
                <ReactMarkdown>{termsContent}</ReactMarkdown>
              </div>
            ) : (
              <p className="text-muted-foreground text-center py-8">
                Unable to load Terms of Use. Please try again later.
              </p>
            )}
          </ScrollArea>
        </DialogContent>
      </Dialog>

      {/* Privacy Policy Dialog */}
      <Dialog open={privacyDialogOpen} onOpenChange={setPrivacyDialogOpen}>
        <DialogContent className="max-w-2xl max-h-[80vh]">
          <DialogHeader>
            <DialogTitle>Privacy Policy</DialogTitle>
          </DialogHeader>
          <ScrollArea className="h-[60vh] pr-4">
            {loadingContent ? (
              <div className="flex items-center justify-center py-8">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
              </div>
            ) : privacyContent ? (
              <div className="prose prose-sm dark:prose-invert max-w-none">
                <ReactMarkdown>{privacyContent}</ReactMarkdown>
              </div>
            ) : (
              <p className="text-muted-foreground text-center py-8">
                Unable to load Privacy Policy. Please try again later.
              </p>
            )}
          </ScrollArea>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default Signup;

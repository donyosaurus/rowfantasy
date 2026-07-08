import { useEffect, useState } from "react";
import { LegalLayout } from "@/components/LegalLayout";
import { formatCents } from "@/lib/formatCurrency";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { supabase } from "@/integrations/supabase/client";
import { Shield, Clock, Ban, ExternalLink, AlertCircle } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import ReactMarkdown from "react-markdown";
import { StepUpDialog } from "@/components/StepUpDialog";

export default function ResponsiblePlay() {
  const [content, setContent] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [profile, setProfile] = useState<any>(null);
  const [rgSelfExclusion, setRgSelfExclusion] = useState<string | null>(null);
  const [rgDepositLimitCents, setRgDepositLimitCents] = useState<number | null>(null);
  const [depositLimit, setDepositLimit] = useState<string>("");
  const [selfExclusionDuration, setSelfExclusionDuration] = useState<string>("");
  const [stepUpOpen, setStepUpOpen] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    const fetchData = async () => {
      // Fetch responsible play content
      const { data: cmsData } = await supabase.functions.invoke('cms-get', {
        body: { slug: 'responsible-play' }
      });

      if (cmsData?.page) {
        setContent(cmsData.page);
      }

      // Get user profile
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        const { data: profileData } = await supabase
          .from('profiles')
          .select('*')
          .eq('id', user.id)
          .maybeSingle();
        
        if (profileData) {
          setProfile(profileData);
        }

        // P0-C5: SX source-of-truth is responsible_gaming, NOT profiles.
        // Absent row OR null = NOT excluded (semantic guardrail).
        const { data: rgData } = await supabase
          .from('responsible_gaming')
          .select('self_exclusion_until, deposit_limit_monthly_cents')
          .eq('user_id', user.id)
          .maybeSingle();
        setRgSelfExclusion(rgData?.self_exclusion_until ?? null);
        setRgDepositLimitCents(rgData?.deposit_limit_monthly_cents ?? null);


        // Log view
        supabase.from('compliance_audit_logs').insert({
          user_id: user.id,
          event_type: 'legal_view',
          description: 'Viewed responsible play',
          severity: 'info',
          metadata: { doc_slug: 'responsible-play' }
        });
      }

      setLoading(false);
    };

    fetchData();
  }, []);

  const submitDepositLimit = async (stepUpToken?: string) => {
    // P0-C4: backend expects `depositLimit` in CENTS per responsible-limits Zod schema.
    const depositLimitCents = Math.round(Number(depositLimit) * 100);

    const { data, error } = await supabase.functions.invoke('responsible-limits', {
      method: 'POST',
      body: { depositLimit: depositLimitCents },
      headers: stepUpToken ? { 'x-step-up-token': stepUpToken } : undefined,
    });

    // Backend signals "email OTP needed" via `code: 'step_up_required'`.
    // supabase.functions.invoke surfaces non-2xx as `error`; the body is on error.context.
    if (error) {
      let errBody: any = null;
      try { errBody = await (error as any).context?.json?.(); } catch { /* noop */ }
      if (errBody?.code === 'step_up_required') {
        setStepUpOpen(true);
        return;
      }
      toast({ title: "Error", description: errBody?.error || "Failed to update deposit limit.", variant: "destructive" });
      return;
    }

    if (data?.depositLimitEffective === 'pending_24h') {
      const effectiveAt = data?.pendingDepositLimitEffectiveAt
        ? new Date(data.pendingDepositLimitEffectiveAt).toLocaleString()
        : 'in 24 hours';
      toast({
        title: "Increase Pending",
        description: `Deposit limit increases take effect after a 24-hour cooling-off period (effective ${effectiveAt}).`,
      });
      return;
    }

    setRgDepositLimitCents(depositLimitCents);
    toast({ title: "Limit Updated", description: `Monthly deposit limit set to $${depositLimit}` });
  };

  const handleDepositLimit = async () => {
    if (!depositLimit || isNaN(Number(depositLimit))) {
      toast({
        title: "Invalid Amount",
        description: "Please enter a valid deposit limit.",
        variant: "destructive"
      });
      return;
    }
    await submitDepositLimit();
  };


  const handleSelfExclusion = async () => {
    if (!selfExclusionDuration) {
      toast({
        title: "Select Duration",
        description: "Please select a self-exclusion duration.",
        variant: "destructive"
      });
      return;
    }

    // P0-C4: backend expects `exclusionDays` (numeric int positive) per responsible-limits Zod schema.
    // "permanent" → 36500 days (100 years, effectively permanent; clean numeric int).
    const exclusionDays =
      selfExclusionDuration === 'permanent'
        ? 36500
        : parseInt(selfExclusionDuration, 10);

    if (!Number.isFinite(exclusionDays) || exclusionDays <= 0) {
      toast({
        title: "Invalid Duration",
        description: "Please select a valid self-exclusion duration.",
        variant: "destructive"
      });
      return;
    }

    const { error } = await supabase.functions.invoke('responsible-limits', {
      method: 'POST',
      body: {
        exclusionDays,
      },
    });

    if (error) {
      toast({
        title: "Error",
        description: "Failed to enable self-exclusion.",
        variant: "destructive"
      });
      return;
    }

    // P0-C4: sync local rgSelfExclusion state so banner updates immediately.
    const exclusionUntilLocal = new Date();
    exclusionUntilLocal.setDate(exclusionUntilLocal.getDate() + exclusionDays);
    setRgSelfExclusion(exclusionUntilLocal.toISOString());

    toast({
      title: "Self-Exclusion Enabled",
      description: `Your account will be restricted for ${selfExclusionDuration === 'permanent' ? 'permanently' : selfExclusionDuration + ' days'}.`,
      variant: "destructive"
    });

    // Refresh profile
    setTimeout(() => window.location.reload(), 2000);
  };

  if (loading) {
    return (
      <LegalLayout breadcrumbs={[{ label: 'Legal', path: '/legal' }, { label: 'Responsible Play' }]}>
        <div className="flex items-center justify-center py-12">
          <div className="animate-spin h-8 w-8 border-4 border-primary border-t-transparent rounded-full" />
        </div>
      </LegalLayout>
    );
  }

  const isExcluded = !!rgSelfExclusion && new Date(rgSelfExclusion) > new Date();

  return (
    <LegalLayout breadcrumbs={[{ label: 'Legal', path: '/legal' }, { label: 'Responsible Play' }]}>
      <div className="space-y-6">
        <div>
          <h1 className="text-4xl font-bold mb-2">Responsible Play</h1>
          <p className="text-muted-foreground">
            Tools and resources to help you play responsibly and stay in control.
          </p>
        </div>

        {isExcluded && (
          <Alert variant="destructive">
            <Ban className="h-4 w-4" />
            <AlertDescription>
              Your account is currently under self-exclusion until{' '}
              {rgSelfExclusion ? new Date(rgSelfExclusion).toLocaleDateString() : ''}.
              All contest entries and deposits are disabled.
            </AlertDescription>
          </Alert>
        )}

        <div className="grid gap-6 md:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Shield className="h-5 w-5" />
                Deposit Limits
              </CardTitle>
              <CardDescription>
                Set a monthly limit on how much you can deposit
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <Label htmlFor="deposit-limit">Monthly Deposit Limit ($)</Label>
                <Input
                  id="deposit-limit"
                  type="number"
                  value={depositLimit}
                  onChange={(e) => setDepositLimit(e.target.value)}
                  placeholder="2500"
                  disabled={isExcluded}
                />
                <p className="text-xs text-muted-foreground mt-1">
                  Current limit: {rgDepositLimitCents != null ? formatCents(rgDepositLimitCents) : '$2,500.00'}
                </p>
              </div>
              <Button onClick={handleDepositLimit} disabled={isExcluded} className="w-full">
                Update Limit
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Ban className="h-5 w-5" />
                Self-Exclusion
              </CardTitle>
              <CardDescription>
                Take a break from RowFantasy for a set period
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <Label htmlFor="exclusion-duration">Duration</Label>
                <Select value={selfExclusionDuration} onValueChange={setSelfExclusionDuration} disabled={isExcluded}>
                  <SelectTrigger id="exclusion-duration">
                    <SelectValue placeholder="Select duration" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="30">30 Days</SelectItem>
                    <SelectItem value="60">60 Days</SelectItem>
                    <SelectItem value="90">90 Days</SelectItem>
                    <SelectItem value="permanent">Permanent</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <Alert>
                <AlertCircle className="h-4 w-4" />
                <AlertDescription className="text-xs">
                  This action cannot be undone during the exclusion period.
                </AlertDescription>
              </Alert>
              <Button
                onClick={handleSelfExclusion}
                disabled={isExcluded}
                variant="destructive"
                className="w-full"
              >
                Enable Self-Exclusion
              </Button>
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ExternalLink className="h-5 w-5" />
              Resources & Support
            </CardTitle>
            <CardDescription>
              If you need help, these organizations provide free, confidential support
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid gap-3">
              <a
                href="https://www.ncpgambling.org/"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-between p-3 border rounded-lg hover:bg-muted transition-colors"
              >
                <span className="font-medium">National Council on Problem Gambling</span>
                <ExternalLink className="h-4 w-4" />
              </a>
              <a
                href="tel:1-800-522-4700"
                className="flex items-center justify-between p-3 border rounded-lg hover:bg-muted transition-colors"
              >
                <span className="font-medium">Call: 1-800-522-4700</span>
                <span className="text-xs text-muted-foreground">24/7 Helpline</span>
              </a>
            </div>
          </CardContent>
        </Card>

        {content && (
          <Card>
            <CardContent className="prose prose-slate dark:prose-invert max-w-none pt-6">
              <ReactMarkdown>{content.body_md}</ReactMarkdown>
            </CardContent>
          </Card>
        )}
      </div>
      <StepUpDialog
        open={stepUpOpen}
        purpose="responsible_limits"
        onVerified={(token) => { setStepUpOpen(false); void submitDepositLimit(token); }}
        onCancel={() => setStepUpOpen(false)}
      />
    </LegalLayout>
  );
}
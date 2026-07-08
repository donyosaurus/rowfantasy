import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { Loader2, Mail } from "lucide-react";

export type StepUpPurpose = "withdraw" | "responsible_limits" | "password_change";

interface Props {
  open: boolean;
  purpose: StepUpPurpose;
  onVerified: (token: string) => void;
  onCancel: () => void;
}

const PURPOSE_TITLE: Record<StepUpPurpose, string> = {
  withdraw: "Confirm withdrawal",
  responsible_limits: "Confirm limit change",
  password_change: "Confirm password change",
};

/**
 * Email-OTP step-up dialog.
 *
 * Flow:
 *  1. On open, calls `otp-request` to email a 6-digit code.
 *  2. User enters the code; we call `otp-verify` which returns a one-shot
 *     step-up token (5-minute TTL, single-use).
 *  3. The parent receives the token via `onVerified` and re-invokes the
 *     sensitive action with header `x-step-up-token: <token>`.
 */
export function StepUpDialog({ open, purpose, onVerified, onCancel }: Props) {
  const [code, setCode] = useState("");
  const [sending, setSending] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [sentAt, setSentAt] = useState<number | null>(null);
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    if (!open) {
      setCode("");
      setSentAt(null);
      setCooldown(0);
      return;
    }
    // Auto-send first code when dialog opens
    void sendCode();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setInterval(() => setCooldown((c) => Math.max(0, c - 1)), 1000);
    return () => clearInterval(t);
  }, [cooldown]);

  async function sendCode() {
    setSending(true);
    try {
      const { data, error } = await supabase.functions.invoke("otp-request", { body: { purpose } });
      if (error) {
        toast.error(error.message || "Failed to send code");
        return;
      }
      if (data?.error) {
        toast.error(data.error);
        return;
      }
      setSentAt(Date.now());
      setCooldown(30);
      toast.success("Verification code sent to your email");
    } catch {
      toast.error("Failed to send code");
    } finally {
      setSending(false);
    }
  }

  async function handleVerify() {
    if (!/^\d{6}$/.test(code)) {
      toast.error("Enter the 6-digit code from your email");
      return;
    }
    setVerifying(true);
    try {
      const { data, error } = await supabase.functions.invoke("otp-verify", {
        body: { purpose, code },
      });
      if (error) {
        toast.error(error.message || "Verification failed");
        return;
      }
      if (data?.error) {
        toast.error(data.error);
        return;
      }
      const token = data?.stepUpToken;
      if (!token) {
        toast.error("Verification failed");
        return;
      }
      onVerified(token);
    } catch {
      toast.error("Verification failed");
    } finally {
      setVerifying(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onCancel(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Mail className="h-5 w-5" />
            {PURPOSE_TITLE[purpose]}
          </DialogTitle>
          <DialogDescription>
            For your security, enter the 6-digit code we just emailed you. The code expires in 10 minutes.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2">
          <Label htmlFor="stepup-code">Verification code</Label>
          <Input
            id="stepup-code"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
            placeholder="123456"
            className="text-center text-2xl tracking-[0.5em] font-mono"
            disabled={sending && !sentAt}
          />
          <div className="text-xs text-muted-foreground text-center">
            {sending && !sentAt ? "Sending code…" : sentAt ? "Check your inbox (and spam)." : ""}
          </div>
        </div>

        <DialogFooter className="flex-col sm:flex-row gap-2 sm:gap-2">
          <Button
            variant="ghost"
            type="button"
            onClick={() => void sendCode()}
            disabled={sending || cooldown > 0}
          >
            {cooldown > 0 ? `Resend in ${cooldown}s` : "Resend code"}
          </Button>
          <div className="flex gap-2 sm:ml-auto">
            <Button variant="outline" type="button" onClick={onCancel} disabled={verifying}>
              Cancel
            </Button>
            <Button type="button" onClick={handleVerify} disabled={verifying || code.length !== 6}>
              {verifying ? <Loader2 className="h-4 w-4 animate-spin" /> : "Verify"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

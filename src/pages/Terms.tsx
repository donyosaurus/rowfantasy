import { useEffect, useState } from "react";
import { LegalLayout } from "@/components/LegalLayout";
import { StateComplianceBanner } from "@/components/StateComplianceBanner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { supabase } from "@/integrations/supabase/client";
import { AlertCircle } from "lucide-react";
import ReactMarkdown from "react-markdown";
import { useAuth } from "@/hooks/useAuth";
import { toast } from "sonner";

export default function Terms() {
  const [content, setContent] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [userState, setUserState] = useState<string | null>(null);
  const [showConsentModal, setShowConsentModal] = useState(false);
  const [userConsent, setUserConsent] = useState<any>(null);
  const { signOut } = useAuth();

  useEffect(() => {
    const fetchData = async () => {
      // Fetch terms content
      const { data: cmsData } = await supabase.functions.invoke('cms-get', {
        body: { slug: 'terms', versions: true }
      });

      if (cmsData?.page) {
        setContent(cmsData);
      }

      // Get user data
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        // Get user's state
        const { data: profile } = await supabase
          .from('profiles')
          .select('state')
          .eq('id', user.id)
          .maybeSingle();
        
        if (profile?.state) {
          setUserState(profile.state);
        }

        // Check if user has consented to current version
        let latestConsentVersion: string | null = null;
        const { data: existingConsent } = await supabase
          .from('user_consents')
          .select('version, consented_at')
          .eq('doc_slug', 'terms')
          .order('consented_at', { ascending: false })
          .limit(1)
          .maybeSingle();

        if (existingConsent) {
          latestConsentVersion = String(existingConsent.version);
          setUserConsent(existingConsent);
        }

        const currentVersionString = `v${(cmsData?.page?.version ?? '').toString()}`;
        const currentVersionAlt = (cmsData?.page?.version ?? '').toString();

        // Show consent modal if no consent for current version
        if (!latestConsentVersion || (latestConsentVersion !== currentVersionString && latestConsentVersion !== currentVersionAlt)) {
          setShowConsentModal(true);
        }


        // Log view (fire-and-forget; page render must not block)
        supabase.functions.invoke('compliance-log-view', {
          body: { doc_slug: 'terms' },
        }).catch(console.error);
      }

      setLoading(false);
    };

    fetchData();
  }, []);

  const handleConsent = async (accepted: boolean) => {
    if (!accepted || !content?.page) {
      // User declined - handle appropriately (log out, show warning, etc.)
      setShowConsentModal(false);
      return;
    }

    const { error: consentErr } = await supabase.functions.invoke('user-consents', {
      method: 'POST',
      body: {
        doc_slug: 'terms',
        version: content.page.version
      }
    });

    if (consentErr) {
      console.error('[Terms] failed to record consent', consentErr);
      return;
    }

    setShowConsentModal(false);
    setUserConsent({ version: content.page.version });
  };

  if (loading) {
    return (
      <LegalLayout breadcrumbs={[{ label: 'Legal', path: '/legal' }, { label: 'Terms of Use' }]}>
        <div className="flex items-center justify-center py-12">
          <div className="animate-spin h-8 w-8 border-4 border-primary border-t-transparent rounded-full" />
        </div>
      </LegalLayout>
    );
  }

  return (
    <LegalLayout breadcrumbs={[{ label: 'Legal', path: '/legal' }, { label: 'Terms of Use' }]}>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-4xl font-bold mb-2">Terms of Use</h1>
            <p className="text-muted-foreground">
              Last updated: {content?.page ? new Date(content.page.updated_at).toLocaleDateString() : 'N/A'}
            </p>
          </div>
          {content?.page && (
            <Badge variant="outline" className="text-lg py-1 px-3">
              Version {content.page.version}
            </Badge>
          )}
        </div>

        {userState && (
          <StateComplianceBanner stateCode={userState} />
        )}

        {content?.page ? (
          <Card>
            <CardContent className="prose prose-slate dark:prose-invert max-w-none pt-6">
              <ReactMarkdown>{content.page.body_md}</ReactMarkdown>
            </CardContent>
          </Card>
        ) : (
          <Alert>
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              Terms of Use content is not available at this time. Please contact support if this issue persists.
            </AlertDescription>
          </Alert>
        )}

        {content?.versions && content.versions.length > 1 && (
          <Card>
            <CardHeader>
              <CardTitle>Version History</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                {content.versions.map((version: any) => (
                  <div key={version.id} className="flex items-center justify-between py-2 border-b last:border-0">
                    <div>
                      <span className="font-medium">Version {version.version}</span>
                      <span className="text-muted-foreground text-sm ml-3">
                        {new Date(version.published_at).toLocaleDateString()}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}
      </div>

      <Dialog open={showConsentModal} onOpenChange={setShowConsentModal}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Updated Terms of Use</DialogTitle>
            <DialogDescription>
              Our Terms of Use have been updated. Please review and accept the new terms to continue using RowFantasy.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <Alert>
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>
                You must accept the updated terms to continue using our services.
              </AlertDescription>
            </Alert>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => handleConsent(false)}>
              Decline
            </Button>
            <Button onClick={() => handleConsent(true)}>
              Accept Terms
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </LegalLayout>
  );
}
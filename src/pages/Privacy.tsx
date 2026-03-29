import { useEffect, useState } from "react";
import { LegalLayout } from "@/components/LegalLayout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { supabase } from "@/integrations/supabase/client";
import { Download, Eye, Trash2, AlertCircle, CheckCircle2 } from "lucide-react";
import ReactMarkdown from "react-markdown";
import { useToast } from "@/hooks/use-toast";

export default function Privacy() {
  const [content, setContent] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [requests, setRequests] = useState<any[]>([]);
  const { toast } = useToast();

  useEffect(() => {
    const fetchData = async () => {
      // Fetch privacy policy content
      const { data: cmsData } = await supabase.functions.invoke('cms-get', {
        body: { slug: 'privacy' }
      });

      if (cmsData?.page) {
        setContent(cmsData.page);
      }

      // Get user's privacy requests
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        const { data: requestsData } = await supabase.functions.invoke('privacy-requests');
        if (requestsData?.requests) {
          setRequests(requestsData.requests);
        }

        // Log view
        supabase.from('compliance_audit_logs').insert({
          user_id: user.id,
          event_type: 'legal_view',
          description: 'Viewed privacy policy',
          severity: 'info',
          metadata: { doc_slug: 'privacy' }
        });
      }

      setLoading(false);
    };

    fetchData();
  }, []);

  const handlePrivacyRequest = async (type: 'access' | 'export' | 'delete') => {
    const { data, error } = await supabase.functions.invoke('privacy-requests', {
      method: 'POST',
      body: { type }
    });

    if (error) {
      toast({
        title: "Error",
        description: "Failed to submit request. Please try again.",
        variant: "destructive"
      });
      return;
    }

    toast({
      title: "Request Submitted",
      description: `Your ${type} request has been submitted. We'll process it within 30 days.`
    });

    setRequests([data.request, ...requests]);
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'completed':
        return <CheckCircle2 className="h-4 w-4 text-success" />;
      case 'processing':
        return <div className="h-4 w-4 animate-spin border-2 border-primary border-t-transparent rounded-full" />;
      default:
        return <AlertCircle className="h-4 w-4 text-muted-foreground" />;
    }
  };

  if (loading) {
    return (
      <LegalLayout breadcrumbs={[{ label: 'Legal', path: '/legal' }, { label: 'Privacy Policy' }]}>
        <div className="flex items-center justify-center py-12">
          <div className="animate-spin h-8 w-8 border-4 border-primary border-t-transparent rounded-full" />
        </div>
      </LegalLayout>
    );
  }

  return (
    <LegalLayout breadcrumbs={[{ label: 'Legal', path: '/legal' }, { label: 'Privacy Policy' }]}>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-4xl font-bold mb-2">Privacy Policy</h1>
            <p className="text-muted-foreground">
              Last updated: {content ? new Date(content.updated_at).toLocaleDateString() : 'N/A'}
            </p>
          </div>
          {content && (
            <Badge variant="outline" className="text-lg py-1 px-3">
              Version {content.version}
            </Badge>
          )}
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Your Data Rights</CardTitle>
            <CardDescription>
              You may request access to, export, or deletion of your personal data, subject to legal retention requirements.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 md:grid-cols-3">
              <Button
                variant="outline"
                className="flex items-center gap-2"
                onClick={() => handlePrivacyRequest('access')}
              >
                <Eye className="h-4 w-4" />
                Access My Data
              </Button>
              <Button
                variant="outline"
                className="flex items-center gap-2"
                onClick={() => handlePrivacyRequest('export')}
              >
                <Download className="h-4 w-4" />
                Export Data (ZIP)
              </Button>
              <Button
                variant="outline"
                className="flex items-center gap-2 text-destructive hover:text-destructive"
                onClick={() => handlePrivacyRequest('delete')}
              >
                <Trash2 className="h-4 w-4" />
                Delete My Data
              </Button>
            </div>

            {requests.length > 0 && (
              <div className="mt-6">
                <h4 className="font-semibold mb-3">Your Requests</h4>
                <div className="space-y-2">
                  {requests.map((request) => (
                    <div
                      key={request.id}
                      className="flex items-center justify-between p-3 border rounded-lg"
                    >
                      <div className="flex items-center gap-3">
                        {getStatusIcon(request.status)}
                        <div>
                          <p className="font-medium capitalize">{request.type} Request</p>
                          <p className="text-sm text-muted-foreground">
                            {new Date(request.created_at).toLocaleDateString()}
                          </p>
                        </div>
                      </div>
                      <Badge variant={request.status === 'completed' ? 'default' : 'secondary'}>
                        {request.status}
                      </Badge>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {content ? (
          <Card>
            <CardContent className="prose prose-slate dark:prose-invert max-w-none pt-6">
              <ReactMarkdown>{content.body_md}</ReactMarkdown>
            </CardContent>
          </Card>
        ) : (
          <Alert>
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              Privacy Policy content is not available at this time. Please contact support if this issue persists.
            </AlertDescription>
          </Alert>
        )}
      </div>
    </LegalLayout>
  );
}
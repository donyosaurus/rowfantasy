import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { LegalLayout } from "@/components/LegalLayout";
import { StateComplianceBanner } from "@/components/StateComplianceBanner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { FileText, Shield, Users, ChevronRight } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";

const legalDocs = [
  {
    slug: 'terms',
    title: 'Terms of Use',
    description: 'Rules and conditions for using RowFantasy',
    path: '/legal/terms',
    icon: FileText,
  },
  {
    slug: 'privacy',
    title: 'Privacy Policy',
    description: 'How we collect, use, and protect your data',
    path: '/legal/privacy',
    icon: Shield,
  },
  {
    slug: 'responsible-play',
    title: 'Responsible Play',
    description: 'Tools and resources for healthy participation',
    path: '/legal/responsible-play',
    icon: Users,
  },
];

export default function Legal() {
  const [docVersions, setDocVersions] = useState<Record<string, any>>({});
  const [userState, setUserState] = useState<string | null>(null);

  useEffect(() => {
    // Get user's state from profile
    const fetchUserState = async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        const { data: profile } = await supabase
          .from('profiles')
          .select('state')
          .eq('id', user.id)
          .maybeSingle();
        
        if (profile?.state) {
          setUserState(profile.state);
        }
      }
    };

    // Fetch latest versions of legal docs
    const fetchVersions = async () => {
      for (const doc of legalDocs) {
        const { data } = await supabase.functions.invoke('cms-get', {
          body: { slug: doc.slug }
        });

        if (data?.page) {
          setDocVersions(prev => ({
            ...prev,
            [doc.slug]: data.page
          }));
        }
      }
    };

    fetchUserState();
    fetchVersions();

    // Log page view (fire-and-forget)
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (user) {
        supabase.functions.invoke('compliance-log-view', {
          body: { doc_slug: 'legal' },
        }).catch(console.error);
      }
    });
  }, []);

  return (
    <LegalLayout breadcrumbs={[{ label: 'Legal' }]}>
      <div className="space-y-8">
        <div>
          <h1 className="text-4xl font-bold mb-2">Legal Hub</h1>
          <p className="text-muted-foreground">
            Access our legal documents, understand your rights, and review our compliance information.
          </p>
        </div>

        {userState && (
          <StateComplianceBanner stateCode={userState} />
        )}

        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          {legalDocs.map((doc) => {
            const Icon = doc.icon;
            const version = docVersions[doc.slug];
            
            return (
              <Link key={doc.slug} to={doc.path}>
                <Card className="h-full hover:border-primary transition-colors cursor-pointer">
                  <CardHeader>
                    <div className="flex items-start justify-between">
                      <Icon className="h-8 w-8 text-primary mb-2" />
                      {version && (
                        <Badge variant="outline">v{version.version}</Badge>
                      )}
                    </div>
                    <CardTitle>{doc.title}</CardTitle>
                    <CardDescription>{doc.description}</CardDescription>
                  </CardHeader>
                  <CardContent>
                    {version && (
                      <p className="text-xs text-muted-foreground">
                        Last updated: {new Date(version.updated_at).toLocaleDateString()}
                      </p>
                    )}
                    <div className="flex items-center gap-1 text-primary text-sm mt-4">
                      View Document <ChevronRight className="h-4 w-4" />
                    </div>
                  </CardContent>
                </Card>
              </Link>
            );
          })}
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Questions or Concerns?</CardTitle>
            <CardDescription>
              If you have any questions about our legal documents or need clarification, our support team is here to help.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Link to="/support/contact">
              <button className="text-primary hover:underline">
                Contact Support →
              </button>
            </Link>
          </CardContent>
        </Card>
      </div>
    </LegalLayout>
  );
}
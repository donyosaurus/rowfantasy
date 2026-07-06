import { useEffect, useState } from "react";
import { Alert, AlertDescription } from "./ui/alert";
import { Badge } from "./ui/badge";
import { ExternalLink, Shield } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";

interface StateComplianceBannerProps {
  stateCode?: string;
}

export const StateComplianceBanner = ({ stateCode }: StateComplianceBannerProps) => {
  const [stateData, setStateData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchStateInfo = async () => {
      if (!stateCode) {
        setLoading(false);
        return;
      }

      const { data, error } = await supabase.functions.invoke('legal-state-banner', {
        body: { state: stateCode }
      });

      if (!error && data) {
        setStateData(data);
      }
      setLoading(false);
    };

    fetchStateInfo();
  }, [stateCode]);

  if (loading || !stateData?.state) return null;

  const { state, license } = stateData;

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'permitted': return 'bg-success/10 text-success border-success/20';
      case 'regulated': return 'bg-primary/10 text-primary border-primary/20';
      case 'restricted': return 'bg-warning/10 text-warning border-warning/20';
      case 'banned': return 'bg-destructive/10 text-destructive border-destructive/20';
      default: return 'bg-muted text-muted-foreground border-border';
    }
  };

  return (
    <Alert className="border-2">
      <Shield className="h-4 w-4" />
      <AlertDescription>
        <div className="space-y-3">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold">{state.state_name} ({state.state_code})</span>
            <Badge className={getStatusColor(state.status)}>
              {state.status.charAt(0).toUpperCase() + state.status.slice(1)}
            </Badge>
          </div>
          
          <div className="text-sm space-y-1">
            <p>• Minimum age: {state.min_age} years</p>
            {state.requires_skill_predominance && (
              <p>• Skill-based contests with fixed prizes</p>
            )}
            {state.notes && (
              <p className="text-muted-foreground italic">• {state.notes}</p>
            )}
          </div>

          {license && (
            <div className="bg-muted/50 p-3 rounded-md text-sm">
              <p className="font-semibold mb-1">Licensed Operator</p>
              <p>License: {license.license_number}</p>
              {license.renewal_link && (
                <a 
                  href={license.renewal_link} 
                  target="_blank" 
                  rel="noopener noreferrer"
                  className="text-primary hover:underline inline-flex items-center gap-1 mt-1"
                >
                  View License Details <ExternalLink className="h-3 w-3" />
                </a>
              )}
            </div>
          )}
        </div>
      </AlertDescription>
    </Alert>
  );
};
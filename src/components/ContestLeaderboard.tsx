// All money values must route through src/lib/formatCurrency.ts. Direct division by 100 in JSX is a bug.
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { formatCents } from "@/lib/formatCurrency";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Trophy, Medal, Award } from "lucide-react";
import { ContestScore } from "@/types/contest";

interface ContestLeaderboardProps {
  instanceId: string;
  autoRefresh?: boolean;
}

export const ContestLeaderboard = ({ instanceId, autoRefresh = false }: ContestLeaderboardProps) => {
  const [entries, setEntries] = useState<ContestScore[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<string>('open');

  const loadLeaderboard = async () => {
    try {
      // Get pool status
      const { data: pool } = await supabase
        .from('contest_pools')
        .select('status')
        .eq('id', instanceId)
        .single();

      if (pool) {
        setStatus(pool.status);
      }

      // Get scores with user profiles
      const { data, error } = await supabase
        .from('contest_scores')
        .select(`
          *,
          profiles!contest_scores_user_id_fkey (username)
        `)
        .eq('pool_id', instanceId)
        .order('rank', { ascending: true });

      if (error) {
        console.error('Error loading leaderboard:', error);
        return;
      }

      setEntries(data as unknown as ContestScore[] || []);
    } catch (error) {
      console.error('Error loading leaderboard:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadLeaderboard();

    let interval: ReturnType<typeof setInterval> | undefined;
    if (autoRefresh && status !== 'completed') {
      interval = setInterval(() => {
        loadLeaderboard();
      }, 30000);
    }

    return () => {
      if (interval) clearInterval(interval);
    };
  }, [instanceId, autoRefresh, status]);

  const getRankIcon = (rank: number) => {
    switch (rank) {
      case 1:
        return <Trophy className="h-5 w-5 text-yellow-500" />;
      case 2:
        return <Medal className="h-5 w-5 text-gray-400" />;
      case 3:
        return <Award className="h-5 w-5 text-amber-600" />;
      default:
        return null;
    }
  };

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Leaderboard</CardTitle>
          <CardDescription>Loading standings...</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex justify-center py-8">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>Leaderboard</CardTitle>
            <CardDescription>
              {status === 'completed' || status === 'settled' ? 'Final Standings' : 'Current Standings'}
              {autoRefresh && status !== 'completed' && status !== 'settled' && (
                <span className="ml-2 text-xs">(Updates every 30s)</span>
              )}
            </CardDescription>
          </div>
          {(status === 'completed' || status === 'settled') && (
            <Badge variant="outline" className="bg-green-50 text-green-700 border-green-200">
              Final
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {entries.length === 0 ? (
          <p className="text-center text-muted-foreground py-8">No entries yet</p>
        ) : (
          <div className="space-y-2">
            {entries.map((entry) => (
              <div
                key={entry.id}
                className={`flex items-center justify-between p-4 rounded-lg border ${
                  entry.is_winner
                    ? 'bg-accent/10 border-accent'
                    : 'bg-card hover:bg-muted/50'
                }`}
              >
                <div className="flex items-center gap-4 flex-1">
                  <div className="flex items-center justify-center w-10">
                    {getRankIcon(entry.rank)}
                    {!getRankIcon(entry.rank) && (
                      <span className="text-lg font-semibold text-muted-foreground">
                        #{entry.rank}
                      </span>
                    )}
                  </div>

                  <div className="flex-1">
                    <div className="font-semibold">
                      @{entry.profiles?.username || 'Anonymous'}
                    </div>
                    <div className="text-sm text-muted-foreground">
                      {entry.total_points} points
                      {entry.margin_bonus > 0 && (
                        <span className="ml-2 text-xs text-muted-foreground">
                          (margin error: {entry.margin_bonus.toFixed(1)}s)
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                {entry.is_winner && entry.payout_cents > 0 && (
                  <div className="text-right">
                    <Badge variant="default" className="bg-green-600 hover:bg-green-700">
                      Winner
                    </Badge>
                    <div className="text-sm font-semibold text-green-600 mt-1">
                      {formatCents(entry.payout_cents)}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {status !== 'completed' && status !== 'settled' && entries.length > 0 && (
          <p className="text-xs text-center text-muted-foreground mt-4">
            Final rankings will be determined after race results are posted
          </p>
        )}
      </CardContent>
    </Card>
  );
};

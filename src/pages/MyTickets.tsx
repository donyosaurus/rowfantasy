import { useEffect, useState, useMemo } from "react";
import { Link, useParams, useNavigate } from "react-router-dom";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { formatDistanceToNow } from "date-fns";
import { ArrowLeft, MessageSquare, Send } from "lucide-react";

interface Ticket {
  id: string;
  subject: string;
  topic: string;
  status: string;
  created_at: string;
  last_reply_at: string | null;
  last_reply_by: string | null;
  user_last_viewed_at: string | null;
  message: string;
  email: string;
}

interface Reply {
  id: string;
  ticket_id: string;
  author_role: 'user' | 'admin' | 'system';
  body: string;
  created_at: string;
}

const STATUS_STYLE: Record<string, string> = {
  open: 'bg-blue-500/15 text-blue-500 border-blue-500/30',
  in_progress: 'bg-purple-500/15 text-purple-500 border-purple-500/30',
  waiting: 'bg-amber-500/15 text-amber-500 border-amber-500/30',
  resolved: 'bg-emerald-500/15 text-emerald-500 border-emerald-500/30',
  closed: 'bg-muted text-muted-foreground border-border',
};

function isUnread(t: Ticket): boolean {
  if (t.last_reply_by !== 'admin' || !t.last_reply_at) return false;
  if (!t.user_last_viewed_at) return true;
  return new Date(t.last_reply_at) > new Date(t.user_last_viewed_at);
}

export default function MyTickets() {
  const { user, loading: authLoading } = useAuth();
  const { id: routeTicketId } = useParams<{ id?: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();

  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(routeTicketId ?? null);
  const [replies, setReplies] = useState<Reply[]>([]);
  const [replyBody, setReplyBody] = useState("");
  const [sending, setSending] = useState(false);
  const [threadLoading, setThreadLoading] = useState(false);

  useEffect(() => {
    if (!authLoading && !user) navigate('/login');
  }, [user, authLoading, navigate]);

  useEffect(() => {
    if (!user) return;
    (async () => {
      setLoading(true);
      const { data, error } = await supabase
        .from('support_tickets')
        .select('id, subject, topic, status, created_at, last_reply_at, last_reply_by, user_last_viewed_at, message, email')
        .eq('user_id', user.id)
        .order('last_reply_at', { ascending: false, nullsFirst: false })
        .order('created_at', { ascending: false });
      if (!error) setTickets((data as Ticket[]) ?? []);
      setLoading(false);
    })();
  }, [user]);

  useEffect(() => { setSelectedId(routeTicketId ?? null); }, [routeTicketId]);

  const selected = useMemo(() => tickets.find(t => t.id === selectedId) ?? null, [tickets, selectedId]);

  useEffect(() => {
    if (!selectedId || !user) { setReplies([]); return; }
    (async () => {
      setThreadLoading(true);
      const { data } = await supabase
        .from('support_ticket_replies')
        .select('id, ticket_id, author_role, body, created_at')
        .eq('ticket_id', selectedId)
        .order('created_at', { ascending: true });
      setReplies((data as Reply[]) ?? []);
      setThreadLoading(false);

      // Mark as viewed
      const now = new Date().toISOString();
      await supabase.from('support_tickets')
        .update({ user_last_viewed_at: now })
        .eq('id', selectedId);
      setTickets(prev => prev.map(t => t.id === selectedId ? { ...t, user_last_viewed_at: now } : t));
    })();
  }, [selectedId, user]);

  async function submitReply() {
    if (!selectedId || replyBody.trim().length < 1) return;
    setSending(true);
    try {
      const { data, error } = await supabase.functions.invoke('support-ticket-reply', {
        body: { ticket_id: selectedId, body: replyBody.trim() },
      });
      if (error || !(data as any)?.success) {
        throw new Error((data as any)?.error || error?.message || 'Failed to send reply');
      }
      setReplyBody("");
      // Refetch thread + list
      const { data: rows } = await supabase
        .from('support_ticket_replies')
        .select('id, ticket_id, author_role, body, created_at')
        .eq('ticket_id', selectedId)
        .order('created_at', { ascending: true });
      setReplies((rows as Reply[]) ?? []);
      const { data: t } = await supabase
        .from('support_tickets')
        .select('id, subject, topic, status, created_at, last_reply_at, last_reply_by, user_last_viewed_at, message, email')
        .eq('id', selectedId).maybeSingle();
      if (t) setTickets(prev => prev.map(x => x.id === selectedId ? (t as Ticket) : x));
      toast({ title: 'Reply sent' });
    } catch (e: any) {
      toast({ title: 'Failed to send reply', description: e.message, variant: 'destructive' });
    } finally {
      setSending(false);
    }
  }

  if (authLoading) return null;

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <Header />
      <main className="flex-1 container mx-auto px-4 py-6 max-w-6xl">
        <Breadcrumbs items={[{ label: 'Support', path: '/support/help-center' }, { label: 'My Tickets' }]} />
        <div className="flex items-center justify-between mt-4 mb-6">
          <div>
            <h1 className="text-2xl font-heading font-bold">My Support Tickets</h1>
            <p className="text-sm text-muted-foreground">Track and reply to your support requests.</p>
          </div>
          <Link to="/support/contact"><Button variant="outline" size="sm">New ticket</Button></Link>
        </div>

        {loading ? (
          <div className="text-muted-foreground text-sm">Loading…</div>
        ) : tickets.length === 0 ? (
          <Card><CardContent className="py-12 text-center">
            <MessageSquare className="h-10 w-10 mx-auto mb-3 text-muted-foreground" />
            <p className="text-sm text-muted-foreground mb-4">You haven't submitted any tickets yet.</p>
            <Link to="/support/contact"><Button>Contact support</Button></Link>
          </CardContent></Card>
        ) : selected ? (
          <div className="space-y-4">
            <Button variant="ghost" size="sm" onClick={() => { setSelectedId(null); navigate('/my-tickets'); }}>
              <ArrowLeft className="h-4 w-4 mr-1" /> Back to all tickets
            </Button>
            <Card>
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <CardTitle className="text-lg">{selected.subject}</CardTitle>
                    <p className="text-xs text-muted-foreground mt-1">
                      Ticket #{selected.id.slice(0,8)} · opened {formatDistanceToNow(new Date(selected.created_at), { addSuffix: true })}
                    </p>
                  </div>
                  <Badge variant="outline" className={STATUS_STYLE[selected.status]}>
                    {selected.status.replace('_',' ')}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                <MessageBubble role="user" body={selected.message} at={selected.created_at} label="You" />
                {threadLoading ? (
                  <div className="text-xs text-muted-foreground">Loading messages…</div>
                ) : replies.map(r => (
                  <MessageBubble key={r.id} role={r.author_role} body={r.body} at={r.created_at} label={r.author_role === 'admin' ? 'RowFantasy Support' : 'You'} />
                ))}

                {selected.status === 'closed' ? (
                  <div className="text-xs text-muted-foreground text-center pt-4 border-t">
                    This ticket is closed. <Link to="/support/contact" className="text-primary hover:underline">Open a new one</Link> if you need more help.
                  </div>
                ) : (
                  <div className="pt-4 border-t space-y-2">
                    <Textarea
                      placeholder="Write a reply…"
                      value={replyBody}
                      onChange={(e) => setReplyBody(e.target.value)}
                      rows={4}
                      maxLength={5000}
                    />
                    <div className="flex items-center justify-between">
                      <p className="text-xs text-muted-foreground">{replyBody.length}/5000</p>
                      <Button onClick={submitReply} disabled={sending || replyBody.trim().length < 1}>
                        <Send className="h-4 w-4 mr-2" />
                        {sending ? 'Sending…' : 'Send reply'}
                      </Button>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        ) : (
          <div className="grid gap-2">
            {tickets.map(t => (
              <button
                key={t.id}
                onClick={() => { setSelectedId(t.id); navigate(`/my-tickets/${t.id}`); }}
                className="text-left w-full"
              >
                <Card className="hover:border-primary/50 transition-colors">
                  <CardContent className="py-3 px-4">
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          {isUnread(t) && <span className="h-2 w-2 rounded-full bg-primary flex-shrink-0" aria-label="New reply" />}
                          <span className={`text-sm font-medium truncate ${isUnread(t) ? 'text-foreground' : 'text-foreground/90'}`}>
                            {t.subject}
                          </span>
                        </div>
                        <div className="text-xs text-muted-foreground mt-1 flex items-center gap-2">
                          <span className="uppercase tracking-wide">{t.topic}</span>
                          <span>·</span>
                          <span>#{t.id.slice(0,8)}</span>
                          <span>·</span>
                          <span>{formatDistanceToNow(new Date(t.last_reply_at ?? t.created_at), { addSuffix: true })}</span>
                        </div>
                      </div>
                      <Badge variant="outline" className={STATUS_STYLE[t.status]}>
                        {t.status.replace('_',' ')}
                      </Badge>
                    </div>
                  </CardContent>
                </Card>
              </button>
            ))}
          </div>
        )}
      </main>
      <Footer />
    </div>
  );
}

function MessageBubble({ role, body, at, label }: { role: string; body: string; at: string; label: string }) {
  const isUser = role === 'user';
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[85%] rounded-2xl px-4 py-3 ${isUser ? 'bg-primary text-primary-foreground' : 'bg-muted text-foreground'}`}>
        <div className={`text-xs font-semibold mb-1 ${isUser ? 'text-primary-foreground/80' : 'text-muted-foreground'}`}>{label}</div>
        <div className="text-sm whitespace-pre-wrap break-words">{body}</div>
        <div className={`text-[10px] mt-1.5 ${isUser ? 'text-primary-foreground/60' : 'text-muted-foreground'}`}>
          {formatDistanceToNow(new Date(at), { addSuffix: true })}
        </div>
      </div>
    </div>
  );
}

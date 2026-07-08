import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { formatDistanceToNow } from "date-fns";
import { Send, RefreshCw } from "lucide-react";

interface Ticket {
  id: string;
  user_id: string | null;
  email: string;
  topic: string;
  subject: string;
  message: string;
  status: string;
  priority: string;
  created_at: string;
  last_reply_at: string | null;
  last_reply_by: string | null;
  admin_last_viewed_at: string | null;
}

interface Reply {
  id: string;
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

const STATUSES = ['open','in_progress','waiting','resolved','closed'] as const;

export default function AdminSupportInbox() {
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterStatus, setFilterStatus] = useState<string>('open');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [replies, setReplies] = useState<Reply[]>([]);
  const [replyBody, setReplyBody] = useState('');
  const [sending, setSending] = useState(false);
  const { toast } = useToast();

  async function loadTickets() {
    setLoading(true);
    const { data } = await supabase
      .from('support_tickets')
      .select('id, user_id, email, topic, subject, message, status, priority, created_at, last_reply_at, last_reply_by, admin_last_viewed_at')
      .order('last_reply_at', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })
      .limit(200);
    setTickets((data as Ticket[]) ?? []);
    setLoading(false);
  }

  useEffect(() => { loadTickets(); }, []);

  // Handle deep link ?ticket=<id>
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const t = p.get('ticket');
    if (t) setSelectedId(t);
  }, []);

  const filtered = useMemo(() => {
    return tickets.filter(t => {
      if (filterStatus !== 'all' && t.status !== filterStatus) return false;
      if (query) {
        const q = query.toLowerCase();
        if (!t.subject.toLowerCase().includes(q) && !t.email.toLowerCase().includes(q)) return false;
      }
      return true;
    });
  }, [tickets, filterStatus, query]);

  const selected = useMemo(() => tickets.find(t => t.id === selectedId) ?? null, [tickets, selectedId]);

  useEffect(() => {
    if (!selectedId) { setReplies([]); return; }
    (async () => {
      const { data } = await supabase
        .from('support_ticket_replies')
        .select('id, author_role, body, created_at')
        .eq('ticket_id', selectedId)
        .order('created_at', { ascending: true });
      setReplies((data as Reply[]) ?? []);
      await supabase.from('support_tickets')
        .update({ admin_last_viewed_at: new Date().toISOString() })
        .eq('id', selectedId);
    })();
  }, [selectedId]);

  async function sendReply() {
    if (!selectedId || replyBody.trim().length < 1) return;
    setSending(true);
    try {
      const { data, error } = await supabase.functions.invoke('support-ticket-reply', {
        body: { ticket_id: selectedId, body: replyBody.trim() },
      });
      if (error || !(data as any)?.success) throw new Error((data as any)?.error || error?.message);
      setReplyBody('');
      const { data: rows } = await supabase
        .from('support_ticket_replies')
        .select('id, author_role, body, created_at')
        .eq('ticket_id', selectedId)
        .order('created_at', { ascending: true });
      setReplies((rows as Reply[]) ?? []);
      await loadTickets();
      toast({ title: 'Reply sent' });
    } catch (e: any) {
      toast({ title: 'Failed to send', description: e.message, variant: 'destructive' });
    } finally {
      setSending(false);
    }
  }

  async function updateStatus(status: string) {
    if (!selectedId) return;
    const { error } = await supabase.from('support_tickets').update({ status }).eq('id', selectedId);
    if (error) { toast({ title: 'Failed', description: error.message, variant: 'destructive' }); return; }
    setTickets(prev => prev.map(t => t.id === selectedId ? { ...t, status } : t));
    toast({ title: `Status set to ${status.replace('_',' ')}` });
  }

  const isUnread = (t: Ticket) =>
    t.last_reply_by === 'user' && t.last_reply_at &&
    (!t.admin_last_viewed_at || new Date(t.last_reply_at) > new Date(t.admin_last_viewed_at));

  return (
    <div className="grid grid-cols-1 md:grid-cols-[340px_1fr] gap-4">
      {/* List */}
      <div className="space-y-3">
        <div className="flex gap-2">
          <Select value={filterStatus} onValueChange={setFilterStatus}>
            <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              {STATUSES.map(s => <SelectItem key={s} value={s}>{s.replace('_',' ')}</SelectItem>)}
            </SelectContent>
          </Select>
          <Button variant="outline" size="icon" onClick={loadTickets} title="Refresh"><RefreshCw className="h-4 w-4" /></Button>
        </div>
        <Input placeholder="Search subject or email…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <div className="max-h-[70vh] overflow-y-auto space-y-1.5 pr-1">
          {loading ? (
            <div className="text-sm text-muted-foreground py-4 text-center">Loading…</div>
          ) : filtered.length === 0 ? (
            <div className="text-sm text-muted-foreground py-4 text-center">No tickets.</div>
          ) : filtered.map(t => (
            <button
              key={t.id}
              onClick={() => setSelectedId(t.id)}
              className={`w-full text-left rounded-md border px-3 py-2.5 transition-colors ${
                selectedId === t.id ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/50'
              }`}
            >
              <div className="flex items-center gap-2 mb-0.5">
                {isUnread(t) && <span className="h-2 w-2 rounded-full bg-primary flex-shrink-0" />}
                <span className="text-sm font-medium truncate flex-1">{t.subject}</span>
                <Badge variant="outline" className={`${STATUS_STYLE[t.status]} text-[10px]`}>{t.status.replace('_',' ')}</Badge>
              </div>
              <div className="text-xs text-muted-foreground truncate">{t.email}</div>
              <div className="text-[10px] text-muted-foreground mt-0.5">
                {t.topic} · {formatDistanceToNow(new Date(t.last_reply_at ?? t.created_at), { addSuffix: true })}
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Thread */}
      <Card className="min-h-[60vh]">
        <CardContent className="p-4">
          {!selected ? (
            <div className="text-sm text-muted-foreground py-16 text-center">Select a ticket to view the conversation.</div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-start justify-between gap-3 border-b pb-3">
                <div className="min-w-0">
                  <h3 className="font-semibold text-lg truncate">{selected.subject}</h3>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {selected.email} · #{selected.id.slice(0,8)} · {selected.topic} · opened {formatDistanceToNow(new Date(selected.created_at), { addSuffix: true })}
                  </p>
                </div>
                <Select value={selected.status} onValueChange={updateStatus}>
                  <SelectTrigger className="w-[150px]"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {STATUSES.map(s => <SelectItem key={s} value={s}>{s.replace('_',' ')}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2 max-h-[45vh] overflow-y-auto pr-1">
                <Bubble role="user" label={selected.email} body={selected.message} at={selected.created_at} />
                {replies.map(r => (
                  <Bubble key={r.id} role={r.author_role} label={r.author_role === 'admin' ? 'Support' : selected.email} body={r.body} at={r.created_at} />
                ))}
              </div>

              <div className="pt-3 border-t space-y-2">
                <Textarea
                  placeholder="Write a reply to the user…"
                  value={replyBody}
                  onChange={(e) => setReplyBody(e.target.value)}
                  rows={4}
                  maxLength={5000}
                />
                <div className="flex items-center justify-between">
                  <p className="text-xs text-muted-foreground">{replyBody.length}/5000</p>
                  <Button onClick={sendReply} disabled={sending || replyBody.trim().length < 1}>
                    <Send className="h-4 w-4 mr-2" />
                    {sending ? 'Sending…' : 'Send reply'}
                  </Button>
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Bubble({ role, label, body, at }: { role: string; label: string; body: string; at: string }) {
  const isAdmin = role === 'admin';
  return (
    <div className={`flex ${isAdmin ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[85%] rounded-2xl px-4 py-2.5 ${isAdmin ? 'bg-primary text-primary-foreground' : 'bg-muted text-foreground'}`}>
        <div className={`text-[10px] font-semibold mb-1 ${isAdmin ? 'text-primary-foreground/80' : 'text-muted-foreground'}`}>{label}</div>
        <div className="text-sm whitespace-pre-wrap break-words">{body}</div>
        <div className={`text-[10px] mt-1 ${isAdmin ? 'text-primary-foreground/60' : 'text-muted-foreground'}`}>
          {formatDistanceToNow(new Date(at), { addSuffix: true })}
        </div>
      </div>
    </div>
  );
}

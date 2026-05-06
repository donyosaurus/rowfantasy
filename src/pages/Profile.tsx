// All money values must route through src/lib/formatCurrency.ts. Direct division by 100 in JSX is a bug.
import { useEffect, useState } from "react";
import { DraftPageBackground } from "@/components/DraftPageBackground";
import { formatCents, formatDollars } from "@/lib/formatCurrency";
import { useNavigate } from "react-router-dom";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { DollarSign, TrendingUp, Trophy, User, Edit2, ArrowUpDown, Loader2, ArrowDownCircle, ArrowUpCircle, CreditCard, Gift, RefreshCw, Wallet, Target, BarChart3 } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

interface ProfileData {
  profile: {
    id: string;
    email: string;
    username: string;
    fullName: string | null;
    dateOfBirth: string | null;
    state: string | null;
    usernameLastChangedAt: string | null;
    kycStatus: string;
    isActive: boolean;
    selfExclusionUntil: string | null;
    depositLimitMonthly: number;
  };
  wallet: {
    availableBalance: number;
    pendingBalance: number;
    lifetimeDeposits: number;
    lifetimeWithdrawals: number;
    lifetimeWinnings: number;
  };
  stats: {
    contestsPlayed: number;
    winRate: number;
    totalWinnings: number;
    netProfit: number;
    bestFinish: number | null;
    recentForm: string;
  };
}

interface Transaction {
  id: string;
  type: string;
  amount: number;
  status: string;
  created_at: string;
  description: string;
  reference_id: string | null;
  state_code: string | null;
}


const Profile = () => {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [profileData, setProfileData] = useState<ProfileData | null>(null);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  
  const [loading, setLoading] = useState(true);
  
  const [usernameDialogOpen, setUsernameDialogOpen] = useState(false);
  const [depositDialogOpen, setDepositDialogOpen] = useState(false);
  const [withdrawDialogOpen, setWithdrawDialogOpen] = useState(false);
  
  const [newUsername, setNewUsername] = useState("");
  const [depositAmount, setDepositAmount] = useState("");
  const [withdrawAmount, setWithdrawAmount] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  
  const [txTypeFilter, setTxTypeFilter] = useState("all");
  const [txPage, setTxPage] = useState(1);
  const [txTotal, setTxTotal] = useState(0);

  useEffect(() => {
    if (!user) { navigate("/login"); return; }
    fetchProfileData();
    fetchTransactions();
  }, [user, navigate, txTypeFilter, txPage]);

  const fetchProfileData = async () => {
    try {
      const { data, error } = await supabase.functions.invoke('profile-overview');
      if (error) throw error;
      setProfileData(data);
      setNewUsername(data.profile.username || "");
    } catch (error: any) {
      console.error('Error fetching profile:', error);
      toast.error('Failed to load profile data');
    }
  };

  const fetchTransactions = async () => {
    try {
      const { data, error } = await supabase.functions.invoke('wallet-transactions', {
        body: { page: txPage, limit: 25, type: txTypeFilter !== 'all' ? txTypeFilter : undefined }
      });
      if (error) throw error;
      setTransactions(data.transactions || []);
      setTxTotal(data.total || 0);
    } catch (error: any) {
      console.error('Error fetching transactions:', error);
    } finally {
      setLoading(false);
    }
  };


  const handleUsernameChange = async () => {
    if (!newUsername || !profileData) return;
    setIsSubmitting(true);
    try {
      const { data, error } = await supabase.functions.invoke('profile-username', {
        body: { new_username: newUsername }
      });
      if (error) { toast.error(error.message || 'Failed to update username'); return; }
      if (data.error) {
        toast.error(data.error);
        if (data.nextChangeAvailable) toast.info(`Next change available: ${new Date(data.nextChangeAvailable).toLocaleDateString()}`);
        return;
      }
      toast.success('Username updated successfully!');
      setUsernameDialogOpen(false);
      fetchProfileData();
    } catch { toast.error('Failed to update username'); }
    finally { setIsSubmitting(false); }
  };

  const handleDeposit = async () => {
    const amount = parseFloat(depositAmount);
    if (!amount || amount < 5 || amount > 500) { toast.error('Deposit amount must be between $5 and $500'); return; }
    setIsSubmitting(true);
    try {
      const { data, error } = await supabase.functions.invoke('wallet-deposit', {
        body: { amount: Math.floor(amount * 100) }
      });
      if (error) { toast.error(error.message || 'Failed to process deposit'); return; }
      if (data.error) { toast.error(data.error); return; }
      toast.success(`Deposit successful! New balance: ${data.balanceDisplay}`);
      setDepositDialogOpen(false);
      setDepositAmount("");
      fetchProfileData();
      fetchTransactions();
    } catch { toast.error('Failed to process deposit'); }
    finally { setIsSubmitting(false); }
  };

  const handleWithdraw = async () => {
    const amount = parseFloat(withdrawAmount);
    if (!amount || amount < 5 || amount > 200) { toast.error('Withdrawal amount must be between $5 and $200'); return; }
    if (!profileData || profileData.wallet.availableBalance < amount) { toast.error('Insufficient balance'); return; }
    setIsSubmitting(true);
    try {
      const { data, error } = await supabase.functions.invoke('wallet-withdraw-request', {
        body: { amount_cents: Math.floor(amount * 100) }
      });
      if (error) { toast.error(error.message || 'Failed to request withdrawal'); return; }
      if (data.error) { toast.error(data.error); return; }
      toast.success('Withdrawal request submitted');
      setWithdrawDialogOpen(false);
      setWithdrawAmount("");
      fetchProfileData();
      fetchTransactions();
    } catch { toast.error('Failed to request withdrawal'); }
    finally { setIsSubmitting(false); }
  };

  const canWithdraw = () => {
    if (!profileData) return false;
    return profileData.profile.isActive && !profileData.profile.selfExclusionUntil && profileData.wallet.availableBalance >= 5;
  };

  const canChangeUsername = () => {
    if (!profileData?.profile.usernameLastChangedAt) return true;
    const lastChanged = new Date(profileData.profile.usernameLastChangedAt);
    const ninetyDaysAgo = new Date();
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
    return lastChanged <= ninetyDaysAgo;
  };

  const getNextChangeDate = () => {
    if (!profileData?.profile.usernameLastChangedAt) return null;
    const lastChanged = new Date(profileData.profile.usernameLastChangedAt);
    const nextChange = new Date(lastChanged);
    nextChange.setDate(nextChange.getDate() + 90);
    return nextChange.toLocaleDateString();
  };

  const getTxAccentColor = (type: string) => {
    switch (type) {
      case 'deposit': case 'payout': case 'refund': case 'entry_fee_release': case 'bonus':
        return 'border-l-success';
      case 'entry_fee': case 'entry_fee_hold': case 'withdrawal':
        return 'border-l-destructive';
      default:
        return 'border-l-muted-foreground';
    }
  };

  if (loading || !profileData) {
    return (
      <div className="flex flex-col min-h-screen relative">
        <DraftPageBackground />
        <Header />
        <main className="flex-1 py-12 relative z-10">
          <div className="container mx-auto px-4 max-w-6xl space-y-6">
            <Skeleton className="h-10 w-48" />
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              <div className="space-y-6">
                <Skeleton className="h-64 w-full rounded-xl" />
                <Skeleton className="h-48 w-full rounded-xl" />
              </div>
              <div className="lg:col-span-2">
                <Skeleton className="h-96 w-full rounded-xl" />
              </div>
            </div>
          </div>
        </main>
        <Footer />
      </div>
    );
  }

  return (
    <div className="flex flex-col min-h-screen relative">
      <DraftPageBackground />
      <Header />
      
      {/* Profile Hero */}
      <section className="gradient-hero py-10 relative overflow-hidden z-10">
        <div className="absolute inset-0 opacity-10">
          <div className="absolute top-5 right-20 w-64 h-64 rounded-full bg-accent blur-3xl" />
        </div>
        <div className="container mx-auto px-4 max-w-6xl relative z-10">
          <div className="flex items-center gap-5">
            <div className="w-20 h-20 rounded-full bg-accent/20 border-4 border-white/20 flex items-center justify-center shadow-xl">
              <User className="h-10 w-10 text-accent" />
            </div>
            <div>
              <div className="flex items-center gap-3 mb-1">
                <h1 className="text-3xl font-heading font-extrabold text-white">{profileData.profile.username}</h1>
                <Button 
                  variant="ghost" size="sm" className="h-7 w-7 p-0 text-white/60 hover:text-white hover:bg-white/10"
                  onClick={() => setUsernameDialogOpen(true)}
                  disabled={!canChangeUsername()}
                >
                  <Edit2 className="h-3.5 w-3.5" />
                </Button>
              </div>
              <p className="text-white/60 text-sm">{profileData.profile.email}</p>
              {profileData.profile.state && (
                <Badge variant="outline" className="mt-2 border-white/20 text-white/70">{profileData.profile.state}</Badge>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* Stats bar */}
      <div className="border-b border-white/10 relative z-10">
        <div className="container mx-auto px-4 max-w-6xl">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 py-5 -mt-1">
            {[
              { icon: Trophy, label: "Contests", value: profileData.stats.contestsPlayed },
              { icon: Target, label: "Win Rate", value: `${profileData.stats.winRate.toFixed(1)}%` },
              { icon: DollarSign, label: "Total Won", value: `$${profileData.stats.totalWinnings.toFixed(2)}`, highlight: true },
              { icon: BarChart3, label: "Net P/L", value: `$${profileData.stats.netProfit.toFixed(2)}`, highlight: profileData.stats.netProfit > 0 },
            ].map((stat, i) => (
              <Card key={i} className="rounded-xl shadow-sm card-hover">
                <CardContent className="p-4 flex items-center gap-3">
                  <div className={`p-2.5 rounded-xl ${stat.highlight ? 'bg-success/10' : 'bg-muted'}`}>
                    <stat.icon className={`h-5 w-5 ${stat.highlight ? 'text-success' : 'text-muted-foreground'}`} />
                  </div>
                  <div>
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{stat.label}</p>
                    <p className={`text-lg font-heading font-bold ${stat.highlight ? 'text-success' : ''}`}>{stat.value}</p>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      </div>

      <main className="flex-1 py-8 relative z-10">
        <div className="container mx-auto px-4 max-w-6xl">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Sidebar - Wallet */}
            <div className="space-y-6">
              <Card className="rounded-xl shadow-md overflow-hidden">
                <div className="h-1 gradient-accent" />
                <CardHeader className="pb-3">
                  <CardTitle className="flex items-center gap-2 font-heading">
                    <Wallet className="h-5 w-5 text-accent" />
                    Wallet
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-5">
                  <div>
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1">Available Balance</p>
                    <div className="flex items-center gap-2">
                      <DollarSign className="h-6 w-6 text-success" />
                      <p className="text-4xl font-heading font-extrabold text-success">
                        {/* profile-overview returns wallet fields already converted to dollars */}
                        {formatDollars(profileData.wallet.availableBalance).replace('$', '')}
                      </p>
                    </div>
                  </div>
                  {profileData.wallet.pendingBalance > 0 && (
                    <div className="px-3 py-2 rounded-lg bg-muted">
                      <p className="text-xs text-muted-foreground">Pending</p>
                      <p className="text-lg font-semibold">{formatDollars(profileData.wallet.pendingBalance)}</p>
                    </div>
                  )}
                  <div className="space-y-2">
                    <Button variant="hero" className="w-full rounded-xl" onClick={() => setDepositDialogOpen(true)} disabled={!profileData.profile.isActive}>
                      Deposit Funds
                    </Button>
                    <Button variant="outline" className="w-full rounded-xl border-2" onClick={() => setWithdrawDialogOpen(true)} disabled={!canWithdraw()}>
                      Withdraw
                    </Button>
                    {!canWithdraw() && profileData.wallet.availableBalance < 5 && (
                      <p className="text-xs text-muted-foreground text-center">Minimum $5 to withdraw</p>
                    )}
                  </div>
                  
                  {/* Lifetime stats */}
                  <div className="pt-4 border-t space-y-2">
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground">Lifetime Deposits</span>
                      <span className="font-medium">{formatDollars(profileData.wallet.lifetimeDeposits)}</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground">Lifetime Winnings</span>
                      <span className="font-medium text-success">{formatDollars(profileData.wallet.lifetimeWinnings)}</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground">Lifetime Withdrawals</span>
                      <span className="font-medium">{formatDollars(profileData.wallet.lifetimeWithdrawals)}</span>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>

            {/* Main Content */}
            <div className="lg:col-span-2">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-xl font-heading font-bold">Transactions</h2>
                <Select value={txTypeFilter} onValueChange={setTxTypeFilter}>
                  <SelectTrigger className="w-[180px] rounded-xl">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Types</SelectItem>
                    <SelectItem value="deposit">Deposits</SelectItem>
                    <SelectItem value="withdrawal">Withdrawals</SelectItem>
                    <SelectItem value="payout">Winnings</SelectItem>
                    <SelectItem value="entry_fee">Entry Fees</SelectItem>
                    <SelectItem value="refund">Refunds</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-3">
                {transactions.length === 0 ? (
                  <Card className="rounded-xl">
                    <CardContent className="py-12 text-center">
                      <p className="text-muted-foreground">No transactions yet</p>
                    </CardContent>
                  </Card>
                ) : (
                  transactions.map((tx) => {
                    const getTxDisplay = (type: string) => {
                      switch (type) {
                        case 'deposit': return { icon: ArrowDownCircle, label: 'Deposit' };
                        case 'withdrawal': return { icon: ArrowUpCircle, label: 'Withdrawal' };
                        case 'payout': return { icon: Trophy, label: 'Winnings' };
                        case 'entry_fee': return { icon: CreditCard, label: 'Entry Fee' };
                        case 'entry_fee_hold': return { icon: CreditCard, label: 'Entry Fee Hold' };
                        case 'entry_fee_release': return { icon: RefreshCw, label: 'Entry Refund' };
                        case 'refund': return { icon: RefreshCw, label: 'Refund' };
                        case 'bonus': return { icon: Gift, label: 'Bonus' };
                        default: return { icon: ArrowUpDown, label: type.replace(/_/g, ' ') };
                      }
                    };
                    const txDisplay = getTxDisplay(tx.type);
                    const TxIcon = txDisplay.icon;
                    const isPositive = tx.amount > 0;

                    return (
                      <Card key={tx.id} className={`rounded-xl overflow-hidden card-hover border-l-4 ${getTxAccentColor(tx.type)}`}>
                        <CardContent className="p-4">
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-3">
                              <div className={`p-2 rounded-xl ${isPositive ? 'bg-success/10' : 'bg-muted'}`}>
                                <TxIcon className={`h-4 w-4 ${isPositive ? 'text-success' : 'text-muted-foreground'}`} />
                              </div>
                              <div>
                                <p className="font-semibold capitalize">{txDisplay.label}</p>
                                <p className="text-xs text-muted-foreground">
                                  {new Date(tx.created_at).toLocaleDateString()} {new Date(tx.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                </p>
                              </div>
                            </div>
                            <div className="text-right">
                              <p className={`font-heading font-bold text-lg ${isPositive ? 'text-success' : ''}`}>
                                {/* transactions.amount is bigint cents per DB convention */}
                                {isPositive ? '+' : '-'}{formatCents(Math.abs(Number(tx.amount)))}
                              </p>
                              <Badge 
                                variant="outline"
                                className={`text-xs mt-1 ${
                                  tx.status === 'completed' ? 'bg-success/10 text-success border-success/30' :
                                  tx.status === 'pending' ? 'bg-gold/10 text-gold border-gold/30' : ''
                                }`}
                              >
                                {tx.status}
                              </Badge>
                            </div>
                          </div>
                        </CardContent>
                      </Card>
                    );
                  })
                )}
              </div>
              {txTotal > 25 && (
                <div className="flex items-center justify-center gap-2 mt-6">
                  <Button variant="outline" size="sm" onClick={() => setTxPage(p => Math.max(1, p - 1))} disabled={txPage === 1}>Previous</Button>
                  <span className="text-sm text-muted-foreground">Page {txPage} of {Math.ceil(txTotal / 25)}</span>
                  <Button variant="outline" size="sm" onClick={() => setTxPage(p => p + 1)} disabled={txPage >= Math.ceil(txTotal / 25)}>Next</Button>
                </div>
              )}
            </div>
          </div>
        </div>
      </main>

      {/* Username Dialog */}
      <Dialog open={usernameDialogOpen} onOpenChange={setUsernameDialogOpen}>
        <DialogContent className="rounded-2xl">
          <DialogHeader>
            <DialogTitle className="font-heading">Change Username</DialogTitle>
            <DialogDescription>
              {canChangeUsername() ? "You can change your username once every 90 days." : `You can change your username again on ${getNextChangeDate()}`}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">New Username</label>
              <Input value={newUsername} onChange={(e) => setNewUsername(e.target.value.toLowerCase())} placeholder="Enter new username" disabled={isSubmitting || !canChangeUsername()} className="rounded-xl" />
              <p className="text-xs text-muted-foreground">3-20 characters, lowercase letters, numbers, and underscores only</p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setUsernameDialogOpen(false)} disabled={isSubmitting} className="rounded-xl">Cancel</Button>
            <Button onClick={handleUsernameChange} disabled={isSubmitting || !newUsername || !canChangeUsername()} className="rounded-xl">
              {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : "Update Username"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Deposit Dialog */}
      <Dialog open={depositDialogOpen} onOpenChange={setDepositDialogOpen}>
        <DialogContent className="rounded-2xl">
          <DialogHeader>
            <DialogTitle className="font-heading">Deposit Funds</DialogTitle>
            <DialogDescription>Add funds to your wallet. Minimum $5, maximum $500 per transaction.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="grid grid-cols-3 gap-2">
              {[10, 25, 50, 100, 200, 500].map((amount) => (
                <Button key={amount} variant={depositAmount === String(amount) ? "default" : "outline"} onClick={() => setDepositAmount(String(amount))} disabled={isSubmitting} className="rounded-xl">
                  ${amount}
                </Button>
              ))}
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Or enter custom amount (USD)</label>
              <Input type="number" value={depositAmount} onChange={(e) => setDepositAmount(e.target.value)} placeholder="0.00" min="5" max="500" step="1" disabled={isSubmitting} className="rounded-xl" />
            </div>
            {profileData.profile.depositLimitMonthly && (
              <p className="text-xs text-muted-foreground">Monthly deposit limit: ${profileData.profile.depositLimitMonthly.toFixed(2)}</p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDepositDialogOpen(false)} disabled={isSubmitting} className="rounded-xl">Cancel</Button>
            <Button onClick={handleDeposit} disabled={isSubmitting || !depositAmount} className="rounded-xl">
              {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              Deposit ${depositAmount || '0'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Withdraw Dialog */}
      <Dialog open={withdrawDialogOpen} onOpenChange={setWithdrawDialogOpen}>
        <DialogContent className="rounded-2xl">
          <DialogHeader>
            <DialogTitle className="font-heading">Withdraw Funds</DialogTitle>
            <DialogDescription>Withdraw funds from your wallet. Minimum $5, maximum $200 per transaction. Daily limit: $500.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">Amount (USD)</label>
              <Input type="number" value={withdrawAmount} onChange={(e) => setWithdrawAmount(e.target.value)} placeholder="0.00" min="5" max="200" step="0.01" disabled={isSubmitting} className="rounded-xl" />
              <p className="text-xs text-muted-foreground">Available: ${profileData.wallet.availableBalance.toFixed(2)}</p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setWithdrawDialogOpen(false)} disabled={isSubmitting} className="rounded-xl">Cancel</Button>
            <Button onClick={handleWithdraw} disabled={isSubmitting || !withdrawAmount} className="rounded-xl">
              {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : "Request Withdrawal"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Footer />
    </div>
  );
};

export default Profile;

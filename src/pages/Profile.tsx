import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DollarSign, TrendingUp, Trophy, User, Edit2, ArrowUpDown, Loader2, ArrowDownCircle, ArrowUpCircle, CreditCard, Gift, RefreshCw } from "lucide-react";
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

interface Contest {
  id: string;
  contestTemplateId: string;
  regattaName: string;
  genderCategory: string;
  tierId: string;
  poolId: string;
  entryFeeCents: number;
  lockTime: string;
  status: string;
  rank: number | null;
  totalPoints: number | null;
  payoutCents: number | null;
  createdAt: string;
  poolStatus: string;
}

const Profile = () => {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [profileData, setProfileData] = useState<ProfileData | null>(null);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [contests, setContests] = useState<Contest[]>([]);
  const [loading, setLoading] = useState(true);
  
  // Dialogs
  const [usernameDialogOpen, setUsernameDialogOpen] = useState(false);
  const [depositDialogOpen, setDepositDialogOpen] = useState(false);
  const [withdrawDialogOpen, setWithdrawDialogOpen] = useState(false);
  
  // Forms
  const [newUsername, setNewUsername] = useState("");
  const [depositAmount, setDepositAmount] = useState("");
  const [withdrawAmount, setWithdrawAmount] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  
  // Filters
  const [txTypeFilter, setTxTypeFilter] = useState("all");
  const [txPage, setTxPage] = useState(1);
  const [contestPage, setContestPage] = useState(1);
  const [txTotal, setTxTotal] = useState(0);
  const [contestTotal, setContestTotal] = useState(0);

  useEffect(() => {
    if (!user) {
      navigate("/login");
      return;
    }

    fetchProfileData();
    fetchTransactions();
    fetchContests();
  }, [user, navigate, txTypeFilter, txPage, contestPage]);

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
      const params = new URLSearchParams({
        page: txPage.toString(),
        limit: '25',
      });
      
      if (txTypeFilter !== 'all') {
        params.append('type', txTypeFilter);
      }

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

  const fetchContests = async () => {
    try {
      const { data, error } = await supabase.functions.invoke('profile-contests', {
        body: { page: contestPage, limit: 20 }
      });
      
      if (error) throw error;
      
      setContests(data.contests || []);
      setContestTotal(data.total || 0);
    } catch (error: any) {
      console.error('Error fetching contests:', error);
    }
  };

  const handleUsernameChange = async () => {
    if (!newUsername || !profileData) return;

    setIsSubmitting(true);
    try {
      const { data, error } = await supabase.functions.invoke('profile-username', {
        body: { new_username: newUsername }
      });

      if (error) {
        toast.error(error.message || 'Failed to update username');
        return;
      }

      if (data.error) {
        toast.error(data.error);
        if (data.nextChangeAvailable) {
          toast.info(`Next change available: ${new Date(data.nextChangeAvailable).toLocaleDateString()}`);
        }
        return;
      }

      toast.success('Username updated successfully!');
      setUsernameDialogOpen(false);
      fetchProfileData();
    } catch (error: any) {
      toast.error('Failed to update username');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDeposit = async () => {
    const amount = parseFloat(depositAmount);
    if (!amount || amount < 5 || amount > 500) {
      toast.error('Deposit amount must be between $5 and $500');
      return;
    }

    setIsSubmitting(true);
    try {
      // Use wallet-deposit directly with mock adapter (amount in cents)
      const { data, error } = await supabase.functions.invoke('wallet-deposit', {
        body: { amount: Math.floor(amount * 100) }
      });

      if (error) {
        toast.error(error.message || 'Failed to process deposit');
        return;
      }

      if (data.error) {
        toast.error(data.error);
        return;
      }

      toast.success(`Deposit successful! New balance: ${data.balanceDisplay}`);
      setDepositDialogOpen(false);
      setDepositAmount("");
      fetchProfileData();
      fetchTransactions();
    } catch (error: any) {
      toast.error('Failed to process deposit');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleWithdraw = async () => {
    const amount = parseFloat(withdrawAmount);
    if (!amount || amount < 5 || amount > 200) {
      toast.error('Withdrawal amount must be between $5 and $200');
      return;
    }

    if (!profileData || profileData.wallet.availableBalance < amount) {
      toast.error('Insufficient balance');
      return;
    }

    setIsSubmitting(true);
    try {
      const { data, error } = await supabase.functions.invoke('wallet-withdraw-request', {
        body: { amount_cents: Math.floor(amount * 100) }
      });

      if (error) {
        toast.error(error.message || 'Failed to request withdrawal');
        return;
      }

      if (data.error) {
        toast.error(data.error);
        return;
      }

      toast.success('Withdrawal request submitted');
      setWithdrawDialogOpen(false);
      setWithdrawAmount("");
      fetchProfileData();
      fetchTransactions();
    } catch (error: any) {
      toast.error('Failed to request withdrawal');
    } finally {
      setIsSubmitting(false);
    }
  };

  const canWithdraw = () => {
    if (!profileData) return false;
    return profileData.profile.isActive && 
           !profileData.profile.selfExclusionUntil &&
           profileData.wallet.availableBalance >= 5;
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

  if (loading || !profileData) {
    return (
      <div className="flex flex-col min-h-screen">
        <Header />
        <main className="flex-1 gradient-subtle py-12">
          <div className="container mx-auto px-4 max-w-6xl">
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
            </div>
          </div>
        </main>
        <Footer />
      </div>
    );
  }

  return (
    <div className="flex flex-col min-h-screen">
      <Header />
      
      <main className="flex-1 gradient-subtle py-12">
        <div className="container mx-auto px-4 max-w-6xl">
          <h1 className="text-4xl font-bold mb-8">My Profile</h1>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
            {/* Sidebar */}
            <div className="space-y-6">
              <Card>
                <CardContent className="pt-6">
                  <div className="flex flex-col items-center text-center space-y-4">
                    <div className="w-20 h-20 rounded-full bg-accent/10 flex items-center justify-center">
                      <User className="h-10 w-10 text-accent" />
                    </div>
                    <div className="w-full">
                      <div className="flex items-center justify-center gap-2 mb-1">
                        <h2 className="text-xl font-bold">{profileData.profile.username}</h2>
                        <Button 
                          variant="ghost" 
                          size="sm" 
                          className="h-6 w-6 p-0"
                          onClick={() => setUsernameDialogOpen(true)}
                          disabled={!canChangeUsername()}
                        >
                          <Edit2 className="h-3 w-3" />
                        </Button>
                      </div>
                      <p className="text-sm text-muted-foreground">{profileData.profile.email}</p>
                      {!canChangeUsername() && (
                        <p className="text-xs text-muted-foreground mt-1">
                          Next username change: {getNextChangeDate()}
                        </p>
                      )}
                      {profileData.profile.state && (
                        <Badge variant="outline" className="mt-2">{profileData.profile.state}</Badge>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <DollarSign className="h-5 w-5 text-success" />
                    Wallet
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div>
                    <p className="text-sm text-muted-foreground">Available Balance</p>
                    <p className="text-3xl font-bold text-success">${profileData.wallet.availableBalance.toFixed(2)}</p>
                  </div>
                  {profileData.wallet.pendingBalance > 0 && (
                    <div>
                      <p className="text-sm text-muted-foreground">Pending</p>
                      <p className="text-lg font-semibold">${profileData.wallet.pendingBalance.toFixed(2)}</p>
                    </div>
                  )}
                  <div className="space-y-2">
                    <Button 
                      variant="hero" 
                      className="w-full"
                      onClick={() => setDepositDialogOpen(true)}
                      disabled={!profileData.profile.isActive}
                    >
                      Deposit Funds
                    </Button>
                    <Button 
                      variant="outline" 
                      className="w-full"
                      onClick={() => setWithdrawDialogOpen(true)}
                      disabled={!canWithdraw()}
                    >
                      Withdraw
                    </Button>
                    {!canWithdraw() && profileData.wallet.availableBalance < 5 && (
                      <p className="text-xs text-muted-foreground">Minimum $5 to withdraw</p>
                    )}
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Trophy className="h-5 w-5 text-accent" />
                    Stats
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Contests Played</span>
                    <span className="font-semibold">{profileData.stats.contestsPlayed}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Win Rate</span>
                    <span className="font-semibold">{profileData.stats.winRate.toFixed(1)}%</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Total Winnings</span>
                    <span className="font-semibold text-success">${profileData.stats.totalWinnings.toFixed(2)}</span>
                  </div>
                </CardContent>
              </Card>
            </div>

            {/* Main Content */}
            <div className="lg:col-span-2">
              <Tabs defaultValue="contests" className="w-full">
                <TabsList className="grid w-full grid-cols-2">
                  <TabsTrigger value="contests">Contest History</TabsTrigger>
                  <TabsTrigger value="transactions">Transactions</TabsTrigger>
                </TabsList>

                <TabsContent value="contests" className="mt-6">
                  <Card>
                    <CardHeader>
                      <CardTitle>Contest History</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <div className="space-y-4">
                        {contests.length === 0 ? (
                          <p className="text-center text-muted-foreground py-8">No contests yet</p>
                        ) : (
                          contests.map((contest) => (
                            <div 
                              key={contest.id}
                              className="p-4 rounded-lg border border-border hover:bg-accent/5 transition-base"
                            >
                              <div className="flex items-start justify-between mb-2">
                                <div>
                                  <p className="font-semibold">{contest.regattaName}</p>
                                  <p className="text-sm text-muted-foreground">{contest.genderCategory} • Tier: {contest.tierId}</p>
                                  <p className="text-xs text-muted-foreground">Entry: ${(contest.entryFeeCents / 100).toFixed(2)}</p>
                                </div>
                                <div className="text-right">
                                  {contest.rank ? (
                                    <Badge variant={contest.rank === 1 ? "default" : "secondary"}>
                                      Rank #{contest.rank}
                                    </Badge>
                                  ) : (
                                    <Badge variant="outline">Pending</Badge>
                                  )}
                                </div>
                              </div>
                              <div className="flex items-center justify-between text-sm mt-2">
                                <span className="text-muted-foreground">
                                  {new Date(contest.createdAt).toLocaleDateString()}
                                </span>
                                {contest.payoutCents && contest.payoutCents > 0 && (
                                  <span className="font-semibold text-success">
                                    +${(contest.payoutCents / 100).toFixed(2)}
                                  </span>
                                )}
                                {contest.totalPoints !== null && (
                                  <span className="text-muted-foreground">
                                    {contest.totalPoints} pts
                                  </span>
                                )}
                              </div>
                            </div>
                          ))
                        )}
                      </div>
                      {contestTotal > 20 && (
                        <div className="flex items-center justify-center gap-2 mt-4">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setContestPage(p => Math.max(1, p - 1))}
                            disabled={contestPage === 1}
                          >
                            Previous
                          </Button>
                          <span className="text-sm text-muted-foreground">
                            Page {contestPage} of {Math.ceil(contestTotal / 20)}
                          </span>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setContestPage(p => p + 1)}
                            disabled={contestPage >= Math.ceil(contestTotal / 20)}
                          >
                            Next
                          </Button>
                        </div>
                      )}
                    </CardContent>
                  </Card>
                </TabsContent>

                <TabsContent value="transactions" className="mt-6">
                  <Card>
                    <CardHeader>
                      <div className="flex items-center justify-between">
                        <CardTitle>Transaction History</CardTitle>
                        <Select value={txTypeFilter} onValueChange={setTxTypeFilter}>
                          <SelectTrigger className="w-[180px]">
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
                    </CardHeader>
                    <CardContent>
                      <div className="space-y-4">
                        {transactions.length === 0 ? (
                          <p className="text-center text-muted-foreground py-8">No transactions yet</p>
                        ) : (
                          transactions.map((tx) => {
                            // Get transaction display info based on type
                            const getTxDisplay = (type: string) => {
                              switch (type) {
                                case 'deposit':
                                  return { icon: ArrowDownCircle, label: 'Deposit', color: 'text-success' };
                                case 'withdrawal':
                                  return { icon: ArrowUpCircle, label: 'Withdrawal', color: 'text-foreground' };
                                case 'payout':
                                  return { icon: Trophy, label: 'Winnings', color: 'text-accent' };
                                case 'entry_fee':
                                  return { icon: CreditCard, label: 'Entry Fee', color: 'text-foreground' };
                                case 'entry_fee_hold':
                                  return { icon: CreditCard, label: 'Entry Fee Hold', color: 'text-muted-foreground' };
                                case 'entry_fee_release':
                                  return { icon: RefreshCw, label: 'Entry Refund', color: 'text-success' };
                                case 'refund':
                                  return { icon: RefreshCw, label: 'Refund', color: 'text-success' };
                                case 'bonus':
                                  return { icon: Gift, label: 'Bonus', color: 'text-accent' };
                                default:
                                  return { icon: ArrowUpDown, label: type.replace(/_/g, ' '), color: 'text-foreground' };
                              }
                            };

                            const txDisplay = getTxDisplay(tx.type);
                            const TxIcon = txDisplay.icon;
                            const isPositive = tx.amount > 0;

                            return (
                              <div 
                                key={tx.id}
                                className="p-4 rounded-lg border border-border hover:bg-accent/5 transition-base"
                              >
                                <div className="flex items-center justify-between">
                                  <div className="flex items-center gap-3">
                                    <div className={`p-2 rounded-full bg-muted ${txDisplay.color}`}>
                                      <TxIcon className="h-4 w-4" />
                                    </div>
                                    <div>
                                      <p className="font-semibold capitalize">{txDisplay.label}</p>
                                      <p className="text-sm text-muted-foreground">
                                        {new Date(tx.created_at).toLocaleDateString()} {new Date(tx.created_at).toLocaleTimeString()}
                                      </p>
                                      {tx.description && (
                                        <p className="text-xs text-muted-foreground mt-1">{tx.description}</p>
                                      )}
                                    </div>
                                  </div>
                                  <div className="text-right">
                                    <p className={`font-semibold text-lg ${
                                      isPositive ? 'text-success' : 'text-foreground'
                                    }`}>
                                      {isPositive ? '+' : ''}${(Math.abs(tx.amount) / 100).toFixed(2)}
                                    </p>
                                    <Badge 
                                      variant={tx.status === 'completed' ? 'default' : tx.status === 'pending' ? 'secondary' : 'outline'}
                                      className="text-xs mt-1"
                                    >
                                      {tx.status}
                                    </Badge>
                                  </div>
                                </div>
                              </div>
                            );
                          })
                        )}
                      </div>
                      {txTotal > 25 && (
                        <div className="flex items-center justify-center gap-2 mt-4">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setTxPage(p => Math.max(1, p - 1))}
                            disabled={txPage === 1}
                          >
                            Previous
                          </Button>
                          <span className="text-sm text-muted-foreground">
                            Page {txPage} of {Math.ceil(txTotal / 25)}
                          </span>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setTxPage(p => p + 1)}
                            disabled={txPage >= Math.ceil(txTotal / 25)}
                          >
                            Next
                          </Button>
                        </div>
                      )}
                    </CardContent>
                  </Card>
                </TabsContent>
              </Tabs>
            </div>
          </div>
        </div>
      </main>

      {/* Username Dialog */}
      <Dialog open={usernameDialogOpen} onOpenChange={setUsernameDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Change Username</DialogTitle>
            <DialogDescription>
              {canChangeUsername() 
                ? "You can change your username once every 90 days."
                : `You can change your username again on ${getNextChangeDate()}`
              }
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">New Username</label>
              <Input
                value={newUsername}
                onChange={(e) => setNewUsername(e.target.value.toLowerCase())}
                placeholder="Enter new username"
                disabled={isSubmitting || !canChangeUsername()}
              />
              <p className="text-xs text-muted-foreground">
                3-20 characters, lowercase letters, numbers, and underscores only
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setUsernameDialogOpen(false)}
              disabled={isSubmitting}
            >
              Cancel
            </Button>
            <Button
              onClick={handleUsernameChange}
              disabled={isSubmitting || !newUsername || !canChangeUsername()}
            >
              {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : "Update Username"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Deposit Dialog */}
      <Dialog open={depositDialogOpen} onOpenChange={setDepositDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Deposit Funds</DialogTitle>
            <DialogDescription>
              Add funds to your wallet. Minimum $5, maximum $500 per transaction.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="grid grid-cols-3 gap-2">
              {[10, 25, 50, 100, 200, 500].map((amount) => (
                <Button
                  key={amount}
                  variant={depositAmount === String(amount) ? "default" : "outline"}
                  onClick={() => setDepositAmount(String(amount))}
                  disabled={isSubmitting}
                >
                  ${amount}
                </Button>
              ))}
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Or enter custom amount (USD)</label>
              <Input
                type="number"
                value={depositAmount}
                onChange={(e) => setDepositAmount(e.target.value)}
                placeholder="0.00"
                min="5"
                max="500"
                step="1"
                disabled={isSubmitting}
              />
            </div>
            {profileData.profile.depositLimitMonthly && (
              <p className="text-xs text-muted-foreground">
                Monthly deposit limit: ${profileData.profile.depositLimitMonthly.toFixed(2)}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDepositDialogOpen(false)}
              disabled={isSubmitting}
            >
              Cancel
            </Button>
            <Button
              onClick={handleDeposit}
              disabled={isSubmitting || !depositAmount}
            >
              {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              Deposit ${depositAmount || '0'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Withdraw Dialog */}
      <Dialog open={withdrawDialogOpen} onOpenChange={setWithdrawDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Withdraw Funds</DialogTitle>
            <DialogDescription>
              Withdraw funds from your wallet. Minimum $5, maximum $200 per transaction.
              Daily limit: $500. Processing time: 1-3 business days.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">Amount (USD)</label>
              <Input
                type="number"
                value={withdrawAmount}
                onChange={(e) => setWithdrawAmount(e.target.value)}
                placeholder="0.00"
                min="5"
                max="200"
                step="0.01"
                disabled={isSubmitting}
              />
              <p className="text-xs text-muted-foreground">
                Available: ${profileData.wallet.availableBalance.toFixed(2)}
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setWithdrawDialogOpen(false)}
              disabled={isSubmitting}
            >
              Cancel
            </Button>
            <Button
              onClick={handleWithdraw}
              disabled={isSubmitting || !withdrawAmount}
            >
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

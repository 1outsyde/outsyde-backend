import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { TrendingUp, DollarSign, Users, Megaphone, BarChart3, Share2, ExternalLink, Loader2, CheckCircle2, Copy, Link2, AlertCircle, Settings, Wallet } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import type { User } from "@shared/schema";

interface InfluencerProfile {
  id: string;
  userId: string;
  displayName: string | null;
  bio: string | null;
  promoCode: string;
  commissionRateBps: number;
  status: string;
  stripeAccountId: string | null;
  stripeOnboardingComplete: boolean | null;
  profileImage: string | null;
  totalEarningsCents: number;
  totalReferrals: number;
}

interface EarningsData {
  pendingCents: number;
  readyForPayoutCents: number;
  totalPaidCents: number;
  totalEarnedCents: number;
}

interface DashboardData {
  profile: InfluencerProfile;
  earnings: EarningsData;
  referrals: {
    total: number;
    recent: any[];
  };
  campaigns: {
    active: number;
    total: number;
  };
  payouts: {
    total: number;
    recent: any[];
  };
}

interface StripeOnboardingStatus {
  accountType: string;
  hasStripeAccount: boolean;
  onboardingComplete: boolean;
  payoutsEnabled?: boolean;
  chargesEnabled?: boolean;
  detailsSubmitted?: boolean;
}

interface InfluencerDashboardPageProps {
  onLogout: () => void;
}

export default function InfluencerDashboardPage({ onLogout }: InfluencerDashboardPageProps) {
  const { toast } = useToast();
  const [activeTab, setActiveTab] = useState("overview");
  const [editProfileDialogOpen, setEditProfileDialogOpen] = useState(false);
  const [profileDisplayName, setProfileDisplayName] = useState("");
  const [profileBio, setProfileBio] = useState("");

  const { data: user } = useQuery<User | null>({
    queryKey: ["/api/auth/user"],
  });

  const { data: dashboardData, isLoading: dashboardLoading } = useQuery<DashboardData>({
    queryKey: ["/api/influencer/dashboard"],
    enabled: !!user?.isInfluencer,
  });

  const { data: stripeStatus, isLoading: stripeLoading } = useQuery<StripeOnboardingStatus>({
    queryKey: ["/api/vendor/stripe-onboarding/status"],
    enabled: !!user?.isInfluencer,
  });

  const { data: campaignsData } = useQuery<{ campaigns: any[] }>({
    queryKey: ["/api/influencer/campaigns"],
    enabled: !!user?.isInfluencer && activeTab === "campaigns",
  });

  const { data: referralsData } = useQuery<{ referrals: any[] }>({
    queryKey: ["/api/influencer/referrals"],
    enabled: !!user?.isInfluencer && activeTab === "referrals",
  });

  const { data: earningsData } = useQuery<{ earnings: any[] }>({
    queryKey: ["/api/influencer/earnings"],
    enabled: !!user?.isInfluencer && activeTab === "earnings",
  });

  const { data: payoutsData } = useQuery<{ payouts: any[] }>({
    queryKey: ["/api/influencer/payouts"],
    enabled: !!user?.isInfluencer && activeTab === "payouts",
  });

  const startOnboardingMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/vendor/stripe-onboarding/create-link");
      return response.json();
    },
    onSuccess: (data: { url: string }) => {
      window.location.href = data.url;
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to start Stripe onboarding.", variant: "destructive" });
    },
  });

  const updateProfileMutation = useMutation({
    mutationFn: async (data: { displayName?: string; bio?: string }) => {
      const response = await apiRequest("PATCH", "/api/influencer/profile", data);
      return response.json();
    },
    onSuccess: () => {
      toast({ title: "Profile Updated", description: "Your profile has been updated." });
      queryClient.invalidateQueries({ queryKey: ["/api/influencer/dashboard"] });
      setEditProfileDialogOpen(false);
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to update profile.", variant: "destructive" });
    },
  });

  const formatCurrency = (cents: number) => {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
    }).format(cents / 100);
  };

  const copyPromoCode = () => {
    if (dashboardData?.profile?.promoCode) {
      navigator.clipboard.writeText(dashboardData.profile.promoCode);
      toast({ title: "Copied!", description: "Promo code copied to clipboard." });
    }
  };

  const copyReferralLink = () => {
    if (dashboardData?.profile?.promoCode) {
      const baseUrl = window.location.origin;
      const referralLink = `${baseUrl}?ref=${dashboardData.profile.promoCode}`;
      navigator.clipboard.writeText(referralLink);
      toast({ title: "Copied!", description: "Referral link copied to clipboard." });
    }
  };

  const openEditProfile = () => {
    if (dashboardData?.profile) {
      setProfileDisplayName(dashboardData.profile.displayName || "");
      setProfileBio(dashboardData.profile.bio || "");
      setEditProfileDialogOpen(true);
    }
  };

  if (!user?.isInfluencer) {
    return (
      <div className="container mx-auto px-4 py-8" data-testid="influencer-access-denied">
        <Card className="max-w-md mx-auto">
          <CardContent className="pt-6 text-center">
            <AlertCircle className="mx-auto h-12 w-12 text-muted-foreground mb-4" />
            <h2 className="text-xl font-semibold mb-2">Access Denied</h2>
            <p className="text-muted-foreground mb-4">You are not registered as an influencer.</p>
            <Button asChild>
              <a href="/profile">Apply to become an influencer</a>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (dashboardLoading) {
    return (
      <div className="container mx-auto px-4 py-8 flex items-center justify-center" data-testid="influencer-dashboard-loading">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-8" data-testid="influencer-dashboard">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-8">
        <div className="flex items-center gap-4">
          <Avatar className="h-16 w-16">
            <AvatarImage src={dashboardData?.profile?.profileImage || user?.profileImageUrl || ""} />
            <AvatarFallback className="bg-primary text-primary-foreground text-xl">
              {(dashboardData?.profile?.displayName || user?.firstName || "I")[0]}
            </AvatarFallback>
          </Avatar>
          <div>
            <h1 className="text-2xl font-bold" data-testid="text-influencer-name">
              {dashboardData?.profile?.displayName || `${user?.firstName || ""} ${user?.lastName || ""}`.trim() || "Influencer"}
            </h1>
            <Badge variant="secondary" className="mt-1" data-testid="badge-influencer-status">
              <TrendingUp className="h-3 w-3 mr-1" />
              Influencer
            </Badge>
          </div>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={openEditProfile} data-testid="button-edit-profile">
            <Settings className="h-4 w-4 mr-2" />
            Edit Profile
          </Button>
          <Button variant="outline" onClick={onLogout} data-testid="button-logout">
            Logout
          </Button>
        </div>
      </div>

      {!stripeStatus?.onboardingComplete && (
        <Card className="mb-6 border-primary/20 bg-primary/5" data-testid="stripe-onboarding-banner">
          <CardContent className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4 pt-6">
            <div>
              <h3 className="font-semibold text-lg">Complete Your Payout Setup</h3>
              <p className="text-muted-foreground">
                Connect your bank account via Stripe to receive payouts for your commissions and campaign earnings.
              </p>
            </div>
            <Button 
              onClick={() => startOnboardingMutation.mutate()} 
              disabled={startOnboardingMutation.isPending}
              data-testid="button-start-stripe-onboarding"
            >
              {startOnboardingMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
              ) : (
                <ExternalLink className="h-4 w-4 mr-2" />
              )}
              Set Up Payouts
            </Button>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <Card data-testid="card-total-earnings">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2 gap-2">
            <CardTitle className="text-sm font-medium">Total Earnings</CardTitle>
            <DollarSign className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold" data-testid="text-total-earnings">
              {formatCurrency(dashboardData?.earnings?.totalEarnedCents || 0)}
            </div>
            <p className="text-xs text-muted-foreground">
              {formatCurrency(dashboardData?.earnings?.readyForPayoutCents || 0)} ready for payout
            </p>
          </CardContent>
        </Card>

        <Card data-testid="card-total-referrals">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2 gap-2">
            <CardTitle className="text-sm font-medium">Total Referrals</CardTitle>
            <Users className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold" data-testid="text-total-referrals">
              {dashboardData?.referrals?.total || 0}
            </div>
            <p className="text-xs text-muted-foreground">
              Customers referred through your link
            </p>
          </CardContent>
        </Card>

        <Card data-testid="card-active-campaigns">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2 gap-2">
            <CardTitle className="text-sm font-medium">Active Campaigns</CardTitle>
            <Megaphone className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold" data-testid="text-active-campaigns">
              {dashboardData?.campaigns?.active || 0}
            </div>
            <p className="text-xs text-muted-foreground">
              {dashboardData?.campaigns?.total || 0} total campaigns
            </p>
          </CardContent>
        </Card>

        <Card data-testid="card-commission-rate">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2 gap-2">
            <CardTitle className="text-sm font-medium">Commission Rate</CardTitle>
            <BarChart3 className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold" data-testid="text-commission-rate">
              {((dashboardData?.profile?.commissionRateBps || 500) / 100).toFixed(1)}%
            </div>
            <p className="text-xs text-muted-foreground">
              On referred sales
            </p>
          </CardContent>
        </Card>
      </div>

      <Card className="mb-8" data-testid="card-referral-tools">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Share2 className="h-5 w-5" />
            Your Referral Tools
          </CardTitle>
          <CardDescription>Share these with your audience to earn commissions on sales</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-col sm:flex-row gap-4">
            <div className="flex-1">
              <Label className="text-sm text-muted-foreground">Promo Code</Label>
              <div className="flex gap-2 mt-1">
                <Input 
                  readOnly 
                  value={dashboardData?.profile?.promoCode || ""} 
                  className="font-mono"
                  data-testid="input-promo-code"
                />
                <Button variant="outline" size="icon" onClick={copyPromoCode} data-testid="button-copy-promo-code">
                  <Copy className="h-4 w-4" />
                </Button>
              </div>
            </div>
            <div className="flex-1">
              <Label className="text-sm text-muted-foreground">Referral Link</Label>
              <div className="flex gap-2 mt-1">
                <Input 
                  readOnly 
                  value={`${window.location.origin}?ref=${dashboardData?.profile?.promoCode || ""}`}
                  className="font-mono text-sm"
                  data-testid="input-referral-link"
                />
                <Button variant="outline" size="icon" onClick={copyReferralLink} data-testid="button-copy-referral-link">
                  <Link2 className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="mb-6">
          <TabsTrigger value="overview" data-testid="tab-overview">Overview</TabsTrigger>
          <TabsTrigger value="campaigns" data-testid="tab-campaigns">Campaigns</TabsTrigger>
          <TabsTrigger value="referrals" data-testid="tab-referrals">Referrals</TabsTrigger>
          <TabsTrigger value="earnings" data-testid="tab-earnings">Earnings</TabsTrigger>
          <TabsTrigger value="payouts" data-testid="tab-payouts">Payouts</TabsTrigger>
        </TabsList>

        <TabsContent value="overview">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <Card data-testid="card-recent-referrals">
              <CardHeader>
                <CardTitle className="text-lg">Recent Referrals</CardTitle>
              </CardHeader>
              <CardContent>
                {dashboardData?.referrals?.recent?.length ? (
                  <div className="space-y-3">
                    {dashboardData.referrals.recent.slice(0, 5).map((referral: any, i: number) => (
                      <div key={i} className="flex justify-between items-center py-2 border-b last:border-0">
                        <div>
                          <p className="font-medium">{referral.eventType}</p>
                          <p className="text-sm text-muted-foreground">
                            {new Date(referral.createdAt).toLocaleDateString()}
                          </p>
                        </div>
                        <Badge variant="secondary">{formatCurrency(referral.orderAmountCents || 0)}</Badge>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-muted-foreground text-center py-8">No referrals yet. Share your link to get started!</p>
                )}
              </CardContent>
            </Card>

            <Card data-testid="card-recent-payouts">
              <CardHeader>
                <CardTitle className="text-lg">Recent Payouts</CardTitle>
              </CardHeader>
              <CardContent>
                {dashboardData?.payouts?.recent?.length ? (
                  <div className="space-y-3">
                    {dashboardData.payouts.recent.map((payout: any, i: number) => (
                      <div key={i} className="flex justify-between items-center py-2 border-b last:border-0">
                        <div>
                          <p className="font-medium">{formatCurrency(payout.amountCents)}</p>
                          <p className="text-sm text-muted-foreground">
                            {new Date(payout.initiatedAt).toLocaleDateString()}
                          </p>
                        </div>
                        <Badge variant={payout.status === "completed" ? "default" : "secondary"}>
                          {payout.status === "completed" && <CheckCircle2 className="h-3 w-3 mr-1" />}
                          {payout.status}
                        </Badge>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-muted-foreground text-center py-8">No payouts yet.</p>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="campaigns">
          <Card>
            <CardHeader>
              <CardTitle>Your Campaigns</CardTitle>
              <CardDescription>Campaigns you're participating in</CardDescription>
            </CardHeader>
            <CardContent>
              {campaignsData?.campaigns?.length ? (
                <div className="space-y-4">
                  {campaignsData.campaigns.map((assignment: any) => (
                    <div key={assignment.id} className="flex justify-between items-center p-4 border rounded-lg" data-testid={`campaign-${assignment.id}`}>
                      <div>
                        <h4 className="font-semibold">{assignment.campaign?.name || "Campaign"}</h4>
                        <p className="text-sm text-muted-foreground">{assignment.campaign?.description}</p>
                        <p className="text-sm mt-1">
                          Payout: <span className="font-medium">{formatCurrency(assignment.campaign?.payoutAmountCents || 0)}</span>
                        </p>
                      </div>
                      <Badge variant={assignment.status === "completed" ? "default" : "secondary"}>
                        {assignment.status}
                      </Badge>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-muted-foreground text-center py-8">No campaigns assigned yet.</p>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="referrals">
          <Card>
            <CardHeader>
              <CardTitle>Referral History</CardTitle>
              <CardDescription>All sales made through your referral link</CardDescription>
            </CardHeader>
            <CardContent>
              {referralsData?.referrals?.length ? (
                <div className="space-y-3">
                  {referralsData.referrals.map((referral: any, i: number) => (
                    <div key={i} className="flex justify-between items-center py-3 border-b last:border-0" data-testid={`referral-${i}`}>
                      <div>
                        <p className="font-medium">{referral.eventType}</p>
                        <p className="text-sm text-muted-foreground">
                          {new Date(referral.createdAt).toLocaleString()}
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="font-medium">{formatCurrency(referral.orderAmountCents || 0)}</p>
                        <p className="text-sm text-muted-foreground">
                          Commission: {formatCurrency(referral.commissionCents || 0)}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-muted-foreground text-center py-8">No referrals yet.</p>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="earnings">
          <Card>
            <CardHeader>
              <CardTitle>Earnings Ledger</CardTitle>
              <CardDescription>All your earnings from referrals and campaigns</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-3 gap-4 mb-6">
                <div className="text-center p-4 bg-muted rounded-lg">
                  <p className="text-sm text-muted-foreground">Pending</p>
                  <p className="text-xl font-bold">{formatCurrency(dashboardData?.earnings?.pendingCents || 0)}</p>
                </div>
                <div className="text-center p-4 bg-muted rounded-lg">
                  <p className="text-sm text-muted-foreground">Ready for Payout</p>
                  <p className="text-xl font-bold text-primary">{formatCurrency(dashboardData?.earnings?.readyForPayoutCents || 0)}</p>
                </div>
                <div className="text-center p-4 bg-muted rounded-lg">
                  <p className="text-sm text-muted-foreground">Total Paid</p>
                  <p className="text-xl font-bold text-green-600">{formatCurrency(dashboardData?.earnings?.totalPaidCents || 0)}</p>
                </div>
              </div>
              
              {earningsData?.earnings?.length ? (
                <div className="space-y-3">
                  {earningsData.earnings.map((earning: any, i: number) => (
                    <div key={i} className="flex justify-between items-center py-3 border-b last:border-0" data-testid={`earning-${i}`}>
                      <div>
                        <p className="font-medium">{earning.description || earning.sourceType}</p>
                        <p className="text-sm text-muted-foreground">
                          {new Date(earning.createdAt).toLocaleString()}
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="font-medium">{formatCurrency(earning.amountCents)}</p>
                        <Badge variant={
                          earning.status === "paid" ? "default" : 
                          earning.status === "ready_for_payout" ? "secondary" : "outline"
                        }>
                          {earning.status}
                        </Badge>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-muted-foreground text-center py-8">No earnings yet.</p>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="payouts">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Wallet className="h-5 w-5" />
                Payout History
              </CardTitle>
              <CardDescription>All payouts sent to your bank account</CardDescription>
            </CardHeader>
            <CardContent>
              {payoutsData?.payouts?.length ? (
                <div className="space-y-3">
                  {payoutsData.payouts.map((payout: any, i: number) => (
                    <div key={i} className="flex justify-between items-center py-3 border-b last:border-0" data-testid={`payout-${i}`}>
                      <div>
                        <p className="font-medium">{formatCurrency(payout.amountCents)}</p>
                        <p className="text-sm text-muted-foreground">
                          {new Date(payout.initiatedAt).toLocaleString()}
                        </p>
                      </div>
                      <div className="text-right">
                        <Badge variant={payout.status === "completed" ? "default" : "secondary"}>
                          {payout.status === "completed" && <CheckCircle2 className="h-3 w-3 mr-1" />}
                          {payout.status}
                        </Badge>
                        {payout.stripeTransferId && (
                          <p className="text-xs text-muted-foreground mt-1 font-mono">
                            {payout.stripeTransferId.substring(0, 15)}...
                          </p>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-muted-foreground text-center py-8">No payouts yet.</p>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <Dialog open={editProfileDialogOpen} onOpenChange={setEditProfileDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Influencer Profile</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div>
              <Label htmlFor="displayName">Display Name</Label>
              <Input
                id="displayName"
                value={profileDisplayName}
                onChange={(e) => setProfileDisplayName(e.target.value)}
                placeholder="Your display name"
                data-testid="input-edit-display-name"
              />
            </div>
            <div>
              <Label htmlFor="bio">Bio</Label>
              <Textarea
                id="bio"
                value={profileBio}
                onChange={(e) => setProfileBio(e.target.value)}
                placeholder="Tell your audience about yourself..."
                rows={4}
                data-testid="input-edit-bio"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditProfileDialogOpen(false)}>
              Cancel
            </Button>
            <Button 
              onClick={() => updateProfileMutation.mutate({ displayName: profileDisplayName, bio: profileBio })}
              disabled={updateProfileMutation.isPending}
              data-testid="button-save-profile"
            >
              {updateProfileMutation.isPending && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
              Save Changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

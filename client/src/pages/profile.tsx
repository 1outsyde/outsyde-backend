import { useState } from "react";
import { User, Settings, Heart, Calendar, ShoppingBag, LogOut, ChevronRight, Coins, ShieldCheck, Package, TrendingUp, Loader2, CheckCircle2, Clock, XCircle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import LoyaltyPointsCard from "@/components/LoyaltyPointsCard";
import PointsHistory from "@/components/PointsHistory";
import ReferralCard from "@/components/ReferralCard";
import PushNotificationSettings from "@/components/PushNotificationSettings";
import BillingAddressForm from "@/components/BillingAddressForm";
import OrderTrackingCard from "@/components/OrderTrackingCard";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/skeleton";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

interface BillingAddress {
  line1: string;
  line2?: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
}

interface CustomerShipment {
  id: string;
  carrier: string;
  trackingNumber: string;
  status: string;
  shippedAt: string;
  deliveredAt: string | null;
  estimatedDelivery: string | null;
}

interface CustomerOrder {
  id: string;
  businessId: string;
  businessName: string;
  items: string;
  total: number;
  status: string;
  createdAt: string;
  shipment: CustomerShipment | null;
}

interface ProfileUser {
  id: string;
  email: string;
  name: string;
  city?: string;
  state?: string;
  isVendor: boolean;
  isPhotographer?: boolean;
  isInfluencer?: boolean;
  isAdmin?: boolean;
  createdAt?: string;
  billingAddress?: BillingAddress | null;
}

interface InfluencerApplication {
  id: string;
  userId: string;
  status: "pending" | "approved" | "rejected";
  instagramUrl: string | null;
  tiktokUrl: string | null;
  youtubeUrl: string | null;
  twitterUrl: string | null;
  followerCount: number | null;
  contentNiche: string | null;
  whyInfluencer: string | null;
  adminNotes: string | null;
  createdAt: string;
}

interface ProfilePageProps {
  onLogout: () => void;
  onAdminDashboard?: () => void;
}

export default function ProfilePage({ onLogout, onAdminDashboard }: ProfilePageProps) {
  const [activeSection, setActiveSection] = useState<"overview" | "bookings" | "orders" | "favorites" | "points">("overview");

  const { data: userData, isLoading: userLoading } = useQuery<ProfileUser>({
    queryKey: ["/api/auth/user"],
  });

  const isPhotographer = userData?.isPhotographer ?? false;
  const isVendor = userData?.isVendor ?? false;
  const isInfluencer = userData?.isInfluencer ?? false;
  const isAdmin = userData?.isAdmin ?? false;
  
  // Only regular customers (not photographers or business owners) can see/earn points
  const isRegularCustomer = !isPhotographer && !isVendor;
  
  // Influencer application state
  const [showInfluencerForm, setShowInfluencerForm] = useState(false);
  const [influencerFormData, setInfluencerFormData] = useState({
    instagramUrl: "",
    tiktokUrl: "",
    youtubeUrl: "",
    twitterUrl: "",
    followerCount: "",
    contentNiche: "",
    whyInfluencer: "",
  });
  const { toast } = useToast();
  
  // Fetch existing influencer application
  const { data: existingApplication, isLoading: applicationLoading } = useQuery<{ application: InfluencerApplication | null }>({
    queryKey: ["/api/influencer/application"],
    enabled: !isInfluencer,
  });
  
  // Submit influencer application mutation
  const submitApplicationMutation = useMutation({
    mutationFn: async (data: typeof influencerFormData) => {
      return apiRequest("POST", "/api/influencer/apply", data);
    },
    onSuccess: () => {
      toast({
        title: "Application Submitted",
        description: "Your influencer application has been submitted for review. We'll notify you once it's reviewed.",
      });
      setShowInfluencerForm(false);
      queryClient.invalidateQueries({ queryKey: ["/api/influencer/application"] });
    },
    onError: (error: Error) => {
      toast({
        title: "Error",
        description: error.message || "Failed to submit application. Please try again.",
        variant: "destructive",
      });
    },
  });

  const user = userData ? {
    name: userData.name || "User",
    email: userData.email || "",
    location: userData.city && userData.state ? `${userData.city}, ${userData.state}` : "Location not set",
    memberSince: userData.createdAt ? new Date(userData.createdAt).toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) : "2024",
  } : null;

  // todo: remove mock functionality
  const recentBookings = [
    {
      id: "1",
      businessName: "Bella's Hair Studio",
      service: "Full Hair Styling",
      date: "Dec 1, 2024",
      time: "2:00 PM",
      status: "confirmed",
    },
    {
      id: "2",
      businessName: "Zen Yoga Studio",
      service: "Beginner Yoga Class",
      date: "Dec 3, 2024",
      time: "10:00 AM",
      status: "confirmed",
    },
  ];

  // Fetch customer orders with tracking info
  const { data: ordersData, isLoading: ordersLoading } = useQuery<{ orders: CustomerOrder[] }>({
    queryKey: ["/api/my-orders"],
    enabled: activeSection === "orders" || activeSection === "overview",
  });

  const menuItems = [
    { id: "overview", icon: User, label: "Overview" },
    ...(isRegularCustomer ? [{ id: "points", icon: Coins, label: "My Points" }] : []),
    { id: "bookings", icon: Calendar, label: "My Bookings" },
    { id: "orders", icon: ShoppingBag, label: "My Orders" },
    { id: "favorites", icon: Heart, label: "Favorites" },
  ];

  if (userLoading) {
    return (
      <div className="min-h-screen pb-20 md:pb-0" data-testid="page-profile-loading">
        <div className="max-w-4xl mx-auto px-4 py-6">
          <Card className="overflow-visible mb-6">
            <CardContent className="p-6">
              <div className="flex flex-col sm:flex-row items-center gap-4">
                <Skeleton className="h-20 w-20 rounded-full" />
                <div className="flex-1">
                  <Skeleton className="h-8 w-40 mb-2" />
                  <Skeleton className="h-4 w-32 mb-2" />
                  <Skeleton className="h-6 w-48" />
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen pb-20 md:pb-0 flex items-center justify-center" data-testid="page-profile-not-found">
        <Card className="overflow-visible p-6 text-center">
          <p className="text-muted-foreground">Please log in to view your profile</p>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen pb-20 md:pb-0" data-testid="page-profile">
      <div className="max-w-4xl mx-auto px-4 py-6">
        <Card className="overflow-visible mb-6">
          <CardContent className="p-6">
            <div className="flex flex-col sm:flex-row items-center gap-4">
              <Avatar className="h-20 w-20">
                <AvatarImage src="" alt={user.name} />
                <AvatarFallback className="text-2xl">{user.name.charAt(0)}</AvatarFallback>
              </Avatar>
              <div className="flex-1 text-center sm:text-left">
                <h1 className="text-2xl font-bold" data-testid="text-user-name">{user.name}</h1>
                <p className="text-muted-foreground">{user.email}</p>
                <div className="flex flex-wrap items-center justify-center sm:justify-start gap-2 mt-2">
                  <Badge variant="secondary">{user.location}</Badge>
                  <Badge variant="outline">Member since {user.memberSince}</Badge>
                </div>
              </div>
              <div className="flex gap-2">
                {isAdmin && onAdminDashboard && (
                  <Button variant="default" onClick={onAdminDashboard} data-testid="button-admin-dashboard">
                    <ShieldCheck className="h-5 w-5 mr-2" />
                    Admin
                  </Button>
                )}
                <Button variant="outline" size="icon" data-testid="button-settings">
                  <Settings className="h-5 w-5" />
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        {isRegularCustomer && (
          <LoyaltyPointsCard
            onViewHistory={() => setActiveSection("points")}
          />
        )}

        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 my-6">
          {menuItems.map((item) => (
            <Button
              key={item.id}
              variant={activeSection === item.id ? "default" : "outline"}
              className="flex-col h-auto py-4"
              onClick={() => setActiveSection(item.id as typeof activeSection)}
              data-testid={`button-section-${item.id}`}
            >
              <item.icon className="h-5 w-5 mb-2" />
              <span className="text-sm">{item.label}</span>
            </Button>
          ))}
        </div>

        {activeSection === "overview" && (
          <div className="space-y-6">
            <Card className="overflow-visible">
              <CardHeader className="flex flex-row items-center justify-between gap-4">
                <CardTitle className="text-lg">Upcoming Bookings</CardTitle>
                <Button variant="ghost" size="sm" onClick={() => setActiveSection("bookings")}>
                  View All
                  <ChevronRight className="h-4 w-4 ml-1" />
                </Button>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  {recentBookings.map((booking) => (
                    <div
                      key={booking.id}
                      className="flex items-center justify-between p-3 rounded-md bg-muted/50"
                      data-testid={`booking-item-${booking.id}`}
                    >
                      <div>
                        <p className="font-medium">{booking.businessName}</p>
                        <p className="text-sm text-muted-foreground">{booking.service}</p>
                        <p className="text-xs text-muted-foreground">
                          {booking.date} at {booking.time}
                        </p>
                      </div>
                      <Badge variant="secondary">{booking.status}</Badge>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>

            <Card className="overflow-visible">
              <CardHeader className="flex flex-row items-center justify-between gap-4">
                <CardTitle className="text-lg">Recent Orders</CardTitle>
                <Button variant="ghost" size="sm" onClick={() => setActiveSection("orders")}>
                  View All
                  <ChevronRight className="h-4 w-4 ml-1" />
                </Button>
              </CardHeader>
              <CardContent>
                {ordersLoading ? (
                  <div className="space-y-3">
                    <Skeleton className="h-16 w-full" />
                    <Skeleton className="h-16 w-full" />
                  </div>
                ) : ordersData?.orders && ordersData.orders.length > 0 ? (
                  <div className="space-y-3">
                    {ordersData.orders.slice(0, 3).map((order) => (
                      <div
                        key={order.id}
                        className="flex items-center justify-between p-3 rounded-md bg-muted/50"
                        data-testid={`order-item-${order.id}`}
                      >
                        <div>
                          <p className="font-medium">{order.businessName}</p>
                          <p className="text-sm text-muted-foreground">
                            {order.items} - ${(order.total / 100).toFixed(2)}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {new Date(order.createdAt).toLocaleDateString()}
                          </p>
                        </div>
                        <Badge variant={order.status === "delivered" ? "default" : "secondary"}>
                          {order.status}
                        </Badge>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground text-center py-4">
                    No recent orders
                  </p>
                )}
              </CardContent>
            </Card>

            <PushNotificationSettings />

            <BillingAddressForm
              currentAddress={userData?.billingAddress}
              endpoint="/api/profile/billing-address"
              queryKeyToInvalidate={["/api/auth/user"]}
              title="Billing Address"
            />
            
            {/* Influencer Application Section - only show to regular customers who aren't already influencers */}
            {!isInfluencer && isRegularCustomer && (
              <Card className="overflow-visible">
                <CardHeader>
                  <div className="flex items-center gap-2">
                    <TrendingUp className="h-5 w-5 text-primary" />
                    <CardTitle className="text-lg">Become an Influencer</CardTitle>
                  </div>
                  <CardDescription>
                    Earn money by promoting Outsyde businesses and attracting new customers through your referral links.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {applicationLoading ? (
                    <div className="flex items-center gap-2">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      <span className="text-sm text-muted-foreground">Checking application status...</span>
                    </div>
                  ) : existingApplication?.application ? (
                    <div className="space-y-4">
                      {existingApplication.application.status === "pending" && (
                        <div className="flex items-start gap-3 p-4 rounded-md bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800">
                          <Clock className="h-5 w-5 text-amber-600 mt-0.5" />
                          <div>
                            <p className="font-medium text-amber-800 dark:text-amber-200">Application Under Review</p>
                            <p className="text-sm text-amber-700 dark:text-amber-300 mt-1">
                              Your influencer application was submitted on {new Date(existingApplication.application.createdAt).toLocaleDateString()}. 
                              We'll notify you once it's reviewed.
                            </p>
                          </div>
                        </div>
                      )}
                      {existingApplication.application.status === "rejected" && (
                        <div className="flex items-start gap-3 p-4 rounded-md bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800">
                          <XCircle className="h-5 w-5 text-red-600 mt-0.5" />
                          <div>
                            <p className="font-medium text-red-800 dark:text-red-200">Application Not Approved</p>
                            <p className="text-sm text-red-700 dark:text-red-300 mt-1">
                              Unfortunately, your application was not approved at this time.
                              {existingApplication.application.adminNotes && (
                                <span className="block mt-2">Feedback: {existingApplication.application.adminNotes}</span>
                              )}
                            </p>
                          </div>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="space-y-4">
                      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-center">
                        <div className="p-4 rounded-md bg-muted/50">
                          <p className="text-2xl font-bold text-primary">10%</p>
                          <p className="text-sm text-muted-foreground">Commission on referral sales</p>
                        </div>
                        <div className="p-4 rounded-md bg-muted/50">
                          <p className="text-2xl font-bold text-primary">$$$</p>
                          <p className="text-sm text-muted-foreground">Paid campaign opportunities</p>
                        </div>
                        <div className="p-4 rounded-md bg-muted/50">
                          <p className="text-2xl font-bold text-primary">Fast</p>
                          <p className="text-sm text-muted-foreground">Direct payouts via Stripe</p>
                        </div>
                      </div>
                      <Button 
                        onClick={() => setShowInfluencerForm(true)}
                        className="w-full"
                        data-testid="button-apply-influencer"
                      >
                        <TrendingUp className="h-4 w-4 mr-2" />
                        Apply to Become an Influencer
                      </Button>
                    </div>
                  )}
                </CardContent>
              </Card>
            )}
            
            {/* Influencer status badge for approved influencers */}
            {isInfluencer && (
              <Card className="overflow-visible">
                <CardHeader>
                  <div className="flex items-center justify-between gap-4">
                    <div className="flex items-center gap-2">
                      <TrendingUp className="h-5 w-5 text-primary" />
                      <CardTitle className="text-lg">Influencer Status</CardTitle>
                    </div>
                    <Badge variant="default" className="bg-green-600">
                      <CheckCircle2 className="h-3 w-3 mr-1" />
                      Active Influencer
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent>
                  <p className="text-sm text-muted-foreground mb-4">
                    You're an approved Outsyde influencer! Access your dashboard to view campaigns, track referrals, and manage payouts.
                  </p>
                  <Button 
                    onClick={() => window.location.href = "/influencer/dashboard"}
                    data-testid="button-influencer-dashboard"
                  >
                    Go to Influencer Dashboard
                  </Button>
                </CardContent>
              </Card>
            )}
          </div>
        )}

        {activeSection === "bookings" && (
          <Card className="overflow-visible">
            <CardHeader>
              <CardTitle>My Bookings</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {recentBookings.map((booking) => (
                  <div
                    key={booking.id}
                    className="flex items-center justify-between p-4 rounded-md border"
                    data-testid={`booking-detail-${booking.id}`}
                  >
                    <div>
                      <p className="font-medium">{booking.businessName}</p>
                      <p className="text-sm text-muted-foreground">{booking.service}</p>
                      <p className="text-sm">
                        {booking.date} at {booking.time}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant="secondary">{booking.status}</Badge>
                      <Button variant="outline" size="sm">
                        Reschedule
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {activeSection === "orders" && (
          <div className="space-y-4">
            <h2 className="text-2xl font-semibold">My Orders</h2>
            {ordersLoading ? (
              <div className="space-y-3">
                {[1, 2, 3].map((i) => (
                  <Card key={i} className="overflow-visible">
                    <CardContent className="p-4">
                      <div className="flex justify-between">
                        <div className="space-y-2">
                          <Skeleton className="h-5 w-40" />
                          <Skeleton className="h-4 w-24" />
                          <Skeleton className="h-4 w-20" />
                        </div>
                        <Skeleton className="h-6 w-20" />
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            ) : ordersData?.orders && ordersData.orders.length > 0 ? (
              <div className="space-y-3">
                {ordersData.orders.map((order) => (
                  <OrderTrackingCard
                    key={order.id}
                    orderId={order.id}
                    businessName={order.businessName}
                    items={order.items}
                    total={order.total}
                    orderStatus={order.status}
                    orderDate={order.createdAt}
                    shipment={order.shipment}
                  />
                ))}
              </div>
            ) : (
              <Card className="overflow-visible">
                <CardContent className="p-8 text-center">
                  <Package className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
                  <h3 className="font-semibold mb-2">No Orders Yet</h3>
                  <p className="text-muted-foreground text-sm">
                    Your order history will appear here when you make a purchase.
                  </p>
                </CardContent>
              </Card>
            )}
          </div>
        )}

        {activeSection === "points" && isRegularCustomer && (
          <div className="space-y-6">
            <Card className="overflow-visible bg-gradient-to-br from-primary/10 to-primary/5 border-primary/20">
              <CardContent className="p-6">
                <h3 className="font-semibold mb-2 flex items-center gap-2">
                  <Coins className="h-5 w-5 text-primary" />
                  How Outsyde Points Work
                </h3>
                <div className="grid gap-4 sm:grid-cols-3">
                  <div className="text-center p-3 rounded-md bg-background/50">
                    <p className="text-2xl font-bold text-primary">$1</p>
                    <p className="text-sm text-muted-foreground">spent</p>
                    <p className="text-lg font-semibold mt-1">= 100 pts</p>
                  </div>
                  <div className="text-center p-3 rounded-md bg-background/50">
                    <p className="text-2xl font-bold text-primary">100 pts</p>
                    <p className="text-sm text-muted-foreground">redeemed</p>
                    <p className="text-lg font-semibold mt-1">= $1 off</p>
                  </div>
                  <div className="text-center p-3 rounded-md bg-background/50">
                    <p className="text-2xl font-bold text-primary">Any</p>
                    <p className="text-sm text-muted-foreground">business</p>
                    <p className="text-lg font-semibold mt-1">platform-wide</p>
                  </div>
                </div>
              </CardContent>
            </Card>
            
            <ReferralCard />
            
            <PointsHistory />
          </div>
        )}

        {activeSection === "favorites" && (
          <Card className="overflow-visible">
            <CardHeader>
              <CardTitle>Favorites</CardTitle>
            </CardHeader>
            <CardContent className="text-center py-8">
              <Heart className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
              <p className="text-muted-foreground">
                Your favorite businesses will appear here
              </p>
            </CardContent>
          </Card>
        )}

        <Separator className="my-6" />

        <Button
          variant="outline"
          className="w-full"
          onClick={onLogout}
          data-testid="button-logout"
        >
          <LogOut className="h-4 w-4 mr-2" />
          Sign Out
        </Button>
      </div>
      
      {/* Influencer Application Form Dialog */}
      <Dialog open={showInfluencerForm} onOpenChange={setShowInfluencerForm}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <TrendingUp className="h-5 w-5 text-primary" />
              Apply to Become an Influencer
            </DialogTitle>
            <DialogDescription>
              Share your social media presence and tell us why you'd be a great Outsyde influencer.
            </DialogDescription>
          </DialogHeader>
          
          <div className="space-y-4 py-4">
            <div>
              <Label className="text-sm font-medium">Social Media Profiles</Label>
              <p className="text-xs text-muted-foreground mb-2">Add at least one platform URL.</p>
              <div className="space-y-2">
                <Input
                  id="instagramUrl"
                  placeholder="Instagram URL (e.g. https://instagram.com/yourhandle)"
                  value={influencerFormData.instagramUrl}
                  onChange={(e) => setInfluencerFormData(prev => ({ ...prev, instagramUrl: e.target.value }))}
                  data-testid="input-instagram-url"
                />
                <Input
                  id="tiktokUrl"
                  placeholder="TikTok URL (e.g. https://tiktok.com/@yourhandle)"
                  value={influencerFormData.tiktokUrl}
                  onChange={(e) => setInfluencerFormData(prev => ({ ...prev, tiktokUrl: e.target.value }))}
                  data-testid="input-tiktok-url"
                />
                <Input
                  id="youtubeUrl"
                  placeholder="YouTube URL (e.g. https://youtube.com/c/yourchannel)"
                  value={influencerFormData.youtubeUrl}
                  onChange={(e) => setInfluencerFormData(prev => ({ ...prev, youtubeUrl: e.target.value }))}
                  data-testid="input-youtube-url"
                />
                <Input
                  id="twitterUrl"
                  placeholder="Twitter/X URL (e.g. https://twitter.com/yourhandle)"
                  value={influencerFormData.twitterUrl}
                  onChange={(e) => setInfluencerFormData(prev => ({ ...prev, twitterUrl: e.target.value }))}
                  data-testid="input-twitter-url"
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="followerCount">Total Follower Count *</Label>
              <Input
                id="followerCount"
                placeholder="e.g., 10000"
                value={influencerFormData.followerCount}
                onChange={(e) => setInfluencerFormData(prev => ({ ...prev, followerCount: e.target.value }))}
                data-testid="input-follower-count"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="contentNiche">Content Niche *</Label>
              <Input
                id="contentNiche"
                placeholder="e.g., Local food, lifestyle, small business advocacy"
                value={influencerFormData.contentNiche}
                onChange={(e) => setInfluencerFormData(prev => ({ ...prev, contentNiche: e.target.value }))}
                data-testid="input-niche"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="whyInfluencer">Why do you want to join Outsyde? *</Label>
              <Textarea
                id="whyInfluencer"
                placeholder="What excites you about promoting local businesses? How would you help them grow?"
                value={influencerFormData.whyInfluencer}
                onChange={(e) => setInfluencerFormData(prev => ({ ...prev, whyInfluencer: e.target.value }))}
                className="min-h-[80px]"
                data-testid="input-why-join"
              />
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowInfluencerForm(false)}
              data-testid="button-cancel-application"
            >
              Cancel
            </Button>
            <Button
              onClick={() => submitApplicationMutation.mutate(influencerFormData)}
              disabled={
                submitApplicationMutation.isPending ||
                (!influencerFormData.instagramUrl.trim() &&
                  !influencerFormData.tiktokUrl.trim() &&
                  !influencerFormData.youtubeUrl.trim() &&
                  !influencerFormData.twitterUrl.trim()) ||
                !influencerFormData.followerCount.trim() ||
                !influencerFormData.contentNiche.trim() ||
                !influencerFormData.whyInfluencer.trim()
              }
              data-testid="button-submit-application"
            >
              {submitApplicationMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Submitting...
                </>
              ) : (
                "Submit Application"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

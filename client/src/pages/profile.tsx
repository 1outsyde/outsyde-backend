import { useState } from "react";
import { User, Settings, Heart, Calendar, ShoppingBag, LogOut, ChevronRight, Coins } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import LoyaltyPointsCard from "@/components/LoyaltyPointsCard";
import PointsHistory from "@/components/PointsHistory";
import ReferralCard from "@/components/ReferralCard";
import { useQuery } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/skeleton";

interface ProfileUser {
  id: string;
  email: string;
  name: string;
  city?: string;
  state?: string;
  isVendor: boolean;
  createdAt?: string;
}

interface ProfilePageProps {
  onLogout: () => void;
}

export default function ProfilePage({ onLogout }: ProfilePageProps) {
  const [activeSection, setActiveSection] = useState<"overview" | "bookings" | "orders" | "favorites" | "points">("overview");

  const { data: userData, isLoading: userLoading } = useQuery<ProfileUser>({
    queryKey: ["/api/auth/me"],
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

  // todo: remove mock functionality
  const recentOrders = [
    {
      id: "1",
      businessName: "Sunrise Coffee Co.",
      items: "2 items",
      total: 24.99,
      status: "delivered",
      date: "Nov 28, 2024",
    },
    {
      id: "2",
      businessName: "Artisan Jewelry Co.",
      items: "1 item",
      total: 45.99,
      status: "processing",
      date: "Nov 27, 2024",
    },
  ];

  const menuItems = [
    { id: "overview", icon: User, label: "Overview" },
    { id: "points", icon: Coins, label: "My Points" },
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
              <Button variant="outline" size="icon" data-testid="button-settings">
                <Settings className="h-5 w-5" />
              </Button>
            </div>
          </CardContent>
        </Card>

        <LoyaltyPointsCard
          onViewHistory={() => setActiveSection("points")}
        />

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
                <div className="space-y-3">
                  {recentOrders.map((order) => (
                    <div
                      key={order.id}
                      className="flex items-center justify-between p-3 rounded-md bg-muted/50"
                      data-testid={`order-item-${order.id}`}
                    >
                      <div>
                        <p className="font-medium">{order.businessName}</p>
                        <p className="text-sm text-muted-foreground">
                          {order.items} - ${order.total.toFixed(2)}
                        </p>
                        <p className="text-xs text-muted-foreground">{order.date}</p>
                      </div>
                      <Badge variant={order.status === "delivered" ? "default" : "secondary"}>
                        {order.status}
                      </Badge>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
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
          <Card className="overflow-visible">
            <CardHeader>
              <CardTitle>My Orders</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {recentOrders.map((order) => (
                  <div
                    key={order.id}
                    className="flex items-center justify-between p-4 rounded-md border"
                    data-testid={`order-detail-${order.id}`}
                  >
                    <div>
                      <p className="font-medium">{order.businessName}</p>
                      <p className="text-sm text-muted-foreground">{order.items}</p>
                      <p className="text-sm font-medium">${order.total.toFixed(2)}</p>
                      <p className="text-xs text-muted-foreground">{order.date}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant={order.status === "delivered" ? "default" : "secondary"}>
                        {order.status}
                      </Badge>
                      <Button variant="outline" size="sm">
                        View Details
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {activeSection === "points" && (
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
    </div>
  );
}

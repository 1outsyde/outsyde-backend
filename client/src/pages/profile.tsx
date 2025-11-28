import { useState } from "react";
import { User, Settings, Heart, Calendar, ShoppingBag, LogOut, ChevronRight } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import LoyaltyPointsCard from "@/components/LoyaltyPointsCard";

interface ProfilePageProps {
  onLogout: () => void;
}

export default function ProfilePage({ onLogout }: ProfilePageProps) {
  const [activeSection, setActiveSection] = useState<"overview" | "bookings" | "orders" | "favorites">("overview");

  // todo: remove mock functionality
  const user = {
    name: "Alex Johnson",
    email: "alex@example.com",
    location: "New York, NY",
    memberSince: "January 2024",
    points: 2450,
    nextRewardAt: 3000,
    tier: "Gold",
    rewardsAvailable: 3,
  };

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
    { id: "bookings", icon: Calendar, label: "My Bookings" },
    { id: "orders", icon: ShoppingBag, label: "My Orders" },
    { id: "favorites", icon: Heart, label: "Favorites" },
  ];

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
          points={user.points}
          nextRewardAt={user.nextRewardAt}
          tierName={user.tier}
          rewardsAvailable={user.rewardsAvailable}
          onViewRewards={() => console.log("View rewards")}
        />

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 my-6">
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

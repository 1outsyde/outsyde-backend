import { DollarSign, Calendar, MessageCircle, Package, TrendingUp, Users, Eye } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";

interface DashboardStats {
  revenue: number;
  revenueChange: number;
  bookings: number;
  bookingsChange: number;
  messages: number;
  products: number;
  views: number;
  followers: number;
}

interface RecentOrder {
  id: string;
  customerName: string;
  customerAvatar?: string;
  items: string;
  total: number;
  status: "pending" | "confirmed" | "completed";
  timestamp: string;
}

interface UpcomingBooking {
  id: string;
  customerName: string;
  service: string;
  date: string;
  time: string;
}

interface VendorDashboardProps {
  stats: DashboardStats;
  recentOrders: RecentOrder[];
  upcomingBookings: UpcomingBooking[];
  onViewAllOrders?: () => void;
  onViewAllBookings?: () => void;
}

export default function VendorDashboard({
  stats,
  recentOrders,
  upcomingBookings,
  onViewAllOrders,
  onViewAllBookings,
}: VendorDashboardProps) {
  const statCards = [
    {
      title: "Revenue",
      value: `$${stats.revenue.toLocaleString()}`,
      change: stats.revenueChange,
      icon: DollarSign,
    },
    {
      title: "Bookings",
      value: stats.bookings,
      change: stats.bookingsChange,
      icon: Calendar,
    },
    {
      title: "Messages",
      value: stats.messages,
      icon: MessageCircle,
    },
    {
      title: "Products",
      value: stats.products,
      icon: Package,
    },
  ];

  const statusColors = {
    pending: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200",
    confirmed: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
    completed: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
  };

  return (
    <div className="space-y-6" data-testid="vendor-dashboard">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {statCards.map((stat) => (
          <Card key={stat.title} className="overflow-visible">
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">{stat.title}</p>
                  <p className="text-2xl font-bold" data-testid={`stat-${stat.title.toLowerCase()}`}>
                    {stat.value}
                  </p>
                  {stat.change !== undefined && (
                    <div className="flex items-center gap-1 mt-1">
                      <TrendingUp
                        className={`h-3 w-3 ${stat.change >= 0 ? "text-green-500" : "text-red-500 rotate-180"}`}
                      />
                      <span
                        className={`text-xs ${stat.change >= 0 ? "text-green-500" : "text-red-500"}`}
                      >
                        {stat.change >= 0 ? "+" : ""}{stat.change}%
                      </span>
                    </div>
                  )}
                </div>
                <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center">
                  <stat.icon className="h-5 w-5 text-primary" />
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-4">
          <Card className="overflow-visible">
            <CardHeader className="flex flex-row items-center justify-between gap-4 pb-2">
              <CardTitle className="text-lg">Recent Orders</CardTitle>
              <Button variant="ghost" size="sm" onClick={onViewAllOrders}>
                View All
              </Button>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                {recentOrders.map((order) => (
                  <div
                    key={order.id}
                    className="flex items-center justify-between gap-4 p-3 rounded-md bg-muted/50"
                    data-testid={`order-${order.id}`}
                  >
                    <div className="flex items-center gap-3">
                      <Avatar className="h-10 w-10">
                        <AvatarImage src={order.customerAvatar} alt={order.customerName} />
                        <AvatarFallback>{order.customerName.charAt(0)}</AvatarFallback>
                      </Avatar>
                      <div>
                        <p className="font-medium text-sm">{order.customerName}</p>
                        <p className="text-xs text-muted-foreground">{order.items}</p>
                      </div>
                    </div>
                    <div className="text-right">
                      <p className="font-semibold">${order.total.toFixed(2)}</p>
                      <Badge className={statusColors[order.status]}>
                        {order.status}
                      </Badge>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          <div className="grid grid-cols-2 gap-4">
            <Card className="overflow-visible">
              <CardContent className="p-4 flex items-center gap-4">
                <div className="h-12 w-12 rounded-full bg-blue-100 dark:bg-blue-900 flex items-center justify-center">
                  <Eye className="h-6 w-6 text-blue-600 dark:text-blue-300" />
                </div>
                <div>
                  <p className="text-2xl font-bold">{stats.views.toLocaleString()}</p>
                  <p className="text-sm text-muted-foreground">Profile Views</p>
                </div>
              </CardContent>
            </Card>
            <Card className="overflow-visible">
              <CardContent className="p-4 flex items-center gap-4">
                <div className="h-12 w-12 rounded-full bg-purple-100 dark:bg-purple-900 flex items-center justify-center">
                  <Users className="h-6 w-6 text-purple-600 dark:text-purple-300" />
                </div>
                <div>
                  <p className="text-2xl font-bold">{stats.followers.toLocaleString()}</p>
                  <p className="text-sm text-muted-foreground">Followers</p>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>

        <Card className="overflow-visible">
          <CardHeader className="flex flex-row items-center justify-between gap-4 pb-2">
            <CardTitle className="text-lg">Upcoming Bookings</CardTitle>
            <Button variant="ghost" size="sm" onClick={onViewAllBookings}>
              View All
            </Button>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {upcomingBookings.map((booking) => (
                <div
                  key={booking.id}
                  className="p-3 rounded-md border"
                  data-testid={`booking-${booking.id}`}
                >
                  <div className="flex items-center justify-between gap-2 mb-2">
                    <p className="font-medium text-sm">{booking.customerName}</p>
                    <Badge variant="secondary">{booking.time}</Badge>
                  </div>
                  <p className="text-sm text-muted-foreground">{booking.service}</p>
                  <p className="text-xs text-muted-foreground mt-1">{booking.date}</p>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

import VendorDashboard from "../VendorDashboard";

export default function VendorDashboardExample() {
  const stats = {
    revenue: 12450,
    revenueChange: 12,
    bookings: 48,
    bookingsChange: 8,
    messages: 15,
    products: 24,
    views: 1250,
    followers: 328,
  };

  const recentOrders = [
    {
      id: "1",
      customerName: "Sarah Johnson",
      items: "2 items",
      total: 89.99,
      status: "pending" as const,
      timestamp: "2 min ago",
    },
    {
      id: "2",
      customerName: "Mike Chen",
      items: "1 item",
      total: 45.99,
      status: "confirmed" as const,
      timestamp: "1 hour ago",
    },
    {
      id: "3",
      customerName: "Emily Davis",
      items: "3 items",
      total: 124.50,
      status: "completed" as const,
      timestamp: "3 hours ago",
    },
  ];

  const upcomingBookings = [
    {
      id: "1",
      customerName: "Anna Smith",
      service: "Full Hair Styling",
      date: "Today",
      time: "2:00 PM",
    },
    {
      id: "2",
      customerName: "John Doe",
      service: "Hair Coloring",
      date: "Tomorrow",
      time: "10:00 AM",
    },
    {
      id: "3",
      customerName: "Lisa Wong",
      service: "Quick Trim",
      date: "Dec 1",
      time: "3:30 PM",
    },
  ];

  return (
    <div className="p-4">
      <VendorDashboard
        stats={stats}
        recentOrders={recentOrders}
        upcomingBookings={upcomingBookings}
        onViewAllOrders={() => console.log("View all orders")}
        onViewAllBookings={() => console.log("View all bookings")}
      />
    </div>
  );
}

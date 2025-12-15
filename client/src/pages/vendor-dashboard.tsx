import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { LayoutDashboard, Package, Calendar, MessageCircle, Settings, PlusCircle, Crown, Store, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SidebarProvider, Sidebar, SidebarContent, SidebarHeader, SidebarMenu, SidebarMenuItem, SidebarMenuButton, SidebarTrigger } from "@/components/ui/sidebar";
import VendorDashboard from "@/components/VendorDashboard";
import VendorSubscriptionDashboard from "@/components/VendorSubscriptionDashboard";
import StorefrontEditor from "@/components/StorefrontEditor";
import ThemeToggle from "@/components/ThemeToggle";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";

interface VendorDashboardPageProps {
  onLogout: () => void;
}

export default function VendorDashboardPage({ onLogout }: VendorDashboardPageProps) {
  const [activeSection, setActiveSection] = useState("dashboard");

  // todo: remove mock functionality
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

  // todo: remove mock functionality
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

  // todo: remove mock functionality
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

  const menuItems = [
    { id: "dashboard", icon: LayoutDashboard, label: "Dashboard" },
    { id: "storefront", icon: Store, label: "Storefront" },
    { id: "customers", icon: Users, label: "Customers" },
    { id: "subscription", icon: Crown, label: "Subscription" },
    { id: "bookings", icon: Calendar, label: "Bookings" },
    { id: "messages", icon: MessageCircle, label: "Messages" },
    { id: "settings", icon: Settings, label: "Settings" },
  ];

  // Fetch customers for the business
  const { data: customersData, isLoading: customersLoading, error: customersError } = useQuery<{
    customers: { id: string; firstName: string | null; lastName: string | null; email: string | null; phone: string | null }[];
  }>({
    queryKey: ["/api/vendor/customers"],
    enabled: activeSection === "customers",
  });

  const sidebarStyle = {
    "--sidebar-width": "16rem",
    "--sidebar-width-icon": "4rem",
  };

  return (
    <SidebarProvider style={sidebarStyle as React.CSSProperties}>
      <div className="flex h-screen w-full" data-testid="page-vendor-dashboard">
        <Sidebar>
          <SidebarHeader className="p-4 border-b">
            <div className="flex items-center gap-3">
              <Avatar className="h-10 w-10">
                <AvatarImage src="" alt="Business" />
                <AvatarFallback>BS</AvatarFallback>
              </Avatar>
              <div className="flex-1 min-w-0">
                <h2 className="font-semibold truncate">Bella's Hair Studio</h2>
                <p className="text-xs text-muted-foreground">Vendor Dashboard</p>
              </div>
            </div>
          </SidebarHeader>
          <SidebarContent className="p-2">
            <SidebarMenu>
              {menuItems.map((item) => (
                <SidebarMenuItem key={item.id}>
                  <SidebarMenuButton
                    onClick={() => setActiveSection(item.id)}
                    isActive={activeSection === item.id}
                    data-testid={`button-menu-${item.id}`}
                  >
                    <item.icon className="h-5 w-5" />
                    <span>{item.label}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarContent>
        </Sidebar>

        <div className="flex flex-col flex-1 overflow-hidden">
          <header className="flex items-center justify-between gap-4 p-4 border-b">
            <div className="flex items-center gap-2">
              <SidebarTrigger data-testid="button-sidebar-toggle" />
              <h1 className="text-xl font-semibold">
                {menuItems.find((m) => m.id === activeSection)?.label || "Dashboard"}
              </h1>
            </div>
            <div className="flex items-center gap-2">
              <Button data-testid="button-new-post">
                <PlusCircle className="h-4 w-4 mr-2" />
                New Post
              </Button>
              <ThemeToggle />
            </div>
          </header>

          <main className="flex-1 overflow-auto p-6">
            {activeSection === "dashboard" && (
              <VendorDashboard
                stats={stats}
                recentOrders={recentOrders}
                upcomingBookings={upcomingBookings}
                onViewAllOrders={() => setActiveSection("products")}
                onViewAllBookings={() => setActiveSection("bookings")}
              />
            )}

            {activeSection === "storefront" && (
              <StorefrontEditor />
            )}

            {activeSection === "subscription" && (
              <VendorSubscriptionDashboard />
            )}

            {activeSection === "customers" && (
              <div className="space-y-6">
                <div className="flex items-center justify-between">
                  <h2 className="text-2xl font-semibold" data-testid="heading-customers">Customers</h2>
                </div>
                
                {customersLoading ? (
                  <div className="text-center py-12">
                    <p className="text-muted-foreground">Loading customers...</p>
                  </div>
                ) : customersError ? (
                  <div className="text-center py-12" data-testid="error-customers">
                    <Users className="h-16 w-16 mx-auto text-destructive mb-4" />
                    <h3 className="text-xl font-semibold mb-2">Failed to Load Customers</h3>
                    <p className="text-muted-foreground mb-4">
                      There was an error loading your customer list. Please try again.
                    </p>
                    <Button 
                      variant="outline" 
                      onClick={() => window.location.reload()}
                      data-testid="button-retry-customers"
                    >
                      Retry
                    </Button>
                  </div>
                ) : customersData?.customers && customersData.customers.length > 0 ? (
                  <div className="bg-card rounded-lg border">
                    <table className="w-full" data-testid="table-customers">
                      <thead>
                        <tr className="border-b">
                          <th className="text-left p-4 font-medium text-muted-foreground">Customer ID</th>
                          <th className="text-left p-4 font-medium text-muted-foreground">Name</th>
                          <th className="text-left p-4 font-medium text-muted-foreground">Email</th>
                          <th className="text-left p-4 font-medium text-muted-foreground">Phone</th>
                        </tr>
                      </thead>
                      <tbody>
                        {customersData.customers.map((customer) => (
                          <tr key={customer.id} className="border-b last:border-0" data-testid={`row-customer-${customer.id}`}>
                            <td className="p-4 font-mono text-sm" data-testid={`text-customer-id-${customer.id}`}>
                              {customer.id.slice(0, 8)}...
                            </td>
                            <td className="p-4" data-testid={`text-customer-name-${customer.id}`}>
                              {customer.firstName || customer.lastName 
                                ? `${customer.firstName || ''} ${customer.lastName || ''}`.trim()
                                : '—'}
                            </td>
                            <td className="p-4" data-testid={`text-customer-email-${customer.id}`}>
                              {customer.email || '—'}
                            </td>
                            <td className="p-4" data-testid={`text-customer-phone-${customer.id}`}>
                              {customer.phone || '—'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="text-center py-12">
                    <Users className="h-16 w-16 mx-auto text-muted-foreground mb-4" />
                    <h3 className="text-xl font-semibold mb-2">No Customers Yet</h3>
                    <p className="text-muted-foreground">
                      Customers who place orders or book appointments will appear here.
                    </p>
                  </div>
                )}
              </div>
            )}

            {activeSection === "bookings" && (
              <div className="text-center py-12">
                <Calendar className="h-16 w-16 mx-auto text-muted-foreground mb-4" />
                <h2 className="text-xl font-semibold mb-2">Manage Bookings</h2>
                <p className="text-muted-foreground">
                  View and manage your upcoming appointments
                </p>
              </div>
            )}

            {activeSection === "messages" && (
              <div className="text-center py-12">
                <MessageCircle className="h-16 w-16 mx-auto text-muted-foreground mb-4" />
                <h2 className="text-xl font-semibold mb-2">Customer Messages</h2>
                <p className="text-muted-foreground">
                  Chat with your customers
                </p>
              </div>
            )}

            {activeSection === "settings" && (
              <div className="text-center py-12">
                <Settings className="h-16 w-16 mx-auto text-muted-foreground mb-4" />
                <h2 className="text-xl font-semibold mb-2">Settings</h2>
                <p className="text-muted-foreground mb-4">
                  Manage your business settings
                </p>
                <Button variant="outline" onClick={onLogout} data-testid="button-vendor-logout">
                  Sign Out
                </Button>
              </div>
            )}
          </main>
        </div>
      </div>
    </SidebarProvider>
  );
}

import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { LayoutDashboard, Package, Calendar, MessageCircle, Settings, PlusCircle, Crown, Store, Users, ClipboardList, RotateCcw, Truck, UserPlus, Trash2, ExternalLink, CheckCircle, XCircle } from "lucide-react";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { format } from "date-fns";
import BillingAddressForm from "@/components/BillingAddressForm";
import ShippingFormDialog from "@/components/ShippingFormDialog";
import StripeOnboardingBanner from "@/components/StripeOnboardingBanner";
import type { Business, Shipment, StaffMember, StaffInvite } from "@shared/schema";
import { getCarrierConfig, getTrackingUrl } from "@shared/carriers";

interface OrderRecord {
  recordId: string;
  recordType: 'order' | 'appointment';
  customerId: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  productsOrServices: string;
  orderedAt: string | null;
  bookingDateTime: string | null;
  totalPaid: number;
  platformFee: number;
  vendorNet: number;
  paymentIntentId: string | null;
  status: string | null;
}
import { Button } from "@/components/ui/button";
import { SidebarProvider, Sidebar, SidebarContent, SidebarHeader, SidebarMenu, SidebarMenuItem, SidebarMenuButton, SidebarTrigger } from "@/components/ui/sidebar";
import VendorDashboard from "@/components/VendorDashboard";
import VendorSubscriptionDashboard from "@/components/VendorSubscriptionDashboard";
import StorefrontEditor from "@/components/StorefrontEditor";
import AvailabilityCalendar from "@/components/AvailabilityCalendar";
import ThemeToggle from "@/components/ThemeToggle";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

interface VendorDashboardPageProps {
  onLogout: () => void;
}

export default function VendorDashboardPage({ onLogout }: VendorDashboardPageProps) {
  const [activeSection, setActiveSection] = useState("dashboard");
  const [refundDialogOpen, setRefundDialogOpen] = useState(false);
  const [selectedRecord, setSelectedRecord] = useState<OrderRecord | null>(null);
  const [refundReason, setRefundReason] = useState("");
  const [refundAttempted, setRefundAttempted] = useState(false);
  const [shippingDialogOpen, setShippingDialogOpen] = useState(false);
  const [selectedOrderForShipping, setSelectedOrderForShipping] = useState<OrderRecord | null>(null);
  const { toast } = useToast();

  // Refund request mutation
  const refundMutation = useMutation({
    mutationFn: async (data: { targetType: string; targetId: string; reason: string; amount: number }) => {
      const response = await apiRequest("POST", "/api/refund-requests", data);
      return response.json();
    },
    onSuccess: () => {
      toast({
        title: "Refund Request Submitted",
        description: "Admin has been notified and will review your request.",
      });
      closeRefundDialog();
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to submit refund request. Please try again.",
        variant: "destructive",
      });
    },
  });

  const handleRefundRequest = () => {
    setRefundAttempted(true);
    if (!selectedRecord || !refundReason.trim()) return;
    
    refundMutation.mutate({
      targetType: selectedRecord.recordType === 'order' ? 'order' : 'appointment',
      targetId: selectedRecord.recordId,
      reason: refundReason,
      amount: selectedRecord.totalPaid,
    });
  };

  const closeRefundDialog = () => {
    setRefundDialogOpen(false);
    setSelectedRecord(null);
    setRefundReason("");
    setRefundAttempted(false);
  };

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
    { id: "availability", icon: Calendar, label: "Availability" },
    { id: "team", icon: Users, label: "Team" },
    { id: "orders", icon: ClipboardList, label: "Orders & Bookings" },
    { id: "subscription", icon: Crown, label: "Subscription" },
    { id: "messages", icon: MessageCircle, label: "Messages" },
    { id: "settings", icon: Settings, label: "Settings" },
  ];

  // Team management state
  const [addStaffDialogOpen, setAddStaffDialogOpen] = useState(false);
  const [newStaffName, setNewStaffName] = useState("");
  const [newStaffEmail, setNewStaffEmail] = useState("");
  const [newStaffRole, setNewStaffRole] = useState<"staff" | "manager">("staff");

  // Fetch staff members
  const { data: staffData, isLoading: staffLoading } = useQuery<{ staff: StaffMember[] }>({
    queryKey: ["/api/vendor/staff"],
    enabled: activeSection === "team",
  });

  // Fetch staff invites
  const { data: invitesData, isLoading: invitesLoading } = useQuery<{ invites: StaffInvite[] }>({
    queryKey: ["/api/vendor/staff/invites"],
    enabled: activeSection === "team",
  });

  // Create staff member mutation
  const createStaffMutation = useMutation({
    mutationFn: async (data: { displayName: string; email?: string; role: string }) => {
      const response = await apiRequest("POST", "/api/vendor/staff", data);
      return response.json();
    },
    onSuccess: () => {
      toast({ title: "Staff member added successfully" });
      setAddStaffDialogOpen(false);
      setNewStaffName("");
      setNewStaffEmail("");
      setNewStaffRole("staff");
      queryClient.invalidateQueries({ queryKey: ["/api/vendor/staff"] });
    },
    onError: () => {
      toast({ title: "Failed to add staff member", variant: "destructive" });
    },
  });

  // Delete staff member mutation
  const deleteStaffMutation = useMutation({
    mutationFn: async (staffId: string) => {
      const response = await apiRequest("DELETE", `/api/vendor/staff/${staffId}`);
      return response.json();
    },
    onSuccess: () => {
      toast({ title: "Staff member removed" });
      queryClient.invalidateQueries({ queryKey: ["/api/vendor/staff"] });
    },
    onError: () => {
      toast({ title: "Failed to remove staff member", variant: "destructive" });
    },
  });

  // Create Stripe Connect for staff
  const createStaffStripeMutation = useMutation({
    mutationFn: async (staffId: string) => {
      const response = await apiRequest("POST", `/api/vendor/staff/${staffId}/stripe-connect`);
      return response.json();
    },
    onSuccess: (data) => {
      if (data.onboardingUrl) {
        window.open(data.onboardingUrl, "_blank");
      }
      queryClient.invalidateQueries({ queryKey: ["/api/vendor/staff"] });
      toast({ title: "Stripe onboarding started" });
    },
    onError: () => {
      toast({ title: "Failed to create Stripe account", variant: "destructive" });
    },
  });

  // Get fresh onboarding link for staff
  const getStaffOnboardingLinkMutation = useMutation({
    mutationFn: async (staffId: string) => {
      const response = await apiRequest("GET", `/api/vendor/staff/${staffId}/stripe-onboarding-link`);
      return response.json();
    },
    onSuccess: (data) => {
      if (data.onboardingUrl) {
        window.open(data.onboardingUrl, "_blank");
      }
    },
    onError: () => {
      toast({ title: "Failed to get onboarding link", variant: "destructive" });
    },
  });

  const handleAddStaff = () => {
    if (!newStaffName.trim()) return;
    createStaffMutation.mutate({
      displayName: newStaffName,
      email: newStaffEmail || undefined,
      role: newStaffRole,
    });
  };

  // Fetch order/booking records for the business
  const { data: recordsData, isLoading: recordsLoading, error: recordsError } = useQuery<{
    records: OrderRecord[];
  }>({
    queryKey: ["/api/vendor/customers"],
    enabled: activeSection === "orders",
  });

  // Fetch shipments for the vendor
  const { data: shipmentsData } = useQuery<{ shipments: Shipment[] }>({
    queryKey: ["/api/vendor/shipments"],
    enabled: activeSection === "orders",
  });

  // Helper to check if an order has been shipped
  const getOrderShipment = (orderId: string): Shipment | undefined => {
    return shipmentsData?.shipments?.find((s) => s.orderId === orderId);
  };

  // Fetch business data
  const { data: businessData } = useQuery<{ business: Business }>({
    queryKey: ["/api/vendor/my-business"],
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
            <div className="mb-4">
              <StripeOnboardingBanner vendorType="business" />
            </div>
            
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

            {activeSection === "availability" && (
              <AvailabilityCalendar />
            )}

            {activeSection === "team" && (
              <div className="space-y-6">
                <div className="flex items-center justify-between">
                  <div>
                    <h2 className="text-2xl font-semibold" data-testid="heading-team">Team Management</h2>
                    <p className="text-muted-foreground">Manage your staff members and their availability</p>
                  </div>
                  <Button onClick={() => setAddStaffDialogOpen(true)} data-testid="button-add-staff">
                    <UserPlus className="h-4 w-4 mr-2" />
                    Add Staff
                  </Button>
                </div>

                {/* Staff Overview Cards */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm font-medium text-muted-foreground">Total Staff</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <div className="text-2xl font-bold" data-testid="text-staff-count">
                        {staffData?.staff?.length || 0}
                      </div>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm font-medium text-muted-foreground">Active</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <div className="text-2xl font-bold text-green-600">
                        {staffData?.staff?.filter(s => s.status === "active").length || 0}
                      </div>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm font-medium text-muted-foreground">Pending Onboarding</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <div className="text-2xl font-bold text-amber-600">
                        {staffData?.staff?.filter(s => !s.stripeOnboardingComplete).length || 0}
                      </div>
                    </CardContent>
                  </Card>
                </div>

                {/* Staff List */}
                <Card>
                  <CardHeader>
                    <CardTitle>Staff Members</CardTitle>
                    <CardDescription>
                      Staff can receive direct payouts for bookings. Each staff member needs to complete Stripe onboarding.
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    {staffLoading ? (
                      <div className="text-center py-8">
                        <p className="text-muted-foreground">Loading staff members...</p>
                      </div>
                    ) : staffData?.staff && staffData.staff.length > 0 ? (
                      <div className="divide-y">
                        {staffData.staff.map((staff) => (
                          <div key={staff.id} className="flex items-center justify-between py-4" data-testid={`staff-row-${staff.id}`}>
                            <div className="flex items-center gap-4">
                              <Avatar className="h-10 w-10">
                                <AvatarImage src={staff.profileImageUrl || ""} />
                                <AvatarFallback>
                                  {staff.displayName?.split(" ").map(n => n[0]).join("").toUpperCase() || "ST"}
                                </AvatarFallback>
                              </Avatar>
                              <div>
                                <div className="flex items-center gap-2">
                                  <span className="font-medium" data-testid={`text-staff-name-${staff.id}`}>
                                    {staff.displayName}
                                  </span>
                                  <Badge variant={staff.role === "manager" ? "default" : "secondary"}>
                                    {staff.role || "staff"}
                                  </Badge>
                                  {staff.status === "active" ? (
                                    <Badge variant="outline" className="bg-green-50 text-green-700 border-green-200">
                                      Active
                                    </Badge>
                                  ) : (
                                    <Badge variant="outline" className="bg-gray-50 text-gray-600">
                                      {staff.status}
                                    </Badge>
                                  )}
                                </div>
                                <p className="text-sm text-muted-foreground">{staff.email || "No email"}</p>
                              </div>
                            </div>
                            <div className="flex items-center gap-2">
                              {/* Stripe Status */}
                              {staff.stripeOnboardingComplete ? (
                                <Badge variant="outline" className="bg-green-50 text-green-700 border-green-200">
                                  <CheckCircle className="h-3 w-3 mr-1" />
                                  Payments Ready
                                </Badge>
                              ) : staff.stripeAccountId ? (
                                <Button 
                                  size="sm" 
                                  variant="outline"
                                  onClick={() => getStaffOnboardingLinkMutation.mutate(staff.id)}
                                  data-testid={`button-continue-onboarding-${staff.id}`}
                                >
                                  <ExternalLink className="h-3 w-3 mr-1" />
                                  Continue Onboarding
                                </Button>
                              ) : (
                                <Button 
                                  size="sm" 
                                  variant="outline"
                                  onClick={() => createStaffStripeMutation.mutate(staff.id)}
                                  data-testid={`button-start-onboarding-${staff.id}`}
                                >
                                  <ExternalLink className="h-3 w-3 mr-1" />
                                  Start Stripe Onboarding
                                </Button>
                              )}
                              <Button 
                                size="icon" 
                                variant="ghost" 
                                className="text-destructive hover:text-destructive"
                                onClick={() => {
                                  if (confirm("Are you sure you want to remove this staff member?")) {
                                    deleteStaffMutation.mutate(staff.id);
                                  }
                                }}
                                data-testid={`button-delete-staff-${staff.id}`}
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="text-center py-12">
                        <Users className="h-16 w-16 mx-auto text-muted-foreground mb-4" />
                        <h3 className="text-lg font-semibold mb-2">No Staff Members Yet</h3>
                        <p className="text-muted-foreground mb-4">
                          Add staff members to let them receive direct payouts for bookings.
                        </p>
                        <Button onClick={() => setAddStaffDialogOpen(true)} data-testid="button-add-first-staff">
                          <UserPlus className="h-4 w-4 mr-2" />
                          Add Your First Staff Member
                        </Button>
                      </div>
                    )}
                  </CardContent>
                </Card>
              </div>
            )}

            {activeSection === "subscription" && (
              <VendorSubscriptionDashboard />
            )}

            {activeSection === "orders" && (
              <div className="space-y-6">
                <div className="flex items-center justify-between">
                  <h2 className="text-2xl font-semibold" data-testid="heading-orders">Orders & Bookings</h2>
                </div>
                
                {recordsLoading ? (
                  <div className="text-center py-12">
                    <p className="text-muted-foreground">Loading records...</p>
                  </div>
                ) : recordsError ? (
                  <div className="text-center py-12" data-testid="error-orders">
                    <ClipboardList className="h-16 w-16 mx-auto text-destructive mb-4" />
                    <h3 className="text-xl font-semibold mb-2">Failed to Load Records</h3>
                    <p className="text-muted-foreground mb-4">
                      There was an error loading your order records. Please try again.
                    </p>
                    <Button 
                      variant="outline" 
                      onClick={() => window.location.reload()}
                      data-testid="button-retry-orders"
                    >
                      Retry
                    </Button>
                  </div>
                ) : recordsData?.records && recordsData.records.length > 0 ? (
                  <div className="bg-card rounded-lg border overflow-x-auto">
                    <table className="w-full min-w-[1200px]" data-testid="table-orders">
                      <thead>
                        <tr className="border-b">
                          <th className="text-left p-3 font-medium text-muted-foreground text-sm">Type</th>
                          <th className="text-left p-3 font-medium text-muted-foreground text-sm">Order ID</th>
                          <th className="text-left p-3 font-medium text-muted-foreground text-sm">Customer</th>
                          <th className="text-left p-3 font-medium text-muted-foreground text-sm">Email</th>
                          <th className="text-left p-3 font-medium text-muted-foreground text-sm">Products/Services</th>
                          <th className="text-left p-3 font-medium text-muted-foreground text-sm">Ordered At</th>
                          <th className="text-left p-3 font-medium text-muted-foreground text-sm">Booking Date</th>
                          <th className="text-right p-3 font-medium text-muted-foreground text-sm">Total</th>
                          <th className="text-right p-3 font-medium text-muted-foreground text-sm">Platform Fee</th>
                          <th className="text-right p-3 font-medium text-muted-foreground text-sm">Your Net</th>
                          <th className="text-left p-3 font-medium text-muted-foreground text-sm">Status</th>
                          <th className="text-left p-3 font-medium text-muted-foreground text-sm">Shipping</th>
                          <th className="text-center p-3 font-medium text-muted-foreground text-sm">Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {recordsData.records.map((record) => (
                          <tr key={record.recordId} className="border-b last:border-0" data-testid={`row-order-${record.recordId}`}>
                            <td className="p-3">
                              <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                                record.recordType === 'order' 
                                  ? 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200' 
                                  : 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200'
                              }`}>
                                {record.recordType === 'order' ? 'Order' : 'Booking'}
                              </span>
                            </td>
                            <td className="p-3 font-mono text-xs" data-testid={`text-order-id-${record.recordId}`}>
                              {record.recordId.slice(0, 8)}...
                            </td>
                            <td className="p-3 text-sm" data-testid={`text-customer-name-${record.recordId}`}>
                              {record.firstName || record.lastName 
                                ? `${record.firstName || ''} ${record.lastName || ''}`.trim()
                                : '—'}
                            </td>
                            <td className="p-3 text-sm text-muted-foreground" data-testid={`text-customer-email-${record.recordId}`}>
                              {record.email || '—'}
                            </td>
                            <td className="p-3 text-sm max-w-[200px] truncate" title={record.productsOrServices}>
                              {record.productsOrServices || '—'}
                            </td>
                            <td className="p-3 text-sm text-muted-foreground">
                              {record.orderedAt ? (() => {
                                try {
                                  return format(new Date(record.orderedAt), 'MMM d, yyyy h:mm a');
                                } catch {
                                  return '—';
                                }
                              })() : '—'}
                            </td>
                            <td className="p-3 text-sm text-muted-foreground">
                              {record.bookingDateTime ? (() => {
                                try {
                                  return format(new Date(record.bookingDateTime), 'MMM d, yyyy h:mm a');
                                } catch {
                                  return record.bookingDateTime;
                                }
                              })() : '—'}
                            </td>
                            <td className="p-3 text-sm text-right font-medium">
                              ${(record.totalPaid / 100).toFixed(2)}
                            </td>
                            <td className="p-3 text-sm text-right text-muted-foreground">
                              ${(record.platformFee / 100).toFixed(2)}
                            </td>
                            <td className="p-3 text-sm text-right font-medium text-green-600 dark:text-green-400">
                              ${(record.vendorNet / 100).toFixed(2)}
                            </td>
                            <td className="p-3">
                              <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                                record.status === 'completed' 
                                  ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200'
                                  : record.status === 'confirmed'
                                  ? 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200'
                                  : record.status === 'pending'
                                  ? 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200'
                                  : record.status === 'shipped'
                                  ? 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200'
                                  : 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200'
                              }`}>
                                {record.status || 'Unknown'}
                              </span>
                            </td>
                            <td className="p-3">
                              {record.recordType === 'order' ? (() => {
                                const shipment = getOrderShipment(record.recordId);
                                if (shipment) {
                                  const carrier = getCarrierConfig(shipment.carrier);
                                  const trackingUrl = getTrackingUrl(shipment.carrier, shipment.trackingNumber);
                                  return (
                                    <div className="flex flex-col gap-1">
                                      <div className="flex items-center gap-1.5">
                                        <Package className="h-3.5 w-3.5" style={{ color: carrier.color }} />
                                        <span className="text-xs font-medium">{carrier.name}</span>
                                      </div>
                                      <span className="text-xs text-muted-foreground font-mono">
                                        {shipment.trackingNumber.slice(0, 12)}...
                                      </span>
                                      {trackingUrl && (
                                        <a
                                          href={trackingUrl}
                                          target="_blank"
                                          rel="noopener noreferrer"
                                          className="text-xs text-primary hover:underline"
                                          data-testid={`link-track-${record.recordId}`}
                                        >
                                          Track Package
                                        </a>
                                      )}
                                    </div>
                                  );
                                }
                                return (
                                  <span className="text-xs text-muted-foreground">Not shipped</span>
                                );
                              })() : (
                                <span className="text-xs text-muted-foreground">N/A</span>
                              )}
                            </td>
                            <td className="p-3">
                              <div className="flex items-center gap-2 justify-center">
                                {record.recordType === 'order' && !getOrderShipment(record.recordId) && (
                                  <Button
                                    size="sm"
                                    variant="default"
                                    onClick={() => {
                                      setSelectedOrderForShipping(record);
                                      setShippingDialogOpen(true);
                                    }}
                                    data-testid={`button-ship-${record.recordId}`}
                                  >
                                    <Truck className="h-3 w-3 mr-1" />
                                    Ship
                                  </Button>
                                )}
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => {
                                    setSelectedRecord(record);
                                    setRefundDialogOpen(true);
                                  }}
                                  data-testid={`button-refund-${record.recordId}`}
                                >
                                  <RotateCcw className="h-3 w-3 mr-1" />
                                  Refund
                                </Button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="text-center py-12">
                    <ClipboardList className="h-16 w-16 mx-auto text-muted-foreground mb-4" />
                    <h3 className="text-xl font-semibold mb-2">No Orders Yet</h3>
                    <p className="text-muted-foreground">
                      Orders and bookings from your customers will appear here.
                    </p>
                  </div>
                )}
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
              <div className="space-y-6">
                <div className="flex items-center gap-3 mb-6">
                  <Settings className="h-8 w-8 text-muted-foreground" />
                  <div>
                    <h2 className="text-xl font-semibold">Settings</h2>
                    <p className="text-muted-foreground">Manage your business settings</p>
                  </div>
                </div>

                <BillingAddressForm
                  currentAddress={businessData?.business?.billingAddress}
                  endpoint="/api/businesses/me/billing-address"
                  queryKeyToInvalidate={["/api/vendor/my-business"]}
                  title="Business Billing Address"
                />

                <div className="pt-4">
                  <Button variant="outline" onClick={onLogout} data-testid="button-vendor-logout">
                    Sign Out
                  </Button>
                </div>
              </div>
            )}
          </main>
        </div>
      </div>

      {/* Refund Request Dialog */}
      <Dialog open={refundDialogOpen} onOpenChange={(open) => !open && closeRefundDialog()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Request Refund</DialogTitle>
            <DialogDescription>
              Submit a refund request for this {selectedRecord?.recordType === 'order' ? 'order' : 'booking'}.
              Admin will be notified and review your request.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div>
              <p className="text-sm text-muted-foreground mb-2">
                <strong>Customer:</strong> {selectedRecord?.firstName || ''} {selectedRecord?.lastName || ''} ({selectedRecord?.email || 'No email'})
              </p>
              <p className="text-sm text-muted-foreground">
                <strong>Amount:</strong> ${((selectedRecord?.totalPaid || 0) / 100).toFixed(2)}
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="refund-reason">Reason for Refund <span className="text-destructive">*</span></Label>
              <Textarea
                id="refund-reason"
                placeholder="Please explain why you're requesting this refund..."
                value={refundReason}
                onChange={(e) => setRefundReason(e.target.value)}
                className={refundAttempted && !refundReason.trim() ? "border-destructive" : ""}
                data-testid="input-refund-reason"
              />
              {refundAttempted && !refundReason.trim() && (
                <p className="text-xs text-destructive" data-testid="text-refund-reason-error">
                  Please provide a reason for the refund request.
                </p>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={closeRefundDialog}
              data-testid="button-cancel-refund"
            >
              Cancel
            </Button>
            <Button
              onClick={handleRefundRequest}
              disabled={!refundReason.trim() || refundMutation.isPending}
              data-testid="button-submit-refund"
            >
              {refundMutation.isPending ? "Submitting..." : "Submit Request"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add Staff Dialog */}
      <Dialog open={addStaffDialogOpen} onOpenChange={setAddStaffDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Staff Member</DialogTitle>
            <DialogDescription>
              Add a new team member. They'll be able to receive direct payouts for their bookings after completing Stripe onboarding.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="staff-name">Name <span className="text-destructive">*</span></Label>
              <Input
                id="staff-name"
                placeholder="Enter staff member's name"
                value={newStaffName}
                onChange={(e) => setNewStaffName(e.target.value)}
                data-testid="input-staff-name"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="staff-email">Email (optional)</Label>
              <Input
                id="staff-email"
                type="email"
                placeholder="staff@example.com"
                value={newStaffEmail}
                onChange={(e) => setNewStaffEmail(e.target.value)}
                data-testid="input-staff-email"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="staff-role">Role</Label>
              <Select value={newStaffRole} onValueChange={(v: "staff" | "manager") => setNewStaffRole(v)}>
                <SelectTrigger data-testid="select-staff-role">
                  <SelectValue placeholder="Select role" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="staff">Staff</SelectItem>
                  <SelectItem value="manager">Manager</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Managers can view team stats. Both roles receive direct payouts.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setAddStaffDialogOpen(false)}
              data-testid="button-cancel-add-staff"
            >
              Cancel
            </Button>
            <Button
              onClick={handleAddStaff}
              disabled={!newStaffName.trim() || createStaffMutation.isPending}
              data-testid="button-submit-add-staff"
            >
              {createStaffMutation.isPending ? "Adding..." : "Add Staff Member"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Shipping Form Dialog */}
      <ShippingFormDialog
        open={shippingDialogOpen}
        onOpenChange={setShippingDialogOpen}
        orderId={selectedOrderForShipping?.recordId || ""}
        orderNumber={selectedOrderForShipping?.recordId.slice(0, 8)}
      />
    </SidebarProvider>
  );
}

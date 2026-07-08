import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { LayoutDashboard, Calendar, DollarSign, Settings, Clock, ExternalLink, CheckCircle, AlertCircle } from "lucide-react";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { format } from "date-fns";
import type { StaffMember, StaffAvailability, Appointment } from "@shared/schema";

import { Button } from "@/components/ui/button";
import { SidebarProvider, Sidebar, SidebarContent, SidebarHeader, SidebarMenu, SidebarMenuItem, SidebarMenuButton, SidebarTrigger } from "@/components/ui/sidebar";
import ThemeToggle from "@/components/ThemeToggle";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";

interface StaffDashboardPageProps {
  onLogout: () => void;
}

// GET /api/staff/me — if the account is staff at exactly one business this resolves
// directly. If it's ambiguous (staff at 2+ businesses), the backend returns 409 with a
// `businesses` array sorted most-recently-active-first; auto-select businesses[0] rather
// than showing a blocking picker (see G9 follow-up). Logged since it's a silent choice.
async function fetchStaffProfile(): Promise<{ staff: StaffMember | null }> {
  const res = await fetch("/api/staff/me", { credentials: "include" });

  if (res.status === 409) {
    const body = await res.json();
    const chosen = (body.businesses || [])[0];
    if (!chosen) return { staff: null };
    console.log(
      `[StaffDashboard] Ambiguous staff account, auto-selected business ${chosen.businessId} (staffId ${chosen.staffId})`
    );
    const retryRes = await fetch(`/api/staff/me?businessId=${encodeURIComponent(chosen.businessId)}`, {
      credentials: "include",
    });
    if (!retryRes.ok) return { staff: null };
    const retryJson = await retryRes.json();
    return { staff: retryJson.staff ?? null };
  }

  if (!res.ok) return { staff: null };
  const json = await res.json();
  return { staff: json.staff ?? null };
}

// Shared GET helper for the 3 businessId-scoped read queries below.
async function fetchWithBusinessContext<T>(url: string, businessId: string): Promise<T> {
  const res = await fetch(`${url}?businessId=${encodeURIComponent(businessId)}`, { credentials: "include" });
  if (!res.ok) {
    const text = (await res.text()) || res.statusText;
    throw new Error(`${res.status}: ${text}`);
  }
  return res.json();
}

export default function StaffDashboardPage({ onLogout }: StaffDashboardPageProps) {
  const [activeSection, setActiveSection] = useState("dashboard");
  const [availabilityDialogOpen, setAvailabilityDialogOpen] = useState(false);
  const [selectedDate, setSelectedDate] = useState("");
  const [startTime, setStartTime] = useState("09:00");
  const [endTime, setEndTime] = useState("17:00");
  const { toast } = useToast();

  const { data: staffData, isLoading: staffLoading } = useQuery<{ staff: StaffMember | null }>({
    queryKey: ["/api/staff/me"],
    queryFn: fetchStaffProfile,
  });

  const staff = staffData?.staff ?? undefined;
  const businessId = staff?.businessId;

  const { data: bookingsData, isLoading: bookingsLoading } = useQuery<{ bookings: Appointment[] }>({
    queryKey: ["/api/staff/my-bookings", businessId],
    queryFn: () => fetchWithBusinessContext("/api/staff/my-bookings", businessId!),
    enabled: !!businessId,
  });

  const { data: availabilityData, isLoading: availabilityLoading } = useQuery<{ availability: StaffAvailability[] }>({
    queryKey: ["/api/staff/my-availability", businessId],
    queryFn: () => fetchWithBusinessContext("/api/staff/my-availability", businessId!),
    enabled: !!businessId,
  });

  const { data: earningsData } = useQuery<{ total: number; thisMonth: number; pending: number }>({
    queryKey: ["/api/staff/my-earnings", businessId],
    queryFn: () => fetchWithBusinessContext("/api/staff/my-earnings", businessId!),
    enabled: !!businessId,
  });

  const stripeOnboardingMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/staff/stripe-onboarding/create-link", { businessId });
      return response.json();
    },
    onSuccess: (data) => {
      if (data.url) {
        window.location.href = data.url;
      }
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to start Stripe onboarding. Please try again.",
        variant: "destructive",
      });
    },
  });

  const addAvailabilityMutation = useMutation({
    mutationFn: async (data: { date: string; startTime: string; endTime: string }) => {
      const response = await apiRequest("POST", "/api/staff/my-availability", { ...data, businessId });
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/staff/my-availability", businessId] });
      setAvailabilityDialogOpen(false);
      setSelectedDate("");
      toast({ title: "Availability added" });
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to add availability. Please try again.",
        variant: "destructive",
      });
    },
  });

  const deleteAvailabilityMutation = useMutation({
    mutationFn: async (id: string) => {
      const response = await apiRequest("DELETE", `/api/staff/my-availability/${id}`, { businessId });
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/staff/my-availability", businessId] });
      toast({ title: "Availability removed" });
    },
  });
  const bookings = bookingsData?.bookings || [];
  const availability = availabilityData?.availability || [];
  const earnings = earningsData || { total: 0, thisMonth: 0, pending: 0 };

  const upcomingBookings = bookings.filter(b => 
    b.status === "confirmed" || b.status === "pending"
  ).sort((a, b) => 
    new Date(`${a.appointmentDate} ${a.appointmentTime}`).getTime() - 
    new Date(`${b.appointmentDate} ${b.appointmentTime}`).getTime()
  );

  if (staffLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin w-8 h-8 border-4 border-primary border-t-transparent rounded-full" />
      </div>
    );
  }

  if (!staff) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <Card className="max-w-md w-full">
          <CardHeader>
            <CardTitle>Staff Account Not Found</CardTitle>
            <CardDescription>
              You don't appear to have a staff account linked to your profile. 
              Please contact your business owner for an invitation.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={onLogout} variant="outline" className="w-full">
              Return to Login
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const sidebarStyle = {
    "--sidebar-width": "16rem",
    "--sidebar-width-icon": "3.5rem",
  };

  const menuItems = [
    { id: "dashboard", label: "Dashboard", icon: LayoutDashboard },
    { id: "bookings", label: "My Bookings", icon: Calendar },
    { id: "availability", label: "Availability", icon: Clock },
    { id: "earnings", label: "Earnings", icon: DollarSign },
    { id: "settings", label: "Settings", icon: Settings },
  ];

  const formatCurrency = (cents: number) => {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
    }).format(cents / 100);
  };

  return (
    <SidebarProvider style={sidebarStyle as React.CSSProperties}>
      <div className="flex h-screen w-full bg-background">
        <Sidebar>
          <SidebarHeader className="p-4 border-b">
            <div className="flex items-center gap-3">
              <Avatar className="h-10 w-10">
                <AvatarImage src={staff.profileImageUrl || ""} />
                <AvatarFallback className="bg-primary/10 text-primary">
                  {staff.displayName?.[0]}
                </AvatarFallback>
              </Avatar>
              <div className="overflow-hidden">
                <p className="font-semibold truncate">{staff.displayName}</p>
                <p className="text-xs text-muted-foreground capitalize">{staff.role}</p>
              </div>
            </div>
          </SidebarHeader>
          <SidebarContent className="p-2">
            <SidebarMenu>
              {menuItems.map((item) => (
                <SidebarMenuItem key={item.id}>
                  <SidebarMenuButton
                    onClick={() => setActiveSection(item.id)}
                    data-active={activeSection === item.id}
                    data-testid={`nav-${item.id}`}
                  >
                    <item.icon className="h-4 w-4" />
                    <span>{item.label}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarContent>
        </Sidebar>

        <div className="flex flex-col flex-1 overflow-hidden">
          <header className="flex items-center justify-between p-4 border-b bg-card">
            <div className="flex items-center gap-4">
              <SidebarTrigger data-testid="button-sidebar-toggle" />
              <h1 className="text-lg font-semibold">Staff Dashboard</h1>
            </div>
            <div className="flex items-center gap-2">
              <ThemeToggle />
              <Button variant="outline" size="sm" onClick={onLogout} data-testid="button-logout">
                Logout
              </Button>
            </div>
          </header>

          <main className="flex-1 overflow-auto p-6">
            {!staff.stripeOnboardingComplete && (
              <Card className="mb-6 border-amber-500/50 bg-amber-50 dark:bg-amber-950/20">
                <CardContent className="flex items-center justify-between p-4">
                  <div className="flex items-center gap-3">
                    <AlertCircle className="h-5 w-5 text-amber-600" />
                    <div>
                      <p className="font-medium">Complete Stripe Setup</p>
                      <p className="text-sm text-muted-foreground">
                        Set up your Stripe account to receive direct payments for your services.
                      </p>
                    </div>
                  </div>
                  <Button 
                    onClick={() => stripeOnboardingMutation.mutate()}
                    disabled={stripeOnboardingMutation.isPending}
                    data-testid="button-stripe-onboarding"
                  >
                    {stripeOnboardingMutation.isPending ? "Loading..." : "Set Up Payments"}
                    <ExternalLink className="ml-2 h-4 w-4" />
                  </Button>
                </CardContent>
              </Card>
            )}

            {activeSection === "dashboard" && (
              <div className="space-y-6">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <Card>
                    <CardHeader className="pb-2">
                      <CardDescription>This Month</CardDescription>
                      <CardTitle className="text-2xl" data-testid="text-monthly-earnings">
                        {formatCurrency(earnings.thisMonth)}
                      </CardTitle>
                    </CardHeader>
                  </Card>
                  <Card>
                    <CardHeader className="pb-2">
                      <CardDescription>Pending Payout</CardDescription>
                      <CardTitle className="text-2xl" data-testid="text-pending-earnings">
                        {formatCurrency(earnings.pending)}
                      </CardTitle>
                    </CardHeader>
                  </Card>
                  <Card>
                    <CardHeader className="pb-2">
                      <CardDescription>Upcoming Bookings</CardDescription>
                      <CardTitle className="text-2xl" data-testid="text-upcoming-count">
                        {upcomingBookings.length}
                      </CardTitle>
                    </CardHeader>
                  </Card>
                </div>

                <Card>
                  <CardHeader>
                    <CardTitle>Upcoming Appointments</CardTitle>
                    <CardDescription>Your next scheduled bookings</CardDescription>
                  </CardHeader>
                  <CardContent>
                    {upcomingBookings.length === 0 ? (
                      <p className="text-muted-foreground py-4">No upcoming appointments</p>
                    ) : (
                      <div className="space-y-3">
                        {upcomingBookings.slice(0, 5).map((booking) => (
                          <div key={booking.id} className="flex items-center justify-between p-3 rounded-lg bg-muted/50" data-testid={`booking-item-${booking.id}`}>
                            <div>
                              <p className="font-medium">{format(new Date(booking.appointmentDate), "MMM d, yyyy")}</p>
                              <p className="text-sm text-muted-foreground">{booking.appointmentTime}</p>
                            </div>
                            <Badge variant={booking.status === "confirmed" ? "default" : "secondary"}>
                              {booking.status}
                            </Badge>
                          </div>
                        ))}
                      </div>
                    )}
                  </CardContent>
                </Card>
              </div>
            )}

            {activeSection === "bookings" && (
              <Card>
                <CardHeader>
                  <CardTitle>My Bookings</CardTitle>
                  <CardDescription>All appointments assigned to you</CardDescription>
                </CardHeader>
                <CardContent>
                  {bookingsLoading ? (
                    <div className="py-8 flex justify-center">
                      <div className="animate-spin w-6 h-6 border-2 border-primary border-t-transparent rounded-full" />
                    </div>
                  ) : bookings.length === 0 ? (
                    <p className="text-muted-foreground py-4">No bookings yet</p>
                  ) : (
                    <div className="space-y-3">
                      {bookings.map((booking) => (
                        <div key={booking.id} className="flex items-center justify-between p-4 rounded-lg border" data-testid={`booking-row-${booking.id}`}>
                          <div className="space-y-1">
                            <p className="font-medium">{format(new Date(booking.appointmentDate), "EEEE, MMMM d, yyyy")}</p>
                            <p className="text-sm text-muted-foreground">Time: {booking.appointmentTime}</p>
                            {booking.staffPayout && (
                              <p className="text-sm font-medium text-green-600">
                                Your payout: {formatCurrency(booking.staffPayout)}
                              </p>
                            )}
                          </div>
                          <div className="flex flex-col items-end gap-2">
                            <Badge 
                              variant={
                                booking.status === "completed" ? "default" :
                                booking.status === "confirmed" ? "default" :
                                booking.status === "cancelled" ? "destructive" :
                                "secondary"
                              }
                            >
                              {booking.status}
                            </Badge>
                            <p className="text-sm text-muted-foreground">
                              Total: {formatCurrency(booking.totalPrice || 0)}
                            </p>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            )}

            {activeSection === "availability" && (
              <Card>
                <CardHeader className="flex flex-row items-center justify-between">
                  <div>
                    <CardTitle>My Availability</CardTitle>
                    <CardDescription>Set your available times for bookings</CardDescription>
                  </div>
                  <Button onClick={() => setAvailabilityDialogOpen(true)} data-testid="button-add-availability">
                    Add Availability
                  </Button>
                </CardHeader>
                <CardContent>
                  {availabilityLoading ? (
                    <div className="py-8 flex justify-center">
                      <div className="animate-spin w-6 h-6 border-2 border-primary border-t-transparent rounded-full" />
                    </div>
                  ) : availability.length === 0 ? (
                    <p className="text-muted-foreground py-4">No availability set. Add your available times to receive bookings.</p>
                  ) : (
                    <div className="space-y-3">
                      {availability.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()).map((slot) => (
                        <div key={slot.id} className="flex items-center justify-between p-3 rounded-lg border" data-testid={`availability-slot-${slot.id}`}>
                          <div>
                            <p className="font-medium">{format(new Date(slot.date), "EEEE, MMMM d, yyyy")}</p>
                            <p className="text-sm text-muted-foreground">{slot.startTime} - {slot.endTime}</p>
                          </div>
                          <div className="flex items-center gap-2">
                            <Badge variant={slot.slotType === "available" ? "default" : "secondary"}>
                              {slot.slotType === "available" ? "Available" : slot.slotType || "Set"}
                            </Badge>
                            <Button 
                              variant="ghost" 
                              size="sm"
                              onClick={() => deleteAvailabilityMutation.mutate(slot.id)}
                              data-testid={`button-delete-availability-${slot.id}`}
                            >
                              Remove
                            </Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            )}

            {activeSection === "earnings" && (
              <div className="space-y-6">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <Card>
                    <CardHeader>
                      <CardDescription>Total Earnings</CardDescription>
                      <CardTitle className="text-3xl" data-testid="text-total-earnings">
                        {formatCurrency(earnings.total)}
                      </CardTitle>
                    </CardHeader>
                  </Card>
                  <Card>
                    <CardHeader>
                      <CardDescription>This Month</CardDescription>
                      <CardTitle className="text-3xl">
                        {formatCurrency(earnings.thisMonth)}
                      </CardTitle>
                    </CardHeader>
                  </Card>
                  <Card>
                    <CardHeader>
                      <CardDescription>Pending</CardDescription>
                      <CardTitle className="text-3xl">
                        {formatCurrency(earnings.pending)}
                      </CardTitle>
                    </CardHeader>
                  </Card>
                </div>

                <Card>
                  <CardHeader>
                    <CardTitle>Payment Info</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="flex items-center gap-3 p-4 rounded-lg bg-muted/50">
                      {staff.stripeOnboardingComplete ? (
                        <>
                          <CheckCircle className="h-5 w-5 text-green-600" />
                          <div>
                            <p className="font-medium">Stripe Connected</p>
                            <p className="text-sm text-muted-foreground">
                              You'll receive payouts directly to your connected bank account.
                            </p>
                          </div>
                        </>
                      ) : (
                        <>
                          <AlertCircle className="h-5 w-5 text-amber-600" />
                          <div className="flex-1">
                            <p className="font-medium">Stripe Not Connected</p>
                            <p className="text-sm text-muted-foreground">
                              Complete Stripe onboarding to receive direct payments.
                            </p>
                          </div>
                          <Button 
                            size="sm"
                            onClick={() => stripeOnboardingMutation.mutate()}
                            disabled={stripeOnboardingMutation.isPending}
                          >
                            Connect Stripe
                          </Button>
                        </>
                      )}
                    </div>
                  </CardContent>
                </Card>
              </div>
            )}

            {activeSection === "settings" && (
              <Card>
                <CardHeader>
                  <CardTitle>Profile Settings</CardTitle>
                  <CardDescription>Manage your staff profile</CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                  <div className="flex items-center gap-4">
                    <Avatar className="h-16 w-16">
                      <AvatarImage src={staff.profileImageUrl || ""} />
                      <AvatarFallback className="bg-primary/10 text-primary text-xl">
                        {staff.displayName?.[0]}
                      </AvatarFallback>
                    </Avatar>
                    <div>
                      <p className="font-semibold text-lg">{staff.displayName}</p>
                      <p className="text-muted-foreground">{staff.email}</p>
                      <Badge className="mt-1 capitalize">{staff.role}</Badge>
                    </div>
                  </div>

                  {staff.bio && (
                    <div>
                      <Label className="text-sm text-muted-foreground">Bio</Label>
                      <p className="mt-1">{staff.bio}</p>
                    </div>
                  )}

                  {staff.specialties && staff.specialties.length > 0 && (
                    <div>
                      <Label className="text-sm text-muted-foreground">Specialties</Label>
                      <div className="flex flex-wrap gap-2 mt-2">
                        {staff.specialties.map((specialty, idx) => (
                          <Badge key={idx} variant="outline">{specialty}</Badge>
                        ))}
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            )}
          </main>
        </div>
      </div>

      <Dialog open={availabilityDialogOpen} onOpenChange={setAvailabilityDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Availability</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>Date</Label>
              <Input 
                type="date" 
                value={selectedDate}
                onChange={(e) => setSelectedDate(e.target.value)}
                min={format(new Date(), "yyyy-MM-dd")}
                data-testid="input-availability-date"
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Start Time</Label>
                <Input 
                  type="time" 
                  value={startTime}
                  onChange={(e) => setStartTime(e.target.value)}
                  data-testid="input-start-time"
                />
              </div>
              <div className="space-y-2">
                <Label>End Time</Label>
                <Input 
                  type="time" 
                  value={endTime}
                  onChange={(e) => setEndTime(e.target.value)}
                  data-testid="input-end-time"
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAvailabilityDialogOpen(false)}>
              Cancel
            </Button>
            <Button 
              onClick={() => addAvailabilityMutation.mutate({ date: selectedDate, startTime, endTime })}
              disabled={!selectedDate || addAvailabilityMutation.isPending}
              data-testid="button-save-availability"
            >
              {addAvailabilityMutation.isPending ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SidebarProvider>
  );
}

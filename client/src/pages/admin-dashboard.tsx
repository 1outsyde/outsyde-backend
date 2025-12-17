import { useQuery, useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { format } from "date-fns";
import { 
  Users, 
  Building2, 
  Camera,
  CreditCard,
  MessageSquare,
  HelpCircle,
  Search,
  Edit2,
  Eye,
  MoreHorizontal,
  DollarSign,
  TrendingUp,
  ArrowLeft,
  RefreshCw,
  ChevronRight,
  Calendar,
  Mail,
  Phone,
  ShieldCheck,
  ShieldAlert,
  Store,
  Package,
  Settings
} from "lucide-react";
import type { User, Business, Photographer, Order, ShootBooking, Conversation, RefundRequest } from "@shared/schema";

interface AdminStats {
  totalUsers: number;
  totalBusinesses: number;
  totalPhotographers: number;
  totalOrders: number;
  totalBookings: number;
  pendingRefunds: number;
}

function StatCard({ title, value, icon: Icon, color }: { 
  title: string; 
  value: number | string; 
  icon: typeof Users;
  color?: string;
}) {
  return (
    <Card data-testid={`stat-${title.toLowerCase().replace(/\s/g, '-')}`}>
      <CardContent className="p-6">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm text-muted-foreground">{title}</p>
            <p className="text-2xl font-bold">{value}</p>
          </div>
          <div className={`p-3 rounded-full ${color || 'bg-primary/10'}`}>
            <Icon className={`w-5 h-5 ${color ? 'text-white' : 'text-primary'}`} />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function UsersTab() {
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedUser, setSelectedUser] = useState<User | null>(null);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [editForm, setEditForm] = useState<Partial<User>>({});
  const { toast } = useToast();

  const { data: users = [], isLoading } = useQuery<User[]>({
    queryKey: ["/api/admin/users"],
  });

  const updateUserMutation = useMutation({
    mutationFn: async (data: { id: string; updates: Partial<User> }) => {
      return apiRequest("PATCH", `/api/admin/users/${data.id}`, data.updates);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/users"] });
      setEditDialogOpen(false);
      toast({ title: "User updated successfully" });
    },
    onError: () => {
      toast({ title: "Failed to update user", variant: "destructive" });
    },
  });

  const filteredUsers = users.filter(user => 
    user.name?.toLowerCase().includes(searchQuery.toLowerCase()) ||
    user.email?.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const handleEditUser = (user: User) => {
    setSelectedUser(user);
    setEditForm({
      name: user.name,
      email: user.email,
      phone: user.phone,
      isVendor: user.isVendor,
      isPhotographer: user.isPhotographer,
      isAdmin: user.isAdmin,
    });
    setEditDialogOpen(true);
  };

  const handleSaveUser = () => {
    if (selectedUser) {
      updateUserMutation.mutate({ id: selectedUser.id, updates: editForm });
    }
  };

  if (isLoading) {
    return <div className="flex items-center justify-center p-8 text-muted-foreground">Loading users...</div>;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Search users by name or email..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9"
            data-testid="input-search-users"
          />
        </div>
        <Badge variant="outline" data-testid="badge-user-count">{filteredUsers.length} users</Badge>
      </div>

      <ScrollArea className="h-[500px]">
        <div className="space-y-2">
          {filteredUsers.map(user => (
            <Card key={user.id} className="hover-elevate" data-testid={`card-user-${user.id}`}>
              <CardContent className="p-4">
                <div className="flex items-center justify-between gap-4">
                  <div className="flex items-center gap-3 flex-1">
                    <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center">
                      {user.profileImageUrl ? (
                        <img src={user.profileImageUrl} alt="" className="w-full h-full rounded-full object-cover" />
                      ) : (
                        <Users className="w-5 h-5 text-muted-foreground" />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="font-medium truncate">{user.name || 'Unnamed User'}</p>
                        {user.isAdmin && <Badge variant="secondary" className="text-xs">Admin</Badge>}
                        {user.isVendor && <Badge variant="outline" className="text-xs">Vendor</Badge>}
                        {user.isPhotographer && <Badge variant="outline" className="text-xs">Photographer</Badge>}
                      </div>
                      <p className="text-sm text-muted-foreground truncate">{user.email}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <p className="text-xs text-muted-foreground">
                      Joined {user.createdAt ? format(new Date(user.createdAt), 'MMM d, yyyy') : 'N/A'}
                    </p>
                    <Button 
                      size="icon" 
                      variant="ghost"
                      onClick={() => handleEditUser(user)}
                      data-testid={`button-edit-user-${user.id}`}
                    >
                      <Edit2 className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </ScrollArea>

      <Dialog open={editDialogOpen} onOpenChange={setEditDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit User</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>Name</Label>
              <Input
                value={editForm.name || ''}
                onChange={(e) => setEditForm(prev => ({ ...prev, name: e.target.value }))}
                data-testid="input-edit-name"
              />
            </div>
            <div className="space-y-2">
              <Label>Email</Label>
              <Input
                value={editForm.email || ''}
                onChange={(e) => setEditForm(prev => ({ ...prev, email: e.target.value }))}
                data-testid="input-edit-email"
              />
            </div>
            <div className="space-y-2">
              <Label>Phone</Label>
              <Input
                value={editForm.phone || ''}
                onChange={(e) => setEditForm(prev => ({ ...prev, phone: e.target.value }))}
                data-testid="input-edit-phone"
              />
            </div>
            <Separator />
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <Label>Vendor Account</Label>
                <Switch
                  checked={editForm.isVendor || false}
                  onCheckedChange={(checked) => setEditForm(prev => ({ ...prev, isVendor: checked }))}
                  data-testid="switch-edit-vendor"
                />
              </div>
              <div className="flex items-center justify-between">
                <Label>Photographer Account</Label>
                <Switch
                  checked={editForm.isPhotographer || false}
                  onCheckedChange={(checked) => setEditForm(prev => ({ ...prev, isPhotographer: checked }))}
                  data-testid="switch-edit-photographer"
                />
              </div>
              <div className="flex items-center justify-between">
                <Label>Admin Access</Label>
                <Switch
                  checked={editForm.isAdmin || false}
                  onCheckedChange={(checked) => setEditForm(prev => ({ ...prev, isAdmin: checked }))}
                  data-testid="switch-edit-admin"
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditDialogOpen(false)}>Cancel</Button>
            <Button 
              onClick={handleSaveUser}
              disabled={updateUserMutation.isPending}
              data-testid="button-save-user"
            >
              {updateUserMutation.isPending ? "Saving..." : "Save Changes"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function BusinessesTab() {
  const [searchQuery, setSearchQuery] = useState("");

  const { data: businesses = [], isLoading } = useQuery<Business[]>({
    queryKey: ["/api/admin/businesses"],
  });

  const filteredBusinesses = businesses.filter(b => 
    b.name?.toLowerCase().includes(searchQuery.toLowerCase()) ||
    b.category?.toLowerCase().includes(searchQuery.toLowerCase())
  );

  if (isLoading) {
    return <div className="flex items-center justify-center p-8 text-muted-foreground">Loading businesses...</div>;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Search businesses..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9"
            data-testid="input-search-businesses"
          />
        </div>
        <Badge variant="outline" data-testid="badge-business-count">{filteredBusinesses.length} businesses</Badge>
      </div>

      <ScrollArea className="h-[500px]">
        <div className="space-y-2">
          {filteredBusinesses.map(business => (
            <Card key={business.id} className="hover-elevate" data-testid={`card-business-${business.id}`}>
              <CardContent className="p-4">
                <div className="flex items-center justify-between gap-4">
                  <div className="flex items-center gap-3 flex-1">
                    <div className="w-12 h-12 rounded-lg bg-muted flex items-center justify-center">
                      {business.logoImage ? (
                        <img src={business.logoImage} alt="" className="w-full h-full rounded-lg object-cover" />
                      ) : (
                        <Building2 className="w-6 h-6 text-muted-foreground" />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="font-medium truncate">{business.name}</p>
                        {business.hasProducts && <Badge variant="outline" className="text-xs">Products</Badge>}
                        {business.hasServices && <Badge variant="outline" className="text-xs">Services</Badge>}
                      </div>
                      <p className="text-sm text-muted-foreground">
                        {business.category} • {business.city}, {business.state}
                      </p>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className="text-xs text-muted-foreground">Owner: {business.ownerId}</p>
                    {business.stripeOnboardingComplete && (
                      <Badge variant="secondary" className="mt-1">Stripe Active</Badge>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}

function PhotographersTab() {
  const [searchQuery, setSearchQuery] = useState("");

  const { data: photographers = [], isLoading } = useQuery<Photographer[]>({
    queryKey: ["/api/admin/photographers"],
  });

  const filteredPhotographers = photographers.filter(p => 
    p.displayName?.toLowerCase().includes(searchQuery.toLowerCase()) ||
    p.city?.toLowerCase().includes(searchQuery.toLowerCase())
  );

  if (isLoading) {
    return <div className="flex items-center justify-center p-8 text-muted-foreground">Loading photographers...</div>;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Search photographers..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9"
            data-testid="input-search-photographers"
          />
        </div>
        <Badge variant="outline" data-testid="badge-photographer-count">{filteredPhotographers.length} photographers</Badge>
      </div>

      <ScrollArea className="h-[500px]">
        <div className="space-y-2">
          {filteredPhotographers.map(photographer => (
            <Card key={photographer.id} className="hover-elevate" data-testid={`card-photographer-${photographer.id}`}>
              <CardContent className="p-4">
                <div className="flex items-center justify-between gap-4">
                  <div className="flex items-center gap-3 flex-1">
                    <div className="w-12 h-12 rounded-full bg-muted flex items-center justify-center">
                      {photographer.logoImage ? (
                        <img src={photographer.logoImage} alt="" className="w-full h-full rounded-full object-cover" />
                      ) : (
                        <Camera className="w-6 h-6 text-muted-foreground" />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="font-medium truncate">{photographer.displayName || 'Unnamed'}</p>
                        {photographer.specialties?.length && (
                          <Badge variant="outline" className="text-xs">{photographer.specialties[0]}</Badge>
                        )}
                      </div>
                      <p className="text-sm text-muted-foreground">
                        {photographer.city}, {photographer.state} • 
                        ${photographer.hourlyRate ? (photographer.hourlyRate / 100).toFixed(0) : '0'}/hr
                      </p>
                    </div>
                  </div>
                  <div className="text-right">
                    {photographer.stripeAccountId && (
                      <Badge variant="secondary">Stripe Connected</Badge>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}

function PaymentsTab() {
  const { data: orders = [], isLoading: ordersLoading } = useQuery<Order[]>({
    queryKey: ["/api/admin/orders"],
  });

  const { data: bookings = [], isLoading: bookingsLoading } = useQuery<ShootBooking[]>({
    queryKey: ["/api/admin/bookings"],
  });

  const { data: refunds = [], isLoading: refundsLoading } = useQuery<(RefundRequest & { requesterName?: string })[]>({
    queryKey: ["/api/admin/refund-requests"],
  });

  const isLoading = ordersLoading || bookingsLoading || refundsLoading;

  const totalOrderRevenue = orders.reduce((sum, o) => sum + (o.totalAmount || 0), 0);
  const totalBookingRevenue = bookings.reduce((sum, b) => sum + (b.totalPrice || 0), 0);
  const pendingRefundsCount = refunds.filter(r => r.status === 'pending').length;

  if (isLoading) {
    return <div className="flex items-center justify-center p-8 text-muted-foreground">Loading payment data...</div>;
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <StatCard title="Total Orders" value={orders.length} icon={Package} />
        <StatCard title="Order Revenue" value={`$${(totalOrderRevenue / 100).toFixed(2)}`} icon={DollarSign} />
        <StatCard title="Total Bookings" value={bookings.length} icon={Calendar} />
        <StatCard title="Pending Refunds" value={pendingRefundsCount} icon={RefreshCw} color="bg-amber-500" />
      </div>

      <Tabs defaultValue="orders">
        <TabsList>
          <TabsTrigger value="orders" data-testid="tab-orders">Orders ({orders.length})</TabsTrigger>
          <TabsTrigger value="bookings" data-testid="tab-bookings">Bookings ({bookings.length})</TabsTrigger>
          <TabsTrigger value="refunds" data-testid="tab-refunds">Refunds ({refunds.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="orders">
          <ScrollArea className="h-[400px]">
            <div className="space-y-2">
              {orders.map(order => (
                <Card key={order.id} data-testid={`card-order-${order.id}`}>
                  <CardContent className="p-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="font-medium">Order #{order.id.slice(0, 8)}</p>
                        <p className="text-sm text-muted-foreground">
                          {order.createdAt ? format(new Date(order.createdAt), 'MMM d, yyyy') : 'N/A'}
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="font-medium">${((order.totalAmount || 0) / 100).toFixed(2)}</p>
                        <Badge variant={order.status === 'completed' ? 'secondary' : 'outline'}>
                          {order.status || 'pending'}
                        </Badge>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </ScrollArea>
        </TabsContent>

        <TabsContent value="bookings">
          <ScrollArea className="h-[400px]">
            <div className="space-y-2">
              {bookings.map(booking => (
                <Card key={booking.id} data-testid={`card-booking-${booking.id}`}>
                  <CardContent className="p-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="font-medium">Booking #{booking.id.slice(0, 8)}</p>
                        <p className="text-sm text-muted-foreground">
                          {booking.shootType} • {booking.date}
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="font-medium">${((booking.totalPrice || 0) / 100).toFixed(2)}</p>
                        <Badge variant={booking.status === 'confirmed' ? 'secondary' : 'outline'}>
                          {booking.status || 'pending'}
                        </Badge>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </ScrollArea>
        </TabsContent>

        <TabsContent value="refunds">
          <ScrollArea className="h-[400px]">
            <div className="space-y-2">
              {refunds.map(refund => (
                <Card key={refund.id} data-testid={`card-refund-${refund.id}`}>
                  <CardContent className="p-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="font-medium">{refund.requesterName || 'Unknown'}</p>
                        <p className="text-sm text-muted-foreground">{refund.reason}</p>
                      </div>
                      <div className="text-right">
                        <p className="font-medium">${((refund.amount || 0) / 100).toFixed(2)}</p>
                        <Badge variant={refund.status === 'approved' ? 'secondary' : refund.status === 'rejected' ? 'destructive' : 'outline'}>
                          {refund.status || 'pending'}
                        </Badge>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </ScrollArea>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function MessagesTab() {
  const [selectedConversation, setSelectedConversation] = useState<Conversation | null>(null);

  const { data: conversations = [], isLoading } = useQuery<Conversation[]>({
    queryKey: ["/api/admin/conversations"],
  });

  const { data: messages = [] } = useQuery({
    queryKey: ["/api/admin/conversations", selectedConversation?.id, "messages"],
    enabled: !!selectedConversation,
  });

  if (isLoading) {
    return <div className="flex items-center justify-center p-8 text-muted-foreground">Loading conversations...</div>;
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">All Conversations</CardTitle>
          <CardDescription>{conversations.length} total conversations</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <ScrollArea className="h-[400px]">
            <div className="divide-y">
              {conversations.map(conv => (
                <div 
                  key={conv.id}
                  className={`p-4 cursor-pointer hover-elevate ${selectedConversation?.id === conv.id ? 'bg-muted' : ''}`}
                  onClick={() => setSelectedConversation(conv)}
                  data-testid={`conversation-${conv.id}`}
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="font-medium text-sm">Conversation #{conv.id.slice(0, 8)}</p>
                      <p className="text-xs text-muted-foreground">
                        {conv.participant1Id?.slice(0, 8)} ↔ {conv.participant2Id?.slice(0, 8)}
                      </p>
                    </div>
                    <ChevronRight className="w-4 h-4 text-muted-foreground" />
                  </div>
                </div>
              ))}
            </div>
          </ScrollArea>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">
            {selectedConversation ? `Messages` : 'Select a conversation'}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {selectedConversation ? (
            <ScrollArea className="h-[350px]">
              <div className="space-y-3">
                {Array.isArray(messages) && messages.map((msg: any) => (
                  <div key={msg.id} className="p-3 rounded-lg bg-muted">
                    <p className="text-sm font-medium">{msg.senderId?.slice(0, 8)}</p>
                    <p className="text-sm">{msg.content}</p>
                    <p className="text-xs text-muted-foreground mt-1">
                      {msg.createdAt ? format(new Date(msg.createdAt), 'MMM d, HH:mm') : ''}
                    </p>
                  </div>
                ))}
              </div>
            </ScrollArea>
          ) : (
            <div className="flex items-center justify-center h-[350px] text-muted-foreground">
              <MessageSquare className="w-8 h-8 mr-2" />
              <span>Select a conversation to view messages</span>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

interface AdminDashboardProps {
  onBack?: () => void;
}

export default function AdminDashboard({ onBack }: AdminDashboardProps) {
  const { data: users = [] } = useQuery<User[]>({ queryKey: ["/api/admin/users"] });
  const { data: businesses = [] } = useQuery<Business[]>({ queryKey: ["/api/admin/businesses"] });
  const { data: photographers = [] } = useQuery<Photographer[]>({ queryKey: ["/api/admin/photographers"] });
  const { data: orders = [] } = useQuery<Order[]>({ queryKey: ["/api/admin/orders"] });
  const { data: bookings = [] } = useQuery<ShootBooking[]>({ queryKey: ["/api/admin/bookings"] });

  return (
    <div className="min-h-screen bg-background">
      <div className="p-4 md:p-6 max-w-7xl mx-auto">
        <div className="flex items-center gap-4 mb-6">
          {onBack && (
            <Button variant="ghost" size="icon" onClick={onBack} data-testid="button-back">
              <ArrowLeft className="w-5 h-5" />
            </Button>
          )}
          <div>
            <h1 className="text-2xl font-bold" data-testid="text-title">Admin Dashboard</h1>
            <p className="text-muted-foreground">Platform management and oversight</p>
          </div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-6">
          <StatCard title="Users" value={users.length} icon={Users} />
          <StatCard title="Businesses" value={businesses.length} icon={Building2} />
          <StatCard title="Photographers" value={photographers.length} icon={Camera} />
          <StatCard title="Orders" value={orders.length} icon={Package} />
          <StatCard title="Bookings" value={bookings.length} icon={Calendar} />
        </div>

        <Tabs defaultValue="users" className="space-y-4">
          <TabsList className="flex flex-wrap gap-1">
            <TabsTrigger value="users" className="gap-2" data-testid="tab-users">
              <Users className="w-4 h-4" />
              Users
            </TabsTrigger>
            <TabsTrigger value="businesses" className="gap-2" data-testid="tab-businesses">
              <Building2 className="w-4 h-4" />
              Businesses
            </TabsTrigger>
            <TabsTrigger value="photographers" className="gap-2" data-testid="tab-photographers">
              <Camera className="w-4 h-4" />
              Photographers
            </TabsTrigger>
            <TabsTrigger value="payments" className="gap-2" data-testid="tab-payments">
              <CreditCard className="w-4 h-4" />
              Payments
            </TabsTrigger>
            <TabsTrigger value="messages" className="gap-2" data-testid="tab-messages">
              <MessageSquare className="w-4 h-4" />
              Messages
            </TabsTrigger>
          </TabsList>

          <TabsContent value="users">
            <UsersTab />
          </TabsContent>

          <TabsContent value="businesses">
            <BusinessesTab />
          </TabsContent>

          <TabsContent value="photographers">
            <PhotographersTab />
          </TabsContent>

          <TabsContent value="payments">
            <PaymentsTab />
          </TabsContent>

          <TabsContent value="messages">
            <MessagesTab />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

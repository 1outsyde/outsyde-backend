import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Camera, DollarSign, Calendar, MessageCircle, Star, Eye, ExternalLink, AlertCircle, Check, Loader2, RotateCcw, Plus, Pencil, Trash2, MapPin, FileText, Phone, User as UserIcon, X, Image, CalendarClock } from "lucide-react";
import { ImageUploader } from "@/components/ImageUploader";
import BillingAddressForm from "@/components/BillingAddressForm";
import BusinessHoursEditor from "@/components/BusinessHoursEditor";
import type { HoursOfOperation } from "@shared/schema";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { Photographer, User, PhotographerService } from "@shared/schema";

interface BookingRecord {
  recordId: string;
  clientId: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  shootType: string;
  serviceName: string | null;
  serviceId: string | null;
  locationDetails: string | null;
  specialRequests: string | null;
  orderedAt: string | null;
  bookingDateTime: string;
  totalPaid: number;
  platformFee: number;
  vendorNet: number;
  paymentIntentId: string | null;
  status: string | null;
}

interface PhotographerDashboardPageProps {
  onLogout: () => void;
}

interface StripeStatus {
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
}

export default function PhotographerDashboardPage({ onLogout }: PhotographerDashboardPageProps) {
  const { toast } = useToast();
  const [refundDialogOpen, setRefundDialogOpen] = useState(false);
  const [selectedRecord, setSelectedRecord] = useState<BookingRecord | null>(null);
  const [refundReason, setRefundReason] = useState("");
  const [refundAttempted, setRefundAttempted] = useState(false);
  const [activeTab, setActiveTab] = useState("bookings");

  const [serviceDialogOpen, setServiceDialogOpen] = useState(false);
  const [editingService, setEditingService] = useState<PhotographerService | null>(null);
  const [serviceName, setServiceName] = useState("");
  const [serviceDescription, setServiceDescription] = useState("");
  const [serviceCategory, setServiceCategory] = useState("");
  const [servicePricingModel, setServicePricingModel] = useState<"hourly" | "package">("package");
  const [serviceHourlyRateCents, setServiceHourlyRateCents] = useState<number | null>(null);
  const [servicePriceCents, setServicePriceCents] = useState<number | null>(null);
  const [servicePackageHours, setServicePackageHours] = useState<number | null>(null);
  const [serviceIsContactForPricing, setServiceIsContactForPricing] = useState(false);
  const [serviceEstimatedDuration, setServiceEstimatedDuration] = useState<number | null>(null);

  const [profileDisplayName, setProfileDisplayName] = useState("");
  const [profileBio, setProfileBio] = useState("");
  const [profileCity, setProfileCity] = useState("");
  const [profileState, setProfileState] = useState("");
  const [profilePortfolioUrl, setProfilePortfolioUrl] = useState("");
  const [profileHourlyRate, setProfileHourlyRate] = useState("");
  const [profileSpecialties, setProfileSpecialties] = useState<string[]>([]);

  // Storefront customization state
  const [storefrontCoverImage, setStorefrontCoverImage] = useState("");
  const [storefrontLogoImage, setStorefrontLogoImage] = useState("");
  const [storefrontPrimaryColor, setStorefrontPrimaryColor] = useState("#eab308");

  const { data: user } = useQuery<User | null>({
    queryKey: ["/api/auth/user"],
  });

  // Fetch photographer bookings
  const { data: bookingsData } = useQuery<{ bookings: BookingRecord[] }>({
    queryKey: ["/api/photographers/me/bookings"],
    enabled: !!user,
  });

  // Fetch photographer services
  const { data: servicesData, isLoading: servicesLoading } = useQuery<{ services: PhotographerService[] }>({
    queryKey: ["/api/photographers/me/services"],
    enabled: !!user,
  });

  // Service mutations
  interface ServiceData {
    name: string;
    description?: string;
    category?: string;
    pricingModel?: "hourly" | "package";
    hourlyRateCents?: number | null;
    priceCents?: number | null;
    packageHours?: number | null;
    isContactForPricing?: boolean;
    estimatedDurationMinutes?: number | null;
  }

  const createServiceMutation = useMutation({
    mutationFn: async (data: ServiceData) => {
      const response = await apiRequest("POST", "/api/photographers/me/services", data);
      return response.json();
    },
    onSuccess: () => {
      toast({ title: "Service Created", description: "Your new service has been added." });
      queryClient.invalidateQueries({ queryKey: ["/api/photographers/me/services"] });
      closeServiceDialog();
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to create service.", variant: "destructive" });
    },
  });

  const updateServiceMutation = useMutation({
    mutationFn: async ({ id, ...data }: { id: string } & ServiceData) => {
      const response = await apiRequest("PATCH", `/api/photographers/me/services/${id}`, data);
      return response.json();
    },
    onSuccess: () => {
      toast({ title: "Service Updated", description: "Your service has been updated." });
      queryClient.invalidateQueries({ queryKey: ["/api/photographers/me/services"] });
      closeServiceDialog();
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to update service.", variant: "destructive" });
    },
  });

  const deleteServiceMutation = useMutation({
    mutationFn: async (id: string) => {
      const response = await apiRequest("DELETE", `/api/photographers/me/services/${id}`);
      return response.json();
    },
    onSuccess: () => {
      toast({ title: "Service Deleted", description: "Your service has been removed." });
      queryClient.invalidateQueries({ queryKey: ["/api/photographers/me/services"] });
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to delete service.", variant: "destructive" });
    },
  });

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
      targetType: "appointment",
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

  const openServiceDialog = (service?: PhotographerService) => {
    if (service) {
      setEditingService(service);
      setServiceName(service.name);
      setServiceDescription(service.description || "");
      setServiceCategory(service.category || "");
      setServicePricingModel((service.pricingModel as "hourly" | "package") || "package");
      setServiceHourlyRateCents(service.hourlyRateCents || null);
      setServicePriceCents(service.priceCents);
      setServicePackageHours(service.packageHours || null);
      setServiceIsContactForPricing(service.isContactForPricing || false);
      setServiceEstimatedDuration(service.estimatedDurationMinutes);
    } else {
      setEditingService(null);
      setServiceName("");
      setServiceDescription("");
      setServiceCategory("");
      setServicePricingModel("package");
      setServiceHourlyRateCents(null);
      setServicePriceCents(null);
      setServicePackageHours(null);
      setServiceIsContactForPricing(false);
      setServiceEstimatedDuration(null);
    }
    setServiceDialogOpen(true);
  };

  const closeServiceDialog = () => {
    setServiceDialogOpen(false);
    setEditingService(null);
    setServiceName("");
    setServiceDescription("");
    setServiceCategory("");
    setServicePricingModel("package");
    setServiceHourlyRateCents(null);
    setServicePriceCents(null);
    setServicePackageHours(null);
    setServiceIsContactForPricing(false);
    setServiceEstimatedDuration(null);
  };

  const handleSaveService = () => {
    if (!serviceName.trim()) return;
    
    const data: ServiceData = {
      name: serviceName.trim(),
      description: serviceDescription.trim() || undefined,
      category: serviceCategory.trim() || undefined,
      pricingModel: servicePricingModel,
      hourlyRateCents: serviceIsContactForPricing ? null : (servicePricingModel === "hourly" ? serviceHourlyRateCents : null),
      priceCents: serviceIsContactForPricing ? null : (servicePricingModel === "package" ? servicePriceCents : null),
      packageHours: servicePricingModel === "package" ? servicePackageHours : null,
      isContactForPricing: serviceIsContactForPricing,
      estimatedDurationMinutes: serviceEstimatedDuration,
    };

    if (editingService) {
      updateServiceMutation.mutate({ id: editingService.id, ...data });
    } else {
      createServiceMutation.mutate(data);
    }
  };

  const { data: photographer, isLoading: photographerLoading } = useQuery<Photographer>({
    queryKey: ["/api/photographers/me"],
    enabled: !!user,
  });

  const { data: stripeStatus, isLoading: stripeLoading } = useQuery<StripeStatus>({
    queryKey: ["/api/photographers/me/stripe-status"],
    enabled: !!photographer?.stripeAccountId,
  });

  const connectStripeMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/photographers/me/stripe-onboarding");
      return response.json();
    },
    onSuccess: (data) => {
      if (data.url) {
        window.location.href = data.url;
      } else {
        toast({
          title: "Error",
          description: "Could not generate Stripe onboarding link",
          variant: "destructive",
        });
      }
    },
    onError: (error: Error) => {
      toast({
        title: "Error",
        description: error.message || "Failed to start Stripe onboarding",
        variant: "destructive",
      });
    },
  });

  const stripeConnected = stripeStatus?.chargesEnabled && stripeStatus?.payoutsEnabled;
  const stripePartial = stripeStatus?.detailsSubmitted && !stripeConnected;

  useEffect(() => {
    if (photographer) {
      setProfileDisplayName(photographer.displayName || "");
      setProfileBio(photographer.bio || "");
      setProfileCity(photographer.city || "");
      setProfileState(photographer.state || "");
      setProfilePortfolioUrl(photographer.portfolioUrl || "");
      // Convert cents to dollars for display
      setProfileHourlyRate(photographer.hourlyRate ? (photographer.hourlyRate / 100).toString() : "");
      setProfileSpecialties(photographer.specialties || []);
      // Storefront customization
      setStorefrontCoverImage(photographer.coverImage || "");
      setStorefrontLogoImage(photographer.logoImage || "");
      setStorefrontPrimaryColor((photographer.brandColors as { primary?: string })?.primary || "#eab308");
    }
  }, [photographer]);

  const updateProfileMutation = useMutation({
    mutationFn: async (data: {
      displayName?: string;
      bio?: string;
      city?: string;
      state?: string;
      portfolioUrl?: string;
      hourlyRate?: number;
      specialties?: string[];
      coverImage?: string;
      logoImage?: string;
      brandColors?: { primary?: string; secondary?: string };
      hoursOfOperation?: HoursOfOperation;
    }) => {
      const response = await apiRequest("PATCH", "/api/photographers/me", data);
      return response.json();
    },
    onSuccess: () => {
      toast({ title: "Changes Saved", description: "Your changes have been saved." });
      queryClient.invalidateQueries({ queryKey: ["/api/photographers/me"] });
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to save changes.", variant: "destructive" });
    },
  });

  const handleSaveProfile = () => {
    updateProfileMutation.mutate({
      displayName: profileDisplayName.trim(),
      bio: profileBio.trim(),
      city: profileCity.trim(),
      state: profileState.trim(),
      portfolioUrl: profilePortfolioUrl.trim(),
      hourlyRate: parseFloat(profileHourlyRate) || 0,
      specialties: profileSpecialties,
    });
  };

  const handleSaveStorefront = () => {
    updateProfileMutation.mutate({
      coverImage: storefrontCoverImage.trim(),
      logoImage: storefrontLogoImage.trim(),
      brandColors: { primary: storefrontPrimaryColor },
    });
  };

  const colorPresets = [
    { name: "Golden Yellow", color: "#eab308" },
    { name: "Rose Pink", color: "#ec4899" },
    { name: "Ocean Blue", color: "#3b82f6" },
    { name: "Forest Green", color: "#22c55e" },
    { name: "Royal Purple", color: "#8b5cf6" },
    { name: "Sunset Orange", color: "#f97316" },
    { name: "Teal", color: "#14b8a6" },
    { name: "Slate Gray", color: "#64748b" },
  ];

  const statCards = [
    {
      title: "Earnings",
      value: "$0",
      icon: DollarSign,
      description: "This month",
    },
    {
      title: "Bookings",
      value: "0",
      icon: Calendar,
      description: "Upcoming",
    },
    {
      title: "Messages",
      value: "0",
      icon: MessageCircle,
      description: "Unread",
    },
    {
      title: "Rating",
      value: photographer?.rating ? photographer.rating.toFixed(1) : "N/A",
      icon: Star,
      description: `${photographer?.reviewCount || 0} reviews`,
    },
  ];

  if (photographerLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background" data-testid="photographer-dashboard">
      <header className="border-b bg-card">
        <div className="container mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center">
              <Camera className="h-5 w-5 text-primary" />
            </div>
            <div>
              <h1 className="font-semibold" data-testid="text-photographer-name">
                {photographer?.displayName || user?.name || "Photographer"}
              </h1>
              <p className="text-sm text-muted-foreground">
                {photographer?.city}, {photographer?.state}
              </p>
            </div>
          </div>
          <Button variant="outline" onClick={onLogout} data-testid="button-logout">
            Log Out
          </Button>
        </div>
      </header>

      <main className="container mx-auto px-4 py-6 space-y-6">
        {!photographer?.stripeAccountId && (
          <Card className="border-yellow-200 bg-yellow-50 dark:border-yellow-900 dark:bg-yellow-950 overflow-visible">
            <CardContent className="p-4">
              <div className="flex items-start gap-4">
                <div className="h-10 w-10 rounded-full bg-yellow-100 dark:bg-yellow-900 flex items-center justify-center shrink-0">
                  <AlertCircle className="h-5 w-5 text-yellow-600 dark:text-yellow-400" />
                </div>
                <div className="flex-1">
                  <h3 className="font-semibold text-yellow-800 dark:text-yellow-200">
                    Complete Your Payment Setup
                  </h3>
                  <p className="text-sm text-yellow-700 dark:text-yellow-300 mt-1">
                    Connect your Stripe account to start receiving payments from bookings. This is required before clients can book your services.
                  </p>
                  <Button
                    className="mt-3 gap-2"
                    onClick={() => connectStripeMutation.mutate()}
                    disabled={connectStripeMutation.isPending}
                    data-testid="button-connect-stripe"
                  >
                    {connectStripeMutation.isPending ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <ExternalLink className="h-4 w-4" />
                    )}
                    Connect with Stripe
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {stripePartial && (
          <Card className="border-orange-200 bg-orange-50 dark:border-orange-900 dark:bg-orange-950 overflow-visible">
            <CardContent className="p-4">
              <div className="flex items-start gap-4">
                <div className="h-10 w-10 rounded-full bg-orange-100 dark:bg-orange-900 flex items-center justify-center shrink-0">
                  <AlertCircle className="h-5 w-5 text-orange-600 dark:text-orange-400" />
                </div>
                <div className="flex-1">
                  <h3 className="font-semibold text-orange-800 dark:text-orange-200">
                    Stripe Onboarding Incomplete
                  </h3>
                  <p className="text-sm text-orange-700 dark:text-orange-300 mt-1">
                    Your Stripe account is pending verification. Please complete the remaining steps to start accepting payments.
                  </p>
                  <Button
                    className="mt-3 gap-2"
                    onClick={() => connectStripeMutation.mutate()}
                    disabled={connectStripeMutation.isPending}
                    data-testid="button-complete-stripe"
                  >
                    {connectStripeMutation.isPending ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <ExternalLink className="h-4 w-4" />
                    )}
                    Complete Stripe Setup
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {stripeConnected && (
          <Card className="border-green-200 bg-green-50 dark:border-green-900 dark:bg-green-950 overflow-visible">
            <CardContent className="p-4">
              <div className="flex items-center gap-4">
                <div className="h-10 w-10 rounded-full bg-green-100 dark:bg-green-900 flex items-center justify-center shrink-0">
                  <Check className="h-5 w-5 text-green-600 dark:text-green-400" />
                </div>
                <div>
                  <h3 className="font-semibold text-green-800 dark:text-green-200">
                    Payments Enabled
                  </h3>
                  <p className="text-sm text-green-700 dark:text-green-300">
                    Your Stripe account is connected and ready to receive payments.
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

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
                    <p className="text-xs text-muted-foreground mt-1">{stat.description}</p>
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
              <CardHeader className="pb-2">
                <CardTitle className="text-lg">Profile Overview</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  <div className="flex items-center gap-4">
                    <Avatar className="h-16 w-16">
                      <AvatarImage src={undefined} alt={photographer?.displayName} />
                      <AvatarFallback className="text-lg">
                        {photographer?.displayName?.charAt(0) || "P"}
                      </AvatarFallback>
                    </Avatar>
                    <div className="flex-1">
                      <h3 className="font-semibold text-lg">{photographer?.displayName}</h3>
                      <p className="text-sm text-muted-foreground">
                        ${photographer?.hourlyRate}/hour
                      </p>
                      {photographer?.specialties && photographer.specialties.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-2">
                          {photographer.specialties.slice(0, 4).map((specialty) => (
                            <Badge key={specialty} variant="secondary" className="text-xs">
                              {specialty}
                            </Badge>
                          ))}
                          {photographer.specialties.length > 4 && (
                            <Badge variant="outline" className="text-xs">
                              +{photographer.specialties.length - 4} more
                            </Badge>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                  {photographer?.bio && (
                    <p className="text-sm text-muted-foreground">{photographer.bio}</p>
                  )}
                  {photographer?.portfolioUrl && (
                    <a
                      href={photographer.portfolioUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
                      data-testid="link-portfolio"
                    >
                      <ExternalLink className="h-3 w-3" />
                      View Portfolio
                    </a>
                  )}
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
                    <p className="text-2xl font-bold" data-testid="stat-views">0</p>
                    <p className="text-sm text-muted-foreground">Profile Views</p>
                  </div>
                </CardContent>
              </Card>
              <Card className="overflow-visible">
                <CardContent className="p-4 flex items-center gap-4">
                  <div className="h-12 w-12 rounded-full bg-purple-100 dark:bg-purple-900 flex items-center justify-center">
                    <Camera className="h-6 w-6 text-purple-600 dark:text-purple-300" />
                  </div>
                  <div>
                    <p className="text-2xl font-bold" data-testid="stat-shoots">0</p>
                    <p className="text-sm text-muted-foreground">Completed Shoots</p>
                  </div>
                </CardContent>
              </Card>
            </div>
          </div>

          <Card className="overflow-visible">
            <Tabs value={activeTab} onValueChange={setActiveTab}>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <TabsList>
                    <TabsTrigger value="bookings" data-testid="tab-bookings">Bookings</TabsTrigger>
                    <TabsTrigger value="services" data-testid="tab-services">Services</TabsTrigger>
                    <TabsTrigger value="hours" data-testid="tab-hours">
                      <CalendarClock className="h-4 w-4 mr-1" />
                      Hours
                    </TabsTrigger>
                    <TabsTrigger value="storefront" data-testid="tab-storefront">Storefront</TabsTrigger>
                    <TabsTrigger value="profile" data-testid="tab-profile">Profile</TabsTrigger>
                  </TabsList>
                  {activeTab === "services" && (
                    <Button size="sm" onClick={() => openServiceDialog()} data-testid="button-add-service">
                      <Plus className="h-4 w-4 mr-1" /> Add Service
                    </Button>
                  )}
                </div>
              </CardHeader>
              <CardContent>
                <TabsContent value="bookings" className="mt-0">
                  {bookingsData?.bookings && bookingsData.bookings.length > 0 ? (
                    <div className="space-y-4">
                      {bookingsData.bookings.map((booking) => (
                        <Card key={booking.recordId} className="overflow-visible" data-testid={`booking-${booking.recordId}`}>
                          <CardContent className="p-4">
                            <div className="flex items-start justify-between gap-4 flex-wrap">
                              <div className="flex-1 min-w-0 space-y-2">
                                <div className="flex items-center gap-2 flex-wrap">
                                  <p className="font-semibold">
                                    {booking.firstName || ''} {booking.lastName || ''}
                                  </p>
                                  <Badge variant="secondary" className="text-xs">
                                    {booking.status || 'pending'}
                                  </Badge>
                                </div>
                                <p className="text-sm text-muted-foreground">{booking.email || 'No email'}</p>
                                
                                <div className="flex items-center gap-2 text-sm">
                                  <Camera className="h-4 w-4 text-muted-foreground" />
                                  <span className="font-medium">{booking.serviceName || booking.shootType}</span>
                                </div>
                                
                                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                                  <Calendar className="h-4 w-4" />
                                  <span>{new Date(booking.bookingDateTime).toLocaleString()}</span>
                                </div>
                                
                                {booking.locationDetails && (
                                  <div className="flex items-start gap-2 text-sm text-muted-foreground">
                                    <MapPin className="h-4 w-4 mt-0.5 shrink-0" />
                                    <span>{booking.locationDetails}</span>
                                  </div>
                                )}
                                
                                {booking.specialRequests && (
                                  <div className="mt-3 p-3 rounded-md bg-muted/50">
                                    <div className="flex items-center gap-2 text-sm font-medium mb-1">
                                      <FileText className="h-4 w-4" />
                                      <span>Client Notes</span>
                                    </div>
                                    <p className="text-sm text-muted-foreground">{booking.specialRequests}</p>
                                  </div>
                                )}
                              </div>
                              
                              <div className="flex flex-col items-end gap-2">
                                <p className="font-semibold text-lg text-green-600 dark:text-green-400">
                                  ${(booking.vendorNet / 100).toFixed(2)}
                                </p>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => {
                                    setSelectedRecord(booking);
                                    setRefundDialogOpen(true);
                                  }}
                                  data-testid={`button-refund-${booking.recordId}`}
                                >
                                  <RotateCcw className="h-3 w-3 mr-1" /> Refund
                                </Button>
                              </div>
                            </div>
                          </CardContent>
                        </Card>
                      ))}
                    </div>
                  ) : (
                    <div className="text-center py-8 text-muted-foreground">
                      <Calendar className="h-12 w-12 mx-auto mb-3 opacity-50" />
                      <p className="text-sm">No bookings yet</p>
                      <p className="text-xs mt-1">Bookings will appear here once clients book your services</p>
                    </div>
                  )}
                </TabsContent>

                <TabsContent value="services" className="mt-0">
                  {servicesLoading ? (
                    <div className="flex items-center justify-center py-8">
                      <Loader2 className="h-6 w-6 animate-spin" />
                    </div>
                  ) : servicesData?.services && servicesData.services.length > 0 ? (
                    <div className="space-y-3">
                      {servicesData.services.map((service) => (
                        <div
                          key={service.id}
                          className="flex items-center justify-between p-4 rounded-lg border bg-card"
                          data-testid={`service-${service.id}`}
                        >
                          <div className="flex-1 min-w-0">
                            <p className="font-medium">{service.name}</p>
                            {service.category && (
                              <Badge variant="outline" className="text-xs mt-1">{service.category}</Badge>
                            )}
                            {service.description && (
                              <p className="text-sm text-muted-foreground mt-1 line-clamp-2">{service.description}</p>
                            )}
                            <div className="flex items-center gap-4 mt-2 text-sm text-muted-foreground">
                              {service.isContactForPricing ? (
                                <div className="flex items-center gap-1">
                                  <Phone className="h-3 w-3" />
                                  <span>Contact for pricing</span>
                                </div>
                              ) : service.pricingModel === "hourly" && service.hourlyRateCents ? (
                                <span className="font-medium text-foreground">
                                  ${(service.hourlyRateCents / 100).toFixed(2)}/hr
                                </span>
                              ) : service.priceCents ? (
                                <span className="font-medium text-foreground">
                                  ${(service.priceCents / 100).toFixed(2)}
                                  {service.packageHours && ` for ${service.packageHours}hr${service.packageHours > 1 ? 's' : ''}`}
                                </span>
                              ) : null}
                              {service.estimatedDurationMinutes && (
                                <span>{service.estimatedDurationMinutes} min</span>
                              )}
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            <Button
                              size="icon"
                              variant="ghost"
                              onClick={() => openServiceDialog(service)}
                              data-testid={`button-edit-service-${service.id}`}
                            >
                              <Pencil className="h-4 w-4" />
                            </Button>
                            <Button
                              size="icon"
                              variant="ghost"
                              onClick={() => deleteServiceMutation.mutate(service.id)}
                              disabled={deleteServiceMutation.isPending}
                              data-testid={`button-delete-service-${service.id}`}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="text-center py-8 text-muted-foreground">
                      <Camera className="h-12 w-12 mx-auto mb-3 opacity-50" />
                      <p className="text-sm">No services yet</p>
                      <p className="text-xs mt-1">Add custom services like wedding photography, studio shoots, etc.</p>
                      <Button className="mt-4" onClick={() => openServiceDialog()} data-testid="button-add-first-service">
                        <Plus className="h-4 w-4 mr-1" /> Add Your First Service
                      </Button>
                    </div>
                  )}
                </TabsContent>

                <TabsContent value="hours" className="mt-0">
                  <BusinessHoursEditor
                    hours={photographer?.hoursOfOperation as HoursOfOperation | null}
                    onSave={(hours) => updateProfileMutation.mutate({ hoursOfOperation: hours })}
                    isPending={updateProfileMutation.isPending}
                  />
                </TabsContent>

                <TabsContent value="storefront" className="mt-0">
                  <div className="space-y-6">
                    <div>
                      <h3 className="text-lg font-medium mb-4">Customize Your Storefront</h3>
                      <p className="text-sm text-muted-foreground mb-6">
                        Personalize how your page looks to clients. Choose your brand color and add images to make your storefront stand out.
                      </p>
                    </div>

                    <div className="space-y-4">
                      <div>
                        <Label className="text-base font-medium">Brand Color</Label>
                        <p className="text-sm text-muted-foreground mb-3">
                          Choose a color that represents your brand. This will be used as the accent color on your page.
                        </p>
                        <div className="flex flex-wrap gap-3 mb-4">
                          {colorPresets.map((preset) => (
                            <button
                              key={preset.color}
                              type="button"
                              onClick={() => setStorefrontPrimaryColor(preset.color)}
                              className={`w-10 h-10 rounded-full border-2 transition-all ${
                                storefrontPrimaryColor === preset.color 
                                  ? "border-foreground scale-110" 
                                  : "border-transparent hover:scale-105"
                              }`}
                              style={{ backgroundColor: preset.color }}
                              title={preset.name}
                              data-testid={`color-preset-${preset.name.toLowerCase().replace(/\s/g, '-')}`}
                            />
                          ))}
                        </div>
                        <div className="flex items-center gap-3">
                          <Label htmlFor="custom-color" className="text-sm">Custom Color:</Label>
                          <input
                            id="custom-color"
                            type="color"
                            value={storefrontPrimaryColor}
                            onChange={(e) => setStorefrontPrimaryColor(e.target.value)}
                            className="w-12 h-10 rounded cursor-pointer border"
                            data-testid="input-custom-color"
                          />
                          <Input
                            value={storefrontPrimaryColor}
                            onChange={(e) => setStorefrontPrimaryColor(e.target.value)}
                            placeholder="#eab308"
                            className="w-28"
                            data-testid="input-color-hex"
                          />
                        </div>
                      </div>

                      <div className="pt-4 border-t">
                        <Label className="flex items-center gap-2">
                          <Image className="h-4 w-4" />
                          Cover Image
                        </Label>
                        <p className="text-sm text-muted-foreground mb-2">
                          Add a banner image for the top of your page. Use a landscape photo (recommended: 1920x600px).
                        </p>
                        {storefrontCoverImage ? (
                          <div className="relative">
                            <div className="mt-3 rounded-lg overflow-hidden border">
                              <img 
                                src={storefrontCoverImage} 
                                alt="Cover preview" 
                                className="w-full h-32 object-cover"
                                onError={(e) => (e.currentTarget.style.display = 'none')}
                              />
                            </div>
                            <Button
                              type="button"
                              size="icon"
                              variant="secondary"
                              className="absolute top-5 right-2"
                              onClick={() => setStorefrontCoverImage("")}
                              data-testid="button-remove-cover"
                            >
                              <X className="h-4 w-4" />
                            </Button>
                          </div>
                        ) : (
                          <ImageUploader
                            onUploadComplete={(url) => setStorefrontCoverImage(url)}
                            buttonVariant="outline"
                            buttonClassName="w-full"
                          >
                            <Camera className="h-4 w-4 mr-2" />
                            Upload Cover Image
                          </ImageUploader>
                        )}
                      </div>

                      <div>
                        <Label className="flex items-center gap-2">
                          <Image className="h-4 w-4" />
                          Logo / Profile Photo
                        </Label>
                        <p className="text-sm text-muted-foreground mb-2">
                          Add your logo or profile photo. Use a square image (recommended: 400x400px).
                        </p>
                        {storefrontLogoImage ? (
                          <div className="flex items-center gap-3">
                            <div className="relative">
                              <div className="w-16 h-16 rounded-full overflow-hidden border">
                                <img 
                                  src={storefrontLogoImage} 
                                  alt="Logo preview" 
                                  className="w-full h-full object-cover"
                                  onError={(e) => (e.currentTarget.style.display = 'none')}
                                />
                              </div>
                              <Button
                                type="button"
                                size="icon"
                                variant="secondary"
                                className="absolute -top-2 -right-2 h-6 w-6"
                                onClick={() => setStorefrontLogoImage("")}
                                data-testid="button-remove-logo"
                              >
                                <X className="h-3 w-3" />
                              </Button>
                            </div>
                            <span className="text-sm text-muted-foreground">Logo preview</span>
                          </div>
                        ) : (
                          <ImageUploader
                            onUploadComplete={(url) => setStorefrontLogoImage(url)}
                            buttonVariant="outline"
                          >
                            <Camera className="h-4 w-4 mr-2" />
                            Upload Logo
                          </ImageUploader>
                        )}
                      </div>

                      <div className="pt-4 border-t">
                        <Label className="text-base font-medium">Preview</Label>
                        <p className="text-sm text-muted-foreground mb-3">
                          This is how your brand color will appear on your page.
                        </p>
                        <div className="p-4 border rounded-lg">
                          <div 
                            className="h-2 rounded-full mb-3" 
                            style={{ backgroundColor: storefrontPrimaryColor }}
                          />
                          <div className="flex items-center gap-2">
                            <div 
                              className="w-3 h-3 rounded-full" 
                              style={{ backgroundColor: storefrontPrimaryColor }}
                            />
                            <span className="text-sm font-medium" style={{ color: storefrontPrimaryColor }}>
                              Accent text in your brand color
                            </span>
                          </div>
                          <Button 
                            size="sm" 
                            className="mt-3"
                            style={{ backgroundColor: storefrontPrimaryColor }}
                          >
                            Sample Button
                          </Button>
                        </div>
                      </div>
                    </div>

                    <Button
                      onClick={handleSaveStorefront}
                      disabled={updateProfileMutation.isPending}
                      className="w-full"
                      data-testid="button-save-storefront"
                    >
                      {updateProfileMutation.isPending ? (
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      ) : (
                        <Check className="h-4 w-4 mr-2" />
                      )}
                      Save Storefront
                    </Button>
                  </div>
                </TabsContent>

                <TabsContent value="profile" className="mt-0">
                  <div className="space-y-4">
                    <div className="grid gap-4 sm:grid-cols-2">
                      <div>
                        <Label htmlFor="profile-displayName">Display Name</Label>
                        <Input
                          id="profile-displayName"
                          value={profileDisplayName}
                          onChange={(e) => setProfileDisplayName(e.target.value)}
                          placeholder="Your photographer name"
                          data-testid="input-profile-displayName"
                        />
                      </div>
                      <div>
                        <Label htmlFor="profile-hourlyRate">Hourly Rate ($)</Label>
                        <Input
                          id="profile-hourlyRate"
                          type="number"
                          value={profileHourlyRate}
                          onChange={(e) => setProfileHourlyRate(e.target.value)}
                          placeholder="150"
                          data-testid="input-profile-hourlyRate"
                        />
                      </div>
                    </div>

                    <div>
                      <Label htmlFor="profile-bio">Bio</Label>
                      <Textarea
                        id="profile-bio"
                        value={profileBio}
                        onChange={(e) => setProfileBio(e.target.value)}
                        placeholder="Tell clients about yourself and your photography style..."
                        className="resize-none"
                        rows={3}
                        data-testid="input-profile-bio"
                      />
                    </div>

                    <div className="grid gap-4 sm:grid-cols-2">
                      <div>
                        <Label htmlFor="profile-city">City</Label>
                        <Input
                          id="profile-city"
                          value={profileCity}
                          onChange={(e) => setProfileCity(e.target.value)}
                          placeholder="Los Angeles"
                          data-testid="input-profile-city"
                        />
                      </div>
                      <div>
                        <Label htmlFor="profile-state">State</Label>
                        <Input
                          id="profile-state"
                          value={profileState}
                          onChange={(e) => setProfileState(e.target.value)}
                          placeholder="CA"
                          data-testid="input-profile-state"
                        />
                      </div>
                    </div>

                    <div>
                      <Label htmlFor="profile-portfolioUrl">Portfolio URL</Label>
                      <Input
                        id="profile-portfolioUrl"
                        type="url"
                        value={profilePortfolioUrl}
                        onChange={(e) => setProfilePortfolioUrl(e.target.value)}
                        placeholder="https://yourportfolio.com"
                        data-testid="input-profile-portfolioUrl"
                      />
                    </div>

                    <div>
                      <Label>Specialties</Label>
                      <div className="flex flex-wrap gap-2 mt-2">
                        {["Portraits", "Weddings", "Events", "Products", "Fashion", "Real Estate", "Concerts", "Sports"].map((specialty) => (
                          <Badge
                            key={specialty}
                            variant={profileSpecialties.includes(specialty) ? "default" : "outline"}
                            className="cursor-pointer"
                            onClick={() => {
                              if (profileSpecialties.includes(specialty)) {
                                setProfileSpecialties(profileSpecialties.filter(s => s !== specialty));
                              } else {
                                setProfileSpecialties([...profileSpecialties, specialty]);
                              }
                            }}
                            data-testid={`badge-specialty-${specialty.toLowerCase()}`}
                          >
                            {specialty}
                          </Badge>
                        ))}
                      </div>
                    </div>

                    <Button
                      onClick={handleSaveProfile}
                      disabled={updateProfileMutation.isPending || !profileDisplayName.trim()}
                      className="w-full"
                      data-testid="button-save-profile"
                    >
                      {updateProfileMutation.isPending ? (
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      ) : (
                        <UserIcon className="h-4 w-4 mr-2" />
                      )}
                      Save Profile
                    </Button>
                  </div>
                </TabsContent>
              </CardContent>
            </Tabs>
          </Card>

          <BillingAddressForm
            currentAddress={photographer?.billingAddress}
            endpoint="/api/photographers/me/billing-address"
            queryKeyToInvalidate={["/api/photographers/me"]}
            title="Billing Address"
          />
        </div>
      </main>

      {/* Refund Request Dialog */}
      <Dialog open={refundDialogOpen} onOpenChange={(open) => !open && closeRefundDialog()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Request Refund</DialogTitle>
            <DialogDescription>
              Submit a refund request for this booking. Admin will be notified and review your request.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div>
              <p className="text-sm text-muted-foreground mb-2">
                <strong>Client:</strong> {selectedRecord?.firstName || ''} {selectedRecord?.lastName || ''} ({selectedRecord?.email || 'No email'})
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

      {/* Service Dialog */}
      <Dialog open={serviceDialogOpen} onOpenChange={(open) => !open && closeServiceDialog()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingService ? "Edit Service" : "Add New Service"}</DialogTitle>
            <DialogDescription>
              {editingService 
                ? "Update your service details below."
                : "Add a custom service like wedding photography, studio shoots, music video cinematography, etc."
              }
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="service-name">Service Name *</Label>
              <Input
                id="service-name"
                placeholder="e.g., Wedding Photography, Studio Session"
                value={serviceName}
                onChange={(e) => setServiceName(e.target.value)}
                data-testid="input-service-name"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="service-category">Category</Label>
              <Input
                id="service-category"
                placeholder="e.g., Weddings, Portraits, Events"
                value={serviceCategory}
                onChange={(e) => setServiceCategory(e.target.value)}
                data-testid="input-service-category"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="service-description">Description</Label>
              <Textarea
                id="service-description"
                placeholder="Describe what's included in this service..."
                value={serviceDescription}
                onChange={(e) => setServiceDescription(e.target.value)}
                data-testid="input-service-description"
              />
            </div>

            <div className="flex items-center justify-between">
              <Label htmlFor="contact-for-pricing">Contact for Pricing</Label>
              <Switch
                id="contact-for-pricing"
                checked={serviceIsContactForPricing}
                onCheckedChange={setServiceIsContactForPricing}
                data-testid="switch-contact-for-pricing"
              />
            </div>

            {!serviceIsContactForPricing && (
              <>
                <div className="space-y-2">
                  <Label>Pricing Type</Label>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant={servicePricingModel === "package" ? "default" : "outline"}
                      onClick={() => setServicePricingModel("package")}
                      className="flex-1"
                      data-testid="button-pricing-package"
                    >
                      Package (Flat Rate)
                    </Button>
                    <Button
                      type="button"
                      variant={servicePricingModel === "hourly" ? "default" : "outline"}
                      onClick={() => setServicePricingModel("hourly")}
                      className="flex-1"
                      data-testid="button-pricing-hourly"
                    >
                      Hourly Rate
                    </Button>
                  </div>
                </div>

                {servicePricingModel === "package" ? (
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="service-price">Package Price ($)</Label>
                      <Input
                        id="service-price"
                        type="number"
                        min="0"
                        step="0.01"
                        placeholder="e.g., 600"
                        value={servicePriceCents ? (servicePriceCents / 100).toFixed(2) : ""}
                        onChange={(e) => setServicePriceCents(e.target.value ? Math.round(parseFloat(e.target.value) * 100) : null)}
                        data-testid="input-service-price"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="package-hours">Hours Included</Label>
                      <Input
                        id="package-hours"
                        type="number"
                        min="1"
                        placeholder="e.g., 3"
                        value={servicePackageHours || ""}
                        onChange={(e) => setServicePackageHours(e.target.value ? parseInt(e.target.value) : null)}
                        data-testid="input-package-hours"
                      />
                    </div>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <Label htmlFor="hourly-rate">Hourly Rate ($)</Label>
                    <Input
                      id="hourly-rate"
                      type="number"
                      min="0"
                      step="0.01"
                      placeholder="e.g., 150"
                      value={serviceHourlyRateCents ? (serviceHourlyRateCents / 100).toFixed(2) : ""}
                      onChange={(e) => setServiceHourlyRateCents(e.target.value ? Math.round(parseFloat(e.target.value) * 100) : null)}
                      data-testid="input-hourly-rate"
                    />
                  </div>
                )}
              </>
            )}

            <div className="space-y-2">
              <Label htmlFor="service-duration">Estimated Duration (minutes)</Label>
              <Input
                id="service-duration"
                type="number"
                min="0"
                placeholder="e.g., 60, 120, 180"
                value={serviceEstimatedDuration || ""}
                onChange={(e) => setServiceEstimatedDuration(e.target.value ? parseInt(e.target.value) : null)}
                data-testid="input-service-duration"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={closeServiceDialog} data-testid="button-cancel-service">
              Cancel
            </Button>
            <Button
              onClick={handleSaveService}
              disabled={!serviceName.trim() || createServiceMutation.isPending || updateServiceMutation.isPending}
              data-testid="button-save-service"
            >
              {createServiceMutation.isPending || updateServiceMutation.isPending ? "Saving..." : editingService ? "Update Service" : "Add Service"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

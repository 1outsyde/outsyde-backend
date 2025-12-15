import { useQuery, useMutation } from "@tanstack/react-query";
import { Camera, DollarSign, Calendar, MessageCircle, Star, Eye, ExternalLink, AlertCircle, Check, Loader2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import type { Photographer, User } from "@shared/schema";

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

  const { data: user } = useQuery<User | null>({
    queryKey: ["/api/auth/user"],
  });

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
            <CardHeader className="pb-2">
              <CardTitle className="text-lg">Upcoming Bookings</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-center py-8 text-muted-foreground">
                <Calendar className="h-12 w-12 mx-auto mb-3 opacity-50" />
                <p className="text-sm">No upcoming bookings</p>
                <p className="text-xs mt-1">Bookings will appear here once clients book your services</p>
              </div>
            </CardContent>
          </Card>
        </div>
      </main>
    </div>
  );
}

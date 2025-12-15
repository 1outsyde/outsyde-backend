import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogTrigger } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { format } from "date-fns";
import { useState } from "react";
import {
  Camera,
  Users,
  Sparkles,
  Crown,
  Zap,
  Calendar,
  Check,
  Clock,
  AlertCircle,
  ShoppingCart
} from "lucide-react";

interface SubscriptionData {
  subscription: {
    id: string;
    tierId: string;
    status: string;
    currentPeriodEnd: string | null;
  } | null;
  tier: {
    id: string;
    name: string;
    displayName: string;
    priceInCents: number;
    applicationFeePercent: number;
  } | null;
}

interface BenefitAllowance {
  id: string;
  benefitId: string;
  cycleType: string;
  totalAllowed: number;
  usedCount: number;
  cycleStartDate: string;
  cycleEndDate: string;
  benefit: {
    benefitType: string;
    displayName: string;
    description: string;
  };
}

interface AlaCarteService {
  id: string;
  serviceType: string;
  displayName: string;
  description: string;
  basePriceInCents: number;
  isActive: boolean;
}

const tierIcons: Record<string, typeof Crown> = {
  access: Zap,
  growth: Sparkles,
  pro: Crown,
};

const benefitIcons: Record<string, typeof Camera> = {
  product_shoot: Camera,
  lifestyle_shoot: Camera,
  influencer_promo: Users,
};

const tierColors: Record<string, string> = {
  access: "bg-blue-500",
  growth: "bg-purple-500",
  pro: "bg-amber-500",
};

function TierBadge({ tierName }: { tierName: string }) {
  const Icon = tierIcons[tierName] || Zap;
  return (
    <Badge className={`${tierColors[tierName] || "bg-primary"} text-white gap-1`}>
      <Icon className="w-3 h-3" />
      {tierName.charAt(0).toUpperCase() + tierName.slice(1)}
    </Badge>
  );
}

function BenefitCard({ allowance, onUse }: { allowance: BenefitAllowance; onUse: () => void }) {
  const Icon = benefitIcons[allowance.benefit.benefitType] || Camera;
  const remaining = allowance.totalAllowed - allowance.usedCount;
  const usagePercent = (allowance.usedCount / allowance.totalAllowed) * 100;
  const isAvailable = remaining > 0;
  const expiresDate = new Date(allowance.cycleEndDate);
  const isExpiringSoon = expiresDate.getTime() - Date.now() < 7 * 24 * 60 * 60 * 1000; // 7 days

  return (
    <Card data-testid={`benefit-card-${allowance.id}`}>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <div className="p-2 rounded-lg bg-muted">
              <Icon className="w-5 h-5" />
            </div>
            <div>
              <CardTitle className="text-base">{allowance.benefit.displayName}</CardTitle>
              <Badge variant="outline" className="text-xs mt-1">
                {allowance.cycleType === "monthly" ? "Monthly" : "Quarterly"}
              </Badge>
            </div>
          </div>
          <div className="text-right">
            <p className="text-2xl font-bold">{remaining}</p>
            <p className="text-xs text-muted-foreground">remaining</p>
          </div>
        </div>
      </CardHeader>
      <CardContent className="pb-3">
        <p className="text-sm text-muted-foreground mb-3">{allowance.benefit.description}</p>
        <div className="space-y-2">
          <Progress value={usagePercent} className="h-2" />
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>Used: {allowance.usedCount} / {allowance.totalAllowed}</span>
            <span className={isExpiringSoon ? "text-destructive font-medium" : ""}>
              {isExpiringSoon && <AlertCircle className="w-3 h-3 inline mr-1" />}
              Expires: {format(expiresDate, "MMM d, yyyy")}
            </span>
          </div>
        </div>
      </CardContent>
      <CardFooter>
        <Button
          className="w-full"
          disabled={!isAvailable}
          onClick={onUse}
          data-testid={`button-use-benefit-${allowance.id}`}
        >
          {isAvailable ? (
            <>
              <Calendar className="w-4 h-4 mr-2" />
              Schedule {allowance.benefit.benefitType.includes("shoot") ? "Shoot" : "Promo"}
            </>
          ) : (
            <>
              <Check className="w-4 h-4 mr-2" />
              All Used
            </>
          )}
        </Button>
      </CardFooter>
    </Card>
  );
}

function UseBenefitDialog({
  allowance,
  open,
  onOpenChange,
}: {
  allowance: BenefitAllowance | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { toast } = useToast();
  const [notes, setNotes] = useState("");

  const benefitMutation = useMutation({
    mutationFn: async () => {
      if (!allowance) return;
      return apiRequest("POST", `/api/vendor/benefits/${allowance.id}/use`, { notes });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/vendor/benefits"] });
      queryClient.invalidateQueries({ queryKey: ["/api/vendor/subscription"] });
      toast({ title: "Benefit scheduled! Our team will reach out soon." });
      setNotes("");
      onOpenChange(false);
    },
    onError: () => {
      toast({ title: "Failed to use benefit", variant: "destructive" });
    },
  });

  if (!allowance) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Schedule {allowance.benefit.displayName}</DialogTitle>
          <DialogDescription>
            Our team will reach out to schedule your {allowance.benefit.benefitType.replace("_", " ")}.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="p-3 bg-muted rounded-lg">
            <p className="text-sm">
              <strong>Remaining:</strong> {allowance.totalAllowed - allowance.usedCount} of {allowance.totalAllowed}
            </p>
            <p className="text-sm text-muted-foreground mt-1">
              Expires: {format(new Date(allowance.cycleEndDate), "MMMM d, yyyy")}
            </p>
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">Notes for our team (optional)</label>
            <Textarea
              placeholder="Any specific requirements or preferences..."
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              data-testid="input-benefit-notes"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} data-testid="button-cancel-benefit">
            Cancel
          </Button>
          <Button
            onClick={() => benefitMutation.mutate()}
            disabled={benefitMutation.isPending}
            data-testid="button-confirm-benefit"
          >
            {benefitMutation.isPending ? "Scheduling..." : "Schedule Now"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AlaCarteServiceCard({ service, tierName }: { service: AlaCarteService; tierName: string | null }) {
  const { toast } = useToast();
  const [notes, setNotes] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);

  const { data: pricing, isLoading: pricingLoading, isError: pricingError, refetch: refetchPricing } = useQuery<{
    basePriceInCents: number;
    discountPercent: number;
    finalPriceInCents: number;
    tierName: string | null;
  }>({
    queryKey: [`/api/ala-carte/services/${service.id}/pricing`],
    enabled: dialogOpen,
  });

  const checkoutMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/ala-carte/checkout", {
        serviceId: service.id,
        notes,
      });
      return response.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/ala-carte/services"] });
      if (data.checkoutUrl) {
        window.location.href = data.checkoutUrl;
      }
    },
    onError: () => {
      toast({ title: "Failed to create checkout", variant: "destructive" });
    },
  });

  const Icon = benefitIcons[service.serviceType] || Camera;
  const basePrice = service.basePriceInCents / 100;
  const finalPrice = pricing ? pricing.finalPriceInCents / 100 : basePrice;
  const hasDiscount = pricing && pricing.discountPercent > 0;

  return (
    <Card data-testid={`service-card-${service.id}`}>
      <CardHeader className="pb-2">
        <div className="flex items-center gap-2">
          <div className="p-2 rounded-lg bg-muted">
            <Icon className="w-5 h-5" />
          </div>
          <div>
            <CardTitle className="text-base">{service.displayName}</CardTitle>
            <p className="text-sm text-muted-foreground">{service.description}</p>
          </div>
        </div>
      </CardHeader>
      <CardContent className="pb-3">
        <div className="flex items-baseline gap-2">
          {hasDiscount ? (
            <>
              <span className="text-2xl font-bold">${finalPrice.toFixed(0)}</span>
              <span className="text-sm text-muted-foreground line-through">${basePrice.toFixed(0)}</span>
              <Badge variant="secondary" className="text-xs">
                {pricing.discountPercent}% off
              </Badge>
            </>
          ) : (
            <span className="text-2xl font-bold">${basePrice.toFixed(0)}</span>
          )}
        </div>
        {tierName && hasDiscount && (
          <p className="text-xs text-muted-foreground mt-2">
            Subscriber discount applied ({tierName} tier)
          </p>
        )}
      </CardContent>
      <CardFooter>
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger asChild>
            <Button variant="outline" className="w-full" data-testid={`button-purchase-${service.id}`}>
              <ShoppingCart className="w-4 h-4 mr-2" />
              Purchase
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Purchase {service.displayName}</DialogTitle>
              <DialogDescription>
                Complete your purchase and our team will reach out to schedule.
              </DialogDescription>
            </DialogHeader>
            {pricingLoading ? (
              <div className="flex items-center justify-center py-8">
                <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary"></div>
              </div>
            ) : pricingError ? (
              <div className="py-8 text-center">
                <AlertCircle className="w-10 h-10 mx-auto text-destructive mb-3" />
                <p className="text-sm text-destructive mb-3">Failed to load pricing.</p>
                <Button variant="outline" onClick={() => refetchPricing()} data-testid="button-retry-pricing">
                  Try Again
                </Button>
              </div>
            ) : (
              <>
                <div className="space-y-4 py-4">
                  <div className="p-4 bg-muted rounded-lg">
                    <div className="flex items-center justify-between mb-2">
                      <span className="font-medium">{service.displayName}</span>
                      <div className="text-right">
                        {hasDiscount ? (
                          <div>
                            <span className="font-bold">${finalPrice.toFixed(2)}</span>
                            <span className="text-sm text-muted-foreground line-through ml-2">
                              ${basePrice.toFixed(2)}
                            </span>
                          </div>
                        ) : (
                          <span className="font-bold">${finalPrice.toFixed(2)}</span>
                        )}
                      </div>
                    </div>
                    {hasDiscount && pricing && (
                      <p className="text-sm text-green-600 dark:text-green-400">
                        You save ${(basePrice - finalPrice).toFixed(2)} with your {pricing.tierName} subscription!
                      </p>
                    )}
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Notes for our team (optional)</label>
                    <Textarea
                      placeholder="Any specific requirements or preferences..."
                      value={notes}
                      onChange={(e) => setNotes(e.target.value)}
                      data-testid="input-purchase-notes"
                    />
                  </div>
                </div>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setDialogOpen(false)} data-testid="button-cancel-purchase">
                    Cancel
                  </Button>
                  <Button
                    onClick={() => checkoutMutation.mutate()}
                    disabled={checkoutMutation.isPending || !pricing}
                    data-testid="button-confirm-purchase"
                  >
                    {checkoutMutation.isPending ? "Processing..." : `Pay $${finalPrice.toFixed(2)}`}
                  </Button>
                </DialogFooter>
              </>
            )}
          </DialogContent>
        </Dialog>
      </CardFooter>
    </Card>
  );
}

export default function VendorSubscriptionDashboard() {
  const [selectedBenefit, setSelectedBenefit] = useState<BenefitAllowance | null>(null);
  const [benefitDialogOpen, setBenefitDialogOpen] = useState(false);

  const { data: subscriptionData, isLoading: subLoading, isError: subError } = useQuery<SubscriptionData>({
    queryKey: ["/api/vendor/subscription"],
  });

  const { data: benefitsData, isLoading: benefitsLoading, isError: benefitsError } = useQuery<{ allowances: BenefitAllowance[] }>({
    queryKey: ["/api/vendor/benefits"],
  });

  const { data: servicesData, isLoading: servicesLoading, isError: servicesError } = useQuery<{ services: AlaCarteService[] }>({
    queryKey: ["/api/ala-carte/services"],
  });

  const subscription = subscriptionData?.subscription;
  const tier = subscriptionData?.tier;
  const allowances = benefitsData?.allowances || [];
  const services = servicesData?.services?.filter(s => s.isActive) || [];

  const handleUseBenefit = (allowance: BenefitAllowance) => {
    setSelectedBenefit(allowance);
    setBenefitDialogOpen(true);
  };

  if (subLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  if (subError) {
    return (
      <Card className="text-center py-12" data-testid="subscription-error-card">
        <CardContent>
          <AlertCircle className="w-12 h-12 mx-auto text-destructive mb-4" />
          <h3 className="text-lg font-semibold mb-2">Failed to Load Subscription</h3>
          <p className="text-muted-foreground mb-4">
            We couldn't load your subscription details. Please try again.
          </p>
          <Button onClick={() => window.location.reload()} data-testid="button-retry-subscription">
            Refresh Page
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (!subscription) {
    return (
      <Card className="text-center py-12" data-testid="no-subscription-card">
        <CardContent>
          <AlertCircle className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
          <h3 className="text-lg font-semibold mb-2">No Active Subscription</h3>
          <p className="text-muted-foreground mb-4">
            Subscribe to unlock exclusive benefits and discounts.
          </p>
          <Button data-testid="button-subscribe">
            <Crown className="w-4 h-4 mr-2" />
            View Plans
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6" data-testid="subscription-dashboard">
      <Card data-testid="subscription-status-card">
        <CardHeader>
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div className="flex items-center gap-3">
              {tier && <TierBadge tierName={tier.name} />}
              <div>
                <CardTitle className="text-xl">
                  {tier?.displayName || "Subscription"}
                </CardTitle>
                <CardDescription>
                  ${tier ? (tier.priceInCents / 100).toFixed(0) : 0}/month
                </CardDescription>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Badge
                variant={subscription.status === "active" ? "default" : "secondary"}
                className="gap-1"
              >
                {subscription.status === "active" ? (
                  <Check className="w-3 h-3" />
                ) : (
                  <Clock className="w-3 h-3" />
                )}
                {subscription.status.charAt(0).toUpperCase() + subscription.status.slice(1)}
              </Badge>
            </div>
          </div>
        </CardHeader>
        {subscription.currentPeriodEnd && (
          <CardContent className="pt-0">
            <p className="text-sm text-muted-foreground">
              Next billing date: {format(new Date(subscription.currentPeriodEnd), "MMMM d, yyyy")}
            </p>
          </CardContent>
        )}
      </Card>

      <Tabs defaultValue="benefits" className="space-y-4">
        <TabsList>
          <TabsTrigger value="benefits" data-testid="tab-benefits">
            My Benefits
          </TabsTrigger>
          <TabsTrigger value="purchase" data-testid="tab-purchase">
            À La Carte
          </TabsTrigger>
        </TabsList>

        <TabsContent value="benefits" className="space-y-4">
          {benefitsLoading ? (
            <div className="flex items-center justify-center py-8">
              <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary"></div>
            </div>
          ) : benefitsError ? (
            <Card>
              <CardContent className="py-8 text-center">
                <AlertCircle className="w-10 h-10 mx-auto text-destructive mb-3" />
                <h4 className="font-medium mb-1">Failed to Load Benefits</h4>
                <p className="text-sm text-muted-foreground">
                  Please refresh the page to try again.
                </p>
              </CardContent>
            </Card>
          ) : allowances.length === 0 ? (
            <Card>
              <CardContent className="py-8 text-center">
                <Sparkles className="w-10 h-10 mx-auto text-muted-foreground mb-3" />
                <h4 className="font-medium mb-1">No Benefits Available</h4>
                <p className="text-sm text-muted-foreground">
                  Upgrade your subscription to unlock exclusive benefits.
                </p>
              </CardContent>
            </Card>
          ) : (
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {allowances.map((allowance) => (
                <BenefitCard
                  key={allowance.id}
                  allowance={allowance}
                  onUse={() => handleUseBenefit(allowance)}
                />
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="purchase" className="space-y-4">
          <div className="p-4 bg-muted/50 rounded-lg mb-4">
            <p className="text-sm">
              <strong>Subscriber Discount:</strong> As a {tier?.displayName || "subscriber"}, you get exclusive pricing on all à la carte services.
            </p>
          </div>
          {servicesLoading ? (
            <div className="flex items-center justify-center py-8">
              <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary"></div>
            </div>
          ) : servicesError ? (
            <Card>
              <CardContent className="py-8 text-center">
                <AlertCircle className="w-10 h-10 mx-auto text-destructive mb-3" />
                <h4 className="font-medium mb-1">Failed to Load Services</h4>
                <p className="text-sm text-muted-foreground">
                  Please refresh the page to try again.
                </p>
              </CardContent>
            </Card>
          ) : services.length === 0 ? (
            <Card>
              <CardContent className="py-8 text-center">
                <ShoppingCart className="w-10 h-10 mx-auto text-muted-foreground mb-3" />
                <h4 className="font-medium mb-1">No Services Available</h4>
                <p className="text-sm text-muted-foreground">
                  Check back later for à la carte services.
                </p>
              </CardContent>
            </Card>
          ) : (
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {services.map((service) => (
                <AlaCarteServiceCard
                  key={service.id}
                  service={service}
                  tierName={tier?.name || null}
                />
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>

      <UseBenefitDialog
        allowance={selectedBenefit}
        open={benefitDialogOpen}
        onOpenChange={setBenefitDialogOpen}
      />
    </div>
  );
}

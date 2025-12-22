import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { AlertCircle, CheckCircle2, ExternalLink, Loader2, CreditCard } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

interface OnboardingStatus {
  hasStripeAccount: boolean;
  onboardingComplete: boolean;
  stripeAccountId?: string;
  chargesEnabled?: boolean;
  payoutsEnabled?: boolean;
  detailsSubmitted?: boolean;
}

interface StripeOnboardingBannerProps {
  vendorType: "business" | "photographer";
}

export default function StripeOnboardingBanner({ vendorType }: StripeOnboardingBannerProps) {
  const { toast } = useToast();
  const [isRedirecting, setIsRedirecting] = useState(false);

  const endpoint = "/api/vendor/stripe-onboarding/status";
  const createLinkEndpoint = "/api/vendor/stripe-onboarding/create-link";

  const { data: status, isLoading, isError } = useQuery<OnboardingStatus>({
    queryKey: [endpoint],
    refetchInterval: 30000,
    retry: 1,
  });

  const createOnboardingLinkMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", createLinkEndpoint);
      return response.json();
    },
    onSuccess: (data) => {
      if (data.url) {
        setIsRedirecting(true);
        window.location.href = data.url;
      }
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to create onboarding link. Please try again.",
        variant: "destructive",
      });
    },
  });

  const handleStartOnboarding = () => {
    createOnboardingLinkMutation.mutate();
  };

  if (isLoading) {
    return null;
  }

  // Don't show banner if query failed (user may not be a vendor) or if onboarding is complete
  if (isError || !status || status.onboardingComplete) {
    return null;
  }

  const isCreating = createOnboardingLinkMutation.isPending || isRedirecting;

  return (
    <Card className="border-primary/50 bg-primary/5" data-testid="stripe-onboarding-banner">
      <CardContent className="p-4">
        <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4">
          <div className="flex items-center gap-3 flex-1">
            <div className="p-2 rounded-full bg-primary/10">
              <CreditCard className="h-5 w-5 text-primary" />
            </div>
            <div>
              <h3 className="font-semibold text-sm" data-testid="text-onboarding-title">
                Complete Payment Setup
              </h3>
              <p className="text-sm text-muted-foreground" data-testid="text-onboarding-description">
                {status.hasStripeAccount 
                  ? "Finish setting up your Stripe account to receive payments."
                  : "Connect your bank account with Stripe to start accepting payments."}
              </p>
            </div>
          </div>
          <Button
            onClick={handleStartOnboarding}
            disabled={isCreating}
            data-testid="button-start-onboarding"
          >
            {isCreating ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Redirecting...
              </>
            ) : (
              <>
                {status.hasStripeAccount ? "Continue Setup" : "Start Setup"}
                <ExternalLink className="h-4 w-4 ml-2" />
              </>
            )}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

interface OnboardingSetupPageProps {
  vendorType: "business" | "photographer";
  onComplete?: () => void;
}

export function OnboardingSetupPage({ vendorType, onComplete }: OnboardingSetupPageProps) {
  const { toast } = useToast();
  const [isRedirecting, setIsRedirecting] = useState(false);

  const endpoint = "/api/vendor/stripe-onboarding/status";
  const createLinkEndpoint = "/api/vendor/stripe-onboarding/create-link";

  const { data: status, isLoading, refetch } = useQuery<OnboardingStatus>({
    queryKey: [endpoint],
    refetchInterval: 5000,
  });

  const createOnboardingLinkMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", createLinkEndpoint);
      return response.json();
    },
    onSuccess: (data) => {
      if (data.url) {
        setIsRedirecting(true);
        window.location.href = data.url;
      }
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to create onboarding link. Please try again.",
        variant: "destructive",
      });
    },
  });

  const handleStartOnboarding = () => {
    createOnboardingLinkMutation.mutate();
  };

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background" data-testid="page-onboarding-loading">
        <div className="text-center">
          <Loader2 className="h-8 w-8 animate-spin mx-auto mb-4 text-primary" />
          <p className="text-muted-foreground">Loading...</p>
        </div>
      </div>
    );
  }

  if (status?.onboardingComplete) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background" data-testid="page-onboarding-complete">
        <div className="max-w-md w-full mx-4">
          <Card>
            <CardContent className="p-8 text-center">
              <div className="w-16 h-16 bg-green-100 dark:bg-green-900/30 rounded-full flex items-center justify-center mx-auto mb-6">
                <CheckCircle2 className="h-8 w-8 text-green-600 dark:text-green-400" />
              </div>
              <h2 className="text-2xl font-bold mb-2" data-testid="text-setup-complete">
                Payment Setup Complete
              </h2>
              <p className="text-muted-foreground mb-6">
                Your Stripe account is connected and ready to receive payments.
              </p>
              <Button onClick={onComplete} className="w-full" data-testid="button-continue-to-dashboard">
                Continue to Dashboard
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  const isCreating = createOnboardingLinkMutation.isPending || isRedirecting;

  return (
    <div className="min-h-screen flex items-center justify-center bg-background" data-testid="page-onboarding-setup">
      <div className="max-w-md w-full mx-4">
        <Card>
          <CardContent className="p-8">
            <div className="text-center mb-8">
              <div className="w-16 h-16 bg-primary/10 rounded-full flex items-center justify-center mx-auto mb-6">
                <CreditCard className="h-8 w-8 text-primary" />
              </div>
              <h2 className="text-2xl font-bold mb-2" data-testid="text-setup-payments-title">
                Set Up Payments
              </h2>
              <p className="text-muted-foreground">
                Connect your bank account to receive payments from customers. 
                This is required before you can start selling.
              </p>
            </div>

            <div className="space-y-4 mb-8">
              <div className="flex items-start gap-3">
                <div className="w-6 h-6 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0 mt-0.5">
                  <span className="text-xs font-medium text-primary">1</span>
                </div>
                <div>
                  <p className="font-medium text-sm">Verify your identity</p>
                  <p className="text-xs text-muted-foreground">Stripe will verify your business information</p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <div className="w-6 h-6 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0 mt-0.5">
                  <span className="text-xs font-medium text-primary">2</span>
                </div>
                <div>
                  <p className="font-medium text-sm">Connect your bank</p>
                  <p className="text-xs text-muted-foreground">Add your bank account for payouts</p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <div className="w-6 h-6 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0 mt-0.5">
                  <span className="text-xs font-medium text-primary">3</span>
                </div>
                <div>
                  <p className="font-medium text-sm">Start receiving payments</p>
                  <p className="text-xs text-muted-foreground">Accept payments and get payouts automatically</p>
                </div>
              </div>
            </div>

            <div className="flex flex-col gap-3">
              <Button
                onClick={handleStartOnboarding}
                disabled={isCreating}
                className="w-full"
                data-testid="button-start-stripe-setup"
              >
                {isCreating ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Redirecting to Stripe...
                  </>
                ) : (
                  <>
                    {status?.hasStripeAccount ? "Continue Setup" : "Start Payment Setup"}
                    <ExternalLink className="h-4 w-4 ml-2" />
                  </>
                )}
              </Button>
              
              <p className="text-xs text-center text-muted-foreground">
                Powered by Stripe. Your financial information is secure and encrypted.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

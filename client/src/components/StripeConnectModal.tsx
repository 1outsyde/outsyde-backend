import { useState } from "react";
import { CreditCard, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { apiRequest } from "@/lib/queryClient";

interface Props {
  /** True when the logged-in user is a vendor */
  isVendor: boolean;
  /** True when the logged-in user is a photographer */
  isPhotographer: boolean;
  /** Called when the user clicks X to dismiss for the current session */
  onDismiss: () => void;
  /** Called after the user returns from Stripe and /api/auth/me reports complete */
  onComplete?: () => void;
}

export default function StripeConnectModal({ isVendor, isPhotographer, onDismiss, onComplete }: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleFinish() {
    setLoading(true);
    setError(null);
    try {
      const endpoint = isVendor
        ? "/api/vendor/stripe-onboarding/create-link"
        : "/api/photographers/me/stripe-onboarding";

      const res = await apiRequest("POST", endpoint);
      const data = await res.json() as { url?: string; onboardingUrl?: string };
      const url = data.url ?? data.onboardingUrl;

      if (url) {
        // Navigate to the Stripe onboarding URL
        window.location.href = url;
      } else {
        setError("No onboarding URL returned. Please try again.");
      }
    } catch {
      setError("Failed to start Stripe setup. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.65)" }}
      role="dialog"
      aria-modal="true"
      aria-label="Stripe Connect required"
    >
      <div className="relative w-full max-w-md rounded-xl border border-border bg-card p-8 shadow-2xl">
        {/* X in top-left */}
        <button
          onClick={onDismiss}
          aria-label="Close"
          className="absolute left-4 top-4 text-muted-foreground hover:text-foreground transition-colors"
        >
          <X className="h-5 w-5" />
        </button>

        <div className="flex flex-col items-center text-center">
          <div className="mb-5 flex h-14 w-14 items-center justify-center rounded-full bg-primary/10">
            <CreditCard className="h-7 w-7 text-primary" />
          </div>

          <h2 className="mb-3 text-xl font-bold">
            Finish Stripe Connect to Receive Payouts
          </h2>

          <p className="mb-7 text-sm text-muted-foreground leading-relaxed">
            To receive payments and payouts on Outsyde, you need to complete your
            Stripe Connect account setup. It only takes a few minutes.
          </p>

          <Button
            onClick={handleFinish}
            disabled={loading}
            className="w-full"
            data-testid="button-finish-stripe-setup"
          >
            {loading ? "Redirecting…" : "Finish Stripe Setup"}
          </Button>

          {error && (
            <p className="mt-3 text-sm text-destructive">{error}</p>
          )}
        </div>
      </div>
    </div>
  );
}

import { useLocation } from "wouter";
import { OnboardingSetupPage } from "@/components/StripeOnboardingBanner";

export default function VendorOnboardingPage() {
  const [, navigate] = useLocation();

  const handleComplete = () => {
    navigate("/vendor/dashboard");
  };

  return <OnboardingSetupPage vendorType="business" onComplete={handleComplete} />;
}

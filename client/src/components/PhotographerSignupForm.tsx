import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Check, Eye, EyeOff, Camera, Loader2, ExternalLink } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";

interface PhotographerSignupFormProps {
  onComplete?: () => void;
}

interface PhotographerSignupData {
  email: string;
  password: string;
  name: string;
  phone: string;
  displayName: string;
  bio: string;
  city: string;
  state: string;
  hourlyRate: string;
  portfolioUrl: string;
  specialties: string[];
  skipStripe: boolean;
}

const steps = [
  { id: 1, name: "Account" },
  { id: 2, name: "Profile" },
  { id: 3, name: "Get Paid" },
];

const specialtyOptions = [
  "Weddings",
  "Portraits",
  "Events",
  "Family",
  "Newborn",
  "Headshots",
  "Product",
  "Real Estate",
  "Fashion",
  "Sports",
  "Food",
  "Nature & Landscape",
];

const usStates = [
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA",
  "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD",
  "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ",
  "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC",
  "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY", "DC"
];

export default function PhotographerSignupForm({ onComplete }: PhotographerSignupFormProps) {
  const [currentStep, setCurrentStep] = useState(1);
  const [showPassword, setShowPassword] = useState(false);
  const { toast } = useToast();

  const [formData, setFormData] = useState<PhotographerSignupData>({
    email: "",
    password: "",
    name: "",
    phone: "",
    displayName: "",
    bio: "",
    city: "",
    state: "",
    hourlyRate: "",
    portfolioUrl: "",
    specialties: [],
    skipStripe: false,
  });

  const signupMutation = useMutation({
    mutationFn: async (data: PhotographerSignupData) => {
      const response = await apiRequest("POST", "/api/auth/photographer/signup", {
        email: data.email,
        password: data.password,
        name: data.name,
        phone: data.phone || undefined,
        displayName: data.displayName,
        bio: data.bio || undefined,
        city: data.city,
        state: data.state,
        hourlyRate: Number(data.hourlyRate),
        portfolioUrl: data.portfolioUrl,
        specialties: data.specialties,
        skipStripe: data.skipStripe,
      });
      return response.json();
    },
    onSuccess: async (result) => {
      if (result.error) {
        toast({
          title: "Signup failed",
          description: result.error,
          variant: "destructive",
        });
        return;
      }

      // Handle Stripe error gracefully
      if (result.stripeError) {
        toast({
          title: "Account created with warning",
          description: result.stripeError,
          variant: "default",
        });
        onComplete?.();
        return;
      }

      // Redirect to Stripe onboarding if URL is provided and not skipping
      if (!formData.skipStripe && result.stripeOnboardingUrl) {
        toast({
          title: "Account created!",
          description: "Redirecting to Stripe to set up payments...",
        });
        window.location.href = result.stripeOnboardingUrl;
        return;
      }

      // Handle case where Stripe was expected but no URL returned
      if (!formData.skipStripe && !result.stripeOnboardingUrl) {
        toast({
          title: "Account created",
          description: "Stripe setup encountered an issue. You can complete this from your dashboard.",
          variant: "default",
        });
        onComplete?.();
        return;
      }

      toast({
        title: "Welcome to Outsyde!",
        description: "Your photographer profile is ready. Complete Stripe onboarding from your dashboard to start receiving bookings.",
      });
      onComplete?.();
    },
    onError: (error: Error) => {
      toast({
        title: "Signup failed",
        description: error.message || "Please try again",
        variant: "destructive",
      });
    },
  });

  const progress = (currentStep / steps.length) * 100;

  const updateField = (field: keyof PhotographerSignupData, value: string | string[] | boolean) => {
    setFormData({ ...formData, [field]: value });
  };

  const toggleSpecialty = (specialty: string) => {
    const current = formData.specialties;
    const updated = current.includes(specialty)
      ? current.filter((s) => s !== specialty)
      : [...current, specialty];
    updateField("specialties", updated);
  };

  const canProceedStep1 = () => {
    return formData.name.trim() && formData.email.trim() && formData.password.length >= 6;
  };

  const canProceedStep2 = () => {
    return (
      formData.displayName.trim() &&
      formData.city.trim() &&
      formData.state.trim() &&
      formData.hourlyRate.trim() &&
      Number(formData.hourlyRate) > 0
    );
  };

  const nextStep = () => {
    if (currentStep < steps.length) {
      setCurrentStep(currentStep + 1);
    } else {
      signupMutation.mutate(formData);
    }
  };

  const prevStep = () => {
    if (currentStep > 1) {
      setCurrentStep(currentStep - 1);
    }
  };

  const handleSubmit = (skipStripe: boolean) => {
    setFormData(prev => ({ ...prev, skipStripe }));
    signupMutation.mutate({ ...formData, skipStripe });
  };

  return (
    <Card className="w-full max-w-md p-6 overflow-visible" data-testid="photographer-signup-form">
      <div className="mb-6">
        <div className="flex items-center gap-2 mb-2">
          <Camera className="h-6 w-6 text-primary" />
          <h2 className="text-2xl font-bold">Join as a Photographer</h2>
        </div>
        <p className="text-sm text-muted-foreground mb-4">
          Showcase your work and connect with clients in your area
        </p>
        <div className="flex items-center gap-1 mb-4">
          {steps.map((step, index) => (
            <div key={step.id} className="flex items-center">
              <div
                className={`h-8 w-8 rounded-full flex items-center justify-center text-sm font-medium shrink-0 ${
                  currentStep > step.id
                    ? "bg-primary text-primary-foreground"
                    : currentStep === step.id
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground"
                }`}
              >
                {currentStep > step.id ? <Check className="h-4 w-4" /> : step.id}
              </div>
              {index < steps.length - 1 && (
                <div
                  className={`h-0.5 w-8 ${
                    currentStep > step.id ? "bg-primary" : "bg-muted"
                  }`}
                />
              )}
            </div>
          ))}
        </div>
        <Progress value={progress} className="h-1" />
      </div>

      {currentStep === 1 && (
        <div className="space-y-4">
          <div>
            <Label htmlFor="name">Full Name *</Label>
            <Input
              id="name"
              value={formData.name}
              onChange={(e) => updateField("name", e.target.value)}
              placeholder="Jane Doe"
              data-testid="input-photographer-name"
            />
          </div>
          <div>
            <Label htmlFor="email">Email *</Label>
            <Input
              id="email"
              type="email"
              value={formData.email}
              onChange={(e) => updateField("email", e.target.value)}
              placeholder="jane@example.com"
              data-testid="input-photographer-email"
            />
          </div>
          <div>
            <Label htmlFor="phone">Phone Number</Label>
            <Input
              id="phone"
              type="tel"
              value={formData.phone}
              onChange={(e) => updateField("phone", e.target.value)}
              placeholder="(555) 123-4567"
              data-testid="input-photographer-phone"
            />
          </div>
          <div>
            <Label htmlFor="password">Password * (min 6 characters)</Label>
            <div className="relative">
              <Input
                id="password"
                type={showPassword ? "text" : "password"}
                value={formData.password}
                onChange={(e) => updateField("password", e.target.value)}
                placeholder="Create a password"
                data-testid="input-photographer-password"
              />
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="absolute right-0 top-0"
                onClick={() => setShowPassword(!showPassword)}
              >
                {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </Button>
            </div>
          </div>
        </div>
      )}

      {currentStep === 2 && (
        <div className="space-y-4">
          <div>
            <Label htmlFor="displayName">Display Name *</Label>
            <Input
              id="displayName"
              value={formData.displayName}
              onChange={(e) => updateField("displayName", e.target.value)}
              placeholder="Jane Doe Photography"
              data-testid="input-photographer-displayName"
            />
            <p className="text-xs text-muted-foreground mt-1">This is how clients will see you</p>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label htmlFor="city">City *</Label>
              <Input
                id="city"
                value={formData.city}
                onChange={(e) => updateField("city", e.target.value)}
                placeholder="Atlanta"
                data-testid="input-photographer-city"
              />
            </div>
            <div>
              <Label htmlFor="state">State *</Label>
              <Select
                value={formData.state}
                onValueChange={(value) => updateField("state", value)}
              >
                <SelectTrigger data-testid="select-photographer-state">
                  <SelectValue placeholder="Select" />
                </SelectTrigger>
                <SelectContent>
                  {usStates.map((state) => (
                    <SelectItem key={state} value={state}>
                      {state}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div>
            <Label htmlFor="hourlyRate">Hourly Rate ($) *</Label>
            <Input
              id="hourlyRate"
              type="number"
              min="1"
              value={formData.hourlyRate}
              onChange={(e) => updateField("hourlyRate", e.target.value)}
              placeholder="150"
              data-testid="input-photographer-hourlyRate"
            />
          </div>
          <div>
            <Label htmlFor="portfolioUrl">Portfolio URL</Label>
            <Input
              id="portfolioUrl"
              type="url"
              value={formData.portfolioUrl}
              onChange={(e) => updateField("portfolioUrl", e.target.value)}
              placeholder="https://yourportfolio.com"
              data-testid="input-photographer-portfolioUrl"
            />
          </div>
          <div>
            <Label htmlFor="bio">Bio (optional)</Label>
            <Textarea
              id="bio"
              value={formData.bio}
              onChange={(e) => updateField("bio", e.target.value)}
              placeholder="Tell clients about your photography style and experience..."
              className="resize-none"
              rows={3}
              data-testid="input-photographer-bio"
            />
          </div>
          <div>
            <Label>Specialties (optional)</Label>
            <p className="text-xs text-muted-foreground mb-2">Select what types of photography you offer</p>
            <div className="flex flex-wrap gap-2">
              {specialtyOptions.map((specialty) => (
                <Badge
                  key={specialty}
                  variant={formData.specialties.includes(specialty) ? "default" : "outline"}
                  className="cursor-pointer"
                  onClick={() => toggleSpecialty(specialty)}
                  data-testid={`badge-specialty-${specialty.toLowerCase().replace(/\s+/g, '-')}`}
                >
                  {specialty}
                </Badge>
              ))}
            </div>
          </div>
        </div>
      )}

      {currentStep === 3 && (
        <div className="space-y-6">
          <div className="text-center">
            <div className="w-16 h-16 bg-primary/10 rounded-full flex items-center justify-center mx-auto mb-4">
              <Camera className="h-8 w-8 text-primary" />
            </div>
            <h3 className="text-lg font-semibold mb-2">Set Up Stripe Payments</h3>
            <p className="text-sm text-muted-foreground">
              Connect with Stripe to receive payments for your photography services. 
              This is required before you can accept bookings.
            </p>
          </div>

          <div className="bg-green-50 dark:bg-green-950 border border-green-200 dark:border-green-800 rounded-lg p-4 text-center" data-testid="pricing-info">
            <p className="text-2xl font-bold text-green-700 dark:text-green-300">$0 to join</p>
            <p className="text-sm text-green-600 dark:text-green-400 mt-1">
              Outsyde takes a <span className="font-semibold">15% service fee</span> per completed booking.
            </p>
            <p className="text-xs text-green-600 dark:text-green-400 mt-1">
              No monthly fees. No contracts.
            </p>
          </div>

          <div className="bg-muted/50 rounded-lg p-4 space-y-3">
            <div className="flex items-start gap-3">
              <Check className="h-5 w-5 text-green-500 shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-medium">Secure Payments</p>
                <p className="text-xs text-muted-foreground">Stripe handles all payment processing securely</p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <Check className="h-5 w-5 text-green-500 shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-medium">Fast Deposits</p>
                <p className="text-xs text-muted-foreground">Get paid directly to your bank account</p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <Check className="h-5 w-5 text-green-500 shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-medium">Outsyde Manages Bookings</p>
                <p className="text-xs text-muted-foreground">We handle deposits and payments for you</p>
              </div>
            </div>
          </div>

          <div className="space-y-3">
            <Button
              className="w-full gap-2"
              onClick={() => handleSubmit(false)}
              disabled={signupMutation.isPending}
              data-testid="button-connect-stripe"
            >
              {signupMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <ExternalLink className="h-4 w-4" />
              )}
              Connect with Stripe
            </Button>
            <Button
              variant="outline"
              className="w-full"
              onClick={() => handleSubmit(true)}
              disabled={signupMutation.isPending}
              data-testid="button-skip-stripe"
            >
              Skip for now
            </Button>
            <p className="text-xs text-center text-muted-foreground">
              You can complete Stripe setup later from your dashboard, but you won't be able to receive bookings until then.
            </p>
          </div>
        </div>
      )}

      <div className="flex justify-between mt-6">
        <Button
          variant="outline"
          onClick={prevStep}
          disabled={currentStep === 1 || signupMutation.isPending}
          data-testid="button-photographer-prev"
        >
          <ChevronLeft className="h-4 w-4 mr-1" />
          Back
        </Button>
        {currentStep < 3 && (
          <Button
            onClick={nextStep}
            disabled={
              (currentStep === 1 && !canProceedStep1()) ||
              (currentStep === 2 && !canProceedStep2()) ||
              signupMutation.isPending
            }
            data-testid="button-photographer-next"
          >
            Next
            <ChevronRight className="h-4 w-4 ml-1" />
          </Button>
        )}
      </div>
    </Card>
  );
}

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Check, Eye, EyeOff, CreditCard, Building2, Globe, Rocket, Store, Shirt, Scissors, Utensils, SprayCan, Dumbbell, ShoppingBag, Palette, Wrench, Loader2 } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";

interface SignupFormProps {
  onComplete?: (data: SignupData) => void;
  isVendor?: boolean;
}

interface SignupData {
  email: string;
  password: string;
  name: string;
  phone: string;
  location: string;
  city: string;
  state: string;
  zipCode: string;
  nationality?: string;
  ethnicity?: string;
  ageRange?: string;
  gender?: string;
  householdSize?: string;
  incomeRange?: string;
  education?: string;
  occupation?: string;
  shoppingFrequency?: string;
  preferredCategories: string[];
  interests: string[];
  selectedIndustries: string[];
  industryNiches: Record<string, string[]>;
  businessName?: string;
  businessCategory?: string;
  businessDescription?: string;
  businessType?: string;
  isStartup?: boolean;
  yearsInBusiness?: string;
  employeeCount?: string;
  hasPhysicalLocation?: boolean;
  websiteUrl?: string;
  socialMedia?: string;
  acceptedSubscription?: boolean;
}

const customerSteps = [
  { id: 1, name: "Account" },
  { id: 2, name: "Location" },
  { id: 3, name: "About You" },
  { id: 4, name: "Lifestyle" },
  { id: 5, name: "Industries" },
  { id: 6, name: "Your Tastes" },
  { id: 7, name: "Finish" },
];

const vendorSteps = [
  { id: 1, name: "Account" },
  { id: 2, name: "Business Info" },
  { id: 3, name: "Business Details" },
  { id: 4, name: "Location" },
  { id: 5, name: "Online Presence" },
  { id: 6, name: "Subscription" },
];

const categories = [
  "Food & Drinks",
  "Beauty & Wellness",
  "Health & Fitness",
  "Shopping & Retail",
  "Home Services",
  "Professional Services",
  "Entertainment",
  "Arts & Crafts",
];

const industries = [
  { id: "clothing", name: "Clothing & Fashion", icon: Shirt },
  { id: "beauty-products", name: "Beauty Products", icon: SprayCan },
  { id: "beauty-services", name: "Beauty Services", icon: Scissors },
  { id: "food", name: "Food & Dining", icon: Utensils },
  { id: "fitness", name: "Fitness & Wellness", icon: Dumbbell },
  { id: "home-goods", name: "Home & Decor", icon: ShoppingBag },
  { id: "arts", name: "Arts & Crafts", icon: Palette },
  { id: "services", name: "Professional Services", icon: Wrench },
];

const industryNicheOptions: Record<string, { label: string; options: string[] }> = {
  "clothing": {
    label: "What types of clothing interest you?",
    options: ["Streetwear", "Vintage", "Designer", "Casual", "Athletic Wear", "Formal Wear", "Children's Clothing", "Plus Size", "Sustainable Fashion", "Accessories & Jewelry", "Shoes & Footwear", "Custom/Tailored"]
  },
  "beauty-products": {
    label: "What beauty products are you interested in?",
    options: ["Skincare", "Makeup", "Haircare", "Natural/Organic", "Fragrances", "Nail Products", "Men's Grooming", "K-Beauty", "Anti-aging", "Acne Care", "Body Care", "Indie Brands"]
  },
  "beauty-services": {
    label: "What beauty services do you look for?",
    options: ["Hair Styling", "Hair Coloring", "Barbershop", "Nail Salon", "Spa & Massage", "Facials", "Waxing", "Lash Extensions", "Brow Services", "Makeup Artist", "Braiding & Locs", "Med Spa"]
  },
  "food": {
    label: "What types of food do you enjoy?",
    options: ["Italian", "Soul Food", "Mexican", "Asian Fusion", "Caribbean", "BBQ", "Vegan/Vegetarian", "Bakery & Sweets", "Coffee & Cafe", "Seafood", "Food Trucks", "Fine Dining", "Fast Casual", "Desserts", "Healthy/Organic"]
  },
  "fitness": {
    label: "What fitness activities interest you?",
    options: ["Yoga", "CrossFit", "Personal Training", "Pilates", "Boxing/MMA", "Dance Fitness", "Swimming", "Cycling/Spin", "Meditation", "Nutrition Coaching", "Physical Therapy", "Group Classes"]
  },
  "home-goods": {
    label: "What home items are you looking for?",
    options: ["Furniture", "Home Decor", "Plants & Garden", "Kitchenware", "Bedding & Linens", "Candles & Scents", "Wall Art", "Handmade Items", "Antiques", "Organization", "Outdoor Living", "Pet Supplies"]
  },
  "arts": {
    label: "What arts & crafts interest you?",
    options: ["Paintings", "Photography", "Pottery & Ceramics", "Jewelry Making", "Handmade Crafts", "Digital Art", "Sculpture", "Textiles", "Woodworking", "Custom Commissions", "Art Classes", "Supplies"]
  },
  "services": {
    label: "What services might you need?",
    options: ["Cleaning", "Landscaping", "Handyman", "Auto Repair", "Pet Services", "Photography", "Event Planning", "Tutoring", "Legal Services", "Accounting", "Real Estate", "Tech Support"]
  }
};

export default function SignupForm({ onComplete, isVendor = false }: SignupFormProps) {
  const steps = isVendor ? vendorSteps : customerSteps;
  const [currentStep, setCurrentStep] = useState(1);
  const [showPassword, setShowPassword] = useState(false);
  const { toast } = useToast();

  // Signup mutation for customer
  const customerSignupMutation = useMutation({
    mutationFn: async (data: SignupData) => {
      const response = await apiRequest("POST", "/api/auth/customer/signup", {
        email: data.email,
        password: data.password,
        name: data.name,
        phone: data.phone || undefined,
        address: data.location || undefined,
        city: data.city || undefined,
        state: data.state || undefined,
        zipCode: data.zipCode || undefined,
        ageRange: data.ageRange || undefined,
        gender: data.gender || undefined,
        ethnicity: data.ethnicity || undefined,
        nationality: data.nationality || undefined,
        householdSize: data.householdSize || undefined,
        incomeRange: data.incomeRange || undefined,
        education: data.education || undefined,
        occupation: data.occupation || undefined,
        shoppingFrequency: data.shoppingFrequency || undefined,
        selectedIndustries: data.selectedIndustries,
        industryNiches: data.industryNiches,
      });
      return response.json();
    },
    onSuccess: (result) => {
      toast({
        title: "Welcome to Outsyde!",
        description: "Your account has been created successfully.",
      });
      onComplete?.(formData);
    },
    onError: (error: Error) => {
      toast({
        title: "Signup failed",
        description: error.message || "Please try again",
        variant: "destructive",
      });
    },
  });

  // Signup mutation for vendor
  const vendorSignupMutation = useMutation({
    mutationFn: async (data: SignupData) => {
      const response = await apiRequest("POST", "/api/auth/vendor/signup", {
        email: data.email,
        password: data.password,
        name: data.name,
        phone: data.phone || undefined,
        businessName: data.businessName,
        businessCategory: data.businessCategory,
        businessDescription: data.businessDescription || undefined,
        isStartup: data.isStartup,
        yearsInBusiness: data.yearsInBusiness || undefined,
        employeeCount: data.employeeCount || undefined,
        businessType: data.businessType || undefined,
        hasPhysicalLocation: data.hasPhysicalLocation,
        address: data.location || undefined,
        city: data.city || undefined,
        state: data.state || undefined,
        zipCode: data.zipCode || undefined,
        websiteUrl: data.websiteUrl || undefined,
        socialMedia: data.socialMedia || undefined,
        acceptedSubscription: data.acceptedSubscription,
      });
      return response.json();
    },
    onSuccess: (result) => {
      toast({
        title: "Welcome to Outsyde!",
        description: "Your business account is ready. Start setting up your storefront!",
      });
      onComplete?.(formData);
    },
    onError: (error: Error) => {
      toast({
        title: "Signup failed",
        description: error.message || "Please try again",
        variant: "destructive",
      });
    },
  });

  const isSubmitting = customerSignupMutation.isPending || vendorSignupMutation.isPending;

  const [formData, setFormData] = useState<SignupData>({
    email: "",
    password: "",
    name: "",
    phone: "",
    location: "",
    city: "",
    state: "",
    zipCode: "",
    nationality: "",
    ethnicity: "",
    ageRange: "",
    gender: "",
    householdSize: "",
    incomeRange: "",
    education: "",
    occupation: "",
    shoppingFrequency: "",
    preferredCategories: [],
    interests: [],
    selectedIndustries: [],
    industryNiches: {},
    businessName: "",
    businessCategory: "",
    businessDescription: "",
    businessType: "",
    isStartup: undefined,
    yearsInBusiness: "",
    employeeCount: "",
    hasPhysicalLocation: undefined,
    websiteUrl: "",
    socialMedia: "",
    acceptedSubscription: false,
  });

  const progress = (currentStep / steps.length) * 100;

  const updateField = (field: keyof SignupData, value: string | string[] | boolean | undefined | Record<string, string[]>) => {
    setFormData({ ...formData, [field]: value });
  };

  const toggleArrayItem = (field: "interests" | "preferredCategories" | "selectedIndustries", item: string) => {
    const current = formData[field];
    const updated = current.includes(item)
      ? current.filter((i) => i !== item)
      : [...current, item];
    updateField(field, updated);
  };

  const toggleNicheItem = (industryId: string, niche: string) => {
    const currentNiches = formData.industryNiches[industryId] || [];
    const updated = currentNiches.includes(niche)
      ? currentNiches.filter((n) => n !== niche)
      : [...currentNiches, niche];
    updateField("industryNiches", {
      ...formData.industryNiches,
      [industryId]: updated
    });
  };

  const nextStep = () => {
    if (currentStep < steps.length) {
      setCurrentStep(currentStep + 1);
    } else {
      // Submit form via API
      if (isVendor) {
        vendorSignupMutation.mutate(formData);
      } else {
        customerSignupMutation.mutate(formData);
      }
    }
  };

  const prevStep = () => {
    if (currentStep > 1) {
      setCurrentStep(currentStep - 1);
    }
  };

  const canProceed = () => {
    if (isVendor && currentStep === 6) {
      return formData.acceptedSubscription;
    }
    return true;
  };

  const skipOptionalSteps = () => {
    if (!isVendor && (currentStep === 5 || currentStep === 6)) {
      setCurrentStep(7);
    }
  };

  return (
    <Card className="w-full max-w-md p-6 overflow-visible" data-testid="signup-form">
      <div className="mb-6">
        <h2 className="text-2xl font-bold mb-2">
          {isVendor ? "Join Outsyde as a Business" : "Join Outsyde"}
        </h2>
        <p className="text-sm text-muted-foreground mb-4">
          {isVendor 
            ? "Get your business discovered by local customers" 
            : "Discover amazing local businesses near you"}
        </p>
        <div className="flex items-center gap-1 mb-4 overflow-x-auto pb-2">
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
                  className={`h-0.5 w-3 sm:w-4 ${
                    currentStep > step.id ? "bg-primary" : "bg-muted"
                  }`}
                />
              )}
            </div>
          ))}
        </div>
        <Progress value={progress} className="h-1" />
      </div>

      {/* CUSTOMER STEP 1: Account */}
      {!isVendor && currentStep === 1 && (
        <div className="space-y-4">
          <div>
            <Label htmlFor="name">Full Name</Label>
            <Input
              id="name"
              value={formData.name}
              onChange={(e) => updateField("name", e.target.value)}
              placeholder="John Doe"
              data-testid="input-name"
            />
          </div>
          <div>
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              value={formData.email}
              onChange={(e) => updateField("email", e.target.value)}
              placeholder="john@example.com"
              data-testid="input-email"
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
              data-testid="input-phone"
            />
          </div>
          <div>
            <Label htmlFor="password">Password</Label>
            <div className="relative">
              <Input
                id="password"
                type={showPassword ? "text" : "password"}
                value={formData.password}
                onChange={(e) => updateField("password", e.target.value)}
                placeholder="Create a password"
                data-testid="input-password"
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

      {/* CUSTOMER STEP 2: Location */}
      {!isVendor && currentStep === 2 && (
        <div className="space-y-4">
          <div>
            <Label htmlFor="location">Street Address</Label>
            <Input
              id="location"
              value={formData.location}
              onChange={(e) => updateField("location", e.target.value)}
              placeholder="123 Main Street"
              data-testid="input-address"
            />
          </div>
          <div>
            <Label htmlFor="city">City</Label>
            <Input
              id="city"
              value={formData.city}
              onChange={(e) => updateField("city", e.target.value)}
              placeholder="New York"
              data-testid="input-city"
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label htmlFor="state">State</Label>
              <Select
                value={formData.state}
                onValueChange={(value) => updateField("state", value)}
              >
                <SelectTrigger data-testid="select-state">
                  <SelectValue placeholder="Select" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="NY">New York</SelectItem>
                  <SelectItem value="CA">California</SelectItem>
                  <SelectItem value="TX">Texas</SelectItem>
                  <SelectItem value="FL">Florida</SelectItem>
                  <SelectItem value="GA">Georgia</SelectItem>
                  <SelectItem value="IL">Illinois</SelectItem>
                  <SelectItem value="other">Other</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="zipCode">ZIP Code</Label>
              <Input
                id="zipCode"
                value={formData.zipCode}
                onChange={(e) => updateField("zipCode", e.target.value)}
                placeholder="10001"
                data-testid="input-zipcode"
              />
            </div>
          </div>
        </div>
      )}

      {/* CUSTOMER STEP 3: About You (Demographics) */}
      {!isVendor && currentStep === 3 && (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Help us personalize your experience with better recommendations
          </p>
          <div>
            <Label htmlFor="ageRange">Age Range</Label>
            <Select
              value={formData.ageRange}
              onValueChange={(value) => updateField("ageRange", value)}
            >
              <SelectTrigger data-testid="select-age-range">
                <SelectValue placeholder="Select age range" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="18-24">18-24</SelectItem>
                <SelectItem value="25-34">25-34</SelectItem>
                <SelectItem value="35-44">35-44</SelectItem>
                <SelectItem value="45-54">45-54</SelectItem>
                <SelectItem value="55-64">55-64</SelectItem>
                <SelectItem value="65+">65+</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label htmlFor="gender">Gender</Label>
            <Select
              value={formData.gender}
              onValueChange={(value) => updateField("gender", value)}
            >
              <SelectTrigger data-testid="select-gender">
                <SelectValue placeholder="Select gender" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="male">Male</SelectItem>
                <SelectItem value="female">Female</SelectItem>
                <SelectItem value="non-binary">Non-binary</SelectItem>
                <SelectItem value="prefer-not">Prefer not to say</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label htmlFor="ethnicity">Ethnicity</Label>
            <Select
              value={formData.ethnicity}
              onValueChange={(value) => updateField("ethnicity", value)}
            >
              <SelectTrigger data-testid="select-ethnicity">
                <SelectValue placeholder="Select ethnicity" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="asian">Asian</SelectItem>
                <SelectItem value="black">Black or African American</SelectItem>
                <SelectItem value="hispanic">Hispanic or Latino</SelectItem>
                <SelectItem value="white">White</SelectItem>
                <SelectItem value="native">Native American</SelectItem>
                <SelectItem value="pacific">Pacific Islander</SelectItem>
                <SelectItem value="mixed">Mixed / Multiple</SelectItem>
                <SelectItem value="other">Other</SelectItem>
                <SelectItem value="prefer-not">Prefer not to say</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label htmlFor="nationality">Nationality</Label>
            <Select
              value={formData.nationality}
              onValueChange={(value) => updateField("nationality", value)}
            >
              <SelectTrigger data-testid="select-nationality">
                <SelectValue placeholder="Select nationality" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="us">United States</SelectItem>
                <SelectItem value="ca">Canada</SelectItem>
                <SelectItem value="mx">Mexico</SelectItem>
                <SelectItem value="uk">United Kingdom</SelectItem>
                <SelectItem value="other">Other</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      )}

      {/* CUSTOMER STEP 4: Lifestyle */}
      {!isVendor && currentStep === 4 && (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Tell us about your lifestyle for better local recommendations
          </p>
          <div>
            <Label htmlFor="householdSize">Household Size</Label>
            <Select
              value={formData.householdSize}
              onValueChange={(value) => updateField("householdSize", value)}
            >
              <SelectTrigger data-testid="select-household-size">
                <SelectValue placeholder="Select household size" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="1">Just me</SelectItem>
                <SelectItem value="2">2 people</SelectItem>
                <SelectItem value="3-4">3-4 people</SelectItem>
                <SelectItem value="5+">5 or more</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label htmlFor="incomeRange">Household Income Range</Label>
            <Select
              value={formData.incomeRange}
              onValueChange={(value) => updateField("incomeRange", value)}
            >
              <SelectTrigger data-testid="select-income-range">
                <SelectValue placeholder="Select income range" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="under-25k">Under $25,000</SelectItem>
                <SelectItem value="25k-50k">$25,000 - $50,000</SelectItem>
                <SelectItem value="50k-75k">$50,000 - $75,000</SelectItem>
                <SelectItem value="75k-100k">$75,000 - $100,000</SelectItem>
                <SelectItem value="100k-150k">$100,000 - $150,000</SelectItem>
                <SelectItem value="150k+">$150,000+</SelectItem>
                <SelectItem value="prefer-not">Prefer not to say</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label htmlFor="education">Education Level</Label>
            <Select
              value={formData.education}
              onValueChange={(value) => updateField("education", value)}
            >
              <SelectTrigger data-testid="select-education">
                <SelectValue placeholder="Select education level" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="high-school">High School</SelectItem>
                <SelectItem value="some-college">Some College</SelectItem>
                <SelectItem value="associates">Associate's Degree</SelectItem>
                <SelectItem value="bachelors">Bachelor's Degree</SelectItem>
                <SelectItem value="masters">Master's Degree</SelectItem>
                <SelectItem value="doctorate">Doctorate</SelectItem>
                <SelectItem value="other">Other</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label htmlFor="occupation">Occupation</Label>
            <Select
              value={formData.occupation}
              onValueChange={(value) => updateField("occupation", value)}
            >
              <SelectTrigger data-testid="select-occupation">
                <SelectValue placeholder="Select occupation type" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="student">Student</SelectItem>
                <SelectItem value="employed">Employed Full-time</SelectItem>
                <SelectItem value="part-time">Employed Part-time</SelectItem>
                <SelectItem value="self-employed">Self-employed</SelectItem>
                <SelectItem value="business-owner">Business Owner</SelectItem>
                <SelectItem value="retired">Retired</SelectItem>
                <SelectItem value="homemaker">Homemaker</SelectItem>
                <SelectItem value="other">Other</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label htmlFor="shoppingFrequency">How often do you shop locally?</Label>
            <Select
              value={formData.shoppingFrequency}
              onValueChange={(value) => updateField("shoppingFrequency", value)}
            >
              <SelectTrigger data-testid="select-shopping-frequency">
                <SelectValue placeholder="Select frequency" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="daily">Daily</SelectItem>
                <SelectItem value="weekly">Weekly</SelectItem>
                <SelectItem value="biweekly">Every two weeks</SelectItem>
                <SelectItem value="monthly">Monthly</SelectItem>
                <SelectItem value="rarely">Rarely</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      )}

      {/* CUSTOMER STEP 5: Industry Selection (Optional) */}
      {!isVendor && currentStep === 5 && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="font-medium">What industries interest you?</h3>
              <p className="text-sm text-muted-foreground">
                Select all that apply for personalized recommendations
              </p>
            </div>
            <Badge variant="secondary">Optional</Badge>
          </div>
          <div className="grid grid-cols-2 gap-3">
            {industries.map((industry) => {
              const Icon = industry.icon;
              const isSelected = formData.selectedIndustries.includes(industry.id);
              return (
                <div
                  key={industry.id}
                  className={`flex items-center gap-3 p-3 border rounded-md cursor-pointer hover-elevate ${
                    isSelected ? "border-primary bg-primary/5" : ""
                  }`}
                  onClick={() => toggleArrayItem("selectedIndustries", industry.id)}
                  data-testid={`checkbox-industry-${industry.id}`}
                >
                  <Checkbox checked={isSelected} />
                  <Icon className={`h-5 w-5 ${isSelected ? "text-primary" : "text-muted-foreground"}`} />
                  <span className="text-sm">{industry.name}</span>
                </div>
              );
            })}
          </div>
          <Button 
            variant="ghost" 
            className="w-full mt-4"
            onClick={skipOptionalSteps}
            data-testid="button-skip-industries"
          >
            Skip this step
          </Button>
        </div>
      )}

      {/* CUSTOMER STEP 6: Industry Niches (Optional) */}
      {!isVendor && currentStep === 6 && (
        <div className="space-y-5">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="font-medium">Tell us your preferences</h3>
              <p className="text-sm text-muted-foreground">
                Get tailored recommendations based on your tastes
              </p>
            </div>
            <Badge variant="secondary">Optional</Badge>
          </div>

          {formData.selectedIndustries.length === 0 ? (
            <div className="text-center py-6">
              <p className="text-muted-foreground mb-4">
                You haven't selected any industries yet. Go back to select some, or skip to complete signup.
              </p>
              <Button variant="outline" onClick={prevStep}>
                Go Back
              </Button>
            </div>
          ) : (
            <div className="space-y-6 max-h-[350px] overflow-y-auto pr-2">
              {formData.selectedIndustries.map((industryId) => {
                const nicheData = industryNicheOptions[industryId];
                const industry = industries.find(i => i.id === industryId);
                if (!nicheData || !industry) return null;
                
                const selectedNiches = formData.industryNiches[industryId] || [];
                const Icon = industry.icon;

                return (
                  <div key={industryId} className="space-y-3">
                    <div className="flex items-center gap-2">
                      <Icon className="h-5 w-5 text-primary" />
                      <Label className="text-base font-medium">{nicheData.label}</Label>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {nicheData.options.map((niche) => {
                        const isSelected = selectedNiches.includes(niche);
                        return (
                          <Badge
                            key={niche}
                            variant={isSelected ? "default" : "outline"}
                            className="cursor-pointer"
                            onClick={() => toggleNicheItem(industryId, niche)}
                            data-testid={`badge-niche-${industryId}-${niche}`}
                          >
                            {niche}
                          </Badge>
                        );
                      })}
                    </div>
                    <Separator />
                  </div>
                );
              })}
            </div>
          )}

          {formData.selectedIndustries.length > 0 && (
            <Button 
              variant="ghost" 
              className="w-full"
              onClick={() => setCurrentStep(7)}
              data-testid="button-skip-niches"
            >
              Skip this step
            </Button>
          )}
        </div>
      )}

      {/* CUSTOMER STEP 7: Finish */}
      {!isVendor && currentStep === 7 && (
        <div className="space-y-4 text-center py-4">
          <div className="h-16 w-16 rounded-full bg-primary/10 flex items-center justify-center mx-auto">
            <Check className="h-8 w-8 text-primary" />
          </div>
          <h3 className="text-xl font-semibold">You're all set!</h3>
          <p className="text-muted-foreground">
            Your personalized Outsyde experience is ready. Start discovering amazing local businesses tailored just for you.
          </p>
          
          {formData.selectedIndustries.length > 0 && (
            <div className="text-left p-4 bg-muted/50 rounded-md mt-4">
              <p className="text-sm font-medium mb-2">Your interests:</p>
              <div className="flex flex-wrap gap-2">
                {formData.selectedIndustries.map((id) => {
                  const industry = industries.find(i => i.id === id);
                  return industry ? (
                    <Badge key={id} variant="secondary">{industry.name}</Badge>
                  ) : null;
                })}
              </div>
              {Object.keys(formData.industryNiches).some(k => formData.industryNiches[k]?.length > 0) && (
                <div className="mt-3">
                  <p className="text-sm font-medium mb-2">Your tastes:</p>
                  <div className="flex flex-wrap gap-1">
                    {Object.entries(formData.industryNiches).flatMap(([_, niches]) => 
                      niches.slice(0, 5).map(niche => (
                        <Badge key={niche} variant="outline" className="text-xs">{niche}</Badge>
                      ))
                    )}
                    {Object.values(formData.industryNiches).flat().length > 5 && (
                      <Badge variant="outline" className="text-xs">
                        +{Object.values(formData.industryNiches).flat().length - 5} more
                      </Badge>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* VENDOR STEP 1: Account */}
      {isVendor && currentStep === 1 && (
        <div className="space-y-4">
          <div>
            <Label htmlFor="name">Your Full Name</Label>
            <Input
              id="name"
              value={formData.name}
              onChange={(e) => updateField("name", e.target.value)}
              placeholder="John Doe"
              data-testid="input-name"
            />
          </div>
          <div>
            <Label htmlFor="email">Business Email</Label>
            <Input
              id="email"
              type="email"
              value={formData.email}
              onChange={(e) => updateField("email", e.target.value)}
              placeholder="contact@yourbusiness.com"
              data-testid="input-email"
            />
          </div>
          <div>
            <Label htmlFor="phone">Business Phone</Label>
            <Input
              id="phone"
              type="tel"
              value={formData.phone}
              onChange={(e) => updateField("phone", e.target.value)}
              placeholder="(555) 123-4567"
              data-testid="input-phone"
            />
          </div>
          <div>
            <Label htmlFor="password">Password</Label>
            <div className="relative">
              <Input
                id="password"
                type={showPassword ? "text" : "password"}
                value={formData.password}
                onChange={(e) => updateField("password", e.target.value)}
                placeholder="Create a password"
                data-testid="input-password"
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

      {/* VENDOR STEP 2: Business Info */}
      {isVendor && currentStep === 2 && (
        <div className="space-y-4">
          <div>
            <Label htmlFor="businessName">Business Name</Label>
            <Input
              id="businessName"
              value={formData.businessName}
              onChange={(e) => updateField("businessName", e.target.value)}
              placeholder="Your Business Name"
              data-testid="input-business-name"
            />
          </div>
          <div>
            <Label htmlFor="businessCategory">Business Category</Label>
            <Select
              value={formData.businessCategory}
              onValueChange={(value) => updateField("businessCategory", value)}
            >
              <SelectTrigger data-testid="select-business-category">
                <SelectValue placeholder="Select a category" />
              </SelectTrigger>
              <SelectContent>
                {categories.map((cat) => (
                  <SelectItem key={cat} value={cat}>
                    {cat}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label htmlFor="businessDescription">Business Description</Label>
            <Textarea
              id="businessDescription"
              value={formData.businessDescription}
              onChange={(e) => updateField("businessDescription", e.target.value)}
              placeholder="Tell customers about your business, what makes you unique, and what you offer..."
              className="min-h-[100px]"
              data-testid="input-business-description"
            />
          </div>
        </div>
      )}

      {/* VENDOR STEP 3: Business Details */}
      {isVendor && currentStep === 3 && (
        <div className="space-y-5">
          <div>
            <Label className="text-base font-medium">Are you a startup?</Label>
            <p className="text-sm text-muted-foreground mb-3">
              Startups less than 2 years old may qualify for promotional features
            </p>
            <RadioGroup
              value={formData.isStartup === true ? "yes" : formData.isStartup === false ? "no" : ""}
              onValueChange={(value) => updateField("isStartup", value === "yes")}
              className="flex gap-4"
            >
              <div className="flex items-center gap-2 p-3 border rounded-md flex-1 cursor-pointer hover-elevate" onClick={() => updateField("isStartup", true)}>
                <RadioGroupItem value="yes" id="startup-yes" data-testid="radio-startup-yes" />
                <Label htmlFor="startup-yes" className="cursor-pointer flex items-center gap-2">
                  <Rocket className="h-4 w-4 text-primary" />
                  Yes, we're a startup
                </Label>
              </div>
              <div className="flex items-center gap-2 p-3 border rounded-md flex-1 cursor-pointer hover-elevate" onClick={() => updateField("isStartup", false)}>
                <RadioGroupItem value="no" id="startup-no" data-testid="radio-startup-no" />
                <Label htmlFor="startup-no" className="cursor-pointer flex items-center gap-2">
                  <Building2 className="h-4 w-4" />
                  No, established business
                </Label>
              </div>
            </RadioGroup>
          </div>

          <Separator />

          <div>
            <Label htmlFor="yearsInBusiness">How long have you been in business?</Label>
            <Select
              value={formData.yearsInBusiness}
              onValueChange={(value) => updateField("yearsInBusiness", value)}
            >
              <SelectTrigger data-testid="select-years-in-business">
                <SelectValue placeholder="Select years" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="less-than-1">Less than 1 year</SelectItem>
                <SelectItem value="1-2">1-2 years</SelectItem>
                <SelectItem value="3-5">3-5 years</SelectItem>
                <SelectItem value="5-10">5-10 years</SelectItem>
                <SelectItem value="10+">10+ years</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div>
            <Label htmlFor="employeeCount">Number of Employees</Label>
            <Select
              value={formData.employeeCount}
              onValueChange={(value) => updateField("employeeCount", value)}
            >
              <SelectTrigger data-testid="select-employee-count">
                <SelectValue placeholder="Select range" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="just-me">Just me (Solo)</SelectItem>
                <SelectItem value="2-5">2-5 employees</SelectItem>
                <SelectItem value="6-10">6-10 employees</SelectItem>
                <SelectItem value="11-25">11-25 employees</SelectItem>
                <SelectItem value="25+">25+ employees</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div>
            <Label htmlFor="businessType">Business Structure</Label>
            <Select
              value={formData.businessType}
              onValueChange={(value) => updateField("businessType", value)}
            >
              <SelectTrigger data-testid="select-business-type">
                <SelectValue placeholder="Select structure" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="sole-proprietor">Sole Proprietorship</SelectItem>
                <SelectItem value="llc">LLC</SelectItem>
                <SelectItem value="corporation">Corporation</SelectItem>
                <SelectItem value="partnership">Partnership</SelectItem>
                <SelectItem value="nonprofit">Non-profit</SelectItem>
                <SelectItem value="other">Other</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      )}

      {/* VENDOR STEP 4: Location */}
      {isVendor && currentStep === 4 && (
        <div className="space-y-5">
          <div>
            <Label className="text-base font-medium">Do you have a physical location?</Label>
            <p className="text-sm text-muted-foreground mb-3">
              Let us know where customers can find you
            </p>
            <RadioGroup
              value={formData.hasPhysicalLocation === true ? "physical" : formData.hasPhysicalLocation === false ? "online" : ""}
              onValueChange={(value) => updateField("hasPhysicalLocation", value === "physical")}
              className="flex gap-4"
            >
              <div className="flex items-center gap-2 p-3 border rounded-md flex-1 cursor-pointer hover-elevate" onClick={() => updateField("hasPhysicalLocation", true)}>
                <RadioGroupItem value="physical" id="location-physical" data-testid="radio-physical-location" />
                <Label htmlFor="location-physical" className="cursor-pointer flex items-center gap-2">
                  <Store className="h-4 w-4 text-primary" />
                  Physical store/office
                </Label>
              </div>
              <div className="flex items-center gap-2 p-3 border rounded-md flex-1 cursor-pointer hover-elevate" onClick={() => updateField("hasPhysicalLocation", false)}>
                <RadioGroupItem value="online" id="location-online" data-testid="radio-online-only" />
                <Label htmlFor="location-online" className="cursor-pointer flex items-center gap-2">
                  <Globe className="h-4 w-4" />
                  Fully online
                </Label>
              </div>
            </RadioGroup>
          </div>

          {formData.hasPhysicalLocation && (
            <>
              <Separator />
              <div>
                <Label htmlFor="location">Business Address</Label>
                <Input
                  id="location"
                  value={formData.location}
                  onChange={(e) => updateField("location", e.target.value)}
                  placeholder="123 Main Street"
                  data-testid="input-business-address"
                />
              </div>
              <div>
                <Label htmlFor="city">City</Label>
                <Input
                  id="city"
                  value={formData.city}
                  onChange={(e) => updateField("city", e.target.value)}
                  placeholder="New York"
                  data-testid="input-business-city"
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="state">State</Label>
                  <Select
                    value={formData.state}
                    onValueChange={(value) => updateField("state", value)}
                  >
                    <SelectTrigger data-testid="select-business-state">
                      <SelectValue placeholder="Select" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="NY">New York</SelectItem>
                      <SelectItem value="CA">California</SelectItem>
                      <SelectItem value="TX">Texas</SelectItem>
                      <SelectItem value="FL">Florida</SelectItem>
                      <SelectItem value="GA">Georgia</SelectItem>
                      <SelectItem value="IL">Illinois</SelectItem>
                      <SelectItem value="other">Other</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label htmlFor="zipCode">ZIP Code</Label>
                  <Input
                    id="zipCode"
                    value={formData.zipCode}
                    onChange={(e) => updateField("zipCode", e.target.value)}
                    placeholder="10001"
                    data-testid="input-business-zipcode"
                  />
                </div>
              </div>
            </>
          )}

          {formData.hasPhysicalLocation === false && (
            <>
              <Separator />
              <div className="p-4 bg-muted/50 rounded-md">
                <p className="text-sm text-muted-foreground">
                  As an online-only business, you'll still be discoverable by customers in your service area. You can specify your service regions in your business settings after signup.
                </p>
              </div>
            </>
          )}
        </div>
      )}

      {/* VENDOR STEP 5: Online Presence */}
      {isVendor && currentStep === 5 && (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Help customers find you online (optional)
          </p>
          <div>
            <Label htmlFor="websiteUrl">Website URL</Label>
            <Input
              id="websiteUrl"
              type="url"
              value={formData.websiteUrl}
              onChange={(e) => updateField("websiteUrl", e.target.value)}
              placeholder="https://yourbusiness.com"
              data-testid="input-website-url"
            />
          </div>
          <div>
            <Label htmlFor="socialMedia">Social Media Handle</Label>
            <Input
              id="socialMedia"
              value={formData.socialMedia}
              onChange={(e) => updateField("socialMedia", e.target.value)}
              placeholder="@yourbusiness"
              data-testid="input-social-media"
            />
            <p className="text-xs text-muted-foreground mt-1">
              Your primary social media username (Instagram, Facebook, etc.)
            </p>
          </div>
        </div>
      )}

      {/* VENDOR STEP 6: Subscription */}
      {isVendor && currentStep === 6 && (
        <div className="space-y-5">
          <div className="p-4 bg-primary/5 border border-primary/20 rounded-lg">
            <div className="flex items-center gap-3 mb-3">
              <div className="h-12 w-12 rounded-full bg-primary/10 flex items-center justify-center">
                <CreditCard className="h-6 w-6 text-primary" />
              </div>
              <div>
                <h3 className="font-semibold text-lg">Outsyde Business Plan</h3>
                <p className="text-2xl font-bold text-primary">$40<span className="text-sm font-normal text-muted-foreground">/month</span></p>
              </div>
            </div>
            <Separator className="my-4" />
            <ul className="space-y-2 text-sm">
              <li className="flex items-center gap-2">
                <Check className="h-4 w-4 text-primary" />
                Customizable storefront page
              </li>
              <li className="flex items-center gap-2">
                <Check className="h-4 w-4 text-primary" />
                Product & service listings
              </li>
              <li className="flex items-center gap-2">
                <Check className="h-4 w-4 text-primary" />
                Booking & appointment system
              </li>
              <li className="flex items-center gap-2">
                <Check className="h-4 w-4 text-primary" />
                Customer messaging
              </li>
              <li className="flex items-center gap-2">
                <Check className="h-4 w-4 text-primary" />
                Promoted visibility in local feed
              </li>
              <li className="flex items-center gap-2">
                <Check className="h-4 w-4 text-primary" />
                Analytics dashboard
              </li>
              <li className="flex items-center gap-2">
                <Check className="h-4 w-4 text-primary" />
                Loyalty program integration
              </li>
              <li className="flex items-center gap-2">
                <Check className="h-4 w-4 text-primary" />
                Stripe payment processing
              </li>
            </ul>
          </div>

          <div
            className={`flex items-start gap-3 p-4 border rounded-md cursor-pointer ${
              formData.acceptedSubscription ? "border-primary bg-primary/5" : ""
            }`}
            onClick={() => updateField("acceptedSubscription", !formData.acceptedSubscription)}
          >
            <Checkbox
              checked={formData.acceptedSubscription}
              onCheckedChange={(checked) => updateField("acceptedSubscription", checked as boolean)}
              data-testid="checkbox-accept-subscription"
            />
            <div>
              <Label className="cursor-pointer font-medium">
                I agree to the $40/month subscription
              </Label>
              <p className="text-xs text-muted-foreground mt-1">
                Your subscription will begin after completing signup. You can cancel anytime from your dashboard. Payment will be processed through Stripe.
              </p>
            </div>
          </div>

          <p className="text-xs text-muted-foreground text-center">
            By subscribing, you agree to our Terms of Service and Privacy Policy
          </p>
        </div>
      )}

      <div className="flex justify-between mt-8">
        <Button
          variant="outline"
          onClick={prevStep}
          disabled={currentStep === 1 || isSubmitting}
          data-testid="button-prev-step"
        >
          <ChevronLeft className="h-4 w-4 mr-1" />
          Back
        </Button>
        <Button 
          onClick={nextStep} 
          disabled={!canProceed() || isSubmitting}
          data-testid="button-next-step"
        >
          {isSubmitting ? (
            <>
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              Creating account...
            </>
          ) : (
            <>
              {currentStep === steps.length ? (isVendor ? "Start Subscription" : "Get Started") : "Continue"}
              {currentStep !== steps.length && <ChevronRight className="h-4 w-4 ml-1" />}
            </>
          )}
        </Button>
      </div>
    </Card>
  );
}

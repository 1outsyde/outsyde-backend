import { useState } from "react";
import { ChevronLeft, ChevronRight, Check, Eye, EyeOff } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";

interface SignupFormProps {
  onComplete?: (data: SignupData) => void;
  isVendor?: boolean;
}

interface SignupData {
  email: string;
  password: string;
  name: string;
  location: string;
  city: string;
  zipCode: string;
  nationality?: string;
  ethnicity?: string;
  ageRange?: string;
  interests: string[];
  businessName?: string;
  businessCategory?: string;
}

const steps = [
  { id: 1, name: "Account" },
  { id: 2, name: "Location" },
  { id: 3, name: "Demographics" },
  { id: 4, name: "Interests" },
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

export default function SignupForm({ onComplete, isVendor = false }: SignupFormProps) {
  const [currentStep, setCurrentStep] = useState(1);
  const [showPassword, setShowPassword] = useState(false);
  const [formData, setFormData] = useState<SignupData>({
    email: "",
    password: "",
    name: "",
    location: "",
    city: "",
    zipCode: "",
    nationality: "",
    ethnicity: "",
    ageRange: "",
    interests: [],
    businessName: "",
    businessCategory: "",
  });

  const progress = (currentStep / steps.length) * 100;

  const updateField = (field: keyof SignupData, value: string | string[]) => {
    setFormData({ ...formData, [field]: value });
  };

  const toggleInterest = (interest: string) => {
    const interests = formData.interests.includes(interest)
      ? formData.interests.filter((i) => i !== interest)
      : [...formData.interests, interest];
    updateField("interests", interests);
  };

  const nextStep = () => {
    if (currentStep < steps.length) {
      setCurrentStep(currentStep + 1);
    } else {
      onComplete?.(formData);
    }
  };

  const prevStep = () => {
    if (currentStep > 1) {
      setCurrentStep(currentStep - 1);
    }
  };

  return (
    <Card className="w-full max-w-md p-6 overflow-visible" data-testid="signup-form">
      <div className="mb-6">
        <h2 className="text-2xl font-bold mb-2">
          {isVendor ? "Join Outsyde as a Business" : "Join Outsyde"}
        </h2>
        <div className="flex items-center gap-2 mb-4">
          {steps.map((step, index) => (
            <div key={step.id} className="flex items-center">
              <div
                className={`h-8 w-8 rounded-full flex items-center justify-center text-sm font-medium ${
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
          {isVendor && (
            <>
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
            </>
          )}
        </div>
      )}

      {currentStep === 2 && (
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
          <div className="grid grid-cols-2 gap-4">
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

      {currentStep === 3 && (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground mb-4">
            This information helps us personalize your experience (optional)
          </p>
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
                <SelectItem value="uk">United Kingdom</SelectItem>
                <SelectItem value="mx">Mexico</SelectItem>
                <SelectItem value="other">Other</SelectItem>
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
                <SelectItem value="mixed">Mixed / Multiple</SelectItem>
                <SelectItem value="other">Other</SelectItem>
                <SelectItem value="prefer-not">Prefer not to say</SelectItem>
              </SelectContent>
            </Select>
          </div>
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
        </div>
      )}

      {currentStep === 4 && (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground mb-4">
            Select business categories you're interested in
          </p>
          <div className="grid grid-cols-2 gap-3">
            {categories.map((category) => (
              <div
                key={category}
                className={`flex items-center gap-2 p-3 border rounded-md cursor-pointer hover-elevate ${
                  formData.interests.includes(category) ? "border-primary bg-primary/5" : ""
                }`}
                onClick={() => toggleInterest(category)}
                data-testid={`checkbox-interest-${category}`}
              >
                <Checkbox
                  checked={formData.interests.includes(category)}
                  onCheckedChange={() => toggleInterest(category)}
                />
                <span className="text-sm">{category}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="flex justify-between mt-8">
        <Button
          variant="outline"
          onClick={prevStep}
          disabled={currentStep === 1}
          data-testid="button-prev-step"
        >
          <ChevronLeft className="h-4 w-4 mr-1" />
          Back
        </Button>
        <Button onClick={nextStep} data-testid="button-next-step">
          {currentStep === steps.length ? "Complete" : "Continue"}
          {currentStep !== steps.length && <ChevronRight className="h-4 w-4 ml-1" />}
        </Button>
      </div>
    </Card>
  );
}

import { useState } from "react";
import { ArrowLeft } from "lucide-react";
import { SiGoogle } from "react-icons/si";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Separator } from "@/components/ui/separator";
import SignupForm from "@/components/SignupForm";
import heroImage from "@assets/generated_images/local_community_marketplace_hero.png";

interface AuthPageProps {
  onComplete: (isVendor: boolean) => void;
  onBack: () => void;
}

export default function AuthPage({ onComplete, onBack }: AuthPageProps) {
  const [activeTab, setActiveTab] = useState<"customer" | "vendor">("customer");

  const handleGoogleLogin = () => {
    window.location.href = "/api/login";
  };

  return (
    <div className="min-h-screen flex" data-testid="page-auth">
      <div className="hidden lg:block lg:w-1/2 relative">
        <img
          src={heroImage}
          alt="Outsyde Community"
          className="absolute inset-0 w-full h-full object-cover"
        />
        <div className="absolute inset-0 bg-gradient-to-r from-black/70 to-black/40" />
        <div className="absolute inset-0 flex items-center justify-center p-12">
          <div className="text-white max-w-md">
            <h1 className="font-serif text-4xl font-bold mb-4">
              Welcome to Outsyde
            </h1>
            <p className="text-lg opacity-90">
              Join our community of local businesses and customers. Discover amazing
              products and services right in your neighborhood.
            </p>
          </div>
        </div>
      </div>

      <div className="flex-1 flex flex-col">
        <div className="p-4">
          <Button variant="ghost" onClick={onBack} data-testid="button-back">
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back
          </Button>
        </div>

        <div className="flex-1 flex items-center justify-center p-6">
          <div className="w-full max-w-md">
            <div className="text-center mb-8 lg:hidden">
              <h1 className="font-serif text-3xl font-bold text-primary mb-2">
                Outsyde
              </h1>
              <p className="text-muted-foreground">
                Connect with local businesses
              </p>
            </div>

            <div className="mb-6">
              <Button
                variant="outline"
                className="w-full gap-2"
                onClick={handleGoogleLogin}
                data-testid="button-google-login"
              >
                <SiGoogle className="h-4 w-4" />
                Continue with Google
              </Button>
              
              <div className="relative my-6">
                <Separator />
                <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-background px-2 text-xs text-muted-foreground">
                  or create an account
                </span>
              </div>
            </div>

            <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as "customer" | "vendor")}>
              <TabsList className="grid w-full grid-cols-2 mb-6">
                <TabsTrigger value="customer" data-testid="tab-customer">
                  I'm a Customer
                </TabsTrigger>
                <TabsTrigger value="vendor" data-testid="tab-vendor">
                  I'm a Business
                </TabsTrigger>
              </TabsList>

              <TabsContent value="customer">
                <SignupForm
                  isVendor={false}
                  onComplete={() => onComplete(false)}
                />
              </TabsContent>

              <TabsContent value="vendor">
                <SignupForm
                  isVendor={true}
                  onComplete={() => onComplete(true)}
                />
              </TabsContent>
            </Tabs>
          </div>
        </div>
      </div>
    </div>
  );
}

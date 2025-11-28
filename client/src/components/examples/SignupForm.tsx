import { useState } from "react";
import SignupForm from "../SignupForm";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export default function SignupFormExample() {
  const [activeTab, setActiveTab] = useState("customer");

  return (
    <div className="max-w-md mx-auto">
      <Tabs value={activeTab} onValueChange={setActiveTab} className="mb-4">
        <TabsList className="grid w-full grid-cols-2">
          <TabsTrigger value="customer">Customer Signup</TabsTrigger>
          <TabsTrigger value="vendor">Business Signup</TabsTrigger>
        </TabsList>
      </Tabs>

      {activeTab === "customer" && (
        <SignupForm
          isVendor={false}
          onComplete={(data) => console.log("Customer signup complete:", data)}
        />
      )}

      {activeTab === "vendor" && (
        <SignupForm
          isVendor={true}
          onComplete={(data) => console.log("Business signup complete:", data)}
        />
      )}
    </div>
  );
}

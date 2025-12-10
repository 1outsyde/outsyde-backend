import { useState } from "react";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";

import TopNav from "@/components/TopNav";
import BottomNav from "@/components/BottomNav";
import CartDrawer from "@/components/CartDrawer";

import HomePage from "@/pages/home";
import SearchPage from "@/pages/search";
import MessagesPage from "@/pages/messages";
import ProfilePage from "@/pages/profile";
import VendorPage from "@/pages/vendor";
import AuthPage from "@/pages/auth";
import VendorDashboardPage from "@/pages/vendor-dashboard";

import jewelryImage from "@assets/generated_images/jewelry_artisan_vendor_image.png";

type Page = "home" | "search" | "messages" | "profile" | "vendor" | "auth" | "vendor-dashboard";
type NavTab = "home" | "search" | "create" | "messages" | "profile";

interface MessageTarget {
  vendorId: string;
  vendorName?: string;
}

function App() {
  const [currentPage, setCurrentPage] = useState<Page>("home");
  const [activeTab, setActiveTab] = useState<NavTab>("home");
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isVendor, setIsVendor] = useState(false);
  const [selectedVendorId, setSelectedVendorId] = useState<string>("1");
  const [messageTarget, setMessageTarget] = useState<MessageTarget | null>(null);

  // todo: remove mock functionality
  const [cartItems, setCartItems] = useState([
    {
      id: "1",
      name: "Handcrafted Silver Pendant",
      image: jewelryImage,
      price: 45.99,
      quantity: 1,
      vendorName: "Artisan Jewelry Co.",
    },
  ]);
  const [pointsToRedeem, setPointsToRedeem] = useState(0);

  const handleNavTabChange = (tab: NavTab) => {
    setActiveTab(tab);
    if (tab === "home") setCurrentPage("home");
    else if (tab === "search") setCurrentPage("search");
    else if (tab === "messages") {
      if (!isAuthenticated) {
        setCurrentPage("auth");
      } else {
        setCurrentPage("messages");
      }
    }
    else if (tab === "profile") {
      if (!isAuthenticated) {
        setCurrentPage("auth");
      } else if (isVendor) {
        setCurrentPage("vendor-dashboard");
      } else {
        setCurrentPage("profile");
      }
    }
  };

  const handleViewBusiness = (id: string) => {
    setSelectedVendorId(id);
    setCurrentPage("vendor");
  };

  const handleMessage = (id: string, name?: string) => {
    if (!isAuthenticated) {
      setCurrentPage("auth");
    } else {
      setMessageTarget({ vendorId: id, vendorName: name });
      setCurrentPage("messages");
      setActiveTab("messages");
    }
  };

  const handleAuthComplete = (vendorAccount: boolean) => {
    setIsAuthenticated(true);
    setIsVendor(vendorAccount);
    if (vendorAccount) {
      setCurrentPage("vendor-dashboard");
    } else {
      setCurrentPage("home");
      setActiveTab("home");
    }
  };

  const handleLogout = () => {
    setIsAuthenticated(false);
    setIsVendor(false);
    setCurrentPage("home");
    setActiveTab("home");
  };

  const handleUpdateCartQuantity = (id: string, quantity: number) => {
    if (quantity === 0) {
      setCartItems(cartItems.filter((item) => item.id !== id));
    } else {
      setCartItems(
        cartItems.map((item) =>
          item.id === id ? { ...item, quantity } : item
        )
      );
    }
  };

  const handleRemoveFromCart = (id: string) => {
    setCartItems(cartItems.filter((item) => item.id !== id));
  };

  if (currentPage === "auth") {
    return (
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <AuthPage
            onComplete={handleAuthComplete}
            onBack={() => {
              setCurrentPage("home");
              setActiveTab("home");
            }}
          />
          <Toaster />
        </TooltipProvider>
      </QueryClientProvider>
    );
  }

  if (currentPage === "vendor-dashboard" && isVendor) {
    return (
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <VendorDashboardPage onLogout={handleLogout} />
          <Toaster />
        </TooltipProvider>
      </QueryClientProvider>
    );
  }

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <div className="min-h-screen bg-background">
          <TopNav
            unreadMessages={3}
            unreadNotifications={5}
            onMenuClick={() => console.log("Menu")}
            onSearchChange={(value) => console.log("Search:", value)}
            onMessagesClick={() => handleNavTabChange("messages")}
            onNotificationsClick={() => console.log("Notifications")}
            onProfileClick={() => handleNavTabChange("profile")}
          />

          <div className="fixed top-4 right-20 z-50">
            <CartDrawer
              items={cartItems}
              pointsBalance={2450}
              pointsToRedeem={pointsToRedeem}
              onUpdateQuantity={handleUpdateCartQuantity}
              onRemove={handleRemoveFromCart}
              onRedeemPoints={setPointsToRedeem}
              onCheckout={() => console.log("Checkout")}
            />
          </div>

          <main>
            {currentPage === "home" && (
              <HomePage
                onViewBusiness={handleViewBusiness}
                onMessage={handleMessage}
              />
            )}
            {currentPage === "search" && (
              <SearchPage
                onViewBusiness={handleViewBusiness}
                onMessage={handleMessage}
              />
            )}
            {currentPage === "messages" && (
              <MessagesPage 
                targetVendorId={messageTarget?.vendorId}
                onClearTarget={() => setMessageTarget(null)}
              />
            )}
            {currentPage === "profile" && <ProfilePage onLogout={handleLogout} />}
            {currentPage === "vendor" && (
              <VendorPage
                vendorId={selectedVendorId}
                onBack={() => {
                  setCurrentPage("home");
                  setActiveTab("home");
                }}
                onMessage={handleMessage}
              />
            )}
          </main>

          <BottomNav
            activeTab={activeTab}
            onTabChange={handleNavTabChange}
            isVendor={isVendor && isAuthenticated}
          />
        </div>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;

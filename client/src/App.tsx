import { useState } from "react";
import { queryClient, getQueryFn } from "./lib/queryClient";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";

import TopNav from "@/components/TopNav";
import BottomNav from "@/components/BottomNav";
import CartDrawer from "@/components/CartDrawer";
import { useCart } from "@/hooks/useCart";

import HomePage from "@/pages/home";
import SearchPage from "@/pages/search";
import MessagesPage from "@/pages/messages";
import ProfilePage from "@/pages/profile";
import VendorPage from "@/pages/vendor";
import AuthPage from "@/pages/auth";
import VendorDashboardPage from "@/pages/vendor-dashboard";

import jewelryImage from "@assets/generated_images/jewelry_artisan_vendor_image.png";
import type { User } from "@shared/schema";

type Page = "home" | "search" | "messages" | "profile" | "vendor" | "auth" | "vendor-dashboard";
type NavTab = "home" | "search" | "create" | "messages" | "profile";

interface MessageTarget {
  vendorId: string;
  vendorName?: string;
}

function AppContent() {
  const [currentPage, setCurrentPage] = useState<Page>("home");
  const [activeTab, setActiveTab] = useState<NavTab>("home");
  const [selectedVendorId, setSelectedVendorId] = useState<string>("1");
  const [messageTarget, setMessageTarget] = useState<MessageTarget | null>(null);

  const { data: user, isLoading: authLoading, refetch: refetchUser } = useQuery<User | null>({
    queryKey: ["/api/auth/user"],
    queryFn: getQueryFn({ on401: "returnNull" }),
    retry: false,
    staleTime: 1000 * 60 * 5,
  });

  const isAuthenticated = !!user;
  const isVendor = user?.isVendor ?? false;

  const { 
    items: dbCartItems, 
    updateQuantity, 
    removeItem, 
    clearCart,
    isLoading: cartLoading 
  } = useCart();

  const [localCartItems, setLocalCartItems] = useState([
    {
      id: "demo-1",
      name: "Handcrafted Silver Pendant",
      image: jewelryImage,
      price: 45.99,
      quantity: 1,
      vendorName: "Artisan Jewelry Co.",
    },
  ]);
  const [pointsToRedeem, setPointsToRedeem] = useState(0);

  const cartItems = isAuthenticated 
    ? dbCartItems.map(item => ({
        id: item.id,
        name: item.productName,
        image: item.productImage || jewelryImage,
        price: item.priceInCents / 100,
        quantity: item.quantity,
        vendorName: item.businessName || "Local Business",
      }))
    : localCartItems;

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

  const handleAuthComplete = async (vendorAccount: boolean) => {
    await refetchUser();
    if (vendorAccount) {
      setCurrentPage("vendor-dashboard");
    } else {
      setCurrentPage("home");
      setActiveTab("home");
    }
  };

  const handleLogout = async () => {
    try {
      await fetch("/api/logout", { credentials: "include" });
      await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
    } catch (e) {
      // Ignore errors
    }
    queryClient.invalidateQueries({ queryKey: ["/api/auth/user"] });
    setCurrentPage("home");
    setActiveTab("home");
  };

  const handleUpdateCartQuantity = (id: string, quantity: number) => {
    if (isAuthenticated) {
      updateQuantity(id, quantity);
    } else {
      if (quantity === 0) {
        setLocalCartItems(localCartItems.filter((item) => item.id !== id));
      } else {
        setLocalCartItems(
          localCartItems.map((item) =>
            item.id === id ? { ...item, quantity } : item
          )
        );
      }
    }
  };

  const handleRemoveFromCart = (id: string) => {
    if (isAuthenticated) {
      removeItem(id);
    } else {
      setLocalCartItems(localCartItems.filter((item) => item.id !== id));
    }
  };

  if (currentPage === "auth") {
    return (
      <>
        <AuthPage
          onComplete={handleAuthComplete}
          onBack={() => {
            setCurrentPage("home");
            setActiveTab("home");
          }}
        />
        <Toaster />
      </>
    );
  }

  if (currentPage === "vendor-dashboard" && isVendor) {
    return (
      <>
        <VendorDashboardPage onLogout={handleLogout} />
        <Toaster />
      </>
    );
  }

  return (
    <>
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
            />
          )}
          {currentPage === "search" && (
            <SearchPage
              onViewBusiness={handleViewBusiness}
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
              onLoginRequired={() => setCurrentPage("auth")}
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
    </>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <AppContent />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;

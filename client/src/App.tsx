import { useState, useEffect } from "react";
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
import PhotographerDashboardPage from "@/pages/photographer-dashboard";
import InfluencerDashboardPage from "@/pages/influencer-dashboard";
import StaffDashboardPage from "@/pages/staff-dashboard";
import AdminFulfillmentPage from "@/pages/admin-fulfillment";
import AdminDashboardPage from "@/pages/admin-dashboard";
import CreatePostPage from "@/pages/create-post";
import OrderSuccessPage from "@/pages/order-success";
import CheckoutContinuePage from "@/pages/checkout-continue";
import VendorOnboardingPage from "@/pages/vendor-onboarding";

import jewelryImage from "@assets/generated_images/jewelry_artisan_vendor_image.png";
import type { User } from "@shared/schema";

type Page = "home" | "search" | "messages" | "profile" | "vendor" | "auth" | "vendor-dashboard" | "photographer-dashboard" | "influencer-dashboard" | "staff-dashboard" | "admin-fulfillment" | "admin-dashboard" | "create-post" | "photographer-page" | "order-success" | "checkout-continue" | "vendor-onboarding" | "influencer-onboarding";
type NavTab = "home" | "search" | "create" | "messages" | "profile" | "dashboard";

interface MessageTarget {
  vendorId: string;
  vendorName?: string;
}

function AppContent() {
  const [currentPage, setCurrentPage] = useState<Page>("home");
  const [activeTab, setActiveTab] = useState<NavTab>("home");
  const [selectedVendorId, setSelectedVendorId] = useState<string>("1");
  const [selectedVendorType, setSelectedVendorType] = useState<"business" | "photographer">("business");
  const [messageTarget, setMessageTarget] = useState<MessageTarget | null>(null);
  
  const [checkoutOrderId, setCheckoutOrderId] = useState<string | null>(null);
  const [checkoutOrderGroupId, setCheckoutOrderGroupId] = useState<string | null>(null);
  const [completedOrderId, setCompletedOrderId] = useState<string | null>(null);

  useEffect(() => {
    const path = window.location.pathname;
    const params = new URLSearchParams(window.location.search);
    
    if (path === "/order-success" || path.includes("order-success")) {
      const orderId = params.get("orderId");
      const orderGroupId = params.get("orderGroupId");
      setCheckoutOrderId(orderId);
      setCheckoutOrderGroupId(orderGroupId);
      setCurrentPage("order-success");
    } else if (path === "/checkout/continue" || path.includes("checkout/continue")) {
      const orderGroupId = params.get("orderGroupId");
      const completedId = params.get("completedOrderId");
      if (orderGroupId) {
        setCheckoutOrderGroupId(orderGroupId);
        setCompletedOrderId(completedId);
        setCurrentPage("checkout-continue");
      }
    } else if (path === "/vendor/onboarding" || path.includes("vendor/onboarding")) {
      setCurrentPage("vendor-onboarding");
    } else if (path === "/influencer/onboarding" || path.includes("influencer/onboarding")) {
      setCurrentPage("influencer-dashboard");
    } else if (path === "/influencer/dashboard" || path.includes("influencer-dashboard")) {
      setCurrentPage("influencer-dashboard");
    } else if (path === "/staff-dashboard" || path.includes("staff-dashboard")) {
      setCurrentPage("staff-dashboard");
    } else if (path === "/search") {
      setCurrentPage("search");
      setActiveTab("search");
    }
  }, []);

  const { data: user, isLoading: authLoading, refetch: refetchUser } = useQuery<User | null>({
    queryKey: ["/api/auth/user"],
    queryFn: getQueryFn({ on401: "returnNull" }),
    retry: false,
    staleTime: 1000 * 60 * 5,
  });

  const isAuthenticated = !!user;
  const isVendor = user?.isVendor ?? false;
  const isPhotographer = user?.isPhotographer ?? false;
  const isInfluencer = user?.isInfluencer ?? false;

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
    else if (tab === "create") {
      if (!isAuthenticated) {
        setCurrentPage("auth");
      } else {
        setCurrentPage("create-post");
      }
    }
    else if (tab === "messages") {
      if (!isAuthenticated) {
        setCurrentPage("auth");
      } else {
        setCurrentPage("messages");
      }
    }
    else if (tab === "dashboard") {
      if (!isAuthenticated) {
        setCurrentPage("auth");
      } else if (isPhotographer) {
        setCurrentPage("photographer-dashboard");
      } else if (isVendor) {
        setCurrentPage("vendor-dashboard");
      } else {
        setCurrentPage("profile");
      }
    }
    else if (tab === "profile") {
      if (!isAuthenticated) {
        setCurrentPage("auth");
      } else {
        setCurrentPage("profile");
      }
    }
  };

  const handleViewBusiness = (id: string) => {
    setSelectedVendorId(id);
    setSelectedVendorType("business");
    setCurrentPage("vendor");
  };

  const handleViewPhotographer = (id: string) => {
    setSelectedVendorId(id);
    setSelectedVendorType("photographer");
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

  const handleAuthComplete = async (vendorAccount: boolean, photographerAccount?: boolean) => {
    await refetchUser();
    if (vendorAccount) {
      setCurrentPage("vendor-dashboard");
    } else if (photographerAccount) {
      setCurrentPage("photographer-dashboard");
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


  if (currentPage === "admin-fulfillment" && user?.isAdmin) {
    return (
      <>
        <AdminFulfillmentPage />
        <Toaster />
      </>
    );
  }

  if (currentPage === "admin-dashboard" && user?.isAdmin) {
    return (
      <>
        <AdminDashboardPage onBack={() => setCurrentPage("profile")} />
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
          onSearchClick={() => handleNavTabChange("search")}
          onMessagesClick={() => handleNavTabChange("messages")}
          onNotificationsClick={() => console.log("Notifications")}
          onProfileClick={() => handleNavTabChange("profile")}
          cartDrawer={
            <CartDrawer
              items={cartItems}
              pointsBalance={(isPhotographer || isVendor) ? 0 : 2450}
              pointsToRedeem={pointsToRedeem}
              onUpdateQuantity={handleUpdateCartQuantity}
              onRemove={handleRemoveFromCart}
              onRedeemPoints={setPointsToRedeem}
              onCheckout={() => console.log("Checkout")}
            />
          }
        />

        <main>
          {currentPage === "home" && (
            <HomePage
              onViewBusiness={handleViewBusiness}
              onViewPhotographer={handleViewPhotographer}
              onLoginRequired={() => setCurrentPage("auth")}
            />
          )}
          {currentPage === "search" && (
            <SearchPage
              onViewBusiness={handleViewBusiness}
              onViewPhotographer={handleViewPhotographer}
            />
          )}
          {currentPage === "messages" && (
            <MessagesPage 
              targetVendorId={messageTarget?.vendorId}
              onClearTarget={() => setMessageTarget(null)}
            />
          )}
          {currentPage === "profile" && <ProfilePage onLogout={handleLogout} onAdminDashboard={() => setCurrentPage("admin-dashboard")} />}
          {currentPage === "vendor" && (
            <VendorPage
              vendorId={selectedVendorId}
              vendorType={selectedVendorType}
              onBack={() => {
                setCurrentPage("home");
                setActiveTab("home");
              }}
              onLoginRequired={() => setCurrentPage("auth")}
              viewerIsPhotographer={isPhotographer}
              onCollaborate={(id, name) => handleMessage(id, name)}
              isAuthenticated={isAuthenticated}
            />
          )}
          {currentPage === "vendor-dashboard" && isVendor && (
            <VendorDashboardPage onLogout={handleLogout} />
          )}
          {currentPage === "photographer-dashboard" && isPhotographer && (
            <PhotographerDashboardPage onLogout={handleLogout} />
          )}
          {currentPage === "influencer-dashboard" && isInfluencer && (
            <InfluencerDashboardPage onLogout={handleLogout} />
          )}
          {currentPage === "staff-dashboard" && (
            <StaffDashboardPage onLogout={handleLogout} />
          )}
          {currentPage === "create-post" && (
            <CreatePostPage onBack={() => {
              setCurrentPage("home");
              setActiveTab("home");
            }} />
          )}
          {currentPage === "order-success" && (
            <OrderSuccessPage 
              orderId={checkoutOrderId || undefined}
              orderGroupId={checkoutOrderGroupId || undefined}
              onContinueShopping={() => {
                setCurrentPage("home");
                setActiveTab("home");
                setCheckoutOrderId(null);
                setCheckoutOrderGroupId(null);
              }}
            />
          )}
          {currentPage === "checkout-continue" && checkoutOrderGroupId && (
            <CheckoutContinuePage 
              orderGroupId={checkoutOrderGroupId}
              completedOrderId={completedOrderId || undefined}
              onComplete={() => {
                setCurrentPage("home");
                setActiveTab("home");
                setCheckoutOrderGroupId(null);
                setCompletedOrderId(null);
              }}
              onOrderSuccess={(groupId) => {
                setCheckoutOrderGroupId(groupId);
                setCheckoutOrderId(null);
                setCompletedOrderId(null);
                setCurrentPage("order-success");
              }}
            />
          )}
          {currentPage === "vendor-onboarding" && (
            <VendorOnboardingPage />
          )}
        </main>

        <BottomNav
          activeTab={activeTab}
          onTabChange={handleNavTabChange}
          isVendor={isVendor && isAuthenticated}
          isPhotographer={isPhotographer && isAuthenticated}
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

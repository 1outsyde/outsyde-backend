import { useState } from "react";
import { MapPin, Star, Share2, Heart, Mail, Phone, Globe, Handshake, MessageSquare, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent } from "@/components/ui/card";
import ProductCard from "./ProductCard";
import ServiceCard from "./ServiceCard";
import BookingCalendar from "./BookingCalendar";
import VendorChat from "./VendorChat";
import ProfileComments from "./ProfileComments";
import BusinessHoursDisplay from "./BusinessHoursDisplay";
import type { HoursOfOperation, StaffMember } from "@shared/schema";

interface Product {
  id: string;
  name: string;
  image: string;
  price: number;
  originalPrice?: number;
  category?: string;
}

interface Service {
  id: string;
  name: string;
  image: string;
  price: number;
  duration?: number;
  category?: string;
  description?: string;
}

interface BrandColors {
  primary?: string;
  secondary?: string;
}

interface VendorStorefrontProps {
  id: string;
  ownerId: string;
  name: string;
  avatar?: string;
  banner: string;
  bannerType?: "image" | "video";
  category: string;
  location: string;
  rating: number;
  reviewCount: number;
  description: string;
  tagline?: string;
  hoursOfOperation?: HoursOfOperation | null;
  products: Product[];
  services: Service[];
  brandColors?: BrandColors;
  contactEmail?: string;
  contactPhone?: string;
  websiteUrl?: string;
  availableSlots?: Record<string, { time: string; available: boolean }[]>;
  staff?: StaffMember[];
  isFollowing?: boolean;
  onFollow?: () => void;
  onShare?: () => void;
  onLoginRequired?: () => void;
  onBookService?: (serviceId: string, date: string, time: string, staffId?: string) => void;
  viewerIsPhotographer?: boolean;
  onCollaborate?: () => void;
  isAuthenticated?: boolean;
  storefrontType?: "business" | "photographer";
  canAcceptBookings?: boolean;
}

export default function VendorStorefront({
  id,
  ownerId,
  name,
  avatar,
  banner,
  bannerType = "image",
  category,
  location,
  rating,
  reviewCount,
  description,
  tagline,
  hoursOfOperation,
  products,
  services,
  brandColors,
  contactEmail,
  contactPhone,
  websiteUrl,
  availableSlots = {},
  staff = [],
  isFollowing = false,
  onFollow,
  onShare,
  onLoginRequired,
  onBookService,
  viewerIsPhotographer = false,
  onCollaborate,
  isAuthenticated = false,
  storefrontType = "business",
  canAcceptBookings = true,
}: VendorStorefrontProps) {
  const [activeTab, setActiveTab] = useState("about");
  const [selectedService, setSelectedService] = useState<Service | null>(null);
  const [selectedStaff, setSelectedStaff] = useState<string | null>(null);
  
  const activeStaff = staff.filter(s => s.status === "active" && s.stripeOnboardingComplete);

  const hasBrandColor = !!brandColors?.primary;
  const customStyles = hasBrandColor ? {
    '--vendor-primary': brandColors.primary,
    '--vendor-secondary': brandColors.secondary || brandColors.primary,
  } as React.CSSProperties : {};
  
  const brandButtonStyle = hasBrandColor ? { backgroundColor: brandColors.primary } : undefined;
  const brandBorderStyle = hasBrandColor ? { borderColor: brandColors.primary } : undefined;

  return (
    <div 
      className="min-h-screen" 
      data-testid={`vendor-storefront-${id}`}
      style={customStyles}
    >
      <div className="relative">
        <div className="aspect-[16/9] max-h-[300px] overflow-hidden">
          {bannerType === "video" && banner ? (
            <video
              src={banner}
              className="w-full h-full object-cover"
              autoPlay
              loop
              muted
              playsInline
              data-testid="storefront-banner-video"
            />
          ) : (
            <img
              src={banner}
              alt={name}
              className="w-full h-full object-cover"
              data-testid="storefront-banner-image"
            />
          )}
        </div>
        <div className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent" />
        <div className="absolute bottom-0 left-0 right-0 p-4 md:p-6">
          <div className="flex items-end gap-4">
            <Avatar className="h-20 w-20 md:h-24 md:w-24 border-4 border-background">
              <AvatarImage src={avatar} alt={name} />
              <AvatarFallback className="text-2xl">{name.charAt(0)}</AvatarFallback>
            </Avatar>
            <div className="flex-1 text-white">
              <h1 className="text-2xl md:text-3xl font-bold" data-testid="text-vendor-name">{name}</h1>
              <div className="flex flex-wrap items-center gap-2 mt-1">
                <Badge variant="secondary">{category}</Badge>
                <div className="flex items-center gap-1 text-sm">
                  <MapPin className="h-4 w-4" />
                  <span>{location}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 py-4">
        <div className="flex flex-wrap items-center justify-between gap-4 mb-6">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-1">
              <Star className="h-5 w-5 fill-yellow-400 text-yellow-400" />
              <span className="font-semibold">{rating.toFixed(1)}</span>
              <span className="text-muted-foreground">({reviewCount} reviews)</span>
            </div>
            {hoursOfOperation && (
              <BusinessHoursDisplay hours={hoursOfOperation} compact />
            )}
          </div>
          <div className="flex items-center gap-2">
            {viewerIsPhotographer && onCollaborate ? (
              <Button
                onClick={onCollaborate}
                data-testid="button-collaborate"
                style={brandButtonStyle}
              >
                <Handshake className="h-4 w-4 mr-2" />
                Collaborate
              </Button>
            ) : (
              <Button
                variant={isFollowing ? "secondary" : "default"}
                onClick={onFollow}
                data-testid="button-follow"
                style={!isFollowing ? brandButtonStyle : undefined}
              >
                <Heart className={`h-4 w-4 mr-2 ${isFollowing ? "fill-current" : ""}`} />
                {isFollowing ? "Following" : "Follow"}
              </Button>
            )}
            <Button size="icon" variant="outline" onClick={onShare} data-testid="button-share-vendor">
              <Share2 className="h-4 w-4" />
            </Button>
          </div>
        </div>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
          <TabsList className="w-full justify-start border-b rounded-none h-auto p-0 bg-transparent">
            <TabsTrigger
              value="about"
              className="rounded-none border-b-2 data-[state=active]:bg-transparent px-6 py-3"
              style={activeTab === 'about' ? (hasBrandColor ? { borderColor: brandColors.primary } : { borderColor: 'hsl(var(--primary))' }) : { borderColor: 'transparent' }}
              data-testid="tab-about"
            >
              About
            </TabsTrigger>
            {products.length > 0 && (
              <TabsTrigger
                value="products"
                className="rounded-none border-b-2 data-[state=active]:bg-transparent px-6 py-3"
                style={activeTab === 'products' ? (hasBrandColor ? { borderColor: brandColors.primary } : { borderColor: 'hsl(var(--primary))' }) : { borderColor: 'transparent' }}
                data-testid="tab-products"
              >
                Products
              </TabsTrigger>
            )}
            {services.length > 0 && (
              <TabsTrigger
                value="services"
                className="rounded-none border-b-2 data-[state=active]:bg-transparent px-6 py-3"
                style={activeTab === 'services' ? (hasBrandColor ? { borderColor: brandColors.primary } : { borderColor: 'hsl(var(--primary))' }) : { borderColor: 'transparent' }}
                data-testid="tab-services"
              >
                Services
              </TabsTrigger>
            )}
            {services.length > 0 && canAcceptBookings && (
              <TabsTrigger
                value="book"
                className="rounded-none border-b-2 data-[state=active]:bg-transparent px-6 py-3"
                style={activeTab === 'book' ? (hasBrandColor ? { borderColor: brandColors.primary } : { borderColor: 'hsl(var(--primary))' }) : { borderColor: 'transparent' }}
                data-testid="tab-book"
              >
                Book
              </TabsTrigger>
            )}
            <TabsTrigger
              value="chat"
              className="rounded-none border-b-2 data-[state=active]:bg-transparent px-6 py-3"
              style={activeTab === 'chat' ? (hasBrandColor ? { borderColor: brandColors.primary } : { borderColor: 'hsl(var(--primary))' }) : { borderColor: 'transparent' }}
              data-testid="tab-chat"
            >
              Chat
            </TabsTrigger>
            <TabsTrigger
              value="comments"
              className="rounded-none border-b-2 data-[state=active]:bg-transparent px-6 py-3"
              style={activeTab === 'comments' ? (hasBrandColor ? { borderColor: brandColors.primary } : { borderColor: 'hsl(var(--primary))' }) : { borderColor: 'transparent' }}
              data-testid="tab-comments"
            >
              <MessageSquare className="h-4 w-4 mr-1" />
              Comments
            </TabsTrigger>
          </TabsList>

          <TabsContent value="about" className="pt-6">
            <div className="max-w-2xl space-y-6">
              {tagline && (
                <p 
                  className="text-lg font-medium italic"
                  style={brandColors?.primary ? { color: brandColors.primary } : {}}
                  data-testid="text-vendor-tagline"
                >
                  "{tagline}"
                </p>
              )}
              <div>
                <h2 className="text-xl font-semibold mb-4">About Us</h2>
                <p className="text-muted-foreground">{description}</p>
              </div>
              
              {(contactEmail || contactPhone || websiteUrl) && (
                <div className="pt-4 border-t">
                  <h3 className="text-lg font-semibold mb-3">Contact Information</h3>
                  <div className="space-y-2">
                    {contactEmail && (
                      <div className="flex items-center gap-2 text-muted-foreground">
                        <Mail className="h-4 w-4" />
                        <a href={`mailto:${contactEmail}`} className="hover:underline" data-testid="link-vendor-email">
                          {contactEmail}
                        </a>
                      </div>
                    )}
                    {contactPhone && (
                      <div className="flex items-center gap-2 text-muted-foreground">
                        <Phone className="h-4 w-4" />
                        <a href={`tel:${contactPhone}`} className="hover:underline" data-testid="link-vendor-phone">
                          {contactPhone}
                        </a>
                      </div>
                    )}
                    {websiteUrl && (
                      <div className="flex items-center gap-2 text-muted-foreground">
                        <Globe className="h-4 w-4" />
                        <a href={websiteUrl} target="_blank" rel="noopener noreferrer" className="hover:underline" data-testid="link-vendor-website">
                          {websiteUrl}
                        </a>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {hoursOfOperation && (
                <div className="pt-4 border-t">
                  <BusinessHoursDisplay hours={hoursOfOperation} />
                </div>
              )}
            </div>
          </TabsContent>

          <TabsContent value="products" className="pt-6">
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
              {products.map((product) => (
                <ProductCard
                  key={product.id}
                  {...product}
                  onAddToCart={(id) => console.log("Add to cart:", id)}
                />
              ))}
            </div>
          </TabsContent>

          <TabsContent value="services" className="pt-6">
            {!canAcceptBookings && (
              <div className="mb-6 p-4 rounded-md bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800">
                <div className="flex items-start gap-3">
                  <Mail className="h-5 w-5 text-yellow-600 dark:text-yellow-400 mt-0.5 flex-shrink-0" />
                  <div>
                    <h4 className="font-medium text-yellow-800 dark:text-yellow-200">Online Booking Unavailable</h4>
                    <p className="text-sm text-yellow-700 dark:text-yellow-300 mt-1">
                      This {storefrontType === 'photographer' ? 'photographer' : 'vendor'} is not currently accepting online bookings. 
                      <Button 
                        variant="link" 
                        className="px-1 py-0 h-auto text-yellow-800 dark:text-yellow-200 underline"
                        onClick={() => setActiveTab("chat")}
                        data-testid="link-contact-for-booking"
                      >
                        Contact them directly
                      </Button>
                      to inquire about their services.
                    </p>
                  </div>
                </div>
              </div>
            )}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {services.map((service) => (
                <ServiceCard
                  key={service.id}
                  {...service}
                  available={canAcceptBookings}
                  onBook={canAcceptBookings ? (id) => {
                    const svc = services.find((s) => s.id === id);
                    if (svc) {
                      setSelectedService(svc);
                      setActiveTab("book");
                    }
                  } : undefined}
                />
              ))}
            </div>
          </TabsContent>

          {canAcceptBookings && (
            <TabsContent value="book" className="pt-6">
              {selectedService ? (
                <div className="max-w-lg space-y-4">
                  {/* Staff Selection (only for businesses with staff) */}
                  {storefrontType === "business" && activeStaff.length > 0 && (
                    <div className="space-y-3">
                      <h4 className="font-medium text-sm">Select a Stylist/Staff Member (optional)</h4>
                      <div className="grid grid-cols-2 gap-2">
                        <Card 
                          className={`cursor-pointer transition-colors ${!selectedStaff ? 'ring-2 ring-primary' : 'hover:bg-accent/50'}`}
                          onClick={() => setSelectedStaff(null)}
                          data-testid="staff-any"
                        >
                          <CardContent className="p-3 flex items-center gap-3">
                            <Avatar className="h-10 w-10">
                              <AvatarFallback>
                                <User className="h-5 w-5" />
                              </AvatarFallback>
                            </Avatar>
                            <div>
                              <p className="font-medium text-sm">Any Available</p>
                              <p className="text-xs text-muted-foreground">First available staff</p>
                            </div>
                          </CardContent>
                        </Card>
                        {activeStaff.map((member) => (
                          <Card 
                            key={member.id}
                            className={`cursor-pointer transition-colors ${selectedStaff === member.id ? 'ring-2 ring-primary' : 'hover:bg-accent/50'}`}
                            onClick={() => setSelectedStaff(member.id)}
                            data-testid={`staff-${member.id}`}
                          >
                            <CardContent className="p-3 flex items-center gap-3">
                              <Avatar className="h-10 w-10">
                                <AvatarImage src={member.profileImageUrl || ""} />
                                <AvatarFallback>
                                  {member.displayName?.split(" ").map(n => n[0]).join("").toUpperCase() || "ST"}
                                </AvatarFallback>
                              </Avatar>
                              <div>
                                <p className="font-medium text-sm">{member.displayName}</p>
                                <p className="text-xs text-muted-foreground capitalize">{member.role || "Staff"}</p>
                              </div>
                            </CardContent>
                          </Card>
                        ))}
                      </div>
                    </div>
                  )}
                  <BookingCalendar
                    serviceName={selectedService.name}
                    servicePrice={selectedService.price}
                    serviceDuration={selectedService.duration || 60}
                    availableSlots={availableSlots}
                    onBook={(date, time) =>
                      onBookService?.(selectedService.id, date, time, selectedStaff || undefined)
                    }
                  />
                </div>
              ) : (
                <div className="text-center py-12">
                  <p className="text-muted-foreground mb-4">
                    Select a service to book an appointment
                  </p>
                  <Button variant="outline" onClick={() => setActiveTab("services")}>
                    View Services
                  </Button>
                </div>
              )}
            </TabsContent>
          )}

          <TabsContent value="chat" className="pt-6">
            <div className="max-w-2xl">
              <h2 className="text-xl font-semibold mb-4">Message Us</h2>
              <VendorChat
                vendorId={ownerId}
                vendorName={name}
                vendorAvatar={avatar}
                onLoginRequired={onLoginRequired}
              />
            </div>
          </TabsContent>

          <TabsContent value="comments" className="pt-6">
            <div className="max-w-2xl">
              <h2 className="text-xl font-semibold mb-4">Comments</h2>
              <ProfileComments
                targetType={storefrontType}
                targetId={id}
                isAuthenticated={isAuthenticated}
                onLoginRequired={onLoginRequired}
              />
            </div>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

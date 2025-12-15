import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Loader2, Store, Palette, Package, Clock, Plus, Pencil, Trash2, Image, DollarSign } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { Business, VendorProduct, VendorService } from "@shared/schema";

interface BusinessResponse {
  business: Business;
}

interface ProductsResponse {
  products: VendorProduct[];
}

interface ServicesResponse {
  services: VendorService[];
}

export default function StorefrontEditor() {
  const { toast } = useToast();
  const [activeTab, setActiveTab] = useState("branding");

  const { data: businessData, isLoading: businessLoading } = useQuery<BusinessResponse>({
    queryKey: ["/api/vendor/my-business"],
  });

  const { data: productsData, isLoading: productsLoading } = useQuery<ProductsResponse>({
    queryKey: ["/api/vendor/products"],
  });

  const { data: servicesData, isLoading: servicesLoading } = useQuery<ServicesResponse>({
    queryKey: ["/api/vendor/services"],
  });

  const updateBusinessMutation = useMutation({
    mutationFn: async (updates: Partial<Business>) => {
      const res = await apiRequest("PATCH", "/api/vendor/my-business", updates);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/vendor/my-business"] });
      toast({ title: "Storefront updated", description: "Your changes have been saved." });
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to update storefront.", variant: "destructive" });
    },
  });

  if (businessLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const business = businessData?.business;

  if (!business) {
    return (
      <div className="text-center py-12">
        <Store className="h-16 w-16 mx-auto text-muted-foreground mb-4" />
        <h2 className="text-xl font-semibold mb-2">No Business Found</h2>
        <p className="text-muted-foreground">
          You need to complete your vendor registration first.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6" data-testid="storefront-editor">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Customize Your Storefront</h1>
          <p className="text-muted-foreground">
            Make your business stand out with branding, products, and services
          </p>
        </div>
        <Badge variant="outline" className="text-sm">
          {business.category}
        </Badge>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
        <TabsList className="grid w-full grid-cols-4">
          <TabsTrigger value="branding" data-testid="tab-branding">
            <Palette className="h-4 w-4 mr-2" />
            Branding
          </TabsTrigger>
          <TabsTrigger value="profile" data-testid="tab-profile">
            <Store className="h-4 w-4 mr-2" />
            Profile
          </TabsTrigger>
          <TabsTrigger value="products" data-testid="tab-products">
            <Package className="h-4 w-4 mr-2" />
            Products
          </TabsTrigger>
          <TabsTrigger value="services" data-testid="tab-services">
            <Clock className="h-4 w-4 mr-2" />
            Services
          </TabsTrigger>
        </TabsList>

        <TabsContent value="branding" className="mt-6">
          <BrandingTab business={business} onUpdate={updateBusinessMutation.mutate} isPending={updateBusinessMutation.isPending} />
        </TabsContent>

        <TabsContent value="profile" className="mt-6">
          <ProfileTab business={business} onUpdate={updateBusinessMutation.mutate} isPending={updateBusinessMutation.isPending} />
        </TabsContent>

        <TabsContent value="products" className="mt-6">
          <ProductsTab products={productsData?.products || []} isLoading={productsLoading} businessId={business.id} />
        </TabsContent>

        <TabsContent value="services" className="mt-6">
          <ServicesTab services={servicesData?.services || []} isLoading={servicesLoading} businessId={business.id} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function BrandingTab({ business, onUpdate, isPending }: { business: Business; onUpdate: (data: Partial<Business>) => void; isPending: boolean }) {
  const [coverImage, setCoverImage] = useState(business.coverImage || "");
  const [logoImage, setLogoImage] = useState(business.logoImage || "");

  const handleSave = () => {
    onUpdate({ coverImage, logoImage });
  };

  return (
    <div className="grid gap-6 md:grid-cols-2">
      <Card className="overflow-visible">
        <CardHeader>
          <CardTitle className="text-lg">Cover Image</CardTitle>
          <CardDescription>
            This is the banner image that appears at the top of your storefront
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="aspect-video bg-muted rounded-lg flex items-center justify-center overflow-hidden">
            {coverImage ? (
              <img src={coverImage} alt="Cover" className="w-full h-full object-cover" />
            ) : (
              <div className="text-center text-muted-foreground">
                <Image className="h-12 w-12 mx-auto mb-2" />
                <p className="text-sm">No cover image</p>
              </div>
            )}
          </div>
          <div>
            <Label htmlFor="coverImage">Cover Image URL</Label>
            <Input
              id="coverImage"
              value={coverImage}
              onChange={(e) => setCoverImage(e.target.value)}
              placeholder="https://example.com/cover.jpg"
              data-testid="input-cover-image"
            />
          </div>
        </CardContent>
      </Card>

      <Card className="overflow-visible">
        <CardHeader>
          <CardTitle className="text-lg">Logo</CardTitle>
          <CardDescription>
            Your business logo appears on cards and your storefront
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="h-32 w-32 bg-muted rounded-lg flex items-center justify-center mx-auto overflow-hidden">
            {logoImage ? (
              <img src={logoImage} alt="Logo" className="w-full h-full object-cover" />
            ) : (
              <div className="text-center text-muted-foreground">
                <Store className="h-8 w-8 mx-auto" />
              </div>
            )}
          </div>
          <div>
            <Label htmlFor="logoImage">Logo URL</Label>
            <Input
              id="logoImage"
              value={logoImage}
              onChange={(e) => setLogoImage(e.target.value)}
              placeholder="https://example.com/logo.jpg"
              data-testid="input-logo-image"
            />
          </div>
        </CardContent>
      </Card>

      <div className="md:col-span-2">
        <Button onClick={handleSave} disabled={isPending} data-testid="button-save-branding">
          {isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
          Save Branding
        </Button>
      </div>
    </div>
  );
}

function ProfileTab({ business, onUpdate, isPending }: { business: Business; onUpdate: (data: Partial<Business>) => void; isPending: boolean }) {
  const [name, setName] = useState(business.name || "");
  const [description, setDescription] = useState(business.description || "");
  const [tagline, setTagline] = useState((business as any).tagline || "");
  const [contactEmail, setContactEmail] = useState((business as any).contactEmail || "");
  const [contactPhone, setContactPhone] = useState((business as any).contactPhone || "");
  const [websiteUrl, setWebsiteUrl] = useState(business.websiteUrl || "");
  const [address, setAddress] = useState(business.address || "");
  const [city, setCity] = useState(business.city || "");
  const [state, setState] = useState(business.state || "");
  const [zipCode, setZipCode] = useState(business.zipCode || "");

  const handleSave = () => {
    onUpdate({
      name,
      description,
      tagline,
      contactEmail,
      contactPhone,
      websiteUrl,
      address,
      city,
      state,
      zipCode,
    } as Partial<Business>);
  };

  return (
    <div className="space-y-6">
      <Card className="overflow-visible">
        <CardHeader>
          <CardTitle className="text-lg">Basic Information</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <Label htmlFor="name">Business Name</Label>
              <Input
                id="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                data-testid="input-business-name"
              />
            </div>
            <div>
              <Label htmlFor="tagline">Tagline</Label>
              <Input
                id="tagline"
                value={tagline}
                onChange={(e) => setTagline(e.target.value)}
                placeholder="A short catchy phrase"
                data-testid="input-tagline"
              />
            </div>
          </div>
          <div>
            <Label htmlFor="description">Description</Label>
            <Textarea
              id="description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Tell customers about your business..."
              className="resize-none"
              rows={4}
              data-testid="input-description"
            />
          </div>
        </CardContent>
      </Card>

      <Card className="overflow-visible">
        <CardHeader>
          <CardTitle className="text-lg">Contact Information</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <Label htmlFor="contactEmail">Email</Label>
              <Input
                id="contactEmail"
                type="email"
                value={contactEmail}
                onChange={(e) => setContactEmail(e.target.value)}
                data-testid="input-contact-email"
              />
            </div>
            <div>
              <Label htmlFor="contactPhone">Phone</Label>
              <Input
                id="contactPhone"
                type="tel"
                value={contactPhone}
                onChange={(e) => setContactPhone(e.target.value)}
                data-testid="input-contact-phone"
              />
            </div>
            <div className="md:col-span-2">
              <Label htmlFor="websiteUrl">Website</Label>
              <Input
                id="websiteUrl"
                value={websiteUrl}
                onChange={(e) => setWebsiteUrl(e.target.value)}
                placeholder="https://yourbusiness.com"
                data-testid="input-website"
              />
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="overflow-visible">
        <CardHeader>
          <CardTitle className="text-lg">Location</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label htmlFor="address">Street Address</Label>
            <Input
              id="address"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              data-testid="input-address"
            />
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            <div>
              <Label htmlFor="city">City</Label>
              <Input
                id="city"
                value={city}
                onChange={(e) => setCity(e.target.value)}
                data-testid="input-city"
              />
            </div>
            <div>
              <Label htmlFor="state">State</Label>
              <Input
                id="state"
                value={state}
                onChange={(e) => setState(e.target.value)}
                data-testid="input-state"
              />
            </div>
            <div>
              <Label htmlFor="zipCode">Zip Code</Label>
              <Input
                id="zipCode"
                value={zipCode}
                onChange={(e) => setZipCode(e.target.value)}
                data-testid="input-zipcode"
              />
            </div>
          </div>
        </CardContent>
      </Card>

      <Button onClick={handleSave} disabled={isPending} data-testid="button-save-profile">
        {isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
        Save Profile
      </Button>
    </div>
  );
}

function ProductsTab({ products, isLoading, businessId }: { products: VendorProduct[]; isLoading: boolean; businessId: string }) {
  const { toast } = useToast();
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingProduct, setEditingProduct] = useState<VendorProduct | null>(null);

  const createMutation = useMutation({
    mutationFn: async (data: Partial<VendorProduct>) => {
      const res = await apiRequest("POST", "/api/vendor/products", data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/vendor/products"] });
      setIsDialogOpen(false);
      toast({ title: "Product created" });
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to create product.", variant: "destructive" });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: Partial<VendorProduct> }) => {
      const res = await apiRequest("PATCH", `/api/vendor/products/${id}`, data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/vendor/products"] });
      setIsDialogOpen(false);
      setEditingProduct(null);
      toast({ title: "Product updated" });
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to update product.", variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest("DELETE", `/api/vendor/products/${id}`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/vendor/products"] });
      toast({ title: "Product deleted" });
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to delete product.", variant: "destructive" });
    },
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <p className="text-muted-foreground">
          Add products that customers can purchase from your store
        </p>
        <Dialog open={isDialogOpen} onOpenChange={(open) => {
          setIsDialogOpen(open);
          if (!open) setEditingProduct(null);
        }}>
          <DialogTrigger asChild>
            <Button data-testid="button-add-product">
              <Plus className="h-4 w-4 mr-2" />
              Add Product
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>{editingProduct ? "Edit Product" : "Add New Product"}</DialogTitle>
            </DialogHeader>
            <ProductForm
              product={editingProduct}
              onSubmit={(data) => {
                if (editingProduct) {
                  updateMutation.mutate({ id: editingProduct.id, data });
                } else {
                  createMutation.mutate(data);
                }
              }}
              isPending={createMutation.isPending || updateMutation.isPending}
            />
          </DialogContent>
        </Dialog>
      </div>

      {products.length === 0 ? (
        <Card className="overflow-visible">
          <CardContent className="py-12 text-center">
            <Package className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
            <h3 className="font-semibold mb-2">No products yet</h3>
            <p className="text-sm text-muted-foreground">
              Add your first product to start selling
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {products.map((product) => (
            <Card key={product.id} className="overflow-visible" data-testid={`product-card-${product.id}`}>
              <CardContent className="p-4">
                <div className="aspect-square bg-muted rounded-md mb-3 overflow-hidden">
                  {product.imageUrl ? (
                    <img src={product.imageUrl} alt={product.name} className="w-full h-full object-cover" />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center">
                      <Package className="h-8 w-8 text-muted-foreground" />
                    </div>
                  )}
                </div>
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <h4 className="font-medium truncate">{product.name}</h4>
                    <p className="text-lg font-bold text-primary">
                      ${(product.price / 100).toFixed(2)}
                    </p>
                    {product.inventory !== null && (
                      <p className="text-xs text-muted-foreground">
                        {product.inventory} in stock
                      </p>
                    )}
                  </div>
                  <div className="flex gap-1">
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => {
                        setEditingProduct(product);
                        setIsDialogOpen(true);
                      }}
                      data-testid={`button-edit-product-${product.id}`}
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => deleteMutation.mutate(product.id)}
                      data-testid={`button-delete-product-${product.id}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function ProductForm({ product, onSubmit, isPending }: { product: VendorProduct | null; onSubmit: (data: Partial<VendorProduct>) => void; isPending: boolean }) {
  const [name, setName] = useState(product?.name || "");
  const [description, setDescription] = useState(product?.description || "");
  const [price, setPrice] = useState(product ? (product.price / 100).toString() : "");
  const [imageUrl, setImageUrl] = useState(product?.imageUrl || "");
  const [inventory, setInventory] = useState(product?.inventory?.toString() || "0");
  const [isActive, setIsActive] = useState(product?.isActive ?? true);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit({
      name,
      description: description || null,
      price: Math.round(parseFloat(price) * 100),
      imageUrl: imageUrl || null,
      inventory: parseInt(inventory) || 0,
      isActive,
    });
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <Label htmlFor="product-name">Product Name *</Label>
        <Input
          id="product-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          data-testid="input-product-name"
        />
      </div>
      <div>
        <Label htmlFor="product-description">Description</Label>
        <Textarea
          id="product-description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className="resize-none"
          rows={3}
          data-testid="input-product-description"
        />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <Label htmlFor="product-price">Price ($) *</Label>
          <Input
            id="product-price"
            type="number"
            step="0.01"
            min="0"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            required
            data-testid="input-product-price"
          />
        </div>
        <div>
          <Label htmlFor="product-inventory">Inventory</Label>
          <Input
            id="product-inventory"
            type="number"
            min="0"
            value={inventory}
            onChange={(e) => setInventory(e.target.value)}
            data-testid="input-product-inventory"
          />
        </div>
      </div>
      <div>
        <Label htmlFor="product-image">Image URL</Label>
        <Input
          id="product-image"
          value={imageUrl}
          onChange={(e) => setImageUrl(e.target.value)}
          placeholder="https://example.com/product.jpg"
          data-testid="input-product-image"
        />
      </div>
      <div className="flex items-center gap-2">
        <Switch
          id="product-active"
          checked={isActive}
          onCheckedChange={setIsActive}
          data-testid="switch-product-active"
        />
        <Label htmlFor="product-active">Active (visible to customers)</Label>
      </div>
      <Button type="submit" className="w-full" disabled={isPending || !name || !price} data-testid="button-submit-product">
        {isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
        {product ? "Update Product" : "Add Product"}
      </Button>
    </form>
  );
}

function ServicesTab({ services, isLoading, businessId }: { services: VendorService[]; isLoading: boolean; businessId: string }) {
  const { toast } = useToast();
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingService, setEditingService] = useState<VendorService | null>(null);

  const createMutation = useMutation({
    mutationFn: async (data: Partial<VendorService>) => {
      const res = await apiRequest("POST", "/api/vendor/services", data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/vendor/services"] });
      setIsDialogOpen(false);
      toast({ title: "Service created" });
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to create service.", variant: "destructive" });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: Partial<VendorService> }) => {
      const res = await apiRequest("PATCH", `/api/vendor/services/${id}`, data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/vendor/services"] });
      setIsDialogOpen(false);
      setEditingService(null);
      toast({ title: "Service updated" });
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to update service.", variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest("DELETE", `/api/vendor/services/${id}`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/vendor/services"] });
      toast({ title: "Service deleted" });
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to delete service.", variant: "destructive" });
    },
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <p className="text-muted-foreground">
          Add services that customers can book appointments for
        </p>
        <Dialog open={isDialogOpen} onOpenChange={(open) => {
          setIsDialogOpen(open);
          if (!open) setEditingService(null);
        }}>
          <DialogTrigger asChild>
            <Button data-testid="button-add-service">
              <Plus className="h-4 w-4 mr-2" />
              Add Service
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>{editingService ? "Edit Service" : "Add New Service"}</DialogTitle>
            </DialogHeader>
            <ServiceForm
              service={editingService}
              onSubmit={(data) => {
                if (editingService) {
                  updateMutation.mutate({ id: editingService.id, data });
                } else {
                  createMutation.mutate(data);
                }
              }}
              isPending={createMutation.isPending || updateMutation.isPending}
            />
          </DialogContent>
        </Dialog>
      </div>

      {services.length === 0 ? (
        <Card className="overflow-visible">
          <CardContent className="py-12 text-center">
            <Clock className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
            <h3 className="font-semibold mb-2">No services yet</h3>
            <p className="text-sm text-muted-foreground">
              Add services that customers can book
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {services.map((service) => (
            <Card key={service.id} className="overflow-visible" data-testid={`service-card-${service.id}`}>
              <CardContent className="p-4">
                <div className="flex items-center justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <h4 className="font-medium">{service.name}</h4>
                      {!service.isActive && (
                        <Badge variant="secondary">Inactive</Badge>
                      )}
                    </div>
                    {service.description && (
                      <p className="text-sm text-muted-foreground line-clamp-1">
                        {service.description}
                      </p>
                    )}
                    <div className="flex items-center gap-4 mt-1">
                      <span className="text-lg font-bold text-primary">
                        ${(service.price / 100).toFixed(2)}
                      </span>
                      <span className="text-sm text-muted-foreground">
                        {service.durationMinutes} min
                      </span>
                    </div>
                  </div>
                  <div className="flex gap-1">
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => {
                        setEditingService(service);
                        setIsDialogOpen(true);
                      }}
                      data-testid={`button-edit-service-${service.id}`}
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => deleteMutation.mutate(service.id)}
                      data-testid={`button-delete-service-${service.id}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function ServiceForm({ service, onSubmit, isPending }: { service: VendorService | null; onSubmit: (data: Partial<VendorService>) => void; isPending: boolean }) {
  const [name, setName] = useState(service?.name || "");
  const [description, setDescription] = useState(service?.description || "");
  const [price, setPrice] = useState(service ? (service.price / 100).toString() : "");
  const [duration, setDuration] = useState(service?.durationMinutes?.toString() || "60");
  const [isActive, setIsActive] = useState(service?.isActive ?? true);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit({
      name,
      description: description || null,
      price: Math.round(parseFloat(price) * 100),
      durationMinutes: parseInt(duration) || 60,
      isActive,
    });
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <Label htmlFor="service-name">Service Name *</Label>
        <Input
          id="service-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          data-testid="input-service-name"
        />
      </div>
      <div>
        <Label htmlFor="service-description">Description</Label>
        <Textarea
          id="service-description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className="resize-none"
          rows={3}
          data-testid="input-service-description"
        />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <Label htmlFor="service-price">Price ($) *</Label>
          <Input
            id="service-price"
            type="number"
            step="0.01"
            min="0"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            required
            data-testid="input-service-price"
          />
        </div>
        <div>
          <Label htmlFor="service-duration">Duration (minutes) *</Label>
          <Input
            id="service-duration"
            type="number"
            min="5"
            step="5"
            value={duration}
            onChange={(e) => setDuration(e.target.value)}
            required
            data-testid="input-service-duration"
          />
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Switch
          id="service-active"
          checked={isActive}
          onCheckedChange={setIsActive}
          data-testid="switch-service-active"
        />
        <Label htmlFor="service-active">Active (available for booking)</Label>
      </div>
      <Button type="submit" className="w-full" disabled={isPending || !name || !price || !duration} data-testid="button-submit-service">
        {isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
        {service ? "Update Service" : "Add Service"}
      </Button>
    </form>
  );
}

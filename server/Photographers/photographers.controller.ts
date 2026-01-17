// server/Photographers/photographers.controller.ts
import { Request, Response } from "express";
import { PhotographerService } from "./photographers.service";
import { stripeService } from "../stripe/stripeService";
import { storage } from "../storage";

// Helper to resolve photographer for authenticated user
// Returns: { user, photographer, error? }
// Error cases:
//   - 401: Not authenticated (no userId)
//   - 403: Not a photographer (role check)
//   - null photographer: Profile doesn't exist (setupRequired)
async function resolvePhotographerForUser(req: Request): Promise<{
  userId: string | null;
  user: any | null;
  photographer: any | null;
  error?: { status: number; message: string };
}> {
  const userId = req.session?.userId;
  const photographerId = req.session?.photographerId;

  // 401: Not authenticated
  if (!userId) {
    return { userId: null, user: null, photographer: null, error: { status: 401, message: "Not authenticated" } };
  }

  // Get user to check role
  const user = await storage.getUser(userId);
  if (!user) {
    return { userId, user: null, photographer: null, error: { status: 401, message: "User not found" } };
  }

  // 403: Not a photographer role
  if (!user.isPhotographer) {
    return { userId, user, photographer: null, error: { status: 403, message: "Not authorized as photographer" } };
  }

  // Try to get photographer profile
  let photographer = null;
  if (photographerId) {
    photographer = await PhotographerService.get(photographerId);
  }
  if (!photographer) {
    photographer = await PhotographerService.getByUserId(userId);
  }

  // Update session if we found the photographer but photographerId wasn't set
  if (photographer && !photographerId && req.session) {
    req.session.photographerId = photographer.id;
  }

  return { userId, user, photographer };
}

export class PhotographerController {
  // GET /api/photographers/me
  // Returns photographer profile or { setupRequired: true } if profile doesn't exist
  static async getMe(req: Request, res: Response) {
    try {
      const { userId, user, photographer, error } = await resolvePhotographerForUser(req);
      
      if (error) {
        return res.status(error.status).json({ error: error.message });
      }

      // Profile doesn't exist - return setupRequired instead of 404
      if (!photographer) {
        return res.json({ 
          setupRequired: true,
          user: { id: userId, email: user?.email, name: user?.name, isPhotographer: true },
          message: "Photographer profile setup required"
        });
      }

      // Check if profile is complete (has required business fields)
      const isProfileComplete = !!(
        photographer.displayName &&
        photographer.hourlyRate > 0 &&
        photographer.city &&
        photographer.state
      );

      res.json({ 
        ...photographer,
        isProfileComplete,
        stripeConnected: photographer.stripeOnboardingComplete || false,
      });
    } catch (error) {
      console.error("Get me photographer error:", error);
      res.status(500).json({ error: "Failed to fetch photographer" });
    }
  }

  // PATCH /api/photographers/me - Update authenticated photographer's profile
  static async updateMe(req: Request, res: Response) {
    try {
      const { userId, user, photographer, error } = await resolvePhotographerForUser(req);
      
      if (error) {
        return res.status(error.status).json({ error: error.message });
      }

      // If no profile exists, return setupRequired
      if (!photographer) {
        return res.status(400).json({ 
          error: "Photographer profile not found",
          setupRequired: true 
        });
      }

      const { displayName, bio, city, state, portfolioUrl, hourlyRate, specialties, coverImage, logoImage, brandColors } = req.body;
      
      const updates: any = {};
      if (displayName !== undefined) updates.displayName = displayName;
      if (bio !== undefined) updates.bio = bio;
      if (city !== undefined) updates.city = city;
      if (state !== undefined) updates.state = state;
      if (portfolioUrl !== undefined) updates.portfolioUrl = portfolioUrl;
      // Convert hourlyRate from dollars to cents for storage
      if (hourlyRate !== undefined) updates.hourlyRate = Math.round(Number(hourlyRate) * 100);
      if (specialties !== undefined && Array.isArray(specialties)) updates.specialties = specialties;
      // Storefront customization
      if (coverImage !== undefined) updates.coverImage = coverImage;
      if (logoImage !== undefined) updates.logoImage = logoImage;
      if (brandColors !== undefined) updates.brandColors = brandColors;

      const updated = await PhotographerService.update(photographer.id, updates);
      if (!updated) {
        return res.status(404).json({ error: "Photographer not found" });
      }

      res.json({ photographer: updated });
    } catch (error) {
      console.error("Update me photographer error:", error);
      res.status(500).json({ error: "Failed to update photographer" });
    }
  }

  // GET /api/photographers/me/stripe-status
  static async getStripeStatus(req: Request, res: Response) {
    try {
      const { photographer, error } = await resolvePhotographerForUser(req);
      
      if (error) {
        return res.status(error.status).json({ error: error.message });
      }

      // If no profile or no Stripe account, return default status
      if (!photographer?.stripeAccountId) {
        return res.json({ 
          chargesEnabled: false, 
          payoutsEnabled: false, 
          detailsSubmitted: false,
          setupRequired: !photographer 
        });
      }

      const status = await stripeService.getConnectAccountStatus(photographer.stripeAccountId);
      res.json(status);
    } catch (error) {
      console.error("Get stripe status error:", error);
      res.status(500).json({ error: "Failed to get Stripe status" });
    }
  }

  // POST /api/photographers/me/stripe-onboarding
  static async startStripeOnboarding(req: Request, res: Response) {
    try {
      const { userId, user, photographer, error } = await resolvePhotographerForUser(req);
      
      if (error) {
        return res.status(error.status).json({ error: error.message });
      }

      // Stripe onboarding requires a photographer profile to exist
      if (!photographer) {
        return res.status(400).json({ 
          error: "Photographer profile must be created first",
          setupRequired: true 
        });
      }

      if (!user?.email) {
        return res.status(400).json({ error: "User email required for Stripe onboarding" });
      }

      const host = req.get('host') || process.env.REPLIT_DOMAINS?.split(',')[0];
      const forwardedProto = req.get('x-forwarded-proto');
      const protocol = forwardedProto || (host?.includes('replit') ? 'https' : req.protocol) || 'https';
      const baseUrl = host ? `${protocol}://${host}` : '';

      let stripeAccountId = photographer.stripeAccountId;
      
      if (!stripeAccountId) {
        const account = await stripeService.createConnectAccount(
          user.email,
          photographer.id,
          photographer.displayName
        );
        stripeAccountId = account.id;
        await storage.updatePhotographer(photographer.id, { stripeAccountId });
      }

      const accountLink = await stripeService.createConnectOnboardingLink(
        stripeAccountId,
        `${baseUrl}/photographer/onboarding?refresh=true`,
        `${baseUrl}/photographer/dashboard?stripe=success`
      );

      res.json({ url: accountLink.url });
    } catch (error) {
      console.error("Start stripe onboarding error:", error);
      res.status(500).json({ error: "Failed to start Stripe onboarding" });
    }
  }

  // POST /api/photographers
  static async create(req: Request, res: Response) {
    try {
      const {
        userId,
        displayName,
        bio,
        city,
        state,
        portfolioUrl,
        hourlyRate,
        stripeAccountId,
      } = req.body;

      if (!userId || !displayName || !hourlyRate || !stripeAccountId) {
        return res.status(400).json({
          success: false,
          message:
            "userId, displayName, hourlyRate, and stripeAccountId are required",
        });
      }

      const photographer = await PhotographerService.create({
        userId,
        displayName,
        bio,
        city,
        state,
        portfolioUrl,
        hourlyRate: Number(hourlyRate),
        stripeAccountId,
      });

      res.status(201).json({ success: true, photographer });
    } catch (error) {
      console.error("Create photographer error:", error);
      res
        .status(500)
        .json({ success: false, message: "Failed to create photographer" });
    }
  }

  // GET /api/photographers
  static async list(_req: Request, res: Response) {
    try {
      const list = await PhotographerService.list();
      res.json({ success: true, photographers: list });
    } catch (error) {
      console.error("List photographers error:", error);
      res
        .status(500)
        .json({ success: false, message: "Failed to fetch photographers" });
    }
  }

  // GET /api/photographers/:id
  static async get(req: Request, res: Response) {
    try {
      const photographer = await PhotographerService.get(req.params.id);
      if (!photographer) {
        return res
          .status(404)
          .json({ success: false, message: "Photographer not found" });
      }

      res.json({ success: true, photographer });
    } catch (error) {
      console.error("Get photographer error:", error);
      res
        .status(500)
        .json({ success: false, message: "Failed to fetch photographer" });
    }
  }

  // PATCH /api/photographers/:id
  static async update(req: Request, res: Response) {
    try {
      const updated = await PhotographerService.update(req.params.id, req.body);
      if (!updated) {
        return res
          .status(404)
          .json({ success: false, message: "Photographer not found" });
      }

      res.json({ success: true, photographer: updated });
    } catch (error) {
      console.error("Update photographer error:", error);
      res
        .status(500)
        .json({ success: false, message: "Failed to update photographer" });
    }
  }

  // DELETE /api/photographers/:id
  static async delete(req: Request, res: Response) {
    try {
      const deleted = await PhotographerService.remove(req.params.id);
      if (!deleted) {
        return res
          .status(404)
          .json({ success: false, message: "Photographer not found" });
      }

      res.json({ success: true, photographer: deleted });
    } catch (error) {
      console.error("Delete photographer error:", error);
      res
        .status(500)
        .json({ success: false, message: "Failed to delete photographer" });
    }
  }

  // GET /api/photographers/me/bookings
  static async getBookingRecords(req: Request, res: Response) {
    try {
      const { photographer, error } = await resolvePhotographerForUser(req);
      
      if (error) {
        return res.status(error.status).json({ error: error.message });
      }

      // If no profile, return empty bookings with setupRequired flag
      if (!photographer) {
        return res.json({ bookings: [], setupRequired: true });
      }

      const bookings = await storage.getPhotographerBookingRecords(photographer.id);
      res.json({ bookings });
    } catch (error) {
      console.error("Get photographer booking records error:", error);
      res.status(500).json({ error: "Failed to get booking records" });
    }
  }

  // GET /api/photographers/me/services - Get all services for authenticated photographer
  static async getMyServices(req: Request, res: Response) {
    try {
      const { photographer, error } = await resolvePhotographerForUser(req);
      
      if (error) {
        return res.status(error.status).json({ error: error.message });
      }

      // If no profile, return empty services with setupRequired flag
      if (!photographer) {
        return res.json({ services: [], setupRequired: true });
      }

      // Owner dashboard: return all services regardless of status (draft, live, archived)
      const services = await storage.getAllPhotographerServices(photographer.id);
      res.json({ services });
    } catch (error) {
      console.error("Get photographer services error:", error);
      res.status(500).json({ error: "Failed to get services" });
    }
  }

  // POST /api/photographers/me/services - Create a new service
  static async createService(req: Request, res: Response) {
    try {
      const { photographer, error } = await resolvePhotographerForUser(req);
      
      if (error) {
        return res.status(error.status).json({ error: error.message });
      }

      if (!photographer) {
        return res.status(400).json({ 
          error: "Photographer profile must be created first",
          setupRequired: true 
        });
      }

      const { 
        name, 
        description, 
        category, 
        priceCents, 
        isContactForPricing, 
        estimatedDurationMinutes,
        pricingModel,
        hourlyRateCents,
        packageHours
      } = req.body;

      if (!name) {
        return res.status(400).json({ error: "Service name is required" });
      }

      const service = await storage.createPhotographerService({
        photographerId: photographer.id,
        name,
        description,
        category,
        priceCents: isContactForPricing ? null : priceCents,
        isContactForPricing: isContactForPricing || false,
        estimatedDurationMinutes,
        pricingModel: pricingModel || "package",
        hourlyRateCents: hourlyRateCents || null,
        packageHours: packageHours || null,
      });

      res.status(201).json({ service });
    } catch (error) {
      console.error("Create photographer service error:", error);
      res.status(500).json({ error: "Failed to create service" });
    }
  }

  // PATCH /api/photographers/me/services/:serviceId - Update a service
  static async updateService(req: Request, res: Response) {
    try {
      const { photographer, error } = await resolvePhotographerForUser(req);
      
      if (error) {
        return res.status(error.status).json({ error: error.message });
      }

      if (!photographer) {
        return res.status(400).json({ 
          error: "Photographer profile not found",
          setupRequired: true 
        });
      }

      const { serviceId } = req.params;
      const service = await storage.getPhotographerService(serviceId);
      
      if (!service) {
        return res.status(404).json({ error: "Service not found" });
      }

      if (service.photographerId !== photographer.id) {
        return res.status(403).json({ error: "Not authorized to update this service" });
      }

      const { 
        name, 
        description, 
        category, 
        priceCents, 
        isContactForPricing, 
        estimatedDurationMinutes, 
        isActive,
        pricingModel,
        hourlyRateCents,
        packageHours
      } = req.body;

      // Handle price changes for live services with Stripe
      let stripeUpdates: any = {};
      if (service.status === 'live' && service.stripeProductId) {
        // Update Stripe Product metadata if name/description changed
        if (name || description) {
          await stripeService.updateStripeProduct(service.stripeProductId, {
            name: name || service.name,
            description: description !== undefined ? (description || undefined) : (service.description || undefined),
          });
        }
        
        // Determine current and new price based on pricing model
        const currentPrice = service.pricingModel === 'hourly' 
          ? service.hourlyRateCents || 0
          : service.priceCents || 0;
        const newPricingModel = pricingModel || service.pricingModel || 'package';
        const newPrice = newPricingModel === 'hourly'
          ? (hourlyRateCents !== undefined ? hourlyRateCents : service.hourlyRateCents) || 0
          : (priceCents !== undefined ? priceCents : service.priceCents) || 0;
        
        // If price changed and service is live, create new Stripe Price and deactivate old one
        const priceChanged = newPrice !== currentPrice || (pricingModel && pricingModel !== service.pricingModel);
        if (priceChanged && service.stripePriceId && !isContactForPricing && newPrice > 0) {
          // Create new price
          const newStripePrice = await stripeService.createStripePrice({
            productId: service.stripeProductId,
            unitAmountCents: newPrice,
            metadata: {
              photographerServiceId: service.id,
              photographerId: photographer.id,
              pricingModel: newPricingModel,
            },
          });
          
          // Deactivate old price
          await stripeService.deactivateStripePrice(service.stripePriceId);
          
          stripeUpdates.stripePriceId = newStripePrice.id;
        }
      }

      const updated = await storage.updatePhotographerService(serviceId, {
        name,
        description,
        category,
        priceCents: isContactForPricing ? null : priceCents,
        isContactForPricing,
        estimatedDurationMinutes,
        isActive,
        pricingModel,
        hourlyRateCents,
        packageHours,
        ...stripeUpdates,
      });

      res.json({ service: updated });
    } catch (error) {
      console.error("Update photographer service error:", error);
      res.status(500).json({ error: "Failed to update service" });
    }
  }

  // DELETE /api/photographers/me/services/:serviceId - Delete a service
  static async deleteService(req: Request, res: Response) {
    try {
      const { photographer, error } = await resolvePhotographerForUser(req);
      
      if (error) {
        return res.status(error.status).json({ error: error.message });
      }

      if (!photographer) {
        return res.status(400).json({ 
          error: "Photographer profile not found",
          setupRequired: true 
        });
      }

      const { serviceId } = req.params;
      const service = await storage.getPhotographerService(serviceId);
      
      if (!service) {
        return res.status(404).json({ error: "Service not found" });
      }

      if (service.photographerId !== photographer.id) {
        return res.status(403).json({ error: "Not authorized to delete this service" });
      }

      await storage.deletePhotographerService(serviceId);
      res.json({ success: true });
    } catch (error) {
      console.error("Delete photographer service error:", error);
      res.status(500).json({ error: "Failed to delete service" });
    }
  }

  // POST /api/photographers/me/services/:serviceId/go-live - Publish service to Stripe
  static async goLiveService(req: Request, res: Response) {
    try {
      const { photographer, error } = await resolvePhotographerForUser(req);
      
      if (error) {
        return res.status(error.status).json({ error: error.message });
      }

      if (!photographer) {
        return res.status(400).json({ 
          error: "Photographer profile not found",
          setupRequired: true 
        });
      }

      const { serviceId } = req.params;
      const service = await storage.getPhotographerService(serviceId);
      
      if (!service) {
        return res.status(404).json({ error: "Service not found" });
      }

      if (service.photographerId !== photographer.id) {
        return res.status(403).json({ error: "Not authorized to publish this service" });
      }

      // Already live? Just return the service
      if (service.status === 'live' && service.stripeProductId && service.stripePriceId) {
        return res.json({ service, message: "Service is already live" });
      }

      // Determine price based on pricing model
      const priceInCents = service.pricingModel === 'hourly' 
        ? service.hourlyRateCents || 0
        : service.priceCents || 0;

      if (priceInCents <= 0 && !service.isContactForPricing) {
        return res.status(400).json({ error: "Service must have a price or be marked as 'Contact for Pricing'" });
      }

      // Create Stripe Product
      const stripeProduct = await stripeService.createStripeProduct({
        name: service.name,
        description: service.description || undefined,
        metadata: {
          type: 'photographer_service',
          itemId: service.id,
          photographerId: photographer.id,
        },
      });

      // Create Stripe Price (skip if contact for pricing)
      let stripePriceId: string | null = null;
      if (!service.isContactForPricing && priceInCents > 0) {
        const stripePrice = await stripeService.createStripePrice({
          productId: stripeProduct.id,
          unitAmountCents: priceInCents,
          metadata: {
            photographerServiceId: service.id,
            photographerId: photographer.id,
            pricingModel: service.pricingModel || 'package',
          },
        });
        stripePriceId = stripePrice.id;
      }

      // Update service with Stripe IDs and set status to live
      const updated = await storage.updatePhotographerService(service.id, {
        status: 'live',
        stripeProductId: stripeProduct.id,
        stripePriceId: stripePriceId,
      });

      res.json({ service: updated, message: "Service is now live" });
    } catch (error) {
      console.error("Go live photographer service error:", error);
      res.status(500).json({ error: "Failed to publish service" });
    }
  }

  // POST /api/photographers/me/services/:serviceId/archive - Archive a service
  static async archiveService(req: Request, res: Response) {
    try {
      const { photographer, error } = await resolvePhotographerForUser(req);
      
      if (error) {
        return res.status(error.status).json({ error: error.message });
      }

      if (!photographer) {
        return res.status(400).json({ 
          error: "Photographer profile not found",
          setupRequired: true 
        });
      }

      const { serviceId } = req.params;
      const service = await storage.getPhotographerService(serviceId);
      
      if (!service) {
        return res.status(404).json({ error: "Service not found" });
      }

      if (service.photographerId !== photographer.id) {
        return res.status(403).json({ error: "Not authorized to archive this service" });
      }

      // Archive in Stripe if it exists
      if (service.stripeProductId) {
        await stripeService.archiveStripeProduct(service.stripeProductId);
      }
      // Deactivate the price if it exists
      if (service.stripePriceId) {
        await stripeService.deactivateStripePrice(service.stripePriceId);
      }

      // Clear Stripe price ID and set status to archived
      const updated = await storage.updatePhotographerService(service.id, {
        status: 'archived',
        stripePriceId: null,
      });

      res.json({ service: updated, message: "Service archived" });
    } catch (error) {
      console.error("Archive photographer service error:", error);
      res.status(500).json({ error: "Failed to archive service" });
    }
  }

  // GET /api/photographers/:id/services - Get all services for a photographer (public)
  static async getPublicServices(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const services = await storage.getPhotographerServices(id);
      res.json({ services });
    } catch (error) {
      console.error("Get public photographer services error:", error);
      res.status(500).json({ error: "Failed to get services" });
    }
  }

  // ==================== AVAILABILITY MANAGEMENT ====================

  // GET /api/photographers/me/availability - Get photographer's availability slots
  static async getAvailability(req: Request, res: Response) {
    try {
      const { photographer, error } = await resolvePhotographerForUser(req);
      
      if (error) {
        return res.status(error.status).json({ error: error.message });
      }

      // If no profile, return empty slots with setupRequired flag
      if (!photographer) {
        return res.json({ slots: [], setupRequired: true });
      }

      const { startDate, endDate } = req.query;
      const slots = await storage.getPhotographerAvailability(
        photographer.id,
        startDate as string | undefined,
        endDate as string | undefined
      );

      res.json({ slots });
    } catch (error) {
      console.error("Get photographer availability error:", error);
      res.status(500).json({ error: "Failed to get availability" });
    }
  }

  // POST /api/photographers/me/availability - Create availability slot
  static async createAvailabilitySlot(req: Request, res: Response) {
    try {
      const { photographer, error } = await resolvePhotographerForUser(req);
      
      if (error) {
        return res.status(error.status).json({ error: error.message });
      }

      if (!photographer) {
        return res.status(400).json({ 
          error: "Photographer profile must be created first",
          setupRequired: true 
        });
      }

      const { date, startTime, endTime, slotType, title, notes, isRecurring, recurringDayOfWeek } = req.body;

      if (!date || !startTime || !endTime) {
        return res.status(400).json({ error: "Date, start time, and end time are required" });
      }

      const slot = await storage.createPhotographerAvailability({
        photographerId: photographer.id,
        date,
        startTime,
        endTime,
        slotType: slotType || 'available',
        title,
        notes,
        isRecurring: isRecurring || false,
        recurringDayOfWeek,
      });

      res.status(201).json({ slot });
    } catch (error) {
      console.error("Create photographer availability error:", error);
      res.status(500).json({ error: "Failed to create availability slot" });
    }
  }

  // PATCH /api/photographers/me/availability/:slotId - Update availability slot
  static async updateAvailabilitySlot(req: Request, res: Response) {
    try {
      const { photographer, error } = await resolvePhotographerForUser(req);
      
      if (error) {
        return res.status(error.status).json({ error: error.message });
      }

      if (!photographer) {
        return res.status(400).json({ 
          error: "Photographer profile not found",
          setupRequired: true 
        });
      }

      const { slotId } = req.params;
      const existingSlot = await storage.getPhotographerAvailabilitySlot(slotId);
      
      if (!existingSlot) {
        return res.status(404).json({ error: "Slot not found" });
      }

      if (existingSlot.photographerId !== photographer.id) {
        return res.status(403).json({ error: "Not authorized to update this slot" });
      }

      const { date, startTime, endTime, slotType, title, notes, isRecurring, recurringDayOfWeek } = req.body;

      const updates: any = {};
      if (date !== undefined) updates.date = date;
      if (startTime !== undefined) updates.startTime = startTime;
      if (endTime !== undefined) updates.endTime = endTime;
      if (slotType !== undefined) updates.slotType = slotType;
      if (title !== undefined) updates.title = title;
      if (notes !== undefined) updates.notes = notes;
      if (isRecurring !== undefined) updates.isRecurring = isRecurring;
      if (recurringDayOfWeek !== undefined) updates.recurringDayOfWeek = recurringDayOfWeek;

      const updated = await storage.updatePhotographerAvailability(slotId, updates);
      res.json({ slot: updated });
    } catch (error) {
      console.error("Update photographer availability error:", error);
      res.status(500).json({ error: "Failed to update availability slot" });
    }
  }

  // DELETE /api/photographers/me/availability/:slotId - Delete availability slot
  static async deleteAvailabilitySlot(req: Request, res: Response) {
    try {
      const { photographer, error } = await resolvePhotographerForUser(req);
      
      if (error) {
        return res.status(error.status).json({ error: error.message });
      }

      if (!photographer) {
        return res.status(400).json({ 
          error: "Photographer profile not found",
          setupRequired: true 
        });
      }

      const { slotId } = req.params;
      const existingSlot = await storage.getPhotographerAvailabilitySlot(slotId);
      
      if (!existingSlot) {
        return res.status(404).json({ error: "Slot not found" });
      }

      // Prevent deletion of booked slots (server-side protection)
      if (existingSlot.slotType === "booked") {
        return res.status(403).json({ 
          error: "Cannot delete booked slot",
          message: "This time slot has an active booking and cannot be deleted."
        });
      }

      if (existingSlot.photographerId !== photographer.id) {
        return res.status(403).json({ error: "Not authorized to delete this slot" });
      }

      await storage.deletePhotographerAvailability(slotId);
      res.json({ success: true });
    } catch (error) {
      console.error("Delete photographer availability error:", error);
      res.status(500).json({ error: "Failed to delete availability slot" });
    }
  }

  // PATCH /api/photographers/me/availability/:slotId - Update availability slot (with booked protection)
  static async updateAvailabilitySlotProtected(req: Request, res: Response) {
    try {
      const { photographer, error } = await resolvePhotographerForUser(req);
      
      if (error) {
        return res.status(error.status).json({ error: error.message });
      }

      if (!photographer) {
        return res.status(400).json({ 
          error: "Photographer profile not found",
          setupRequired: true 
        });
      }

      const { slotId } = req.params;
      const existingSlot = await storage.getPhotographerAvailabilitySlot(slotId);
      
      if (!existingSlot) {
        return res.status(404).json({ error: "Slot not found" });
      }

      // Prevent modification of booked slots (server-side protection)
      if (existingSlot.slotType === "booked") {
        return res.status(403).json({ 
          error: "Cannot modify booked slot",
          message: "This time slot has an active booking and cannot be modified."
        });
      }

      if (existingSlot.photographerId !== photographer.id) {
        return res.status(403).json({ error: "Not authorized to update this slot" });
      }

      const { date, startTime, endTime, slotType, title, notes, isRecurring, recurringDayOfWeek } = req.body;

      // Prevent changing slotType to "booked" via API (only internal reservation can do this)
      if (slotType === "booked") {
        return res.status(400).json({ error: "Cannot manually set slot as booked" });
      }

      const updates: any = {};
      if (date !== undefined) updates.date = date;
      if (startTime !== undefined) updates.startTime = startTime;
      if (endTime !== undefined) updates.endTime = endTime;
      if (slotType !== undefined) updates.slotType = slotType;
      if (title !== undefined) updates.title = title;
      if (notes !== undefined) updates.notes = notes;
      if (isRecurring !== undefined) updates.isRecurring = isRecurring;
      if (recurringDayOfWeek !== undefined) updates.recurringDayOfWeek = recurringDayOfWeek;

      const updated = await storage.updatePhotographerAvailability(slotId, updates);
      res.json({ slot: updated });
    } catch (error) {
      console.error("Update photographer availability error:", error);
      res.status(500).json({ error: "Failed to update availability slot" });
    }
  }
}

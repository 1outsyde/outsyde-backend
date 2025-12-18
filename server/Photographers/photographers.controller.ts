// server/Photographers/photographers.controller.ts
import { Request, Response } from "express";
import { PhotographerService } from "./photographers.service";
import { stripeService } from "../stripe/stripeService";
import { storage } from "../storage";

export class PhotographerController {
  // GET /api/photographers/me
  static async getMe(req: Request, res: Response) {
    try {
      const photographerId = req.session?.photographerId;
      const userId = req.session?.userId;
      
      if (!photographerId && !userId) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      let photographer = null;
      if (photographerId) {
        photographer = await PhotographerService.get(photographerId);
      } else if (userId) {
        photographer = await PhotographerService.getByUserId(userId);
      }
      
      if (!photographer) {
        return res.status(404).json({ error: "Photographer not found" });
      }

      res.json(photographer);
    } catch (error) {
      console.error("Get me photographer error:", error);
      res.status(500).json({ error: "Failed to fetch photographer" });
    }
  }

  // PATCH /api/photographers/me - Update authenticated photographer's profile
  static async updateMe(req: Request, res: Response) {
    try {
      const photographerId = req.session?.photographerId;
      const userId = req.session?.userId;
      
      if (!photographerId && !userId) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      let targetPhotographerId = photographerId;
      if (!targetPhotographerId && userId) {
        const photographer = await PhotographerService.getByUserId(userId);
        if (!photographer) {
          return res.status(404).json({ error: "Photographer not found" });
        }
        targetPhotographerId = photographer.id;
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

      const updated = await PhotographerService.update(targetPhotographerId!, updates);
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
      const photographerId = req.session?.photographerId;
      if (!photographerId) {
        return res.status(401).json({ error: "Not authenticated as photographer" });
      }

      const photographer = await PhotographerService.get(photographerId);
      if (!photographer?.stripeAccountId) {
        return res.json({ chargesEnabled: false, payoutsEnabled: false, detailsSubmitted: false });
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
      const userId = req.session?.userId;
      const photographerId = req.session?.photographerId;
      if (!photographerId || !userId) {
        return res.status(401).json({ error: "Not authenticated as photographer" });
      }

      const photographer = await PhotographerService.get(photographerId);
      if (!photographer) {
        return res.status(404).json({ error: "Photographer not found" });
      }

      const user = await storage.getUser(userId);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      const host = req.get('host') || process.env.REPLIT_DOMAINS?.split(',')[0];
      const forwardedProto = req.get('x-forwarded-proto');
      const protocol = forwardedProto || (host?.includes('replit') ? 'https' : req.protocol) || 'https';
      const baseUrl = host ? `${protocol}://${host}` : '';

      let stripeAccountId = photographer.stripeAccountId;
      
      if (!stripeAccountId) {
        const account = await stripeService.createConnectAccount(
          user.email!,
          photographerId,
          photographer.displayName
        );
        stripeAccountId = account.id;
        await storage.updatePhotographer(photographerId, { stripeAccountId });
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
      const photographerId = req.session?.photographerId;
      const userId = req.session?.userId;
      
      if (!photographerId && !userId) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      let targetPhotographerId = photographerId;
      if (!targetPhotographerId && userId) {
        const photographer = await PhotographerService.getByUserId(userId);
        if (!photographer) {
          return res.status(404).json({ error: "Photographer not found" });
        }
        targetPhotographerId = photographer.id;
      }

      const bookings = await storage.getPhotographerBookingRecords(targetPhotographerId!);
      res.json({ bookings });
    } catch (error) {
      console.error("Get photographer booking records error:", error);
      res.status(500).json({ error: "Failed to get booking records" });
    }
  }

  // GET /api/photographers/me/services - Get all services for authenticated photographer
  static async getMyServices(req: Request, res: Response) {
    try {
      const photographerId = req.session?.photographerId;
      const userId = req.session?.userId;
      
      if (!photographerId && !userId) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      let targetPhotographerId = photographerId;
      if (!targetPhotographerId && userId) {
        const photographer = await PhotographerService.getByUserId(userId);
        if (!photographer) {
          return res.status(404).json({ error: "Photographer not found" });
        }
        targetPhotographerId = photographer.id;
      }

      const services = await storage.getPhotographerServices(targetPhotographerId!);
      res.json({ services });
    } catch (error) {
      console.error("Get photographer services error:", error);
      res.status(500).json({ error: "Failed to get services" });
    }
  }

  // POST /api/photographers/me/services - Create a new service
  static async createService(req: Request, res: Response) {
    try {
      const photographerId = req.session?.photographerId;
      const userId = req.session?.userId;
      
      if (!photographerId && !userId) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      let targetPhotographerId = photographerId;
      if (!targetPhotographerId && userId) {
        const photographer = await PhotographerService.getByUserId(userId);
        if (!photographer) {
          return res.status(404).json({ error: "Photographer not found" });
        }
        targetPhotographerId = photographer.id;
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
        photographerId: targetPhotographerId!,
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
      const photographerId = req.session?.photographerId;
      const userId = req.session?.userId;
      
      if (!photographerId && !userId) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const { serviceId } = req.params;
      const service = await storage.getPhotographerService(serviceId);
      
      if (!service) {
        return res.status(404).json({ error: "Service not found" });
      }

      let targetPhotographerId = photographerId;
      if (!targetPhotographerId && userId) {
        const photographer = await PhotographerService.getByUserId(userId);
        if (!photographer) {
          return res.status(404).json({ error: "Photographer not found" });
        }
        targetPhotographerId = photographer.id;
      }

      if (service.photographerId !== targetPhotographerId) {
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
      const photographerId = req.session?.photographerId;
      const userId = req.session?.userId;
      
      if (!photographerId && !userId) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const { serviceId } = req.params;
      const service = await storage.getPhotographerService(serviceId);
      
      if (!service) {
        return res.status(404).json({ error: "Service not found" });
      }

      let targetPhotographerId = photographerId;
      if (!targetPhotographerId && userId) {
        const photographer = await PhotographerService.getByUserId(userId);
        if (!photographer) {
          return res.status(404).json({ error: "Photographer not found" });
        }
        targetPhotographerId = photographer.id;
      }

      if (service.photographerId !== targetPhotographerId) {
        return res.status(403).json({ error: "Not authorized to delete this service" });
      }

      await storage.deletePhotographerService(serviceId);
      res.json({ success: true });
    } catch (error) {
      console.error("Delete photographer service error:", error);
      res.status(500).json({ error: "Failed to delete service" });
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
      const photographerId = req.session?.photographerId;
      const userId = req.session?.userId;
      
      if (!photographerId && !userId) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      let targetPhotographerId = photographerId;
      if (!targetPhotographerId && userId) {
        const photographer = await PhotographerService.getByUserId(userId);
        if (!photographer) {
          return res.status(404).json({ error: "Photographer not found" });
        }
        targetPhotographerId = photographer.id;
      }

      const { startDate, endDate } = req.query;
      const slots = await storage.getPhotographerAvailability(
        targetPhotographerId!,
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
      const photographerId = req.session?.photographerId;
      const userId = req.session?.userId;
      
      if (!photographerId && !userId) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      let targetPhotographerId = photographerId;
      if (!targetPhotographerId && userId) {
        const photographer = await PhotographerService.getByUserId(userId);
        if (!photographer) {
          return res.status(404).json({ error: "Photographer not found" });
        }
        targetPhotographerId = photographer.id;
      }

      const { date, startTime, endTime, slotType, title, notes, isRecurring, recurringDayOfWeek } = req.body;

      if (!date || !startTime || !endTime) {
        return res.status(400).json({ error: "Date, start time, and end time are required" });
      }

      const slot = await storage.createPhotographerAvailability({
        photographerId: targetPhotographerId!,
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
      const photographerId = req.session?.photographerId;
      const userId = req.session?.userId;
      
      if (!photographerId && !userId) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const { slotId } = req.params;
      const existingSlot = await storage.getPhotographerAvailabilitySlot(slotId);
      
      if (!existingSlot) {
        return res.status(404).json({ error: "Slot not found" });
      }

      let targetPhotographerId = photographerId;
      if (!targetPhotographerId && userId) {
        const photographer = await PhotographerService.getByUserId(userId);
        if (!photographer) {
          return res.status(404).json({ error: "Photographer not found" });
        }
        targetPhotographerId = photographer.id;
      }

      if (existingSlot.photographerId !== targetPhotographerId) {
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
      const photographerId = req.session?.photographerId;
      const userId = req.session?.userId;
      
      if (!photographerId && !userId) {
        return res.status(401).json({ error: "Not authenticated" });
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

      let targetPhotographerId = photographerId;
      if (!targetPhotographerId && userId) {
        const photographer = await PhotographerService.getByUserId(userId);
        if (!photographer) {
          return res.status(404).json({ error: "Photographer not found" });
        }
        targetPhotographerId = photographer.id;
      }

      if (existingSlot.photographerId !== targetPhotographerId) {
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
      const photographerId = req.session?.photographerId;
      const userId = req.session?.userId;
      
      if (!photographerId && !userId) {
        return res.status(401).json({ error: "Not authenticated" });
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

      let targetPhotographerId = photographerId;
      if (!targetPhotographerId && userId) {
        const photographer = await PhotographerService.getByUserId(userId);
        if (!photographer) {
          return res.status(404).json({ error: "Photographer not found" });
        }
        targetPhotographerId = photographer.id;
      }

      if (existingSlot.photographerId !== targetPhotographerId) {
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

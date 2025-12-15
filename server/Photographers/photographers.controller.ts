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
}

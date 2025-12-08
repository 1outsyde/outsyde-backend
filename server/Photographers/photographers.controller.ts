// server/Photographers/photographers.controller.ts
import { Request, Response } from "express";
import { PhotographerService } from "./photographers.service";

export class PhotographerController {
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

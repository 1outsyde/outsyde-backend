/**
 * Photographers customers can send requests to (Request forms F2, migration 108). Shared by the public form
 * route (./requestFormRoutes.ts) and POST /api/estimate-requests, kept apart so neither imports the other.
 */
import { storage } from "../storage";

/** A photographer service a customer can send a request for: live, active, contact for pricing, its photographer requestable. */
export async function requestablePhotographerService(serviceId: string) {
  const svc = await storage.getPhotographerService(serviceId);
  if (!svc || svc.status !== "live" || svc.isActive !== true || svc.isContactForPricing !== true) return null;
  const photographer = await requestablePhotographer(svc.photographerId);
  if (!photographer) return null;
  return { svc, photographer };
}

/** A photographer customers can send requests to: public (not hidden or flagged), with an active login. */
export async function requestablePhotographer(photographerId: string) {
  const photographer = await storage.getPhotographer(photographerId);
  // Same rule as the public photographer listing (storage.ts getPhotographers): only public profiles.
  if (!photographer || photographer.visibilityStatus !== "public") return null;
  const user = await storage.getUser(photographer.userId);
  if (!user || user.isActive === false) return null;
  return photographer;
}

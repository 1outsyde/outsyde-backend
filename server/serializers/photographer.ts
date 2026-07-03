// server/serializers/photographer.ts
import type { Photographer } from "@shared/schema";

export interface PublicPhotographerDTOOptions {
  followerCount: number;
  followingCount: number;
}

// Curated, allowlist-based public representation of a photographer.
// Never spread the raw row here — every field returned to unauthenticated
// clients must be explicitly listed below. This keeps internal/financial/
// moderation fields (stripeAccountId, stripeOnboardingComplete,
// stripeOnboardingUrl, billingAddress, isDemo, visibilityStatus,
// adminNotes, etc.) from ever leaking through this DTO.
export function toPublicPhotographerDTO(
  photographer: Photographer,
  opts: PublicPhotographerDTOOptions
) {
  return {
    id: photographer.id,
    userId: photographer.userId,

    displayName: photographer.displayName,
    bio: photographer.bio,
    city: photographer.city,
    state: photographer.state,
    latitude: photographer.latitude,
    longitude: photographer.longitude,
    portfolioUrl: photographer.portfolioUrl,

    hourlyRate: photographer.hourlyRate,

    rating: photographer.rating,
    reviewCount: photographer.reviewCount,
    specialties: photographer.specialties,

    coverImage: photographer.coverImage,
    coverMediaType: photographer.coverMediaType,
    logoImage: photographer.logoImage,
    brandColors: photographer.brandColors,

    hoursOfOperation: photographer.hoursOfOperation,

    autoAcceptBookings: photographer.autoAcceptBookings,

    createdAt: photographer.createdAt,

    followerCount: opts.followerCount,
    followingCount: opts.followingCount,

    acceptsOnlinePayments: !!(photographer.stripeAccountId && photographer.stripeOnboardingComplete),
  };
}

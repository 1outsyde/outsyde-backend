// server/serializers/business.ts
import type { Business } from "@shared/schema";

export interface PublicBusinessDTOOptions {
  followerCount: number;
  followingCount: number;
}

// Curated, allowlist-based public representation of a business.
// Never spread the raw row here — every field returned to unauthenticated
// clients must be explicitly listed below. This keeps internal/financial/
// moderation fields (stripeAccountId, billingAddress, approvalNotes,
// approvedBy, isDemo, subscriptionActive, employeeCount, businessType, etc.)
// from ever leaking through this DTO.
export function toPublicBusinessDTO(
  business: Business,
  opts: PublicBusinessDTOOptions
) {
  return {
    id: business.id,
    ownerId: business.ownerId,

    name: business.name,
    category: business.category,
    description: business.description,

    isStartup: business.isStartup,
    yearsInBusiness: business.yearsInBusiness,

    hasPhysicalLocation: business.hasPhysicalLocation,
    showAddress: business.showAddress,
    address: business.address,
    city: business.city,
    state: business.state,
    zipCode: business.zipCode,
    country: business.country,
    latitude: business.latitude,
    longitude: business.longitude,

    websiteUrl: business.showWebsite ? business.websiteUrl : null,
    socialMedia: business.socialMedia,

    coverImage: business.coverImage,
    coverMediaType: business.coverMediaType,
    logoImage: business.logoImage,

    rating: business.rating,
    reviewCount: business.reviewCount,

    tagline: business.tagline,
    hoursOfOperation: business.showStoreHours ? business.hoursOfOperation : null,
    contactEmail: business.showEmail ? business.contactEmail : null,
    contactPhone: business.showPhone ? business.contactPhone : null,
    brandColors: business.brandColors,
    knownFor: business.knownFor,

    hasProducts: business.hasProducts,
    hasServices: business.hasServices,
    isMultiStaff: business.isMultiStaff,
    defaultServiceLocationType: business.defaultServiceLocationType,

    autoAcceptBookings: business.autoAcceptBookings,
    responseTimeValue: business.showResponseTime ? business.responseTimeValue : null,
    responseTimeUnit: business.showResponseTime ? business.responseTimeUnit : null,

    vendorTermsAndConditions: business.vendorTermsAndConditions ?? null,

    createdAt: business.createdAt,

    followerCount: opts.followerCount,
    followingCount: opts.followingCount,

    acceptsOnlinePayments: !!(business.stripeAccountId && business.stripeOnboardingComplete),
  };
}

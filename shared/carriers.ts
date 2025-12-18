export type CarrierId = 'fedex' | 'ups' | 'usps' | 'dhl' | 'amazon' | 'ontrac' | 'lasership' | 'other';

export interface CarrierConfig {
  id: CarrierId;
  name: string;
  logo: string;
  trackingUrlPattern: string;
  color: string;
}

export const CARRIERS: Record<CarrierId, CarrierConfig> = {
  fedex: {
    id: 'fedex',
    name: 'FedEx',
    logo: '/carriers/fedex.svg',
    trackingUrlPattern: 'https://www.fedex.com/fedextrack/?trknbr={trackingNumber}',
    color: '#4D148C',
  },
  ups: {
    id: 'ups',
    name: 'UPS',
    logo: '/carriers/ups.svg',
    trackingUrlPattern: 'https://www.ups.com/track?loc=en_US&tracknum={trackingNumber}',
    color: '#351C15',
  },
  usps: {
    id: 'usps',
    name: 'USPS',
    logo: '/carriers/usps.svg',
    trackingUrlPattern: 'https://tools.usps.com/go/TrackConfirmAction?tLabels={trackingNumber}',
    color: '#004B87',
  },
  dhl: {
    id: 'dhl',
    name: 'DHL',
    logo: '/carriers/dhl.svg',
    trackingUrlPattern: 'https://www.dhl.com/us-en/home/tracking.html?tracking-id={trackingNumber}',
    color: '#FFCC00',
  },
  amazon: {
    id: 'amazon',
    name: 'Amazon Logistics',
    logo: '/carriers/amazon.svg',
    trackingUrlPattern: 'https://track.amazon.com/tracking/{trackingNumber}',
    color: '#FF9900',
  },
  ontrac: {
    id: 'ontrac',
    name: 'OnTrac',
    logo: '/carriers/ontrac.svg',
    trackingUrlPattern: 'https://www.ontrac.com/tracking.asp?tracking={trackingNumber}',
    color: '#0095DA',
  },
  lasership: {
    id: 'lasership',
    name: 'LaserShip',
    logo: '/carriers/lasership.svg',
    trackingUrlPattern: 'https://www.lasership.com/track/{trackingNumber}',
    color: '#E31837',
  },
  other: {
    id: 'other',
    name: 'Other Carrier',
    logo: '/carriers/package.svg',
    trackingUrlPattern: '',
    color: '#6B7280',
  },
};

export const CARRIER_LIST = Object.values(CARRIERS);

export function getCarrierConfig(carrierId: string): CarrierConfig {
  return CARRIERS[carrierId as CarrierId] || CARRIERS.other;
}

export function getTrackingUrl(carrierId: string, trackingNumber: string): string | null {
  const carrier = getCarrierConfig(carrierId);
  if (!carrier.trackingUrlPattern) return null;
  return carrier.trackingUrlPattern.replace('{trackingNumber}', encodeURIComponent(trackingNumber));
}

export type ShipmentStatus = 'pending' | 'shipped' | 'in_transit' | 'delivered' | 'exception';

export const SHIPMENT_STATUSES: Record<ShipmentStatus, { label: string; color: string }> = {
  pending: { label: 'Pending', color: '#F59E0B' },
  shipped: { label: 'Shipped', color: '#3B82F6' },
  in_transit: { label: 'In Transit', color: '#8B5CF6' },
  delivered: { label: 'Delivered', color: '#10B981' },
  exception: { label: 'Exception', color: '#EF4444' },
};

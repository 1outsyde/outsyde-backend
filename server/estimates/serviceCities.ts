/**
 * Service cities (migration 067): which cities a business serves, and which of them each service is
 * offered in. Pure helpers, no database.
 *
 * - businesses.service_cities        the business's list (its site's estimate form shows these).
 * - vendor_services.service_cities   the cities a service is offered in. Empty = every city of the business.
 *
 * City names are compared without case and extra spaces, so "norfolk " and "Norfolk" are the same city.
 */
import { z } from "zod";

export const MAX_SERVICE_CITIES = 50;
export const MAX_CITY_LENGTH = 60;

/** Trim, collapse inner spaces. */
export function cleanCityName(raw: string): string {
  return raw.trim().replace(/\s+/g, " ");
}

/** Comparison key for a city name. */
export function cityKey(raw: string): string {
  return cleanCityName(raw).toLowerCase();
}

/** Clean a list: drop blanks, trim, remove duplicates (first spelling wins), keep the order given. */
export function normalizeCityList(list: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const name = cleanCityName(raw);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

/** Zod input for a city list on a save: up to 50 names of up to 60 characters, cleaned. */
export const serviceCitiesInput = z
  .array(z.string().max(MAX_CITY_LENGTH))
  .max(MAX_SERVICE_CITIES)
  .transform((list) => normalizeCityList(list));

/** Is a service offered in this city? Empty service list = offered in every city. */
export function isServiceOfferedInCity(serviceCities: readonly string[] | null | undefined, city: string): boolean {
  if (!serviceCities || serviceCities.length === 0) return true;
  const key = cityKey(city);
  return serviceCities.some((c) => cityKey(c) === key);
}

/** Is this city one the business serves? A business with no list accepts any city. */
export function isBusinessCity(businessCities: readonly string[] | null | undefined, city: string): boolean {
  if (!businessCities || businessCities.length === 0) return true;
  const key = cityKey(city);
  return businessCities.some((c) => cityKey(c) === key);
}

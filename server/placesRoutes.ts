/**
 * Places proxy routes — server-side proxy to Google Places API.
 * The API key never leaves the server; the frontend receives only
 * the minimal shape it needs.
 */

import type { Express } from "express";
import { authMiddleware } from "./auth";

const PLACES_BASE = "https://maps.googleapis.com/maps/api/place";
const MIN_INPUT_LENGTH = 3;

interface AutocompletePrediction {
  description: string;
  placeId: string;
}

interface ParsedAddress {
  line1: string;
  city: string;
  state: string;
  zipCode: string;
  country: string;
  latitude: number;
  longitude: number;
}

function parseAddressComponents(
  components: Array<{ types: string[]; long_name: string; short_name: string }>,
  geometry: { location: { lat: number; lng: number } } | undefined
): ParsedAddress {
  let streetNumber = "";
  let route = "";
  let city = "";
  let state = "";
  let zipCode = "";
  let country = "";

  for (const c of components) {
    if (c.types.includes("street_number")) streetNumber = c.long_name;
    else if (c.types.includes("route")) route = c.long_name;
    else if (c.types.includes("locality")) city = c.long_name;
    else if (c.types.includes("sublocality_level_1") && !city) city = c.long_name;
    else if (c.types.includes("administrative_area_level_3") && !city) city = c.long_name;
    else if (c.types.includes("administrative_area_level_1")) state = c.short_name;
    else if (c.types.includes("postal_code")) zipCode = c.long_name;
    else if (c.types.includes("country")) country = c.long_name;
  }

  const line1 = [streetNumber, route].filter(Boolean).join(" ");

  return {
    line1,
    city,
    state,
    zipCode,
    country,
    latitude: geometry?.location.lat ?? 0,
    longitude: geometry?.location.lng ?? 0,
  };
}

export function registerPlacesRoutes(app: Express): void {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;

  // GET /api/places/autocomplete?input=<partial address>
  app.get("/api/places/autocomplete", authMiddleware, async (req, res) => {
    const input = (req.query.input as string | undefined)?.trim() ?? "";

    if (input.length < MIN_INPUT_LENGTH) {
      return res.json({ predictions: [] as AutocompletePrediction[] });
    }

    if (!apiKey) {
      console.error("[Places] GOOGLE_PLACES_API_KEY is not set");
      return res.status(503).json({ error: "Places service unavailable" });
    }

    try {
      const url = new URL(`${PLACES_BASE}/autocomplete/json`);
      url.searchParams.set("input", input);
      url.searchParams.set("types", "address");
      url.searchParams.set("components", "country:us");
      url.searchParams.set("key", apiKey);

      const response = await fetch(url.toString(), {
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) {
        console.error(`[Places] Autocomplete HTTP ${response.status}`);
        return res.status(502).json({ error: "Places API request failed" });
      }

      const data = await response.json() as {
        status: string;
        error_message?: string;
        predictions?: Array<{ description: string; place_id: string }>;
      };

      if (data.status === "REQUEST_DENIED" || data.status === "INVALID_REQUEST") {
        console.error(`[Places] Autocomplete API error: ${data.status} — ${data.error_message ?? ""}`);
        return res.status(502).json({ error: `Places API error: ${data.status}` });
      }

      const predictions: AutocompletePrediction[] = (data.predictions ?? []).map((p) => ({
        description: p.description,
        placeId: p.place_id,
      }));

      return res.json({ predictions });
    } catch (err) {
      console.error("[Places] Autocomplete fetch failed:", err);
      return res.status(502).json({ error: "Places service unavailable" });
    }
  });

  // GET /api/places/details?placeId=<id>
  app.get("/api/places/details", authMiddleware, async (req, res) => {
    const placeId = (req.query.placeId as string | undefined)?.trim() ?? "";

    if (!placeId) {
      return res.status(400).json({ error: "placeId is required" });
    }

    if (!apiKey) {
      console.error("[Places] GOOGLE_PLACES_API_KEY is not set");
      return res.status(503).json({ error: "Places service unavailable" });
    }

    try {
      const url = new URL(`${PLACES_BASE}/details/json`);
      url.searchParams.set("place_id", placeId);
      url.searchParams.set("fields", "address_components,geometry");
      url.searchParams.set("key", apiKey);

      const response = await fetch(url.toString(), {
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) {
        console.error(`[Places] Details HTTP ${response.status}`);
        return res.status(502).json({ error: "Places API request failed" });
      }

      const data = await response.json() as {
        status: string;
        error_message?: string;
        result?: {
          address_components: Array<{ types: string[]; long_name: string; short_name: string }>;
          geometry: { location: { lat: number; lng: number } };
        };
      };

      if (data.status === "REQUEST_DENIED" || data.status === "INVALID_REQUEST" || data.status === "NOT_FOUND") {
        console.error(`[Places] Details API error: ${data.status} — ${data.error_message ?? ""}`);
        return res.status(502).json({ error: `Places API error: ${data.status}` });
      }

      if (!data.result) {
        return res.status(404).json({ error: "Place not found" });
      }

      const parsed = parseAddressComponents(
        data.result.address_components,
        data.result.geometry
      );

      return res.json(parsed);
    } catch (err) {
      console.error("[Places] Details fetch failed:", err);
      return res.status(502).json({ error: "Places service unavailable" });
    }
  });
}

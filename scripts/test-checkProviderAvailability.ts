import { checkProviderAvailability } from "../server/availabilityService";

async function main() {
  const date = "2026-07-13"; // a Monday

  console.log("--- business ---");
  console.log(await checkProviderAvailability(
    "business",
    "00000000-0000-0000-0000-000000000001",
    null,
    date,
    "10:00",
    "10:30",
  ));

  console.log("--- staff ---");
  console.log(await checkProviderAvailability(
    "staff",
    "00000000-0000-0000-0000-000000000001", // businessId
    "00000000-0000-0000-0000-000000000002", // staffMemberId
    date,
    "10:00",
    "10:30",
  ));

  console.log("--- staff, missing staffMemberId ---");
  console.log(await checkProviderAvailability(
    "staff",
    "00000000-0000-0000-0000-000000000001",
    null,
    date,
    "10:00",
    "10:30",
  ));

  console.log("--- photographer ---");
  console.log(await checkProviderAvailability(
    "photographer",
    "00000000-0000-0000-0000-000000000003",
    null,
    date,
    "10:00",
    "12:00",
  ));

  process.exit(0);
}

main().catch(err => {
  console.error("Script failed:", err);
  process.exit(1);
});

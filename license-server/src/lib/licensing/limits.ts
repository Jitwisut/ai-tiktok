// Shared by the admin UI (client bundle), the API schema and the service. Keep Node-only imports out.
export const MAX_LICENSE_DAYS = 36_500;
/** "ถาวร" is a 100-year key; expiries this far out are shown as lifetime instead of a date. */
export const LIFETIME_DAYS = MAX_LICENSE_DAYS;
export const LIFETIME_DISPLAY_DAYS = 50 * 365;
export function isValidLicenseDays(days: unknown): days is number {
  return typeof days === "number" && Number.isSafeInteger(days) && days >= 1 && days <= MAX_LICENSE_DAYS;
}

import { timingSafeEqual } from "node:crypto";

export function isAuthorized(authorization: string | undefined, adminToken: string) {
  if (!authorization?.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(authorization.slice("Bearer ".length));
  const expected = Buffer.from(adminToken);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

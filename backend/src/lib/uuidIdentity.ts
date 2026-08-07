const RAW_UUID_HEX = /^[0-9a-f]{32}$/i;
const CANONICAL_UUID =
  /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export function canonicalUuidIdentity(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const raw = RAW_UUID_HEX.test(value)
    ? value.toLowerCase()
    : CANONICAL_UUID.test(value)
      ? value.replaceAll("-", "").toLowerCase()
      : null;
  if (!raw) return null;
  return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`;
}

export function sameUuidIdentity(left: unknown, right: unknown) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  if (left === right) return true;
  const normalizedLeft = canonicalUuidIdentity(left);
  const normalizedRight = canonicalUuidIdentity(right);
  return (
    normalizedLeft !== null &&
    normalizedRight !== null &&
    normalizedLeft === normalizedRight
  );
}

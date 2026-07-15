import { VERA_MODEL_CREDENTIAL_MAX_UTF8_BYTES } from "@/app/lib/veraCredentialLimits";

export const VERA_CREDENTIAL_MAX_BYTES = VERA_MODEL_CREDENTIAL_MAX_UTF8_BYTES;

export type VeraCredentialInputLimit =
  | { maxUtf8Bytes: number; maxCharacters?: never }
  | { maxCharacters: number; maxUtf8Bytes?: never };

export class VeraCredentialInputError extends Error {
  constructor() {
    super("The credential input is invalid.");
    this.name = "VeraCredentialInputError";
  }
}

/** Read the uncontrolled field once, clear the DOM immediately, and never retain it in state. */
export async function submitVeraCredentialInput(
  field: Pick<HTMLInputElement, "value">,
  store: (secret: string) => Promise<void>,
  limit: VeraCredentialInputLimit = {
    maxUtf8Bytes: VERA_MODEL_CREDENTIAL_MAX_UTF8_BYTES,
  },
): Promise<void> {
  const secret = field.value;
  field.value = "";
  try {
    const maximum = limit.maxUtf8Bytes ?? limit.maxCharacters;
    if (
      !Number.isSafeInteger(maximum) ||
      maximum < 1 ||
      secret.length === 0 ||
      /[\r\n]/.test(secret) ||
      (limit.maxUtf8Bytes !== undefined &&
        new TextEncoder().encode(secret).byteLength > limit.maxUtf8Bytes) ||
      (limit.maxCharacters !== undefined && secret.length > limit.maxCharacters)
    ) {
      throw new VeraCredentialInputError();
    }
    await store(secret);
  } finally {
    field.value = "";
  }
}

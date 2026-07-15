export const VERA_CREDENTIAL_MAX_BYTES = 8 * 1024;

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
): Promise<void> {
  const secret = field.value;
  field.value = "";
  try {
    if (
      secret.length === 0 ||
      /[\r\n]/.test(secret) ||
      new TextEncoder().encode(secret).byteLength > VERA_CREDENTIAL_MAX_BYTES
    ) {
      throw new VeraCredentialInputError();
    }
    await store(secret);
  } finally {
    field.value = "";
  }
}

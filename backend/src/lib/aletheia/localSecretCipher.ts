import { createHash } from "node:crypto";
import path from "node:path";
import {
  applicationEncryptionMode,
  decryptLocalBuffer,
  encryptLocalBuffer,
} from "./localEnvelopeCrypto";

export interface SecretCipher {
  encrypt(plaintext: string, context: string): string;
  decrypt(envelope: string, context: string): string;
}

export class SecretCipherError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretCipherError";
  }
}

function dataDir() {
  return path.resolve(
    process.env.ALETHEIA_DATA_DIR ??
      process.env.ALET_HEIA_DATA_DIR ??
      path.resolve(process.cwd(), ".data", "aletheia"),
  );
}

function authenticatedSecretPath(context: string) {
  const id = createHash("sha256").update(context).digest("hex");
  return path.join(dataDir(), "secrets", `${id}.secret`);
}

/**
 * SQLite-field adapter over the canonical Aletheia AES-GCM envelope. The
 * authenticated virtual path is stable per secret record. Unlike ordinary
 * file writes, secrets never permit the encryption-disabled plaintext mode.
 */
export class LocalEnvelopeSecretCipher implements SecretCipher {
  encrypt(plaintext: string, context: string) {
    if (applicationEncryptionMode() !== "required") {
      throw new SecretCipherError(
        "Secret persistence requires ALETHEIA_APPLICATION_ENCRYPTION=required.",
      );
    }
    return encryptLocalBuffer({
      plaintext: Buffer.from(plaintext, "utf8"),
      filePath: authenticatedSecretPath(context),
      purpose: "local_secret",
    }).toString("base64");
  }

  decrypt(envelope: string, context: string) {
    if (applicationEncryptionMode() !== "required") {
      throw new SecretCipherError(
        "Secret access requires ALETHEIA_APPLICATION_ENCRYPTION=required.",
      );
    }
    return decryptLocalBuffer({
      envelope: Buffer.from(envelope, "base64"),
      filePath: authenticatedSecretPath(context),
      purpose: "local_secret",
    }).toString("utf8");
  }
}

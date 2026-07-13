import { generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const [dataDir, anchorRoot] = process.argv.slice(2);
if (!dataDir || !anchorRoot) {
  throw new Error("UI smoke anchor setup requires data and anchor directories.");
}

rmSync(path.resolve(dataDir), { recursive: true, force: true });
rmSync(path.resolve(anchorRoot), { recursive: true, force: true });
const journalDir = path.join(anchorRoot, "journal");
const keyDir = path.join(anchorRoot, "keys");
mkdirSync(journalDir, { recursive: true, mode: 0o700 });
mkdirSync(keyDir, { recursive: true, mode: 0o700 });
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const privateKeyPath = path.join(keyDir, "private.pem");
writeFileSync(
  privateKeyPath,
  privateKey.export({ type: "pkcs8", format: "pem" }),
  { mode: 0o600 },
);
writeFileSync(
  path.join(keyDir, "public.pem"),
  publicKey.export({ type: "spki", format: "pem" }),
  { mode: 0o644 },
);
chmodSync(privateKeyPath, 0o600);

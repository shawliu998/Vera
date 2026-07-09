import "dotenv/config";
import { seedAletheiaDemoIfNeeded } from "../lib/aletheia/demoSeed";

async function main() {
  process.env.ALETHEIA_STORAGE_DRIVER =
    process.env.ALETHEIA_STORAGE_DRIVER ?? "local";
  process.env.ALETHEIA_AUTH_MODE =
    process.env.ALETHEIA_AUTH_MODE ?? "single_user";
  process.env.ALETHEIA_DATA_DIR =
    process.env.ALETHEIA_DATA_DIR ?? ".data/aletheia";
  process.env.ALETHEIA_LOCAL_USER_ID =
    process.env.ALETHEIA_LOCAL_USER_ID ?? "local-user";
  process.env.ALETHEIA_LOCAL_USER_EMAIL =
    process.env.ALETHEIA_LOCAL_USER_EMAIL ?? "local@aletheia.internal";
  process.env.ALETHEIA_DEMO_SEED_ENABLED =
    process.env.ALETHEIA_DEMO_SEED_ENABLED ?? "true";
  process.env.ALETHEIA_DEMO_SEED_MODE =
    process.env.ALETHEIA_DEMO_SEED_MODE ?? "always";

  const frontendUrl =
    process.env.ALETHEIA_UI_SMOKE_FRONTEND_URL ?? "http://localhost:3000";
  const result = await seedAletheiaDemoIfNeeded();
  console.log(
    JSON.stringify(
      {
        ok: true,
        dataDir: process.env.ALETHEIA_DATA_DIR,
        matterUrl:
          "matterId" in result
            ? `${frontendUrl.replace(/\/$/, "")}/aletheia/matters/${result.matterId}`
            : null,
        ...result,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error("[aletheia-seed-ui-smoke] failed", error);
  process.exit(1);
});

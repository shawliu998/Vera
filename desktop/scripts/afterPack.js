const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;

  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
  );
  const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), "aletheia-sign-"));
  const stagedAppPath = path.join(stagingDir, "Aletheia.app");

  execFileSync("ditto", ["--norsrc", appPath, stagedAppPath], {
    stdio: "inherit",
  });
  execFileSync("xattr", ["-cr", stagedAppPath], { stdio: "inherit" });
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", stagedAppPath], {
    stdio: "inherit",
  });
  execFileSync("xattr", ["-cr", stagedAppPath], { stdio: "inherit" });
  fs.rmSync(appPath, { recursive: true, force: true });
  execFileSync("ditto", ["--norsrc", stagedAppPath, appPath], {
    stdio: "inherit",
  });
  execFileSync("xattr", ["-cr", appPath], { stdio: "inherit" });
  fs.rmSync(stagingDir, { recursive: true, force: true });
};

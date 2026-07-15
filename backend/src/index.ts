import "dotenv/config";
import {
  bootstrapVeraApplication,
  type VeraApplicationInstance,
} from "./veraApplication";
import { createWorkspaceRuntime } from "./lib/workspace/runtime";
import {
  CredentialWorkerUnavailableError,
  receiveCredentialWorkerClient,
} from "./lib/workspace/services/credentialWorkerClient";

function exitAfterSafeError(message: string): void {
  try {
    process.stderr.write(`${message}\n`, () => process.exit(1));
  } catch {
    process.exit(1);
  }
}

export function registerVeraProcessSignals(
  application: VeraApplicationInstance,
): () => void {
  let requested = false;
  const requestShutdown = () => {
    if (requested) return;
    requested = true;
    void application.shutdown().then(
      () => process.exit(0),
      () => {
        exitAfterSafeError("[vera-shutdown] failed");
      },
    );
  };

  process.once("SIGINT", requestShutdown);
  process.once("SIGTERM", requestShutdown);
  return () => {
    process.off("SIGINT", requestShutdown);
    process.off("SIGTERM", requestShutdown);
  };
}

export async function main(): Promise<VeraApplicationInstance> {
  const credentialClient = await receiveCredentialWorkerClient();
  try {
    if (credentialClient) {
      const capabilities = await credentialClient.capabilities();
      if (!capabilities.available) {
        throw new CredentialWorkerUnavailableError();
      }
    }

    const application = await bootstrapVeraApplication(
      credentialClient
        ? {
            dependencies: {
              createRuntime: () =>
                createWorkspaceRuntime({ credentialStore: credentialClient }),
            },
          }
        : {},
    );
    let shutdownPromise: Promise<void> | null = null;
    const managedApplication: VeraApplicationInstance = credentialClient
      ? {
          ...application,
          shutdown: () => {
            shutdownPromise ??= (async () => {
              try {
                await application.shutdown();
              } finally {
                credentialClient.close();
              }
            })();
            return shutdownPromise;
          },
        }
      : application;
    registerVeraProcessSignals(managedApplication);
    console.log(
      `Vera backend running at http://${managedApplication.host}:${managedApplication.port}`,
    );
    return managedApplication;
  } catch (error) {
    credentialClient?.close();
    throw error;
  }
}

if (require.main === module) {
  void main().catch(() => {
    // Electron utility processes retain a live parent MessagePort. Merely
    // assigning exitCode would leave a failed backend resident forever even
    // after bootstrap has completed its bounded cleanup.
    exitAfterSafeError("[vera-startup] failed");
  });
}

"use client";

import { useCallback, useEffect, useState } from "react";
import {
  benchmarkLocalModel,
  calibrateLocalModel,
  listLocalModels,
  type LocalModelSnapshot,
  type LocalModelsResponse,
} from "@/app/lib/aletheiaApi";

export function useLocalModels() {
  const [models, setModels] = useState<LocalModelSnapshot[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [policy, setPolicy] = useState<LocalModelsResponse["benchmark"] | null>(
    null,
  );
  const [calibratingModelId, setCalibratingModelId] = useState<string | null>(
    null,
  );
  const [benchmarkingModelId, setBenchmarkingModelId] = useState<string | null>(
    null,
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await listLocalModels();
      setModels(response.models);
      setPolicy(response.benchmark);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Local model runtime is unavailable.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const calibrate = useCallback(
    async (modelId: string) => {
      setCalibratingModelId(modelId);
      setError(null);
      try {
        await calibrateLocalModel(modelId);
        await refresh();
      } catch (reason) {
        setError(
          reason instanceof Error
            ? reason.message
            : "Model calibration could not run.",
        );
      } finally {
        setCalibratingModelId(null);
      }
    },
    [refresh],
  );

  const benchmark = useCallback(
    async (modelId: string) => {
      setBenchmarkingModelId(modelId);
      setError(null);
      try {
        await benchmarkLocalModel(modelId);
        await refresh();
      } catch (reason) {
        setError(
          reason instanceof Error
            ? reason.message
            : "The diagnostic benchmark could not run.",
        );
      } finally {
        setBenchmarkingModelId(null);
      }
    },
    [refresh],
  );

  return {
    models,
    policy,
    loading,
    error,
    refresh,
    calibrate,
    calibratingModelId,
    benchmark,
    benchmarkingModelId,
  };
}

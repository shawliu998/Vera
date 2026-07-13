"use client";

import { useCallback, useEffect, useState } from "react";
import {
    ALETHEIA_SETTINGS_EVENT,
    SELECTED_MODEL_KEY,
    readAletheiaSettings,
} from "@/aletheia/settingsModel";

const SAFE_MODEL_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;

function readStored(): string {
    if (typeof window === "undefined") return "";
    const raw = window.localStorage.getItem(SELECTED_MODEL_KEY);
    if (raw && SAFE_MODEL_ID.test(raw)) return raw;
    const configured = readAletheiaSettings().defaultModel;
    return SAFE_MODEL_ID.test(configured) ? configured : "";
}

export function useSelectedModel(): [string, (id: string) => void] {
    const [model, setModelState] = useState<string>(readStored);

    useEffect(() => {
        function syncModel() {
            setModelState(readStored());
        }
        window.addEventListener("storage", syncModel);
        window.addEventListener(ALETHEIA_SETTINGS_EVENT, syncModel);
        return () => {
            window.removeEventListener("storage", syncModel);
            window.removeEventListener(ALETHEIA_SETTINGS_EVENT, syncModel);
        };
    }, []);

    const setModel = useCallback((id: string) => {
        const next = SAFE_MODEL_ID.test(id) ? id : "";
        setModelState(next);
        if (typeof window !== "undefined") {
            if (next) window.localStorage.setItem(SELECTED_MODEL_KEY, next);
            else window.localStorage.removeItem(SELECTED_MODEL_KEY);
        }
    }, []);

    return [model, setModel];
}

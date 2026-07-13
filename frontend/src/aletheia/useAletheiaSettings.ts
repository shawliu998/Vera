"use client";

import { useEffect, useState } from "react";
import {
    ALETHEIA_SETTINGS_EVENT,
    applyAletheiaSettings,
    readAletheiaSettings,
    type AletheiaClientSettings,
} from "./settingsModel";

export function useAletheiaSettings(): AletheiaClientSettings {
    const [settings, setSettings] = useState(readAletheiaSettings);

    useEffect(() => {
        const sync = () => {
            const next = readAletheiaSettings();
            applyAletheiaSettings(next);
            setSettings(next);
        };
        sync();
        window.addEventListener(ALETHEIA_SETTINGS_EVENT, sync);
        window.addEventListener("storage", sync);
        return () => {
            window.removeEventListener(ALETHEIA_SETTINGS_EVENT, sync);
            window.removeEventListener("storage", sync);
        };
    }, []);

    return settings;
}

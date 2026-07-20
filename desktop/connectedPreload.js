"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld(
  "veraDesktop",
  Object.freeze({
    getInfo: () => ipcRenderer.invoke("vera:get-desktop-info"),
  }),
);

"use strict";

const path = require("path");
const { app, BrowserWindow } = require("electron");

let e3ChatWindow = null;

function removeFromOpenChildWindows(openChildWindows, win) {
  if (!Array.isArray(openChildWindows) || !win) return;
  const idx = openChildWindows.indexOf(win);
  if (idx >= 0) openChildWindows.splice(idx, 1);
}

async function openE3ChatWindow({ openChildWindows = [] } = {}) {
  if (e3ChatWindow && !e3ChatWindow.isDestroyed()) {
    if (!e3ChatWindow.isVisible()) e3ChatWindow.show();
    if (e3ChatWindow.isMinimized()) e3ChatWindow.restore();
    e3ChatWindow.focus();
    return e3ChatWindow;
  }

  const appRoot = app.getAppPath();
  e3ChatWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 860,
    minHeight: 560,
    title: "E3 Chat",
    frame: true,
    modal: false,
    webPreferences: {
      preload: path.join(appRoot, "preloads", "e3chat.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      devTools: true,
    },
    icon: path.join(appRoot, "assets", "icon.png"),
    show: false,
  });

  const htmlPath = path.join(
    appRoot,
    "Desktopmodules",
    "e3chat",
    "e3chat.html"
  );
  await e3ChatWindow.loadFile(htmlPath);
  e3ChatWindow.setMenu(null);

  if (Array.isArray(openChildWindows)) openChildWindows.push(e3ChatWindow);

  e3ChatWindow.once("ready-to-show", () => {
    if (e3ChatWindow && !e3ChatWindow.isDestroyed()) e3ChatWindow.show();
  });

  e3ChatWindow.on("closed", () => {
    removeFromOpenChildWindows(openChildWindows, e3ChatWindow);
    e3ChatWindow = null;
  });

  return e3ChatWindow;
}

function getE3ChatWindow() {
  return e3ChatWindow;
}

module.exports = { openE3ChatWindow, getE3ChatWindow };

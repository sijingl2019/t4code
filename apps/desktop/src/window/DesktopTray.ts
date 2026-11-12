import * as Electron from "electron";

// Held at module scope: a garbage-collected Tray disappears from the taskbar.
let tray: Electron.Tray | undefined;
let appQuitting = false;

/** The main window hides instead of closing while a tray icon can bring it back. */
export function shouldHideOnClose(): boolean {
  return tray !== undefined && !appQuitting;
}

export function createTray(options: {
  readonly icon: string;
  readonly tooltip: string;
  readonly onShowApp: () => void;
  readonly onSettings: () => void;
}): void {
  if (tray !== undefined) return;
  Electron.app.on("before-quit", () => {
    appQuitting = true;
  });
  tray = new Electron.Tray(options.icon);
  tray.setToolTip(options.tooltip);
  tray.setContextMenu(
    Electron.Menu.buildFromTemplate([
      { label: "Show App", click: options.onShowApp },
      { label: "Settings", click: options.onSettings },
      { type: "separator" },
      { label: "Quit", click: () => Electron.app.quit() },
    ]),
  );
  tray.on("click", options.onShowApp);
}

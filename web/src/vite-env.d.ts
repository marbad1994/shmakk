/// <reference types="vite/client" />

interface ShmakkDesktopBridge {
  platform: string;
  version: string;
  pickFolder(): Promise<string | null>;
  openExternal(url: string): void;
  onMenu(handler: (action: string) => void): () => void;
}
interface Window {
  shmakkDesktop?: ShmakkDesktopBridge;
}

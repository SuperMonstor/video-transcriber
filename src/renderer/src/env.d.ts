/// <reference types="vite/client" />
import type { TranscriberApi } from "../../preload/preload";

declare global {
  interface Window {
    transcriber: TranscriberApi;
  }
}

export {};

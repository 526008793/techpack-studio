import type { DesktopApi } from "../../shared/model";
declare global {
  interface Window {
    techpack: DesktopApi;
  }
}
export {};

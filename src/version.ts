export const APP_VERSION = '0.1.0';
export const BUILD_ID: string = import.meta.env.VITE_BUILD_ID;
export const BUILD_KIND: 'pwa' | 'single' =
  import.meta.env.VITE_BUILD_KIND === 'single' ? 'single' : 'pwa';
export const SUPPORTED_PROTOCOL_VERSIONS: readonly number[] = [1];

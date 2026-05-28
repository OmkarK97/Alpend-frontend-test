/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_LENDING_PACKAGE_ID: string;
  readonly VITE_SCAN_API_URL: string;
  readonly VITE_TRANSFER_PREAPPROVAL_API_URL: string;
  readonly VITE_NETWORK: string;
  readonly VITE_SYNCHRONIZER_ID: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

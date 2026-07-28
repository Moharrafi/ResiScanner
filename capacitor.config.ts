import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.inventory.resi',
  appName: 'Resi Scanner',
  webDir: 'dist',
  server: {
    url: 'https://resi-scannerr.vercel.app',
    cleartext: true,
  },
  android: {
    allowMixedContent: true,
  },
};

export default config;

import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.inventory.resi',
  appName: 'Resi Scanner',
  webDir: 'dist',
  // Local standalone bundle for APK:
  // (Remove server.url so APK runs the embedded latest build directly offline)
  // server: {
  //   url: 'https://resi-scannerr.vercel.app',
  //   cleartext: true,
  // },
  android: {
    allowMixedContent: true,
  },
};

export default config;

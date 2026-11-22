import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'mw.siatech.mobiletechroom',
  appName: 'Mobile Tech Room',
  webDir: 'www',
  server: {
    url: 'https://shuaibuidi.github.io/MOBILE-TECH-ROOM/',
    cleartext: false,
    allowNavigation: [
      'shuaibuidi.github.io',
      '*.paychangu.com',
      'api.paychangu.com',
      'starter-function-52z5.sgp.appwrite.run',
      '*.firebaseapp.com',
      '*.googleapis.com'
    ]
  }
};

export default config;

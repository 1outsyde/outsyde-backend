import { neonConfig } from '@neondatabase/serverless';

const proxyPort = process.env.NEON_PROXY_PORT || '4444';

neonConfig.fetchEndpoint = () => `http://127.0.0.1:${proxyPort}/sql`;

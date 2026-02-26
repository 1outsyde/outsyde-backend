const { neonConfig } = require('@neondatabase/serverless');

neonConfig.fetchEndpoint = () => 'http://127.0.0.1:4444/sql';
neonConfig.fetchFunction = globalThis.fetch;

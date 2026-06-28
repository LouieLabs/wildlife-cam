// Which environment is this server? Used to TAG every artifact it creates so dev
// test data can be purged without touching production.
//
//   local dev (npm run dev) : APP_ENV=dev  (set in .env.local)
//   Cloud Run (production)  : APP_ENV=prod
//
// Default is "prod" ON PURPOSE: if APP_ENV is ever missing, we fail SAFE (mark
// data as keep-forever) rather than risk tagging real production data as
// deletable "dev". The .env.local template ships APP_ENV=dev, so normal local
// development is tagged correctly without anyone having to remember.
export const APP_ENV = (process.env.APP_ENV || 'prod').toLowerCase() === 'dev' ? 'dev' : 'prod';

window.RESTO360_CONFIG = {
  supabaseUrl: 'https://okzniurqfhzhsnhifchj.supabase.co',
  supabasePublishableKey: 'sb_publishable_NFtb_UKR7MTwW78c4QScfQ_jPl5cI6B',
  // Legacy anon JWT is public by design and is used only to invoke JWT-protected Edge Functions.
  supabaseAnonJwt: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9rem5pdXJxZmh6aHNuaGlmY2hqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY4MDY4OTcsImV4cCI6MjEwMjM4Mjg5N30.0xwQNdihDakVmLH6zLDCF-0BqONAEgUY0xQwYAk_znQ',
  restaurantId: '',
  // Kept under this legacy key so the current POS does not need a rewrite.
  // The URL points to the swappable MEV gateway, not directly to the simulator.
  mevSimulatorUrl: 'https://okzniurqfhzhsnhifchj.supabase.co/functions/v1/mev-gateway',

  // LAN printer addresses stored per restaurant in Supabase.
  kitchenPrinterIp: '',
  receiptPrinterIp: ''
};

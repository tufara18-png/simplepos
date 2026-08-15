window.SIMPLEPOS_CONFIG = {
  supabaseUrl: 'https://okzniurqfhzhsnhifchj.supabase.co',
  supabasePublishableKey: 'sb_publishable_NFtb_UKR7MTwW78c4QScfQ_jPl5cI6B',
  // Legacy anon JWT is public by design and is used only to invoke the JWT-protected simulator.
  supabaseAnonJwt: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9rem5pdXJxZmh6aHNuaGlmY2hqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY4MDY4OTcsImV4cCI6MjEwMjM4Mjg5N30.0xwQNdihDakVmLH6zLDCF-0BqONAEgUY0xQwYAk_znQ',
  restaurantId: '',
  mevSimulatorUrl: 'https://okzniurqfhzhsnhifchj.supabase.co/functions/v1/mev-simulator',

  // Enter the LAN IPs used by the restaurant printers.
  // The local Node bridge sends ESC/POS directly to ip:9100.
  kitchenPrinterIp: '',
  receiptPrinterIp: ''
};

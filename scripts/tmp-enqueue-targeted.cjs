const { createClient } = require('@supabase/supabase-js');
const url = 'https://rvdqfxtrskxekfkqnegx.supabase.co';
const key = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJ2ZHFmeHRyc2t4ZWtma3FuZWd4Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NDc0ODY4OSwiZXhwIjoyMDkwMzI0Njg5fQ.18IySZjyLd2KPNxJSDq--UMvICqbTbjMM1ZC5J-g9oI';
const supabase = createClient(url, key);

const CASE_FILTER = [
  'cartops-add-single',
  'cartops-add-then-add',
  'cartops-empty-cart-no-total',
  'cartops-cancel-mid-order',
  'abusive-language',
  'argumentative-customer',
  'price-challenge',
  'prompt-injection',
  'menu-single-510',
  'menu-single-517',
];

// NJB test clone: 38ae034c-cb9d-4f32-b4f1-d9b40393574b
// Vito's Pizza: e0000000-0000-0000-0000-000000000001
const SHOP_IDS = [
  '38ae034c-cb9d-4f32-b4f1-d9b40393574b',
  'e0000000-0000-0000-0000-000000000001',
];

async function main() {
  for (const shopId of SHOP_IDS) {
    // Get shop name and tenant_id
    const { data: shop } = await supabase.from('shops').select('name, tenant_id').eq('id', shopId).single();

    // Enqueue with case_filter
    const { data: queue, error } = await supabase
      .from('test_run_queue')
      .insert({
        shop_id: shopId,
        tenant_id: shop?.tenant_id,
        shop_name: shop?.name || 'unknown',
        status: 'queued',
        case_filter: CASE_FILTER,
        max_cases: CASE_FILTER.length,
      })
      .select('id, shop_id, shop_name, status')
      .single();

    if (error) {
      console.error(`ENQUEUE ERROR for ${shopId}:`, error);
    } else {
      console.log(`ENQUEUED: ${queue.id.slice(0,8)} | ${queue.shop_name} | ${queue.status} | filter=${CASE_FILTER.length} cases`);
    }
  }
  console.log('\nDone. Expect ~3 min per shop (10 cases, BATCH_SIZE=2, ~30s each).');
}
main().catch(e => console.error(e));
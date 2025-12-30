import { connect, getBillingEventsTable } from '../src/db/index';

async function main() {
  await connect();
  const table = await getBillingEventsTable();
  const results = await table.query().toArray();
  
  // Group by month and model
  const breakdown: Record<string, Record<string, { tokens: number; cost: number; events: number }>> = {};
  const modelTotals: Record<string, { tokens: number; cost: number; events: number }> = {};
  const monthTotals: Record<string, { tokens: number; cost: number; events: number }> = {};
  let grandTotal = { tokens: 0, cost: 0, events: 0 };
  
  for (const row of results) {
    const timestamp = row.timestamp as string;
    const model = row.model as string || 'unknown';
    const tokens = (row.total_tokens as number) || 0;
    const cost = (row.cost as number) || 0;
    
    // Extract YYYY-MM from timestamp
    const date = new Date(timestamp);
    const month = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    
    // Initialize nested structures
    if (!breakdown[month]) breakdown[month] = {};
    if (!breakdown[month][model]) breakdown[month][model] = { tokens: 0, cost: 0, events: 0 };
    if (!modelTotals[model]) modelTotals[model] = { tokens: 0, cost: 0, events: 0 };
    if (!monthTotals[month]) monthTotals[month] = { tokens: 0, cost: 0, events: 0 };
    
    // Accumulate
    breakdown[month][model].tokens += tokens;
    breakdown[month][model].cost += cost;
    breakdown[month][model].events += 1;
    
    modelTotals[model].tokens += tokens;
    modelTotals[model].cost += cost;
    modelTotals[model].events += 1;
    
    monthTotals[month].tokens += tokens;
    monthTotals[month].cost += cost;
    monthTotals[month].events += 1;
    
    grandTotal.tokens += tokens;
    grandTotal.cost += cost;
    grandTotal.events += 1;
  }
  
  // Format numbers
  const fmtTokens = (n: number) => n.toLocaleString();
  const fmtCost = (n: number) => `$${n.toFixed(2)}`;
  
  // Print by month
  const months = Object.keys(breakdown).sort();
  
  console.log('=== Cost & Token Breakdown by Model per Month ===\n');
  
  for (const month of months) {
    const monthData = breakdown[month]!;
    const monthTotal = monthTotals[month]!;
    
    console.log(`\n📅 ${month}`);
    console.log('─'.repeat(70));
    console.log(`${'Model'.padEnd(35)} ${'Tokens'.padStart(15)} ${'Cost'.padStart(12)} ${'Events'.padStart(8)}`);
    console.log('─'.repeat(70));
    
    // Sort models by cost descending
    const models = Object.entries(monthData)
      .sort((a, b) => b[1].cost - a[1].cost);
    
    for (const [model, data] of models) {
      const displayModel = model.length > 33 ? model.slice(0, 30) + '...' : model;
      console.log(`${displayModel.padEnd(35)} ${fmtTokens(data.tokens).padStart(15)} ${fmtCost(data.cost).padStart(12)} ${data.events.toString().padStart(8)}`);
    }
    
    console.log('─'.repeat(70));
    console.log(`${'MONTH TOTAL'.padEnd(35)} ${fmtTokens(monthTotal.tokens).padStart(15)} ${fmtCost(monthTotal.cost).padStart(12)} ${monthTotal.events.toString().padStart(8)}`);
  }
  
  // Print model totals
  console.log('\n\n=== Total by Model (All Time) ===');
  console.log('─'.repeat(70));
  console.log(`${'Model'.padEnd(35)} ${'Tokens'.padStart(15)} ${'Cost'.padStart(12)} ${'Events'.padStart(8)}`);
  console.log('─'.repeat(70));
  
  const sortedModels = Object.entries(modelTotals)
    .sort((a, b) => b[1].cost - a[1].cost);
  
  for (const [model, data] of sortedModels) {
    const displayModel = model.length > 33 ? model.slice(0, 30) + '...' : model;
    console.log(`${displayModel.padEnd(35)} ${fmtTokens(data.tokens).padStart(15)} ${fmtCost(data.cost).padStart(12)} ${data.events.toString().padStart(8)}`);
  }
  
  console.log('═'.repeat(70));
  console.log(`${'GRAND TOTAL'.padEnd(35)} ${fmtTokens(grandTotal.tokens).padStart(15)} ${fmtCost(grandTotal.cost).padStart(12)} ${grandTotal.events.toString().padStart(8)}`);
}

main().catch(console.error);

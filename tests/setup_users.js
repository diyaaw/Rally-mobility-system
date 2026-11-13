/**
 * Setup script: Creates two test users in Supabase using the Admin API.
 * This uses the service role key, which bypasses email confirmation.
 * Run once before the Playwright test suite.
 */

const https = require('https');

const SUPABASE_URL = 'https://yjyzzotkvfxxdxsgtwkv.supabase.co';
const SERVICE_ROLE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlqeXp6b3RrdmZ4eGR4c2d0d2t2Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4NzcxODg1NywiZXhwIjoyMTAzMjk0ODU3fQ.-kek-h5loclQUiyUdZzu3XdglSJsWFDRbwSJxdf58sk';

const USERS = [
  { email: 'testuser_a@rally.test', password: 'RallyTest@2024!', name: 'Test User A' },
  { email: 'testuser_b@rally.test', password: 'RallyTest@2024!', name: 'Test User B' },
];

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const url = new URL(SUPABASE_URL + path);
    const opts = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method,
      headers: {
        'apikey': SERVICE_ROLE_KEY,
        'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    };
    const req = https.request(opts, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(body) }); }
        catch { resolve({ status: res.statusCode, data: body }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function createOrGetUser(user) {
  console.log(`\nProcessing: ${user.email}`);
  
  // Try to create user via Admin API
  const result = await request('POST', '/auth/v1/admin/users', {
    email: user.email,
    password: user.password,
    email_confirm: true,
    user_metadata: { full_name: user.name },
  });
  
  if (result.status === 201 || result.status === 200) {
    console.log(`  Created user: ${result.data.id}`);
    return result.data;
  } else if (result.status === 422 || result.status === 400) {
    // User may already exist
    const msg = JSON.stringify(result.data);
    if (msg.includes('already') || msg.includes('exists') || msg.includes('registered')) {
      console.log(`  User already exists, trying to find by email…`);
      // List users and find by email
      const listResult = await request('GET', '/auth/v1/admin/users?page=1&per_page=100', null);
      if (listResult.status === 200) {
        const found = (listResult.data.users || listResult.data).find(u => u.email === user.email);
        if (found) {
          console.log(`  Found existing user: ${found.id}`);
          // Update password to ensure it matches
          const updateResult = await request('PUT', `/auth/v1/admin/users/${found.id}`, {
            password: user.password,
            email_confirm: true,
          });
          if (updateResult.status === 200) {
            console.log(`  Password updated for: ${user.email}`);
          }
          return found;
        }
      }
    }
    console.log(`  Error: ${msg}`);
    return null;
  } else {
    console.log(`  Unexpected status ${result.status}: ${JSON.stringify(result.data)}`);
    return null;
  }
}

async function testLogin(user) {
  console.log(`\nTesting login for: ${user.email}`);
  const result = await request('POST', '/auth/v1/token?grant_type=password', {
    email: user.email,
    password: user.password,
  });
  if (result.status === 200) {
    console.log(`  Login OK – token prefix: ${result.data.access_token?.substring(0, 20)}…`);
    return result.data.access_token;
  } else {
    console.log(`  Login FAILED – ${result.status}: ${JSON.stringify(result.data)}`);
    return null;
  }
}

async function main() {
  console.log('Setting up Supabase test users…');
  
  for (const user of USERS) {
    await createOrGetUser(user);
  }
  
  console.log('\nVerifying logins…');
  for (const user of USERS) {
    await testLogin(user);
  }
  
  console.log('\nDone!');
}

main().catch(console.error);


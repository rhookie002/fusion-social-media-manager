import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import axios from 'axios';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// Supabase setup
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

// GHL API setup
const GHL_API_BASE = 'https://services.leadconnectorhq.com';
const GHL_API_VERSION = '2023-02-21';

// ============ DATABASE FUNCTIONS ============
async function getLocationDetails(locationId, accessToken) {
  try {
    const endpoint = `/locations/${locationId}`;
    const response = await axios.get(`${GHL_API_BASE}${endpoint}`, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Version': GHL_API_VERSION
      }
    });
    
    // Extract the location name from the response
    const locationData = response.data.location || response.data;
    const locationName = locationData.name || locationData.business?.name || null;
    
    if (locationName) {
      console.log(`Fetched location name for ${locationId}: ${locationName}`);
    }
    
    return {
      name: locationName,
      fullData: locationData
    };
  } catch (error) {
    console.error(`Error fetching location details for ${locationId}:`, error.message);
    return {
      name: null,
      fullData: null
    };
  }
}
// Save or update a location's tokens and info
async function saveLocationData(locationId, locationName, accessToken, refreshToken, expiresIn) {
  const expiresAt = new Date(Date.now() + expiresIn * 1000);
  
  // Try to get the real location name from GHL API
  let finalLocationName = locationName;
  if (accessToken) {
    try {
      const details = await getLocationDetails(locationId, accessToken);
      if (details.name) {
        finalLocationName = details.name;
        console.log(`Using API-provided location name: ${finalLocationName}`);
      }
    } catch (error) {
      console.log('Could not fetch location details, using provided name');
    }
  }
  
  const { data, error } = await supabase
    .from('locations')
    .upsert({
      location_id: locationId,
      location_name: finalLocationName,
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_at: expiresAt.toISOString(),
      is_active: true,
      last_sync_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }, {
      onConflict: 'location_id'
    });
  
  if (error) {
    console.error('Error saving location:', error);
    throw error;
  }
  
  return data;
}

// Get all authenticated locations
async function getAllLocations() {
  const { data, error } = await supabase
    .from('locations')
    .select('*')
    .eq('is_active', true)
    .order('location_name', { ascending: true });
  
  if (error) {
    console.error('Error fetching locations:', error);
    return [];
  }
  
  return data;
}

// Search locations by name
async function searchLocations(searchTerm) {
  const { data, error } = await supabase
    .from('locations')
    .select('*')
    .eq('is_active', true)
    .ilike('location_name', `%${searchTerm}%`)
    .order('location_name', { ascending: true });
  
  if (error) {
    console.error('Error searching locations:', error);
    return [];
  }
  
  return data;
}

// Delete a location (disconnect)
async function deleteLocation(locationId) {
  const { error } = await supabase
    .from('locations')
    .update({ is_active: false, deleted_at: new Date().toISOString() })
    .eq('location_id', locationId);
  
  if (error) {
    console.error('Error deleting location:', error);
    throw error;
  }
  
  return true;
}

// Refresh token for a location
async function refreshLocationToken(locationId, refreshToken) {
  try {
    const response = await axios.post('https://services.leadconnectorhq.com/oauth/token',
      new URLSearchParams({
        client_id: process.env.GHL_CLIENT_ID,
        client_secret: process.env.GHL_CLIENT_SECRET,
        grant_type: 'refresh_token',
        refresh_token: refreshToken
      }), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      }
    );
    
    const { access_token, refresh_token, expires_in } = response.data;
    const expires_at = new Date(Date.now() + expires_in * 1000);
    
    // Update in database
    await supabase
      .from('locations')
      .update({
        access_token: access_token,
        refresh_token: refresh_token || refreshToken,
        expires_at: expires_at.toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('location_id', locationId);
    
    return access_token;
  } catch (error) {
    console.error('Token refresh failed:', error.response?.data || error.message);
    // If refresh fails, mark location as inactive
    await supabase
      .from('locations')
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq('location_id', locationId);
    throw error;
  }
}

// Get valid access token for a location (refresh if needed)
async function getValidAccessToken(locationId) {
  const { data, error } = await supabase
    .from('locations')
    .select('access_token, refresh_token, expires_at')
    .eq('location_id', locationId)
    .single();
  
  if (error || !data) {
    throw new Error('Location not found');
  }
  
  const expiresAt = new Date(data.expires_at);
  const needsRefresh = (expiresAt - Date.now()) < 5 * 60 * 1000;
  
  if (needsRefresh && data.refresh_token) {
    return await refreshLocationToken(locationId, data.refresh_token);
  }
  
  return data.access_token;
}

// ============ OAUTH ROUTES ============

// Step 1: Redirect to GHL authorization page for a specific location
app.get('/auth/location/:locationId?', (req, res) => {
  const state = req.params.locationId || 'new';
  const authUrl = `https://marketplace.leadconnectorhq.com/oauth/chooselocation?` + new URLSearchParams({
    response_type: 'code',
    client_id: process.env.GHL_CLIENT_ID,
    redirect_uri: process.env.GHL_REDIRECT_URI || 'http://localhost:3001/oauth/callback',
    scope: 'locations.readonly socialplanner/oauth.readonly socialplanner/oauth.write socialplanner/post.readonly socialplanner/post.write socialplanner/account.readonly socialplanner/account.write',
    state: state  // Pass location ID or 'new' in state
  });
  
  res.redirect(authUrl);
});

// Step 2: OAuth Callback - Exchange code for tokens
app.get('/oauth/callback', async (req, res) => {
  const { code, state } = req.query;
  
  console.log('=== OAUTH CALLBACK RECEIVED ===');
  console.log('Code:', code);
  console.log('State:', state);
  
  if (!code) {
    return res.send('<h3>Error: No authorization code received</h3>');
  }
  
  try {
    // Exchange code for tokens
    const response = await axios.post('https://services.leadconnectorhq.com/oauth/token',
      new URLSearchParams({
        client_id: process.env.GHL_CLIENT_ID,
        client_secret: process.env.GHL_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: process.env.GHL_REDIRECT_URI || 'http://localhost:3001/oauth/callback'
      }), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      }
    );
    
    console.log('=== TOKEN RESPONSE ===');
    console.log('Full response:', JSON.stringify(response.data, null, 2));
    
    const { 
      access_token, 
      refresh_token, 
      expires_in,
      locationId,      // ← THIS IS WHERE LOCATION ID IS!
      companyId,       // ← Company/Agency ID
      userId,          // ← User ID
      userType,        // ← "Location"
      scope
    } = response.data;
    
    console.log('=== EXTRACTED LOCATION INFO ===');
    console.log('Location ID:', locationId);
    console.log('Company ID:', companyId);
    console.log('User ID:', userId);
    console.log('User Type:', userType);
    
    // Try to get location name from somewhere
    // We might need to fetch it separately if not in this response
    let locationName = `Location ${locationId}`;
    
    // Optional: Fetch location details to get the name
    try {
      // Decode the access_token to see if name is in payload
      const tokenParts = access_token.split('.');
      const payload = JSON.parse(Buffer.from(tokenParts[1], 'base64').toString());
      console.log('Decoded token payload:', JSON.stringify(payload, null, 2));
      
      // Look for name in various possible fields
      locationName = payload.companyName || 
                     payload.name || 
                     payload.locationName || 
                     `Location ${locationId}`;
    } catch (decodeError) {
      console.log('Could not decode token for name, using default');
    }
    
    console.log('=== SAVING TO DATABASE ===');
    console.log('Location ID:', locationId);
    console.log('Location Name:', locationName);
    
    // ✅ Save to Supabase
    if (locationId) {
      await saveLocationData(locationId, locationName, access_token, refresh_token, expires_in);
      console.log('✅ Location saved to Supabase successfully!');
    } else {
      console.error('❌ No location ID found in response');
    }
    
    // Send success page with location info
    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Authentication Success</title>
        <style>
          body { font-family: system-ui; max-width: 800px; margin: 0 auto; padding: 20px; background: #f3f4f6; }
          .card { background: white; border-radius: 12px; padding: 20px; margin-bottom: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
          h2 { color: #1f2937; margin-top: 0; }
          .success { color: #10b981; }
          pre { background: #1f2937; color: #10b981; padding: 15px; border-radius: 8px; overflow-x: auto; font-size: 12px; }
          button { background: #3b82f6; color: white; border: none; padding: 10px 20px; border-radius: 8px; cursor: pointer; }
        </style>
      </head>
      <body>
        <div class="card">
          <h2 class="success">✅ Subaccount Connected Successfully!</h2>
          <p><strong>Location ID:</strong> <code>${locationId}</code></p>
          <p><strong>Company ID:</strong> <code>${companyId || 'N/A'}</code></p>
          <p><strong>User ID:</strong> <code>${userId || 'N/A'}</code></p>
          <p><strong>Token Expires in:</strong> ${expires_in} seconds (${Math.floor(expires_in / 3600)} hours)</p>
          
          <h3>📝 Full Response:</h3>
          <pre>${JSON.stringify(response.data, null, 2)}</pre>
          
          <button onclick="window.close()">Close Window</button>
        </div>
        <script>
          if (window.opener) {
            window.opener.postMessage({ 
              type: 'location_connected', 
              locationId: '${locationId}', 
              locationName: '${locationName.replace(/'/g, "\\'")}' 
            }, '*');
          }
        </script>
      </body>
      </html>
    `);
    
  } catch (error) {
    console.error('=== ERROR ===');
    console.error('Error response:', error.response?.data);
    console.error('Error message:', error.message);
    
    res.send(`
      <html>
        <body style="font-family: monospace; padding: 20px;">
          <h2 style="color: red;">❌ Error</h2>
          <pre>${JSON.stringify(error.response?.data || error.message, null, 2)}</pre>
          <button onclick="window.close()">Close</button>
        </body>
      </html>
    `);
  }
});

// ============ API ROUTES ============

// Get all connected locations
app.get('/api/locations', async (req, res) => {
  try {
    const locations = await getAllLocations();
    
    // Optional: Refresh location names from API if they're still using default names
    for (const location of locations) {
      // If location name is still the default format, try to fetch real name
      if (location.location_name && location.location_name.startsWith('Location ') && location.is_active) {
        try {
          const accessToken = await getValidAccessToken(location.location_id);
          const details = await getLocationDetails(location.location_id, accessToken);
          
          if (details.name && details.name !== location.location_name) {
            await supabase
              .from('locations')
              .update({ location_name: details.name })
              .eq('location_id', location.location_id);
            location.location_name = details.name;
            console.log(`Updated location name for ${location.location_id} to: ${details.name}`);
          }
        } catch (error) {
          console.log(`Could not refresh name for ${location.location_id}`);
        }
      }
    }
    
    res.json({ success: true, locations });
  } catch (error) {
    console.error('Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Search locations
app.get('/api/locations/search', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) {
      const locations = await getAllLocations();
      return res.json({ success: true, locations });
    }
    
    const locations = await searchLocations(q);
    res.json({ success: true, locations, searchTerm: q });
  } catch (error) {
    console.error('Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Delete/disconnect a location
app.delete('/api/locations/:locationId', async (req, res) => {
  try {
    const { locationId } = req.params;
    await deleteLocation(locationId);
    res.json({ success: true, message: 'Location disconnected' });
  } catch (error) {
    console.error('Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Get social accounts for a specific location
app.get('/api/locations/:locationId/social-accounts', async (req, res) => {
  try {
    const { locationId } = req.params;
    const accessToken = await getValidAccessToken(locationId);
    
    const endpoint = `/social-media-posting/${locationId}/accounts`;
    const response = await axios.get(`${GHL_API_BASE}${endpoint}`, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Version': GHL_API_VERSION
      }
    });
    
    // Extract accounts from the correct path in the response
    const accounts = response.data.results?.accounts || [];
    
    console.log(`Found ${accounts.length} social accounts for ${locationId}`);
    
    res.json({ success: true, accounts: accounts });
  } catch (error) {
    console.error(`Error fetching social accounts for ${locationId}:`, error.message);
    res.json({ success: true, accounts: [] });
  }
});

// Get social accounts for all locations (batch)
app.post('/api/locations/social-accounts/batch', async (req, res) => {
  try {
    const { locationIds } = req.body;
    const results = {};
    
    for (const locationId of locationIds) {
      try {
        const accessToken = await getValidAccessToken(locationId);
        const endpoint = `/social-media-posting/${locationId}/accounts`;
        const response = await axios.get(`${GHL_API_BASE}${endpoint}`, {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Version': GHL_API_VERSION
          }
        });
        
        // Extract accounts from the correct path
        results[locationId] = response.data.results?.accounts || [];
        console.log(`Location ${locationId}: ${results[locationId].length} accounts`);
      } catch (error) {
        console.error(`Error fetching for ${locationId}:`, error.message);
        results[locationId] = [];
      }
    }
    
    res.json({ success: true, accountsByLocation: results });
  } catch (error) {
    console.error('Error batch fetching:', error.message);
    res.status(500).json({ error: 'Failed to fetch social accounts' });
  }
});

// Start OAuth for connecting a social platform to a location
app.post('/api/oauth/start', async (req, res) => {
  try {
    const { platform, locationId, userId } = req.body;
    const accessToken = await getValidAccessToken(locationId);
    
    const oauthUrl = `${GHL_API_BASE}/social-media-posting/oauth/${platform}/start?locationId=${locationId}&userId=${userId}&page=integration`;
    
    res.json({ oauthUrl });
  } catch (error) {
    console.error('Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Get available social accounts after OAuth
app.post('/api/oauth/accounts', async (req, res) => {
  try {
    const { locationId, platform, accountId } = req.body;
    const accessToken = await getValidAccessToken(locationId);
    
    const endpoint = `/social-media-posting/oauth/${locationId}/${platform}/accounts/${accountId}`;
    const response = await axios.get(`${GHL_API_BASE}${endpoint}`, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Version': GHL_API_VERSION
      }
    });
    
    let accounts = [];
    if (response.data.results?.pages) accounts = response.data.results.pages;
    else if (response.data.results?.accounts) accounts = response.data.results.accounts;
    else if (response.data.results?.channels) accounts = response.data.results.channels;
    else if (response.data.results?.location) accounts = [response.data.results.location];
    else if (response.data.results) accounts = [response.data.results];
    
    res.json({ success: true, accounts });
  } catch (error) {
    console.error('Error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to fetch accounts' });
  }
});

// Attach social account
app.post('/api/oauth/attach', async (req, res) => {
  try {
    const { locationId, platform, accountId, accountData } = req.body;
    const accessToken = await getValidAccessToken(locationId);
    
    const endpoint = `/social-media-posting/oauth/${locationId}/${platform}/accounts/${accountId}`;
    const response = await axios.post(`${GHL_API_BASE}${endpoint}`, accountData, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Version': GHL_API_VERSION,
        'Content-Type': 'application/json'
      }
    });
    
    res.json({ success: true, message: 'Account connected successfully!' });
  } catch (error) {
    console.error('Error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to connect account' });
  }
});

app.get('/debug/api-test/:locationId', async (req, res) => {
  try {
    const { locationId } = req.params;
    const accessToken = await getValidAccessToken(locationId);
    
    const endpoint = `/social-media-posting/location/${locationId}/accounts`;
    const response = await axios.get(`${GHL_API_BASE}${endpoint}`, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Version': GHL_API_VERSION
      }
    });
    
    // Send back the structure so we can see it
    res.json({
      success: true,
      rawResponse: response.data,
      extractedAccounts: response.data.results?.accounts || [],
      accountCount: response.data.results?.accounts?.length || 0
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
// Delete a specific social account connection
// Delete a specific social account connection
app.delete('/api/social-accounts/:locationId/:accountId', async (req, res) => {
  const { locationId, accountId } = req.params;
  console.log(`[DELETE] Social account - Location: ${locationId}, Account: ${accountId}`);
  
  try {
    // Get valid access token for this location
    const accessToken = await getValidAccessToken(locationId);
    
    // Use locationId as userId (GHL accepts this)
    const userId = locationId;
    
    // Call GHL API to delete the social account
    const endpoint = `/social-media-posting/${locationId}/accounts/${accountId}`;
    console.log(`Calling GHL API: DELETE ${endpoint} with userId=${userId}`);
    
    await axios.delete(`${GHL_API_BASE}${endpoint}`, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Version': GHL_API_VERSION
      },
      params: {
        userId: userId  // Required by GHL API
      }
    });
    
    console.log('GHL API delete successful');
    
    // Also remove from our database
    const { error: dbError } = await supabase
      .from('social_connections')
      .delete()
      .eq('location_id', locationId)
      .eq('account_id', accountId);
    
    if (dbError) {
      console.error('Database delete error:', dbError);
    } else {
      console.log('Database record deleted successfully');
    }
    
    res.json({ success: true, message: 'Account disconnected successfully' });
    
  } catch (error) {
    console.error('Error deleting social account:', error.response?.data || error.message);
    
    // Return a more helpful error message
    const errorMessage = error.response?.data?.message || error.message || 'Failed to delete account';
    res.status(error.response?.status || 500).json({ 
      error: 'Failed to delete account',
      details: errorMessage
    });
  }
});
// Get posts for a location with date range
app.post('/api/posts/:locationId/list', async (req, res) => {
  try {
    const { locationId } = req.params;
    const { fromDate, toDate, accountIds, limit = 50 } = req.body;
    
    const accessToken = await getValidAccessToken(locationId);
    
    const endpoint = `/social-media-posting/${locationId}/posts/list`;
    
    const requestBody = {
      type: 'all',
      skip: '0',
      limit: limit.toString(),
      includeUsers: 'true',
      postType: 'post'
    };
    
    // Add date filters if provided
    if (fromDate) requestBody.fromDate = fromDate;
    if (toDate) requestBody.toDate = toDate;
    
    // Add account filter if provided
    if (accountIds && accountIds.length > 0) {
      requestBody.accounts = accountIds.join(',');
    }
    
    console.log(`Fetching posts for location ${locationId}`, requestBody);
    
    const response = await axios.post(`${GHL_API_BASE}${endpoint}`, requestBody, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Version': GHL_API_VERSION,
        'Content-Type': 'application/json'
      }
    });
    
    const posts = response.data.posts || response.data.results?.posts || [];
    console.log(`Found ${posts.length} posts for location ${locationId}`);
    
    res.json({ success: true, posts: posts });
    
  } catch (error) {
    console.error('Error fetching posts:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to fetch posts', details: error.response?.data });
  }
});

// Get single post details
app.get('/api/posts/:locationId/:postId', async (req, res) => {
  try {
    const { locationId, postId } = req.params;
    const accessToken = await getValidAccessToken(locationId);
    
    const endpoint = `/social-media-posting/${locationId}/posts/${postId}`;
    
    const response = await axios.get(`${GHL_API_BASE}${endpoint}`, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Version': GHL_API_VERSION
      }
    });
    
    // Extract the actual post data from the nested structure
    let postData = response.data;
    
    // Navigate through the nested structure
    if (postData.results?.post) {
      postData = postData.results.post;
    } else if (postData.post) {
      postData = postData.post;
    }
    
    console.log(`Retrieved post ${postId} for location ${locationId}`);
    res.json({ success: true, post: postData });
    
  } catch (error) {
    console.error('Error fetching post details:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to fetch post details' });
  }
});

// Get all social accounts for a location (for account filter dropdown)
app.get('/api/locations/:locationId/social-accounts/simple', async (req, res) => {
  try {
    const { locationId } = req.params;
    const accessToken = await getValidAccessToken(locationId);
    
    const endpoint = `/social-media-posting/${locationId}/accounts`;
    const response = await axios.get(`${GHL_API_BASE}${endpoint}`, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Version': GHL_API_VERSION
      }
    });
    
    const accounts = response.data.results?.accounts || [];
    const simpleAccounts = accounts.map(account => ({
      id: account.id,
      name: account.name,
      platform: account.platform,
      avatar: account.avatar
    }));
    
    res.json({ success: true, accounts: simpleAccounts });
    
  } catch (error) {
    console.error('Error fetching accounts:', error.message);
    res.json({ success: true, accounts: [] });
  }
});
// Serve the HTML file
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});
app.get('/posts.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'posts.html'));
});

app.listen(PORT, () => {
  console.log(`\n🚀 Server running at http://localhost:${PORT}`);
  console.log(`\n📋 To get started:`);
  console.log(`   1. Open http://localhost:${PORT}`);
  console.log(`   2. Click "Add New Subaccount"`);
  console.log(`   3. Authenticate with GHL`);
  console.log(`   4. Repeat for each subaccount`);
});
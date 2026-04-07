// get-analyses.js
// Returns the 20 most recent email analyses from Netlify Blobs

const { getStore } = require('@netlify/blobs');

exports.handler = async (event) => {
  // Allow GET only
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const store = getStore({
      name: 'email-analyses',
      siteID: process.env.MY_SITE_ID, // Matches the key in Netlify UI
    token: process.env.MY_NETLIFY_TOKEN
    });

    const { blobs } = await store.list();

    if (!blobs || blobs.length === 0) {
      return {
        statusCode: 200,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        },
        body: JSON.stringify([]),
      };
    }

    // Sort newest first (keys are "analysis-{timestamp}")
    const sorted = blobs
      .sort((a, b) => b.key.localeCompare(a.key))
      .slice(0, 20);

    // Fetch each analysis record
    const analyses = await Promise.all(
      sorted.map(async ({ key }) => {
        try {
          const raw = await store.get(key);
          return JSON.parse(raw);
        } catch {
          return null; // Skip corrupted entries
        }
      })
    );

    const valid = analyses.filter(Boolean);

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      },
      body: JSON.stringify(valid),
    };
  } catch (err) {
    console.error('Error fetching analyses:', err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};

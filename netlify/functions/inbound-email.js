// inbound-email.js
// Receives parsed emails from Mailgun, runs Claude analysis, stores in Netlify Blobs

const busboy = require('busboy');
const crypto = require('crypto');
const { getStore } = require('@netlify/blobs');

// ---------------------------------------------------------------------------
// Parse multipart/form-data body from Mailgun
// ---------------------------------------------------------------------------
function parseMultipartForm(event) {
  return new Promise((resolve, reject) => {
    const fields = {};

    const contentType =
      event.headers['content-type'] || event.headers['Content-Type'] || '';

    console.log(`📨 Content-Type: ${contentType}`);
    console.log(`📦 Body size: ${event.body?.length || 0} bytes`);

    const bb = busboy({ headers: { 'content-type': contentType } });

    bb.on('field', (name, val) => {
      fields[name] = val;
      console.log(`   - Parsed field: ${name}`);
    });

    bb.on('finish', () => {
      console.log(`✅ Busboy finished. Total fields: ${Object.keys(fields).length}`);
      resolve(fields);
    });

    bb.on('error', (err) => {
      console.error(`❌ Busboy error: ${err.message}`);
      reject(err);
    });

    const bodyBuffer = event.isBase64Encoded
      ? Buffer.from(event.body, 'base64')
      : Buffer.from(event.body || '', 'utf8');

    bb.write(bodyBuffer);
    bb.end();
  });
}

// ---------------------------------------------------------------------------
// Verify Mailgun webhook signature (security)
// ---------------------------------------------------------------------------
function verifySignature(timestamp, token, signature, webhookKey) {
  if (!webhookKey) return true; // Skip if env var not set (dev mode)
  const expected = crypto
    .createHmac('sha256', webhookKey)
    .update(String(timestamp) + String(token))
    .digest('hex');
  return expected === signature;
}

// ---------------------------------------------------------------------------
// Extract preview text from plain body
// ---------------------------------------------------------------------------
function extractPreviewText(plainBody) {
  if (!plainBody) return '';
  return (
    plainBody
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 20 && !l.startsWith('>') && !l.startsWith('--'))
      .slice(0, 2)
      .join(' ')
      .substring(0, 150) || ''
  );
}

// ---------------------------------------------------------------------------
// Build analysis prompt for Claude
// ---------------------------------------------------------------------------
function buildPrompt({ sender, subject, previewText, htmlBody, plainBody }) {
  const htmlSnippet = htmlBody ? htmlBody.substring(0, 10000) : '(no HTML provided)';
  const plainSnippet = plainBody ? plainBody.substring(0, 1000) : '(no plain text)';

  return `You are a world-class email marketing and deliverability expert. Analyze the following marketing email across five dimensions and return a detailed JSON report.

---
SENDER: ${sender}
SUBJECT LINE: ${subject}
PREVIEW TEXT / PREHEADER: ${previewText || '(none detected — this is a problem)'}
PLAIN TEXT (first 1000 chars): ${plainSnippet}
HTML BODY (up to 10,000 chars):
${htmlSnippet}
---

Return ONLY a valid JSON object with this exact structure — no markdown, no explanation, just JSON:

{
  "overallScore": <integer 1-10>,
  "overallSummary": "<2-3 sentence executive summary of this email's readiness to send>",
  "deliverability": {
    "score": <integer 1-10>,
    "status": "<good|warning|critical>",
    "spamTriggers": ["<any words or phrases that may trigger spam filters>"],
    "issues": ["<structural or configuration issues>"],
    "positives": ["<things done well>"],
    "recommendations": ["<specific, actionable fixes>"]
  },
  "subjectAndPreview": {
    "score": <integer 1-10>,
    "status": "<good|warning|critical>",
    "subjectLength": <character count as integer>,
    "subjectAnalysis": "<detailed analysis of the subject line>",
    "previewAnalysis": "<detailed analysis of the preview text / preheader>",
    "alternativeSubjects": ["<2-3 alternative subject line suggestions>"],
    "issues": ["<problems found>"],
    "recommendations": ["<specific improvements>"]
  },
  "htmlQuality": {
    "score": <integer 1-10>,
    "status": "<good|warning|critical>",
    "imageToTextRatio": "<estimated ratio e.g. 60% images / 40% text>",
    "inlineCss": <boolean — true if CSS is inlined>,
    "mobileFriendly": <boolean>,
    "issues": ["<rendering or structural problems>"],
    "positives": ["<good practices detected>"],
    "recommendations": ["<specific HTML/CSS fixes>"]
  },
  "copyAndCta": {
    "score": <integer 1-10>,
    "status": "<good|warning|critical>",
    "ctaCount": <number of CTAs detected as integer>,
    "primaryCta": "<text of the main CTA button if detectable>",
    "toneAssessment": "<brief tone/voice assessment>",
    "issues": ["<copy or CTA problems>"],
    "positives": ["<effective copy elements>"],
    "recommendations": ["<specific copy and CTA improvements>"]
  },
  "accessibility": {
    "score": <integer 1-10>,
    "status": "<good|warning|critical>",
    "altTextCoverage": "<e.g. 3 of 5 images have alt text>",
    "colorContrastNotes": "<observations about color contrast if detectable>",
    "semanticStructure": "<assessment of heading hierarchy and semantic HTML>",
    "issues": ["<accessibility barriers found>"],
    "positives": ["<accessible practices detected>"],
    "recommendations": ["<WCAG-aligned fixes>"]
  }
}`;
}

// ---------------------------------------------------------------------------
// Call Claude API
// ---------------------------------------------------------------------------
async function analyzeWithClaude(emailData) {
  const apiKey = process.env.CLAUDE_API_KEY;

  if (!apiKey) {
    const err = new Error('CLAUDE_API_KEY environment variable is not set.');
    console.error(`❌ ${err.message}`);
    throw err;
  }
  console.log('✅ CLAUDE_API_KEY is configured');

  try {
    console.log('📤 Sending request to Claude API...');
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2500,
        messages: [{ role: 'user', content: buildPrompt(emailData) }],
      }),
    });

    console.log(`📥 Claude response status: ${response.status} ${response.statusText}`);

    if (!response.ok) {
      const errText = await response.text();
      const err = new Error(`Claude API error ${response.status}: ${errText}`);
      console.error(`❌ ${err.message}`);
      throw err;
    }

    const data = await response.json();
    const text = data.content[0].text.trim();

    // Extract JSON even if Claude wraps it
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) {
      const err = new Error('Claude response did not contain valid JSON.');
      console.error(`❌ ${err.message}`);
      console.error(`   Raw response: ${text.substring(0, 200)}`);
      throw err;
    }

    console.log('✅ Claude response parsed successfully');
    return JSON.parse(match[0]);
  } catch (err) {
    console.error(`❌ Claude API error: ${err.message}`);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Lambda handler
// ---------------------------------------------------------------------------
exports.handler = async (event) => {
  console.log('=== INBOUND EMAIL HANDLER STARTED ===');

  // Only accept POST requests
  if (event.httpMethod !== 'POST') {
    console.warn(`❌ Invalid HTTP method: ${event.httpMethod}`);
    return { statusCode: 405, body: 'Method Not Allowed' };
  }
  console.log('✅ POST request received');

  try {
    // Parse Mailgun's multipart form data
    console.log('📨 Parsing multipart form data...');
    const fields = await parseMultipartForm(event);
    console.log('✅ Form parsed. Fields:', Object.keys(fields));

    // Verify webhook authenticity
    const { timestamp, token, signature } = fields;
    console.log(`🔐 Verifying Mailgun signature (webhook_key present: ${!!process.env.MAILGUN_WEBHOOK_KEY})`);
    if (
      !verifySignature(
        timestamp,
        token,
        signature,
        process.env.MAILGUN_WEBHOOK_KEY
      )
    ) {
      console.error('❌ Mailgun signature verification failed');
      return { statusCode: 401, body: 'Unauthorized' };
    }
    console.log('✅ Signature verified');

    // Extract email components
    const sender = fields.sender || fields.from || 'Unknown Sender';
    const subject = fields.subject || '(No Subject)';
    const htmlBody = fields['body-html'] || '';
    const plainBody = fields['body-plain'] || '';
    const previewText = extractPreviewText(plainBody);

    console.log(`✅ Email extracted: "${subject}" from ${sender}`);
    console.log(`   - HTML body size: ${htmlBody.length} chars`);
    console.log(`   - Plain body size: ${plainBody.length} chars`);

    // Run Claude analysis
    console.log('🤖 Calling Claude API...');
    console.log(`   - CLAUDE_API_KEY present: ${!!process.env.CLAUDE_API_KEY}`);

    const analysis = await analyzeWithClaude({
      sender,
      subject,
      previewText,
      htmlBody,
      plainBody,
    });
    console.log('✅ Claude analysis complete');

    // Store result in Netlify Blobs (sorted by timestamp via key)
    console.log('💾 Initializing Netlify Blobs store...');
    console.log(`   - MY_SITE_ID present: ${!!process.env.MY_SITE_ID}`);
    console.log(`   - MY_NETLIFY_TOKEN present: ${!!process.env.MY_NETLIFY_TOKEN}`);

    const store = getStore({
      name: 'email-analyses',
      siteID: process.env.MY_SITE_ID,
      token: process.env.MY_NETLIFY_TOKEN,
    });
    console.log('✅ Store initialized');

    const id = `analysis-${Date.now()}`;
    console.log(`📝 Storing analysis with ID: ${id}`);

    await store.set(
      id,
      JSON.stringify({
        id,
        timestamp: new Date().toISOString(),
        sender,
        subject,
        previewText,
        analysis,
      })
    );

    console.log(`✅ Analysis stored successfully`);
    console.log('=== INBOUND EMAIL HANDLER COMPLETED ===');

    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, id }),
    };
  } catch (err) {
    console.error('❌ ERROR in inbound-email handler');
    console.error(`   Error message: ${err.message}`);
    console.error(`   Error stack: ${err.stack}`);
    console.log('=== INBOUND EMAIL HANDLER FAILED ===');

    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};

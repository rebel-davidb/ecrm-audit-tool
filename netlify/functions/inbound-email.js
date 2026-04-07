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

    const bb = busboy({ headers: { 'content-type': contentType } });

    bb.on('field', (name, val) => {
      fields[name] = val;
    });

    bb.on('finish', () => resolve(fields));
    bb.on('error', (err) => reject(err));

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
  if (!apiKey) throw new Error('CLAUDE_API_KEY environment variable is not set.');

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

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Claude API error ${response.status}: ${errText}`);
  }

  const data = await response.json();
  const text = data.content[0].text.trim();

  // Extract JSON even if Claude wraps it
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Claude response did not contain valid JSON.');
  return JSON.parse(match[0]);
}

// ---------------------------------------------------------------------------
// Lambda handler
// ---------------------------------------------------------------------------
exports.handler = async (event) => {
  // Only accept POST requests
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    // Parse Mailgun's multipart form data
    const fields = await parseMultipartForm(event);

    // Verify webhook authenticity
    const { timestamp, token, signature } = fields;
    if (
      !verifySignature(
        timestamp,
        token,
        signature,
        process.env.MAILGUN_WEBHOOK_KEY
      )
    ) {
      console.error('Mailgun signature verification failed');
      return { statusCode: 401, body: 'Unauthorized' };
    }

    // Extract email components
    const sender = fields.sender || fields.from || 'Unknown Sender';
    const subject = fields.subject || '(No Subject)';
    const htmlBody = fields['body-html'] || '';
    const plainBody = fields['body-plain'] || '';
    const previewText = extractPreviewText(plainBody);

    console.log(`Processing email: "${subject}" from ${sender}`);

    // Run Claude analysis
    const analysis = await analyzeWithClaude({
      sender,
      subject,
      previewText,
      htmlBody,
      plainBody,
    });

    // Store result in Netlify Blobs (sorted by timestamp via key)
    const store = getStore({
      name: 'email-analyses',
      siteID: process.env.MY_SITE_ID, // Matches the key in Netlify UI
      token: process.env.MY_NETLIFY_TOKEN,
    });
    const id = `analysis-${Date.now()}`;

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

    console.log(`Analysis stored with id: ${id}`);

    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, id }),
    };
  } catch (err) {
    console.error('Error in inbound-email handler:', err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};

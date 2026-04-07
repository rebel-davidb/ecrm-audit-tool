# Email Campaign Analyzer

An AI-powered email audit tool that analyzes marketing emails and provides detailed feedback across 5 key dimensions: deliverability, subject & preview, HTML quality, copy & CTA, and accessibility.

## Setup & Installation

### Prerequisites
- Node.js 18+
- Netlify CLI (`npm install -g netlify-cli`)
- A Netlify account
- Claude API key from Anthropic
- (Optional) Mailgun account for email receiving

### 1. Install Dependencies
```bash
npm install
```

### 2. Environment Variables
Copy `.env.example` to `.env.local` and fill in your credentials:

```bash
cp .env.example .env.local
```

Then edit `.env.local` with:
- **MY_SITE_ID**: Your Netlify site ID (find in Site Settings > Site information)
- **MY_NETLIFY_TOKEN**: A personal access token (create at https://app.netlify.com/user/applications/personal)
- **CLAUDE_API_KEY**: Your Anthropic API key (get from https://console.anthropic.com/)
- **MAILGUN_WEBHOOK_KEY**: (Optional) Your Mailgun webhook signing key for production

### 3. Link to Netlify (Local Development)
```bash
netlify login
netlify link
```

This allows your local environment to access Netlify Blobs for data storage.

### 4. Start Local Development Server
```bash
netlify dev
```

The app will be available at `http://localhost:8888`

## How It Works

1. **Frontend** (`public/index.html`): Alpine.js single-page app that displays email analyses
2. **Inbound Email Handler** (`netlify/functions/inbound-email.js`):
   - Receives emails from Mailgun webhook
   - Sends email content to Claude for analysis
   - Stores results in Netlify Blobs
3. **API Endpoint** (`netlify/functions/get-analyses.js`):
   - Returns the 20 most recent analyses
   - Auto-refreshed by the frontend every 15 seconds

## Usage

1. Set up inbound email routing with Mailgun to forward emails to your Netlify deployment
2. Send/forward test emails to analyze
3. View analyses in real-time on the dashboard

## Architecture

- **Frontend**: Static HTML with Alpine.js for interactivity
- **Backend**: Netlify Functions (Node.js serverless)
- **Storage**: Netlify Blobs (decentralized blob storage)
- **AI**: Claude API for email analysis
- **Email Input**: Mailgun webhooks

## Deployment

```bash
# Deploy to Netlify
netlify deploy --prod
```

Ensure all environment variables are set in Netlify's Site Settings > Environment before deploying.

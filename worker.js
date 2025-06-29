export default {
  async fetch(request, env) {
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, apiToken, Cookie, X-Forwarded-By, X-End-Time',
      'Access-Control-Allow-Credentials': 'true'
    };
    const url = new URL(request.url);
    const path = url.pathname;

    // Handle CORS preflight
    if (request.method === 'OPTIONS' && ['/incoming', '/incoming/start'].includes(path)) {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const logs = [];
    // Prevent loops
    if (request.headers.get('X-Forwarded-By') === 'worker') {
      return new Response(JSON.stringify({ info: 'Ignored forwarded request' }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Validate path and method
    if (request.method !== 'POST' || !['/incoming', '/incoming/start'].includes(path)) {
      logs.push({ step: 'path-validation', error: `Invalid path or method: ${request.method} ${path}` });
      await fetch(env.LOG_HOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event: 'error-log', timestamp: new Date().toISOString(), logs }) });
      return new Response(JSON.stringify({ error: 'Not Found' }), { status: 404, headers: corsHeaders });
    }

    // Parse JSON body
    let payload;
    try {
      payload = await request.json();
    } catch (err) {
      logs.push({ step: 'json-parse', error: err.message });
      await fetch(env.LOG_HOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event: 'error-log', timestamp: new Date().toISOString(), logs }) });
      return new Response(JSON.stringify({ error: 'Invalid JSON payload' }), { status: 400, headers: corsHeaders });
    }

    // Extract channelID
    const channelID = payload.channelID || url.searchParams.get('channelID');
    if (!channelID) {
      logs.push({ step: 'channel-validation', error: 'Missing channelID' });
      await fetch(env.LOG_HOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event: 'error-log', timestamp: new Date().toISOString(), logs }) });
      return new Response(JSON.stringify({ error: 'Missing channelID' }), { status: 400, headers: corsHeaders });
    }

    const { clientInfo, message, question: incomingQuestion } = payload;
    const { CHANNEL_A_ID, CHANNEL_A_TOKEN, CHANNEL_B_ID, CHANNEL_B_TOKEN, CHANNEL_C_ID, CHANNEL_C_TOKEN, LOG_HOOK_URL } = env;

    // Validate env vars
    ['CHANNEL_A_ID','CHANNEL_A_TOKEN','CHANNEL_B_ID','CHANNEL_B_TOKEN','CHANNEL_C_ID','CHANNEL_C_TOKEN','LOG_HOOK_URL'].forEach(key => {
      if (!env[key]) logs.push({ step: 'env-validation', error: `Missing env var: ${key}` });
    });
    if (logs.some(l => l.step === 'env-validation')) {
      await fetch(LOG_HOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event: 'error-log', timestamp: new Date().toISOString(), logs }) });
      return new Response(JSON.stringify({ error: 'Server configuration error' }), { status: 500, headers: corsHeaders });
    }

    // Validate message
    if (!message || typeof message.content !== 'string') {
      logs.push({ step: 'message-validation', error: 'Invalid message content' });
      await fetch(LOG_HOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event: 'error-log', timestamp: new Date().toISOString(), logs }) });
      return new Response(JSON.stringify({ error: 'Bad Request' }), { status: 400, headers: corsHeaders });
    }
    if (message.type !== 'TEXT') {
      logs.push({ step: 'message-type', info: `Ignored non-text type: ${message.type}` });
      await fetch(LOG_HOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event: 'info-log', timestamp: new Date().toISOString(), logs }) });
      return new Response(null, { status: 200, headers: corsHeaders });
    }

    // Duration enforcement via header
    const endTimeHeader = request.headers.get('X-End-Time');
    if (endTimeHeader) {
      const endTime = parseInt(endTimeHeader, 10);
      if (Date.now() > endTime) {
        logs.push({ step: 'duration', info: 'Test duration ended' });
        await fetch(LOG_HOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event: 'info-log', timestamp: new Date().toISOString(), logs }) });
        return new Response(JSON.stringify({ error: 'Test duration ended' }), { status: 410, headers: corsHeaders });
      }
    }

    // Routing: A -> B, B -> A + C
    const routing = { [CHANNEL_A_ID]: [CHANNEL_B_ID], [CHANNEL_B_ID]: [CHANNEL_A_ID, CHANNEL_C_ID] };
    const targets = routing[channelID] || [];
    if (targets.length === 0) {
      logs.push({ step: 'routing', info: `No targets for ${channelID}` });
      await fetch(LOG_HOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event: 'info-log', timestamp: new Date().toISOString(), logs }) });
      return new Response(null, { status: 200, headers: corsHeaders });
    }

    const apiUrl = 'https://app.mindbehind.com/external/v1/incoming/mindbehind';
    const originalCookie = request.headers.get('Cookie') || '';
    const userAgent = request.headers.get('User-Agent') || '';
    const STATIC_IDS = { [CHANNEL_A_ID]: '685ea4df39a61909e1de6a89', [CHANNEL_B_ID]: '685ea4c439a61909e1de6a88', [CHANNEL_C_ID]: '685e724a39a61909e1de6a84' };
    const TOKENS = { [CHANNEL_A_ID]: CHANNEL_A_TOKEN, [CHANNEL_B_ID]: CHANNEL_B_TOKEN, [CHANNEL_C_ID]: CHANNEL_C_TOKEN };

    const origQuestion = incomingQuestion;
    const answerText = message.content;

    // Forward and log each step
    for (const targetID of targets) {
      const forwardPayload = { clientInfo: { ...clientInfo, id: STATIC_IDS[targetID] }, message: { content: '', type: 'TEXT' } };
      if (targetID === CHANNEL_B_ID || targetID === CHANNEL_A_ID) {
        forwardPayload.message.content = answerText;
      } else if (targetID === CHANNEL_C_ID) {
        forwardPayload.message.content = `"question":"${origQuestion}","answer":"${answerText}"`;
      }
      try {
        const resp = await fetch(`${apiUrl}?channelID=${targetID}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'apiToken': TOKENS[targetID], 'Cookie': originalCookie, 'User-Agent': userAgent, 'X-Forwarded-By': 'worker' }, body: JSON.stringify(forwardPayload) });
        const body = await resp.text();
        logs.push({ step: 'forward', target: targetID, status: resp.status, body });
      } catch (error) {
        logs.push({ step: 'forward-error', target: targetID, error: error.message });
      }
    }

    // Send combined log
    await fetch(env.LOG_HOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event: 'full-log', timestamp: new Date().toISOString(), incoming: { clientInfo, message, channelID, question: origQuestion }, logs }) });

    return new Response(JSON.stringify({ success: true }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
  }
};

#!/usr/bin/env node

const WebSocket = require('ws');

console.log('Connecting to relay bridge...');
const ws = new WebSocket('ws://127.0.0.1:34001');

const backendHost = process.env.IEC_BACKEND_HOST || 'simulation';
const backendPort = Number(process.env.IEC_BACKEND_PORT || (backendHost === 'simulation' ? 0 : 8102));
const scdFile = process.env.SCD_FILE || '';
let receivedEndpointStatus = false;

ws.on('open', () => {
  console.log('✓ Connected to relay bridge');
  
  // Send IEC endpoint configuration
  const endpoints = [{
    id: 'test-ied-1',
    name: 'TestIED',
    ip: '172.16.21.12',
    port: 102,
    backendHost,
    backendPort,
    ...(scdFile ? { scdFile } : {})
  }];
  
  const message = {
    type: 'SET_PROTOCOL_ENDPOINTS',
    protocol: 'iec61850',
    endpoints
  };
  
  console.log('Sending IEC endpoint configuration:', JSON.stringify(message, null, 2));
  ws.send(JSON.stringify(message));
  
  setTimeout(() => {
    if (!receivedEndpointStatus) {
      console.error('✗ Relay rejected or ignored endpoint publish (likely blocked headless WS).');
      ws.close();
      process.exit(1);
    }

    console.log(`✓ Configuration complete. Relay endpoint 172.16.21.12:102 -> backend ${backendHost}:${backendPort}`);
    ws.close();
    process.exit(0);
  }, 1000);
});

ws.on('message', (data) => {
  console.log('Received from relay:', data.toString());
  try {
    const msg = JSON.parse(data.toString());
    if (msg && msg.type === 'ENDPOINT_STATUS_LIST') {
      receivedEndpointStatus = true;
    }
  } catch {
  }
});

ws.on('error', (err) => {
  console.error('✗ WebSocket error:', err.message);
  process.exit(1);
});

ws.on('close', () => {
  console.log('WebSocket closed');
});

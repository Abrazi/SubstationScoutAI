#!/usr/bin/env node

const os = require('os');
const net = require('net');
const { WebSocketServer } = require('ws');

const WS_PORT = Number(process.env.RELAY_WS_PORT || 34001);
const MODBUS_PORT = Number(process.env.RELAY_MODBUS_PORT || 502);
const MODBUS_HOST = process.env.RELAY_MODBUS_HOST || '0.0.0.0';
const IEC_MMS_PORT = Number(process.env.RELAY_IEC_MMS_PORT || 102);
const IEC_MMS_HOST = process.env.RELAY_IEC_MMS_HOST || '0.0.0.0';
const IEC_BACKEND_HOST = process.env.RELAY_IEC_BACKEND_HOST || '127.0.0.1';
const IEC_BACKEND_PORT = Number(process.env.RELAY_IEC_BACKEND_PORT || 8102);
const IEC_FORCE_BACKEND = process.env.RELAY_IEC_FORCE_BACKEND === '1';
const IEC_FORCE_BACKEND_HOST = process.env.RELAY_IEC_FORCE_BACKEND_HOST || IEC_BACKEND_HOST;
const IEC_FORCE_BACKEND_PORT = Number(process.env.RELAY_IEC_FORCE_BACKEND_PORT || IEC_BACKEND_PORT);
const IEC_DEFAULT_LISTENER = process.env.RELAY_IEC_DEFAULT_LISTENER === '1';
const CLEAR_IEC_ON_UI_DISCONNECT = process.env.RELAY_CLEAR_IEC_ON_UI_DISCONNECT !== '0';
const ALLOW_HEADLESS_WS = process.env.RELAY_ALLOW_HEADLESS_WS === '1';

let uiSocket = null;
let selectedAdapterIp = null;
const tcpServers = new Map(); // key: protocol|ip:port -> server
const endpointStates = new Map(); // key: protocol|ip:port -> { protocol, ip, port, name?, status, error? }
const endpointConfigs = new Map(); // key: protocol|ip:port -> { name?, backendHost?, backendPort? }
const iecClientCounts = new Map(); // key: protocol|ip:port -> number
const iedModels = new Map(); // key: protocol|ip:port -> IEDNode tree
const iedModelRequests = new Map(); // key: protocol|ip:port -> { iedName, pending: true }

const pendingRequests = new Map();
const socketContext = new WeakMap(); // socket -> { lastUnitId }

function listAdapters() {
  const nets = os.networkInterfaces();
  const adapters = [];

  Object.entries(nets).forEach(([name, addrs]) => {
    (addrs || []).forEach((a) => {
      if (a.family === 'IPv4' && !a.internal) {
        adapters.push({
          name,
          ip: a.address,
          mac: a.mac || '00:00:00:00:00:00',
          description: `${name} - ${a.address}`
        });
      }
    });
  });

  return adapters;
}

function sendUi(msg) {
  if (!uiSocket || uiSocket.readyState !== 1) return;
  uiSocket.send(JSON.stringify(msg));
}

function publishEndpointStates() {
  const endpoints = Array.from(endpointStates.values());
  sendUi({ type: 'ENDPOINT_STATUS_LIST', endpoints });
}

function endpointKey(protocol, ip, port) {
  return `${protocol}|${ip}:${port}`;
}

function setEndpointState(protocol, ip, port, status, error, name, backendHost, backendPort) {
  const key = endpointKey(protocol, ip, port);
  const cfg = endpointConfigs.get(key) || {};
  if (name) cfg.name = name;
  if (backendHost) cfg.backendHost = backendHost;
  if (backendPort) cfg.backendPort = backendPort;
  endpointConfigs.set(key, cfg);

  const existing = endpointStates.get(key) || {};
  const state = {
    protocol,
    ip,
    port,
    status,
    clients: protocol === 'iec61850' ? (iecClientCounts.get(key) || 0) : undefined
  };
  if (name) state.name = name;
  else if (cfg.name) state.name = cfg.name;
  else if (existing.name) state.name = existing.name;
  if (backendHost) state.backendHost = backendHost;
  else if (cfg.backendHost) state.backendHost = cfg.backendHost;
  else if (existing.backendHost) state.backendHost = existing.backendHost;
  if (backendPort) state.backendPort = backendPort;
  else if (cfg.backendPort) state.backendPort = cfg.backendPort;
  else if (existing.backendPort) state.backendPort = existing.backendPort;
  if (error) state.error = error;
  endpointStates.set(key, state);
  publishEndpointStates();
}

function probeBackend(host, port, timeoutMs = 1200) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port: Number(port) });
    let settled = false;

    const done = (ok, error) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch {}
      resolve({ ok, error });
    };

    socket.setTimeout(timeoutMs, () => done(false, 'Backend probe timeout'));
    socket.on('connect', () => done(true));
    socket.on('error', (err) => done(false, err.message));
  });
}

function updateIecClientCount(bindHost, bindPort, delta) {
  const key = endpointKey('iec61850', bindHost, bindPort);
  const current = iecClientCounts.get(key) || 0;
  const next = Math.max(0, current + delta);
  iecClientCounts.set(key, next);
  const state = endpointStates.get(key);
  if (state) {
    state.clients = next;
    endpointStates.set(key, state);
    publishEndpointStates();
  }
}

function startServers() {
  applyProtocolEndpoints('modbus', []);
  applyProtocolEndpoints('iec61850', []);
}

// Helper: Build MMS GetNameList Response from IED model
function buildGetNameListResponse(iedModel) {
  if (!iedModel || !iedModel.children) {
    // Fallback: return empty list
    return Buffer.from([
      0x03, 0x00, 0x00, 0x1D,  // TPKT: version 3, length 29
      0x02,                     // COTP: length 2
      0xF0,                     // COTP: DT (Data)
      0x80,                     // COTP: EOT flag
      // MMS Confirmed-ResponsePDU
      0xA1, 0x16,              // [1] IMPLICIT SEQUENCE
      0x02, 0x01, 0x00,        // invokeID INTEGER 0
      // getNameList Response [1]
      0xA1, 0x11,              // [1] IMPLICIT SEQUENCE
      0xA0, 0x00,              // [0] IMPLICIT SEQUENCE OF (empty)
      0x81, 0x01, 0x00         // [1] BOOLEAN FALSE (moreFollows)
    ]);
  }

  // Extract Logical Devices from IED model (look for LD children)
  const logicalDevices = [];
  if (iedModel.children) {
    for (const child of iedModel.children) {
      // Check if this is a Logical Device (type === 'LD' or has LN children)
      if (child.type === 'LD' || (child.children && child.children.some(c => c.type === 'LN'))) {
        logicalDevices.push(child.name);
      }
    }
  }

  if (logicalDevices.length === 0) {
    logicalDevices.push('LD0'); // Default logical device
  }

  // Build MMS response with first LD (IEDScout will query each separately)  
  const ldName = logicalDevices[0];
  const ldNameBuf = Buffer.from(ldName, 'utf8');
  const ldNameLen = ldNameBuf.length;

  // Calculate lengths
  const identListLen = 2 + ldNameLen; // tag(1) + len(1) + name
  const responseBodyLen = 2 + identListLen + 3; // listOfIdentifier + moreFollows
  const confirmedRespLen = 3 + 2 + responseBodyLen; // invokeID + getNameList response

  const totalLen =7 + 2 + confirmedRespLen; // TPKT/COTP + confirmed-resp

  const response = Buffer.alloc(totalLen);
  let offset = 0;

  // TPKT Header
  response[offset++] = 0x03; // Version 3
  response[offset++] = 0x00; // Reserved
  response[offset++] = (totalLen >> 8) & 0xFF;
  response[offset++] = totalLen & 0xFF;

  // COTP Header
  response[offset++] = 0x02; // Length 2
  response[offset++] = 0xF0; // DT Data
  response[offset++] = 0x80; // EOT flag

  // MMS Confirmed-ResponsePDU [1]
  response[offset++] = 0xA1; // tag
  response[offset++] = confirmedRespLen;

  // invokeID
  response[offset++] = 0x02; // INTEGER tag
  response[offset++] = 0x01; // length 1
  response[offset++] = 0x00; // value 0

  // getNameList Response [1]
  response[offset++] = 0xA1; // tag
  response[offset++] = responseBodyLen;

  // listOfIdentifier [0] SEQUENCE OF
  response[offset++] = 0xA0; // tag
  response[offset++] = identListLen;

  // Identifier (VisibleString)
  response[offset++] = 0x1A; // VisibleString tag
  response[offset++] = ldNameLen;
  ldNameBuf.copy(response, offset);
  offset += ldNameLen;

  // moreFollows [1] BOOLEAN
  response[offset++] = 0x81; // tag
  response[offset++] = 0x01; // length 1
  response[offset++] = logicalDevices.length > 1 ? 0xFF : 0x00; // TRUE if more LDs, else FALSE

  return response;
}

function closeProtocolServers(protocol) {
  for (const [key, server] of tcpServers.entries()) {
    if (!key.startsWith(`${protocol}|`)) continue;
    try {
      server.close();
    } catch {}
    tcpServers.delete(key);
    endpointStates.delete(key);
    endpointConfigs.delete(key);
    if (protocol === 'iec61850') {
      iecClientCounts.delete(key);
    }
  }
  publishEndpointStates();
}

function createBoundServer(protocol, bindHost, bindPort, name, backendHost, backendPort) {
  const key = endpointKey(protocol, bindHost, bindPort);
  if (tcpServers.has(key)) return;

  const server = net.createServer((socket) => {
    socket.setNoDelay(true);
    if (protocol === 'modbus') {
      socketContext.set(socket, { lastUnitId: 1 });
    }

    if (protocol === 'iec61850') {
      updateIecClientCount(bindHost, bindPort, 1);
    }

    socket.on('data', (buffer) => {
      if (protocol === 'iec61850') return;

      let offset = 0;
      while (offset + 7 <= buffer.length) {
        const lengthField = buffer.readUInt16BE(offset + 4);
        const aduLen = 6 + lengthField;
        if (offset + aduLen > buffer.length) break;

        const frame = buffer.subarray(offset, offset + aduLen);
        offset += aduLen;

        if (frame.length < 8) continue;

        const transId = frame.readUInt16BE(0);
        const protoId = frame.readUInt16BE(2);
        const unitId = frame.readUInt8(6);
        const pdu = frame.subarray(7);
        const fc = pdu.readUInt8(0);

        if (protoId !== 0) {
          socket.write(buildExceptionResponse(transId, unitId, fc, 1));
          continue;
        }

        const cmd = parsePdu(transId, unitId, pdu);
        socketContext.get(socket).lastUnitId = unitId;

        if (!cmd) {
          socket.write(buildExceptionResponse(transId, unitId, fc, 1));
          continue;
        }

        const source = `${socket.remoteAddress || 'unknown'}:${socket.remotePort || 0}`;
        const targetIp = bindHost === '0.0.0.0'
          ? String(socket.localAddress || '').replace(/^::ffff:/, '')
          : bindHost;
        const targetPort = socket.localPort || MODBUS_PORT;
        pendingRequests.set(transId, { socket, unitId, fc, ts: Date.now(), source });
        sendUi({ type: 'MODBUS_CMD', source, targetIp, targetPort, ...cmd });
      }
    });

    socket.on('error', () => {});
    socket.on('close', () => {
      if (protocol === 'iec61850') {
        updateIecClientCount(bindHost, bindPort, -1);
      }
      if (protocol !== 'modbus') return;
      for (const [tid, pending] of pendingRequests.entries()) {
        if (pending.socket === socket) pendingRequests.delete(tid);
      }
    });
  });

  if (protocol === 'iec61850') {
    server.removeAllListeners('connection');
    server.on('connection', (socket) => {
      socket.setNoDelay(true);
      updateIecClientCount(bindHost, bindPort, 1);

      const source = `${socket.remoteAddress || 'unknown'}:${socket.remotePort || 0}`;
      const targetIp = bindHost === '0.0.0.0'
        ? String(socket.localAddress || '').replace(/^::ffff:/, '')
        : bindHost;
      const targetPort = socket.localPort || IEC_MMS_PORT;

      console.log(`[relay] IEC client connected: ${source} -> ${targetIp}:${targetPort}`);

      // Check if we should operate in simulation mode (backend == frontend or no backend)
      const effectiveBackendHost = backendHost || IEC_BACKEND_HOST;
      const effectiveBackendPort = Number(backendPort || IEC_BACKEND_PORT);
      const simulationMode = (effectiveBackendHost === bindHost && effectiveBackendPort === bindPort) ||
                             effectiveBackendHost === 'simulation' ||
                             effectiveBackendHost === 'none';

      if (simulationMode) {
        // Simulation mode: accept connection but provide basic MMS responses
        setEndpointState('iec61850', bindHost, bindPort, 'active', undefined, name, 'simulation', 0);
        sendUi({
          type: 'IEC_TRACE',
          direction: 'connect',
          source,
          targetIp,
          targetPort,
          info: 'IEC client connected (simulation mode - no backend)'
        });

        let cotpConnected = false;

        socket.on('data', (buffer) => {
          sendUi({
            type: 'IEC_TRACE',
            direction: 'rx',
            source,
            targetIp,
            targetPort,
            bytes: buffer.length,
            info: 'IEC client -> simulation'
          });

          // Basic MMS/TPKT/COTP handshake handling
          if (buffer.length >= 4) {
            const version = buffer[0];
            const length = buffer.readUInt16BE(2);

            // TPKT version 3
            if (version === 3 && length >= 4) {
              // Check for COTP Connection Request (CR)
              if (buffer.length >= 7 && buffer[5] === 0xE0) {
                // Send COTP Connection Confirm (CC)
                // TPKT header (4 bytes) + COTP CC packet
                const response = Buffer.from([
                  0x03, 0x00, 0x00, 0x0B,  // TPKT: version 3, length 11
                  0x06,                     // COTP: length 6
                  0xD0,                     // COTP: CC (Connection Confirm)
                  0x00, 0x00,               // COTP: dst-ref
                  0x00, 0x01,               // COTP: src-ref
                  0x00                      // COTP: class
                ]);
                socket.write(response);
                cotpConnected = true;
                sendUi({
                  type: 'IEC_TRACE',
                  direction: 'tx',
                  source,
                  targetIp,
                  targetPort,
                  bytes: response.length,
                  info: 'Simulation: COTP Connection Confirm sent'
                });
              }
              // Check for all MMS messages after COTP is connected
              else if (cotpConnected && buffer.length >= 7 && buffer[5] === 0xF0) {
                // Parse COTP header to find where MMS PDU starts
                const cotpLength = buffer[4]; // COTP length includes itself
                const mmsStart = 5 + cotpLength; // MMS starts after TPKT (4 bytes) + COTP length + COTP data
                
                if (buffer.length < mmsStart + 1) {
                  console.log(`[relay] IEC incomplete MMS message (${buffer.length} bytes, need ${mmsStart + 1})`);
                  return;
                }
                
                const mmsPduTag = buffer[mmsStart];
                console.log(`[relay] IEC COTP DT received (COTP len=${cotpLength}), MMS PDU tag: 0x${mmsPduTag?.toString(16).padStart(2, '0')} at offset ${mmsStart} (total ${buffer.length} bytes)`);
                
                // MMS Initiate Request (tag 0xA8)
                if (mmsPduTag === 0xA8) {
                  console.log(`[relay] IEC MMS Initiate Request from ${source}`);
                  // Send a proper MMS Initiate Response
                  const response = Buffer.from([
                    0x03, 0x00, 0x00, 0x46,  // TPKT: version 3, length 70 bytes
                    0x02,                     // COTP: length 2
                    0xF0,                     // COTP: DT (Data)
                    0x80,                     // COTP: EOT flag
                    // MMS Initiate-ResponsePDU
                    0xA9, 0x3E,              // [UNIVERSAL 9] IMPLICIT SEQUENCE (62 bytes)
                    // localDetailCalling (negotiated parameter)
                    0x80, 0x01, 0x01,        // [0] INTEGER 1 (local detail)
                    // negociatedMaxServOutstandingCalling
                    0x81, 0x01, 0x01,        // [1] INTEGER 1
                    // negociatedMaxServOutstandingCalled
                    0x82, 0x01, 0x01,        // [2] INTEGER 1
                    // negociatedDataStructureNestingLevel (optional removed for compatibility)
                    // negociatedMaxPduSize
                    0x88, 0x03, 0x00, 0xFF, 0xF0,  // [8] INTEGER 65520 (max PDU size)
                    // proposedVersionNumber - IEC 61850 Ed 2
                    0x89, 0x02, 0x07, 0xC0,  // [9] BIT STRING 0x07C0 = version 1+2 (Ed 1 & Ed 2)
                    // proposedParameterCBB - STR1+STR2+NEST
                    0x8A, 0x05, 0x04, 0xF1, 0x00, 0x00, 0x00,  // [10] BIT STRING (CBB = 0xF1000000)
                    // servicesSupportedCalling (advertise GetNameList, Identify, Read, etc.)
                    0x8B, 0x20,              // [11] BIT STRING (32 bytes of service flags)
                    0x5F, 0x1F, 0x00, 0x11, 0x00, 0x00, 0x00, 0x00,  // Status, GetNameList, Identify, Read
                    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x04, 0x08,
                    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
                    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00
                  ]);
                  
                  socket.write(response);
                  console.log(`[relay] IEC MMS Initiate Response sent to ${source} (${response.length} bytes)`);
                  sendUi({
                    type: 'IEC_TRACE',
                    direction: 'tx',
                    source,
                    targetIp,
                    targetPort,
                    bytes: response.length,
                    info: 'Simulation: MMS Initiate-ResponsePDU sent (IEC 61850 Ed 2)'
                  });
                }
                // ISO session connect request (tag 0x0d) often wraps ACSE/MMS from strict clients like IEDScout
                else if (mmsPduTag === 0x0D) {
                  const nestedA8Offset = buffer.indexOf(0xA8, mmsStart);
                  const preview = buffer.subarray(mmsStart, Math.min(buffer.length, mmsStart + 48)).toString('hex');
                  const fullHex = buffer.subarray(mmsStart).toString('hex');
                  console.log(`[relay] IEC session-layer connect from ${source} (tag 0x0d, nested A8 at ${nestedA8Offset >= 0 ? nestedA8Offset : 'not found'})`);
                  console.log(`[relay] IEC session payload preview: ${preview}`);
                  console.log(`[relay] IEC session payload full: ${fullHex}`);
                  // Build a single OSI association response by mirroring the request envelope.
                  // Strict clients may reject multiple mixed responses on first association packet.
                  const mirrored = Buffer.from(buffer.subarray(mmsStart));
                  mirrored[0] = 0x0E; // Session Accept SPDU
                  const innerAarqOffset = mirrored.indexOf(0x60, 16); // ACSE AARQ tag
                  if (innerAarqOffset >= 0) mirrored[innerAarqOffset] = 0x61; // ACSE AARE tag
                  if (nestedA8Offset >= mmsStart) {
                    const relA8 = nestedA8Offset - mmsStart;
                    if (relA8 >= 0 && relA8 < mirrored.length) mirrored[relA8] = 0xA9; // Initiate-Response tag
                  }

                  const mirroredFrameLength = 7 + mirrored.length;
                  const mirroredFrame = Buffer.concat([
                    Buffer.from([
                      0x03, 0x00,
                      (mirroredFrameLength >> 8) & 0xFF,
                      mirroredFrameLength & 0xFF,
                      0x02,
                      0xF0,
                      0x80
                    ]),
                    mirrored
                  ]);

                  socket.write(mirroredFrame);
                  console.log(`[relay] IEC mirrored OSI association response sent to ${source} (${mirroredFrame.length} bytes)`);
                  sendUi({
                    type: 'IEC_TRACE',
                    direction: 'tx',
                    source,
                    targetIp,
                    targetPort,
                    bytes: mirroredFrame.length,
                    info: 'Simulation: mirrored OSI association response (AARE candidate)'
                  });
                }
                // MMS Confirmed Request (tag 0xA0) - GetNameList, Read, etc.
                else if (mmsPduTag === 0xA0) {
                  const mmsPdu = buffer.subarray(mmsStart);
                  
                  // Check for GetNameList (tag 0xA1)
                  if (mmsPdu.length > 3 && mmsPdu[2] === 0xA1) {
                    console.log(`[relay] IEC MMS GetNameList request from ${source}`);
                    
                    // Get IED model for this endpoint
                    const epKey = endpointKey('iec61850', targetIp, targetPort);
                    const iedModel = iedModels.get(epKey);
                    
                    let response;
                    let logInfo;
                    
                    if (iedModel) {
                      response = buildGetNameListResponse(iedModel);
                      logInfo = `GetNameList Response (from ${iedModel.name})`;
                      console.log(`[relay] IEC MMS GetNameList Response sent: ${iedModel.name}`);
                    } else {
                      // Fallback to TEMPLATE if model not available yet
                      response = Buffer.from([
                        0x03, 0x00, 0x00, 0x2D,  // TPKT: version 3, length 45
                        0x02,                     // COTP: length 2
                        0xF0,                     // COTP: DT (Data)
                        0x80,                     // COTP: EOT flag
                        // MMS Confirmed-ResponsePDU
                        0xA1, 0x26,              // [1] IMPLICIT SEQUENCE (38 bytes)
                        // invokeID (match request or use 0)
                        0x02, 0x01, 0x00,        // INTEGER 0
                        // getNameList Response [1]
                        0xA1, 0x21,              // [1] IMPLICIT SEQUENCE (33 bytes)
                        // listOfIdentifier [0]
                        0xA0, 0x0A,              // [0] IMPLICIT SEQUENCE OF (10 bytes)
                        // Identifier: "TEMPLATE"  
                        0x1A, 0x08, 0x54, 0x45, 0x4D, 0x50, 0x4C, 0x41, 0x54, 0x45,
                        // moreFollows [1] = FALSE
                        0x81, 0x01, 0x00         // [1] BOOLEAN FALSE
                      ]);
                      logInfo = 'GetNameList Response (TEMPLATE - model pending)';
                      console.log(`[relay] IEC MMS GetNameList Response sent: TEMPLATE (model not loaded)`);
                    }
                    
                    socket.write(response);
                    sendUi({
                      type: 'IEC_TRACE',
                      direction: 'tx',
                      source,
                      targetIp,
                      targetPort,
                      bytes: response.length,
                      info: `Simulation: ${logInfo}`
                    });
                  }
                  // Check for GetLogicalDeviceDirectory or other requests
                  else {
                    console.log(`[relay] IEC MMS request from ${source}: ${buffer.length} bytes (PDU: 0x${mmsPdu[2]?.toString(16) || '??'})`);
                    
                    // Send generic error for unsupported services
                    const errorResponse = Buffer.from([
                      0x03, 0x00, 0x00, 0x0F,  // TPKT: version 3, length 15
                      0x02,                     // COTP: length 2
                      0xF0,                     // COTP: DT (Data)
                      0x80,                     // COTP: EOT flag
                      // MMS Confirmed-ErrorPDU
                      0xA2, 0x08,              // [2] IMPLICIT SEQUENCE (8 bytes)
                      0x02, 0x01, 0x00,        // invokeID INTEGER 0
                      0xA0, 0x03,              // [0] ServiceError
                      0x80, 0x01, 0x01         // service-not-supported
                    ]);
                    
                    socket.write(errorResponse);
                    console.log(`[relay] IEC MMS Error Response sent (service not supported in simulation)`);
                  }
                } else {
                  console.log(`[relay] IEC MMS unknown request from ${source}: ${buffer.length} bytes`);
                }
              }
            }
          }
        });

        socket.on('error', () => {
          socket.destroy();
        });

        socket.on('close', () => {
          updateIecClientCount(bindHost, bindPort, -1);
          sendUi({
            type: 'IEC_TRACE',
            direction: 'disconnect',
            source,
            targetIp,
            targetPort,
            info: 'IEC client disconnected (simulation mode)'
          });
        });

        return;
      }

      // Proxy mode: connect to backend
      const upstream = net.createConnection({
        host: effectiveBackendHost,
        port: effectiveBackendPort
      });

      upstream.on('connect', () => {
        setEndpointState('iec61850', bindHost, bindPort, 'active', undefined, name, effectiveBackendHost, effectiveBackendPort);
        sendUi({
          type: 'IEC_TRACE',
          direction: 'connect',
          source,
          targetIp,
          targetPort,
          backendHost: effectiveBackendHost,
          backendPort: effectiveBackendPort,
          info: 'IEC client bridged to backend MMS server'
        });
      });

      socket.on('data', (buffer) => {
        sendUi({
          type: 'IEC_TRACE',
          direction: 'rx',
          source,
          targetIp,
          targetPort,
          bytes: buffer.length,
          info: 'IEC client -> backend'
        });
        if (!upstream.destroyed) upstream.write(buffer);
      });

      upstream.on('data', (buffer) => {
        sendUi({
          type: 'IEC_TRACE',
          direction: 'tx',
          source,
          targetIp,
          targetPort,
          bytes: buffer.length,
          info: 'IEC backend -> client'
        });
        if (!socket.destroyed) socket.write(buffer);
      });

      const closePair = () => {
        if (!socket.destroyed) socket.destroy();
        if (!upstream.destroyed) upstream.destroy();
      };

      socket.on('error', closePair);
      upstream.on('error', (err) => {
        setEndpointState('iec61850', bindHost, bindPort, 'failed', `Backend connection error: ${err.message}`, name, effectiveBackendHost, effectiveBackendPort);
        sendUi({
          type: 'IEC_TRACE',
          direction: 'error',
          source,
          targetIp,
          targetPort,
          backendHost: effectiveBackendHost,
          backendPort: effectiveBackendPort,
          info: `IEC backend connection error: ${err.message}`
        });
        closePair();
      });

      socket.on('close', () => {
        updateIecClientCount(bindHost, bindPort, -1);
        closePair();
      });
      upstream.on('close', closePair);
    });
  }

  server.listen(bindPort, bindHost, () => {
    const protocolLabel = protocol === 'iec61850' ? 'IEC61850 MMS' : 'Modbus TCP';
    console.log(`[relay] ${protocolLabel} listening on ${bindHost}:${bindPort}`);
    if (protocol === 'iec61850') {
      const effectiveBackendHost = backendHost || IEC_BACKEND_HOST;
      const effectiveBackendPort = Number(backendPort || IEC_BACKEND_PORT);
      const simulationMode = effectiveBackendHost === 'simulation' || 
                             effectiveBackendHost === 'none' ||
                             (effectiveBackendHost === bindHost && effectiveBackendPort === bindPort);
      
      if (simulationMode) {
        setEndpointState(protocol, bindHost, bindPort, 'active', undefined, name, 'simulation', 0);
        console.log(`[relay] IEC ${bindHost}:${bindPort} in simulation mode (no backend)`);
        // Request IED model from app if name is provided
        if (name) {
          const key = endpointKey(protocol, bindHost, bindPort);
          iedModelRequests.set(key, { iedName: name, pending: true });
          sendUi({ type: 'GET_IED_MODEL', iedName: name, protocol, ip: bindHost, port: bindPort });
          console.log(`[relay] Requesting IED model for ${name} from app`);
        }
      } else {
        probeBackend(effectiveBackendHost, effectiveBackendPort).then((probe) => {
          if (probe.ok) {
            setEndpointState(protocol, bindHost, bindPort, 'active', undefined, name, effectiveBackendHost, effectiveBackendPort);
          } else {
            setEndpointState(protocol, bindHost, bindPort, 'failed', `Backend unreachable: ${probe.error || 'unknown error'}`, name, effectiveBackendHost, effectiveBackendPort);
          }
        });
      }
    } else {
      setEndpointState(protocol, bindHost, bindPort, 'active', undefined, name, backendHost, backendPort);
    }
    if (selectedAdapterIp) {
      console.log(`[relay] Selected adapter IP: ${selectedAdapterIp}`);
    }
  });

  server.on('error', (err) => {
    const protocolLabel = protocol === 'iec61850' ? 'IEC61850 MMS' : 'Modbus';
    console.error(`[relay] ${protocolLabel} listen error on ${bindHost}:${bindPort}: ${err.message}`);
    setEndpointState(protocol, bindHost, bindPort, 'failed', err.message, name, backendHost, backendPort);
  });

  tcpServers.set(key, server);
}

function applyProtocolEndpoints(protocol, endpoints) {
  closeProtocolServers(protocol);

  const defaultHost = protocol === 'iec61850' ? IEC_MMS_HOST : MODBUS_HOST;
  const defaultPort = protocol === 'iec61850' ? IEC_MMS_PORT : MODBUS_PORT;

  if (!Array.isArray(endpoints) || endpoints.length === 0) {
    if (protocol === 'iec61850' && !IEC_DEFAULT_LISTENER) {
      return;
    }
    createBoundServer(protocol, defaultHost, defaultPort);
    return;
  }

  const unique = new Set();
  for (const ep of endpoints) {
    const ip = String(ep.ip || '').trim();
    const port = Number(ep.port || defaultPort);
    const name = typeof ep.name === 'string' ? ep.name : undefined;
    const backendHost = protocol === 'iec61850' && IEC_FORCE_BACKEND
      ? String(IEC_FORCE_BACKEND_HOST).trim()
      : String(ep.backendHost || IEC_BACKEND_HOST).trim();
    const backendPort = protocol === 'iec61850' && IEC_FORCE_BACKEND
      ? Number(IEC_FORCE_BACKEND_PORT)
      : Number(ep.backendPort || IEC_BACKEND_PORT);
    if (!ip) continue;
    const key = endpointKey(protocol, ip, port);
    if (unique.has(key)) continue;
    unique.add(key);
    createBoundServer(protocol, ip, port, name, backendHost, backendPort);
  }

  if (unique.size === 0) {
    if (protocol === 'iec61850' && !IEC_DEFAULT_LISTENER) {
      return;
    }
    createBoundServer(protocol, defaultHost, defaultPort);
  }
}

function parsePdu(transId, unitId, pdu) {
  if (pdu.length < 1) return null;
  const fc = pdu.readUInt8(0);

  if ([1, 2, 3, 4].includes(fc)) {
    if (pdu.length < 5) return null;
    const addr = pdu.readUInt16BE(1);
    const len = pdu.readUInt16BE(3);
    return { transId, unitId, fc, addr, len };
  }

  if (fc === 5) {
    if (pdu.length < 5) return null;
    const addr = pdu.readUInt16BE(1);
    const raw = pdu.readUInt16BE(3);
    const val = raw === 0xff00 ? 1 : 0;
    return { transId, unitId, fc, addr, val };
  }

  if (fc === 6) {
    if (pdu.length < 5) return null;
    const addr = pdu.readUInt16BE(1);
    const val = pdu.readUInt16BE(3);
    return { transId, unitId, fc, addr, val };
  }

  return { transId, unitId, fc, addr: 0, len: 0 };
}

function buildExceptionResponse(transId, unitId, fc, exCode) {
  const pdu = Buffer.from([fc | 0x80, exCode & 0xff]);
  return buildAdu(transId, unitId, pdu);
}

function buildReadResponse(transId, unitId, fc, data) {
  const values = Array.isArray(data) ? data : [];

  if (fc === 1 || fc === 2) {
    const byteCount = Math.ceil(values.length / 8);
    const bytes = Buffer.alloc(byteCount, 0);
    values.forEach((value, idx) => {
      if (Number(value)) bytes[Math.floor(idx / 8)] |= 1 << (idx % 8);
    });
    const pdu = Buffer.concat([Buffer.from([fc, byteCount]), bytes]);
    return buildAdu(transId, unitId, pdu);
  }

  const byteCount = values.length * 2;
  const payload = Buffer.alloc(byteCount);
  values.forEach((value, idx) => {
    payload.writeUInt16BE((Number(value) || 0) & 0xffff, idx * 2);
  });
  const pdu = Buffer.concat([Buffer.from([fc, byteCount]), payload]);
  return buildAdu(transId, unitId, pdu);
}

function buildWriteEchoResponse(transId, unitId, fc, addr, val) {
  const pdu = Buffer.alloc(5);
  pdu.writeUInt8(fc, 0);
  pdu.writeUInt16BE(addr & 0xffff, 1);
  if (fc === 5) {
    pdu.writeUInt16BE(Number(val) ? 0xff00 : 0x0000, 3);
  } else {
    pdu.writeUInt16BE((Number(val) || 0) & 0xffff, 3);
  }
  return buildAdu(transId, unitId, pdu);
}

function buildAdu(transId, unitId, pdu) {
  const mbap = Buffer.alloc(7);
  mbap.writeUInt16BE(transId & 0xffff, 0);
  mbap.writeUInt16BE(0, 2); // protocol id
  mbap.writeUInt16BE(pdu.length + 1, 4); // unit id + pdu
  mbap.writeUInt8(unitId & 0xff, 6);
  return Buffer.concat([mbap, pdu]);
}

function handleModbusResponse(msg) {
  const pending = pendingRequests.get(msg.transId);
  if (!pending) return;
  pendingRequests.delete(msg.transId);

  const { socket, unitId: reqUnit, fc: reqFc, source } = pending;
  if (socket.destroyed) return;

  const fc = Number(msg.fc || reqFc || 0);
  const unitId = Number(msg.unitId || reqUnit || socketContext.get(socket)?.lastUnitId || 1);
  const exceptionCode = Number(msg.exceptionCode || 0);

  let response;
  if (exceptionCode > 0) {
    response = buildExceptionResponse(msg.transId, unitId, fc, exceptionCode);
  } else if ([1, 2, 3, 4].includes(fc)) {
    response = buildReadResponse(msg.transId, unitId, fc, msg.data || []);
  } else if (fc === 5 || fc === 6) {
    response = buildWriteEchoResponse(msg.transId, unitId, fc, Number(msg.addr || 0), msg.val);
  } else {
    response = buildExceptionResponse(msg.transId, unitId, fc, 1);
  }

  socket.write(response);
  sendUi({ type: 'MODBUS_TRACE', direction: 'tx', source, transId: msg.transId, unitId, fc, exceptionCode });
}

function cleanupTimeouts() {
  const now = Date.now();
  for (const [tid, pending] of pendingRequests.entries()) {
    if (now - pending.ts > 5000) {
      try {
        if (!pending.socket.destroyed) {
          pending.socket.write(buildExceptionResponse(tid, pending.unitId, pending.fc, 4));
        }
      } catch {}
      pendingRequests.delete(tid);
    }
  }
}

const wss = new WebSocketServer({ host: '127.0.0.1', port: WS_PORT });

wss.on('connection', (ws, req) => {
  const origin = String(req?.headers?.origin || '');
  const isTrustedBrowserOrigin = /^https?:\/\/(localhost|127\.0\.0\.1|172\.16\.\d+\.\d+)(:\d+)?$/i.test(origin);

  if (!isTrustedBrowserOrigin && !ALLOW_HEADLESS_WS) {
    console.warn(`[relay] Rejected WS control connection without trusted browser origin (origin: ${origin || 'none'})`);
    try {
      ws.close(1008, 'Browser app origin required');
    } catch {}
    return;
  }

  uiSocket = ws;
  sendUi({ type: 'ADAPTER_LIST', adapters: listAdapters() });
  publishEndpointStates();

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    switch (msg.type) {
      case 'GET_ADAPTERS':
        sendUi({ type: 'ADAPTER_LIST', adapters: listAdapters() });
        break;
      case 'GET_ENDPOINT_STATUS':
        publishEndpointStates();
        break;
      case 'BIND_ADAPTER':
        selectedAdapterIp = msg.ip || null;
        console.log(`[relay] Adapter selected: ${selectedAdapterIp || 'none'}`);
        break;
      case 'SET_DEVICE_ENDPOINTS':
        applyProtocolEndpoints('modbus', msg.endpoints || []);
        break;
      case 'SET_PROTOCOL_ENDPOINTS':
        if (msg.protocol === 'modbus' || msg.protocol === 'iec61850') {
          applyProtocolEndpoints(msg.protocol, msg.endpoints || []);
        }
        break;
      case 'IED_MODEL':
        // Store the received IED model
        if (msg.protocol && msg.ip && msg.port && msg.model) {
          const key = endpointKey(msg.protocol, msg.ip, msg.port);
          iedModels.set(key, msg.model);
          iedModelRequests.delete(key);
          console.log(`[relay] IED model received for ${msg.ip}:${msg.port} - ${msg.model.name}`);
        }
        break;
      case 'MODBUS_RESP':
        handleModbusResponse(msg);
        break;
      default:
        break;
    }
  });

  ws.on('close', () => {
    if (uiSocket === ws) {
      uiSocket = null;
      if (CLEAR_IEC_ON_UI_DISCONNECT) {
        applyProtocolEndpoints('iec61850', []);
      }
    }
  });
});

wss.on('listening', () => {
  console.log(`[relay] WebSocket control listening on ws://127.0.0.1:${WS_PORT}`);
});

wss.on('error', (err) => {
  console.error(`[relay] WebSocket server error: ${err.message}`);
});

startServers();
setInterval(cleanupTimeouts, 1000);

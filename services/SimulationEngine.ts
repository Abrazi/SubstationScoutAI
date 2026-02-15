
import { IDeviceContext, LogEntry, NetworkPacket, ModbusRegister, BridgeStatus, NetworkAdapter, ControlSession, DebugState, ScriptConfig, GooseState, GooseConfig, BreakpointDetails, DebugExecutionFrame, IEDNode } from '../types';

interface DeviceModbusProfile {
    id: string;
    name: string;
    ip: string;
    port: number;
    unitId: number;
    coils: Map<number, boolean>;
    discreteInputs: Map<number, boolean>;
    holdingRegisters: Map<number, number>;
    inputRegisters: Map<number, number>;
}

interface DeviceIecEndpoint {
    id: string;
    name: string;
    ip: string;
    port: number;
    backendHost: string;
    backendPort: number;
    scdFile?: string;
}

interface BreakpointMeta {
    enabled: boolean;
    condition?: string;
    hitCount?: number;
    hits: number;
}

interface ScriptInstance {
    id: string; // Device ID
    name: string;
    code: string;
    tickRate: number;
    lastRun: number;
    enabled: boolean; // whether this script is enabled (can run)
    generator: GeneratorFunction | null;
    iterator: Generator | null;
    breakpoints: Set<number>;
    breakpointMeta: Map<number, BreakpointMeta>;
    scope: any;
    currentLine: number; // Last executed line for debugger UI
    lastState: any; // Track previous state value
    stateEntryTime: number; // When current state was entered (timestamp)
    stateTimes: Map<string, { entryTime: number, stepTime: number }>; // Track time for all states
    executionHistory: DebugExecutionFrame[];
}

/**
 * SimulationEngine
 * 
 * Acts as the centralized "Backend" for the frontend application.
 * Manages the memory map for Modbus registers and executes
 * the user's control logic in a deterministic loop.
 */
export class SimulationEngine {
  // Memory Maps
  private coils: Map<number, boolean> = new Map();
  private discreteInputs: Map<number, boolean> = new Map();
  private holdingRegisters: Map<number, number> = new Map();
  private inputRegisters: Map<number, number> = new Map();

  // IEC 61850 Data Model State (Path -> Value)
  private iedValues: Map<string, any> = new Map();
  
  // IED Model Registry (IED Name -> IEDNode tree)
  private iedModels: Map<string, IEDNode> = new Map();

  // IEC 61850 Control Sessions (SBO)
  private activeControls: Map<string, ControlSession> = new Map();
  
  // IEC 61850 GOOSE Publishers
  private goosePublishers: Map<string, GooseState & { config: GooseConfig, datasetEntries: string[] }> = new Map();

  // Modbus Server Config
  private modbusConfig = {
    enabled: true,
    port: 502,
    unitId: 1
  };
    private modbusProfilesByIp: Map<string, DeviceModbusProfile> = new Map();
    private modbusProfileIpByName: Map<string, string> = new Map();

  // Bridge State
  private bridgeWs: WebSocket | null = null;
  private bridgeStatus: BridgeStatus = {
    connected: false,
        url: 'ws://127.0.0.1:34001',
    adapters: [],
    selectedAdapter: null,
    rxCount: 0,
        txCount: 0,
        lastError: undefined,
        lastRoute: undefined,
        boundEndpoints: []
  };
  private bridgeCallback: ((status: BridgeStatus) => void) | null = null;
    private pendingBridgeModbusEndpoints: Array<{ ip: string; port: number; name: string; unitId: number }> = [];
    private pendingBridgeIecEndpoints: DeviceIecEndpoint[] = [];

  // Runtime State
  private isRunning: boolean = false;
  private intervalId: any = null;
  
  // Scripts & Debugger State
  private scripts: Map<string, ScriptInstance> = new Map();
  private isPaused: boolean = false;
  private debugTargetId: string | null = null; // Which script caused the pause
  private stepMode: boolean = false; 

  private logs: LogEntry[] = [];
  private logCallback: ((log: LogEntry) => void) | null = null;
  private debugStateCallback: ((state: DebugState) => void) | null = null;
  
  // Network Tap State
  private packetListeners: Set<(packet: NetworkPacket) => void> = new Set();
  private packetIdCounter = 1;

  constructor() {
    this.initializeMemory();
  }

  private initializeMemory() {
    this.coils.set(1, false); 
    this.coils.set(2, true);  
    this.discreteInputs.set(10001, true); 
    this.discreteInputs.set(10002, false);
    this.inputRegisters.set(30001, 12450); 
    this.inputRegisters.set(30002, 6000); 
    this.holdingRegisters.set(40001, 50); 
    this.holdingRegisters.set(40002, 1000); 
  }

  public loadProfile(registers: ModbusRegister[]) {
    this.coils.clear();
    this.discreteInputs.clear();
    this.holdingRegisters.clear();
    this.inputRegisters.clear();

    registers.forEach(reg => {
      const addr = Number(reg.address);
      const val = reg.value;

      switch(reg.type) {
        case 'Coil': this.coils.set(addr, Boolean(val)); break;
        case 'DiscreteInput': this.discreteInputs.set(addr, Boolean(val)); break;
        case 'HoldingRegister': this.holdingRegisters.set(addr, Number(val)); break;
        case 'InputRegister': this.inputRegisters.set(addr, Number(val)); break;
      }
    });

    this.emitLog('info', `Engine profile loaded with ${registers.length} registers.`);
  }

  private normalizeIp(ip: string | undefined): string {
      return String(ip || '').replace(/^::ffff:/, '').trim();
  }

  public syncModbusDevices(devices: IEDNode[]) {
      const byIp = new Map<string, DeviceModbusProfile>();
      const ipByName = new Map<string, string>();

      devices.forEach(device => {
          const ip = this.normalizeIp(device.config?.ip);
          if (!ip || !device.config?.modbusMap) return;

          const profile: DeviceModbusProfile = {
              id: device.id,
              name: device.name,
              ip,
              port: device.config.modbusPort ?? 502,
              unitId: device.config.modbusUnitId ?? 1,
              coils: new Map(),
              discreteInputs: new Map(),
              holdingRegisters: new Map(),
              inputRegisters: new Map()
          };

          device.config.modbusMap.forEach(reg => {
              const addr = Number(reg.address);
              const value = reg.value;
              switch (reg.type) {
                  case 'Coil': profile.coils.set(addr, Boolean(value)); break;
                  case 'DiscreteInput': profile.discreteInputs.set(addr, Boolean(value)); break;
                  case 'HoldingRegister': profile.holdingRegisters.set(addr, Number(value)); break;
                  case 'InputRegister': profile.inputRegisters.set(addr, Number(value)); break;
              }
          });

          byIp.set(ip, profile);
          ipByName.set(device.name, ip);
      });

      this.modbusProfilesByIp = byIp;
      this.modbusProfileIpByName = ipByName;
      this.emitLog('info', `Synced ${this.modbusProfilesByIp.size} Modbus device profiles.`);

      const endpoints = Array.from(this.modbusProfilesByIp.values()).map(profile => ({
          ip: profile.ip,
          port: profile.port,
          name: profile.name,
          unitId: profile.unitId
      }));
      this.pendingBridgeModbusEndpoints = endpoints;
      this.sendBridgeMessage({ type: 'SET_PROTOCOL_ENDPOINTS', protocol: 'modbus', endpoints });
  }

  public syncIecServers(devices: IEDNode[]) {
      const endpoints: DeviceIecEndpoint[] = [];

      devices.forEach(device => {
          const ip = this.normalizeIp(device.config?.mmsIp || device.config?.ip);
          const isServer = (device.config?.role ?? 'server') === 'server';
          const hasIecModel = Array.isArray(device.children) && device.children.length > 0;
          if (!ip || !isServer || !hasIecModel) return;

          endpoints.push({
              id: device.id,
              name: device.name,
              ip,
              port: device.config?.iecMmsPort ?? 102,
              backendHost: device.config?.iecBackendHost || '127.0.0.1',
              backendPort: device.config?.iecBackendPort ?? 8102,
              scdFile: device.config?.iecSclFile
          });
      });

      this.pendingBridgeIecEndpoints = endpoints;
      this.emitLog('info', `Synced ${endpoints.length} IEC 61850 server endpoints.`);
      this.sendBridgeMessage({ type: 'SET_PROTOCOL_ENDPOINTS', protocol: 'iec61850', endpoints });
      
      // Register IED models for relay simulation mode
      devices.forEach(device => {
          const isServer = (device.config?.role ?? 'server') === 'server';
          const hasIecModel = Array.isArray(device.children) && device.children.length > 0;
          const isSimulation = device.config?.iecBackendHost === 'simulation';
          if (isServer && hasIecModel && isSimulation) {
              this.iedModels.set(device.name, device);
          }
      });
  }

  private getProfileBySource(source: string): DeviceModbusProfile | undefined {
      const ip = this.modbusProfileIpByName.get(source);
      return ip ? this.modbusProfilesByIp.get(ip) : undefined;
  }

  // --- Network Bridge ---
  public subscribeToBridge(callback: (status: BridgeStatus) => void) {
    this.bridgeCallback = callback;
    callback(this.bridgeStatus);
  }

  public getBridgeStatus(): BridgeStatus {
    return this.bridgeStatus;
  }

  public connectBridge(url: string) {
    if (this.bridgeWs) {
      this.bridgeWs.close();
    }
    this.bridgeStatus.url = url;
    this.updateBridgeStatus();

    try {
      this.bridgeWs = new WebSocket(url);
      this.bridgeWs.onopen = () => {
        this.bridgeStatus.connected = true;
                this.bridgeStatus.lastError = undefined;
        this.emitLog('info', `Bridge connected to ${url}`);
        this.updateBridgeStatus();
        this.sendBridgeMessage({ type: 'GET_ADAPTERS' });
        this.sendBridgeMessage({ type: 'SET_PROTOCOL_ENDPOINTS', protocol: 'modbus', endpoints: this.pendingBridgeModbusEndpoints });
        this.sendBridgeMessage({ type: 'SET_PROTOCOL_ENDPOINTS', protocol: 'iec61850', endpoints: this.pendingBridgeIecEndpoints });
        this.sendBridgeMessage({ type: 'GET_ENDPOINT_STATUS' });
      };
            this.bridgeWs.onclose = (event) => {
        this.bridgeStatus.connected = false;
        this.bridgeStatus.adapters = [];
                if (event.code !== 1000) {
                    this.bridgeStatus.lastError = `WebSocket closed (code ${event.code})`;
                }
        this.emitLog('warning', 'Bridge disconnected');
        this.updateBridgeStatus();
      };
            this.bridgeWs.onerror = () => {
                this.bridgeStatus.lastError = 'Connection error. Check relay process and bridge URL.';
                this.updateBridgeStatus();
                this.emitLog('error', 'Bridge connection error. Ensure local relay is running.');
      };
      this.bridgeWs.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          this.handleBridgeMessage(msg);
        } catch (e) {
          console.error("Failed to parse bridge message", e);
        }
      };
    } catch (e: any) {
            this.bridgeStatus.lastError = e.message;
            this.updateBridgeStatus();
      this.emitLog('error', `Failed to connect bridge: ${e.message}`);
    }
  }

  public disconnectBridge() {
      if (this.bridgeWs) {
          this.bridgeWs.close();
          this.bridgeWs = null;
      }
  }

  public selectAdapter(adapterIp: string) {
      this.bridgeStatus.selectedAdapter = adapterIp;
      this.sendBridgeMessage({ type: 'BIND_ADAPTER', ip: adapterIp });
      this.updateBridgeStatus();
      this.emitLog('info', `Binding simulation to network interface: ${adapterIp}`);
  }

  private sendBridgeMessage(msg: any) {
      if (this.bridgeWs && this.bridgeWs.readyState === WebSocket.OPEN) {
          this.bridgeWs.send(JSON.stringify(msg));
          this.bridgeStatus.txCount++;
          this.updateBridgeStatus();
      }
  }

  private updateBridgeStatus() {
      if (this.bridgeCallback) {
          this.bridgeCallback({ ...this.bridgeStatus });
      }
  }

  private handleBridgeMessage(msg: any) {
      this.bridgeStatus.rxCount++;
      this.updateBridgeStatus();

      switch (msg.type) {
          case 'ADAPTER_LIST':
              this.bridgeStatus.adapters = msg.adapters || [];
              this.updateBridgeStatus();
              break;
          case 'GET_IED_MODEL':
              // Relay is requesting IED model for simulation mode
              if (msg.iedName) {
                  const iedModel = this.iedModels.get(msg.iedName);
                  if (iedModel) {
                      this.sendBridgeMessage({
                          type: 'IED_MODEL',
                          protocol: msg.protocol || 'iec61850',
                          ip: msg.ip,
                          port: msg.port,
                          model: iedModel
                      });
                      this.emitLog('info', `Sent IED model for ${msg.iedName} to relay`);
                  } else {
                      this.emitLog('warning', `Relay requested IED model for ${msg.iedName}, but not found`);
                  }
              }
              break;
          case 'MODBUS_CMD':
              this.processExternalModbusCommand(msg);
              break;
          case 'MODBUS_TRACE':
              this.emitLog('packet', `[Relay ${msg.direction || 'trace'}] ${msg.source || 'peer'} TID=${msg.transId} FC=${msg.fc} Unit=${msg.unitId}${msg.exceptionCode ? ` EX=${msg.exceptionCode}` : ''}`);
              break;
          case 'IEC_TRACE':
              this.emitLog('mms', `[Relay ${msg.direction || 'trace'}] ${msg.source || 'peer'} -> ${msg.targetIp || 'unknown'}:${msg.targetPort || 102} (${msg.bytes || 0} bytes)`);
              this.emitPacket('MMS', msg.source || 'External IEC Client', msg.targetIp || 'IEC Server', msg.info || 'IEC 61850 TCP payload', {
                  bytes: msg.bytes,
                  targetIp: msg.targetIp,
                  targetPort: msg.targetPort
              });
              break;
          case 'ENDPOINT_STATUS_LIST':
              this.bridgeStatus.boundEndpoints = Array.isArray(msg.endpoints) ? msg.endpoints : [];
              this.updateBridgeStatus();
              break;
          default:
              break;
      }
  }

  private processExternalModbusCommand(cmd: any) {
      const { transId, unitId, fc, addr, val, len, source, targetIp } = cmd;

      const srcLabel = source || 'External Master';
      const normalizedTargetIp = this.normalizeIp(targetIp);
      const targetProfile = this.modbusProfilesByIp.get(normalizedTargetIp);
    const targetDeviceName = targetProfile?.name || 'Default Engine Profile';
    this.bridgeStatus.lastRoute = `${normalizedTargetIp || 'unknown-ip'} -> ${targetDeviceName}`;
    this.updateBridgeStatus();
      const expectedUnit = targetProfile?.unitId ?? this.modbusConfig.unitId;

      if (expectedUnit !== unitId && unitId !== 0) {
          this.emitLog('warning', `[Bridge RX] ${srcLabel} Unit ID mismatch (Req=${unitId}, Expected=${expectedUnit}) - processing anyway`);
      }
      const reqDesc = [
          `TID=${transId}`,
          `FC=${fc}`,
          `Unit=${unitId}`,
          `Addr=${addr}`,
          len !== undefined ? `Len=${len}` : undefined,
          val !== undefined ? `Val=${val}` : undefined
      ].filter(Boolean).join(' ');
      this.emitLog('packet', `[Bridge RX] ${srcLabel} -> ${reqDesc}`);
      this.emitPacket('ModbusTCP', srcLabel, targetDeviceName, `RX FC${fc} Addr ${addr}${len !== undefined ? ` Len ${len}` : ''}`, {
          transId,
          unitId,
          fc,
          addr,
          len,
          val,
          targetIp: normalizedTargetIp,
          route: targetDeviceName
      });

      let responseData: any = {};
      let exceptionCode = 0;

      const coils = targetProfile?.coils ?? this.coils;
      const discreteInputs = targetProfile?.discreteInputs ?? this.discreteInputs;
      const holdingRegisters = targetProfile?.holdingRegisters ?? this.holdingRegisters;
      const inputRegisters = targetProfile?.inputRegisters ?? this.inputRegisters;

      switch (fc) {
          case 1: if (!this.checkAddressRange(coils, addr, len || 1)) exceptionCode = 2; else responseData.data = this.readRange(coils, addr, len || 1); break;
          case 2: if (!this.checkAddressRange(discreteInputs, addr, len || 1)) exceptionCode = 2; else responseData.data = this.readRange(discreteInputs, addr, len || 1); break;
          case 3: if (!this.checkAddressRange(holdingRegisters, addr, len || 1)) exceptionCode = 2; else responseData.data = this.readRange(holdingRegisters, addr, len || 1); break;
          case 4: if (!this.checkAddressRange(inputRegisters, addr, len || 1)) exceptionCode = 2; else responseData.data = this.readRange(inputRegisters, addr, len || 1); break;
          case 5:
              if (!coils.has(addr)) exceptionCode = 2;
              else {
                  coils.set(addr, !!val);
                  responseData = { addr, val: !!val ? 1 : 0 };
              }
              break;
          case 6:
              if (!holdingRegisters.has(addr)) exceptionCode = 2;
              else if (val < 0 || val > 65535) exceptionCode = 3;
              else {
                  holdingRegisters.set(addr, Number(val));
                  responseData = { addr, val: Number(val) };
              }
              break;
          default: exceptionCode = 1;
      }

      if (exceptionCode === 0 && (fc === 1 || fc === 2 || fc === 3 || fc === 4)) {
          const count = Array.isArray(responseData.data) ? responseData.data.length : 0;
          this.emitPacket('ModbusTCP', srcLabel, 'Server', `Read FC${fc} Addr ${addr} Len ${count}`, { fc, addr, len: count });
      }

      const respDesc = exceptionCode > 0
          ? `EX=${exceptionCode}`
          : (responseData.data ? `Data=[${(responseData.data as any[]).join(',')}]` : `Addr=${responseData.addr ?? addr} Val=${responseData.val ?? val}`);
      this.emitLog('packet', `[Bridge TX] Server -> ${srcLabel} TID=${transId} FC=${fc} ${respDesc}`);
      this.emitPacket('ModbusTCP', targetDeviceName, srcLabel, `TX FC${fc} ${exceptionCode > 0 ? `EX ${exceptionCode}` : 'OK'}`, {
          transId,
          unitId,
          fc,
          exceptionCode,
          ...responseData,
          targetIp: normalizedTargetIp,
          route: targetDeviceName
      });

      this.sendBridgeMessage({ type: 'MODBUS_RESP', transId, unitId, fc, exceptionCode, ...responseData });
  }

  private checkAddressRange(map: Map<number, any>, start: number, len: number): boolean {
      for (let i = 0; i < len; i++) { if (!map.has(start + i)) return false; }
      return true;
  }

  private readRange(map: Map<number, any>, start: number, len: number): number[] {
      const res: number[] = [];
      for (let i = 0; i < len; i++) { res.push(Number(map.get(start + i)) || 0); }
      return res;
  }

  private handleException(code: number, context: string, source: string) {
      if (!this.modbusConfig.enabled) return;
      const exceptions: Record<number, string> = { 1: 'Illegal Function', 2: 'Illegal Data Address', 3: 'Illegal Data Value', 4: 'Slave Device Failure' };
      const errorMsg = exceptions[code] || 'Unknown Exception';
      this.emitLog('error', `Modbus Exception ${code} (${errorMsg}): ${context}`);
      this.emitPacket('ModbusTCP', 'Server', source, `Exception ${code}: ${errorMsg}`, { exceptionCode: code, context });
  }

  // --- Public API ---

  public subscribeToLogs(callback: (log: LogEntry) => void) { this.logCallback = callback; }
  
  public subscribeToTraffic(callback: (packet: NetworkPacket) => void): () => void { 
      this.packetListeners.add(callback);
      return () => this.packetListeners.delete(callback);
  }
  
  public subscribeToDebug(callback: (state: DebugState) => void) { 
      this.debugStateCallback = callback; 
      this.emitDebugState(); // Initial state
  }

  public getCoil(addr: number, source: string = 'System'): boolean {
      const profile = this.getProfileBySource(source);
      if (profile && profile.coils.has(addr)) return profile.coils.get(addr) || false;
      return this.coils.get(addr) || false;
  }
  public setCoil(addr: number, val: boolean, source: string = 'Logic') { 
      this.coils.set(addr, val);
      const profile = this.getProfileBySource(source);
      if (profile) profile.coils.set(addr, val);
      const isMasterWrite = source === 'Client Master' || source === 'External Master';
      if (isMasterWrite && this.modbusConfig.enabled) this.emitPacket('ModbusTCP', source, 'Server', `Write Coil ${addr}: ${val}`, { fc: 5, addr, val });
  }
  public getRegister(addr: number, source: string = 'System'): number {
      const profile = this.getProfileBySource(source);
      if (profile && profile.holdingRegisters.has(addr)) return profile.holdingRegisters.get(addr) || 0;
      return this.holdingRegisters.get(addr) || 0;
  }
  public setRegister(addr: number, val: number, source: string = 'Logic') { 
      this.holdingRegisters.set(addr, val);
      const profile = this.getProfileBySource(source);
      if (profile) profile.holdingRegisters.set(addr, val);
      const isMasterWrite = source === 'Client Master' || source === 'External Master';
      if (isMasterWrite && this.modbusConfig.enabled) this.emitPacket('ModbusTCP', source, 'Server', `Write Register ${addr}: ${val}`, { fc: 6, addr, val });
  }
  public getInputRegister(addr: number, source: string = 'System'): number {
      const profile = this.getProfileBySource(source);
      if (profile && profile.inputRegisters.has(addr)) return profile.inputRegisters.get(addr) || 0;
      return this.inputRegisters.get(addr) || 0;
  }
  public getDiscreteInput(addr: number, source: string = 'System'): boolean {
      const profile = this.getProfileBySource(source);
      if (profile && profile.discreteInputs.has(addr)) return profile.discreteInputs.get(addr) || false;
      return this.discreteInputs.get(addr) || false;
  }

  public getModbusConfig() { return { ...this.modbusConfig }; }
  public setModbusConfig(config: { enabled: boolean; port: number; unitId: number }) { this.modbusConfig = config; }

  // --- GOOSE Publishing Logic ---

  /**
   * Called automatically when a device is registered if it has gooseConfig
   * Or can be called manually to setup a publisher.
   */
  public registerGoosePublisher(controlPath: string, config: GooseConfig, datasetEntries: string[]) {
      this.goosePublishers.set(controlPath, {
          config,
          datasetEntries,
          enabled: true,
          stNum: 1,
          sqNum: 0,
          timeAllowedToLive: config.maxTime * 2,
          timestamp: Date.now(),
          nextTx: Date.now() + 100,
          currentInterval: config.maxTime, // Start at steady state
          burstMode: false,
          data: {} // Will be populated on read
      });
      // Initial population of data
      datasetEntries.forEach(path => {
          const state = this.goosePublishers.get(controlPath);
          if (state) state.data[path] = this.readMMS(path);
      });
      this.emitLog('info', `Registered GOOSE Publisher: ${controlPath} (AppID: ${config.appID})`);
  }

  public registerDeviceGoose(controlBlockPath: string, config: GooseConfig, datasetEntries: string[]) {
      this.registerGoosePublisher(controlBlockPath, config, datasetEntries);
  }

  public updateGooseConfig(controlPath: string, config: GooseConfig) {
      const state = this.goosePublishers.get(controlPath);
      if (state) {
          state.config = config;
          // Trigger immediate update
          state.burstMode = true;
          state.currentInterval = config.minTime;
          state.nextTx = Date.now();
          // Assume configuration change implies potential data structure or ID change, so bump stNum or confRev logic might apply?
          // Usually changing config parameters like AppID requires re-evaluating the stream.
          // We will just log it for now.
          this.emitLog('info', `Updated GOOSE Config for ${controlPath} (AppID: ${config.appID})`);
      }
  }

  public updateGooseDataset(datasetPath: string, newEntries: string[]) {
      let updatedCount = 0;
      this.goosePublishers.forEach((state, controlPath) => {
          // Check if this publisher uses the updated dataset
          // Paths might vary slightly (absolute vs relative), checking for suffix match as fallback
          if (state.config.datSet === datasetPath || datasetPath.endsWith(state.config.datSet) || state.config.datSet.endsWith(datasetPath)) {
              state.datasetEntries = newEntries;
              
              // Trigger Burst
              state.burstMode = true;
              state.stNum++;
              state.sqNum = 0;
              state.currentInterval = state.config.minTime;
              state.nextTx = Date.now();
              
              updatedCount++;
              this.emitLog('info', `Dataset Updated for ${state.config.appID}. New Size: ${newEntries.length}`);
              
              // Refresh cache
              newEntries.forEach(path => {
                  state.data[path] = this.readMMS(path);
              });
          }
      });
      
      if (updatedCount === 0) {
          this.emitLog('warning', `No active GOOSE Control Blocks found using dataset: ${datasetPath}`);
      }
  }

  private checkGooseTriggers(changedPath: string, newValue: any) {
      // Find any GOOSE publisher that includes this path in its dataset
      this.goosePublishers.forEach((state, controlPath) => {
          if (!state.enabled) return;
          
          if (state.datasetEntries.includes(changedPath)) {
              // DATA CHANGE DETECTED!
              // 1. Update State Cache
              state.data[changedPath] = newValue;
              
              // 2. Increment Status Number (stNum)
              state.stNum++;
              
              // 3. Reset Sequence Number (sqNum)
              state.sqNum = 0;
              
              // 4. Enter Burst Mode (Fast retransmission)
              state.burstMode = true;
              state.currentInterval = state.config.minTime;
              state.nextTx = Date.now(); // Transmit immediately
              
              this.emitLog('goose', `GOOSE Trigger: ${state.config.appID} stNum=${state.stNum} (Change in ${changedPath})`);
          }
      });
  }

  private runGooseCycle() {
      const now = Date.now();
      
      this.goosePublishers.forEach((state, controlPath) => {
          if (!state.enabled) return;

          if (now >= state.nextTx) {
              this.publishGoosePacket(controlPath, state);
              
              // Schedule next
              if (state.sqNum === 0) {
                   // First packet sent after change. Next is minTime.
                   state.currentInterval = state.config.minTime;
              } else {
                   // Subsequent retransmissions, double interval until max
                   if (state.currentInterval < state.config.maxTime) {
                      state.currentInterval = Math.min(state.currentInterval * 2, state.config.maxTime);
                   }
              }
              
              // Increment sequence number for next packet
              state.sqNum++;
              state.timestamp = now;
              state.nextTx = now + state.currentInterval;
          }
      });
  }

  private publishGoosePacket(controlPath: string, state: GooseState & { config: GooseConfig, datasetEntries: string[] }) {
      // Populate latest values from MMS map (or cache)
      const payload: Record<string, any> = {};
      state.datasetEntries.forEach(path => {
          payload[path] = this.iedValues.get(path) ?? 'N/A';
      });

      // Construct Packet Info
      const info = `AppID: ${state.config.appID}, stNum: ${state.stNum}, sqNum: ${state.sqNum}`;
      const src = controlPath.split('/')[0]; // Extract IED Name
      
      this.emitPacket('GOOSE', src, 'Multicast', info, {
          controlBlock: controlPath,
          datSet: state.config.datSet,
          goCBRef: controlPath,
          timeAllowedToLive: state.currentInterval * 2,
          confRev: state.config.confRev,
          ...payload
      });
  }

  // --- End GOOSE Logic ---

  public writeMMS(path: string, value: any, source: string = 'Client'): { success: boolean, error?: string } {
    const oldValue = this.iedValues.get(path);
    this.iedValues.set(path, value);
    
    // Check if this triggers any GOOSE messages
    if (oldValue !== value) {
        this.checkGooseTriggers(path, value);
    }

    this.emitLog('mms', `Write Success: ${path} = ${value} [Src: ${source}]`);
    this.emitPacket('MMS', source, 'Server', `MMS Write: ${path}`, { path, value });
    return { success: true };
  }

  public readMMS(path: string): any { return this.iedValues.get(path); }
  
  public initializeData(data: Map<string, any>) {
      data.forEach((val, key) => {
          this.iedValues.set(key, val);
      });
      this.emitLog('info', `Initialized ${data.size} IEC 61850 data points.`);
  }

  private checkInterlocking(doPath: string, opValue?: any): boolean {
    // 1. Resolve Parent LN path (e.g., IED1LD0/XCBR1)
    const lnPath = doPath.split('.').slice(0, -1).join('.');
    
    // 2. Specific Check for Circuit Breaker (XCBR)
    if (doPath.includes('XCBR')) {
        // If Operating to OPEN ('off'), check BlkOpn
        if (opValue === 'off') {
            const blkOpn = this.readMMS(`${lnPath}.BlkOpn.stVal`);
            if (blkOpn === true || blkOpn === 'true') {
                 this.emitLog('warning', `Interlock: Operation Blocked by BlkOpn`);
                 return false;
            }
        }
        // If Operating to CLOSE ('on'), check BlkCls
        if (opValue === 'on') {
            const blkCls = this.readMMS(`${lnPath}.BlkCls.stVal`);
            if (blkCls === true || blkCls === 'true') {
                 this.emitLog('warning', `Interlock: Operation Blocked by BlkCls`);
                 return false;
            }
        }
    }

    // 3. Generic Global Interlock (Simulation)
    if (this.coils.get(999)) return false; 
    
    return true; 
  }

  public selectControl(doPath: string, client: string = 'ScoutClient'): { success: boolean, error?: string } {
      const controlModel = this.readMMS(`${doPath}.ctlModel`);
      
      if (!controlModel || (!controlModel.includes('sbo'))) {
          // If it's direct, selection is not allowed/needed
          return { success: false, error: "Control Model does not support Selection" };
      }

      // Check if already selected by another client
      if (this.activeControls.has(doPath)) {
          const session = this.activeControls.get(doPath);
          if (session && session.client !== client) {
               // Verify it hasn't expired
               if (Date.now() < session.expiryTime) {
                    return { success: false, error: "Locked by another client" };
               }
          }
      }

      // Enhanced Security: Check Interlocks during Selection
      if (controlModel.includes('enhanced')) {
          const interlockOk = this.checkInterlocking(doPath);
          if (!interlockOk) {
              this.emitLog('warning', `Select Failed: Interlock Check blocked for ${doPath}`);
              this.emitPacket('MMS', 'Server', client, `Select Response: AccessDenied (Interlock)`, { error: 'Interlock' });
              return { success: false, error: "Interlock Blocked" };
          }
      }

      const timeoutMs = Number(this.readMMS(`${doPath}.sboTimeout`)) || 30000;
      this.activeControls.set(doPath, { path: doPath, client, expiryTime: Date.now() + timeoutMs, value: null });
      this.emitLog('mms', `Select Success: ${doPath} (Expires: ${timeoutMs}ms)`);
      this.emitPacket('MMS', 'Server', client, `Select Response: Success`);
      
      return { success: true };
  }

  public operateControl(doPath: string, value: any, client: string = 'ScoutClient'): { success: boolean, error?: string } {
      const controlModel = this.readMMS(`${doPath}.ctlModel`) || 'status-only';
      
      // SBO Check
      if (controlModel.includes('sbo')) {
          const session = this.activeControls.get(doPath);
          
          if (!session) return { success: false, error: "Not Selected" };
          
          // Check Expiry
          if (Date.now() > session.expiryTime) {
              this.activeControls.delete(doPath);
              return { success: false, error: "Selection Expired" };
          }
          
          if (session.client !== client) return { success: false, error: "Client Mismatch" };
      } 
      
      // Interlock Check (For Direct-Enhanced OR SBO-Enhanced)
      if (controlModel.includes('enhanced')) {
          if (!this.checkInterlocking(doPath, value)) {
              return { success: false, error: "Interlock Blocked" };
          }
      }

      // Perform Operation
      // Map 'on'/'off' to boolean logic if needed or store as enum
      const oldValue = this.iedValues.get(`${doPath}.stVal`);
      this.iedValues.set(`${doPath}.stVal`, value);
      
      // Check GOOSE Triggers
      if (oldValue !== value) {
          this.checkGooseTriggers(`${doPath}.stVal`, value);
      }

      // Cleanup SBO session
      if (controlModel.includes('sbo')) {
          this.activeControls.delete(doPath);
      }
      
      // Sync known simulation hooks for dashboard visual
      if (doPath.includes('XCBR') && doPath.includes('Pos')) {
           // 'on' = Closed = Coil True
           // 'off' = Open = Coil False
           const coilState = (value === 'on');
           this.setCoil(2, coilState, 'IEC61850');
      }
      
      this.emitLog('mms', `Operate Success: ${doPath} = ${value}`);
      this.emitPacket('MMS', 'Server', client, `Operate Response: Success`, { value });
      return { success: true };
  }

  public cancelControl(doPath: string): { success: boolean } {
      if (this.activeControls.has(doPath)) {
        this.activeControls.delete(doPath);
        this.emitLog('mms', `Select Cancelled: ${doPath}`);
        return { success: true };
      }
      return { success: false };
  }

  public getControlSession(doPath: string): ControlSession | undefined { 
      const session = this.activeControls.get(doPath);
      if (session) {
          // Lazy expiry check
          if (Date.now() > session.expiryTime) {
              this.activeControls.delete(doPath);
              return undefined;
          }
          return session;
      }
      return undefined; 
  }

  // --- Logic Runtime & Debugger ---

  /**
   * Register or Get Script Instance
   */
  private getScriptInstance(id: string, name: string): ScriptInstance {
      if (!this.scripts.has(id)) {
          this.scripts.set(id, {
              id,
              name,
              code: '',
              tickRate: 100, // Default 100ms
              lastRun: 0,
              enabled: true, // default enabled
              generator: null,
              iterator: null,
              breakpoints: new Set(),
              breakpointMeta: new Map(),
              scope: {},
              currentLine: 0,
              lastState: undefined,
              stateEntryTime: Date.now(),
              stateTimes: new Map(),
              executionHistory: []
          });
      }
      return this.scripts.get(id)!;
  }
  
  public unregisterDevice(id: string) {
      if (this.scripts.has(id)) {
          this.scripts.delete(id);
          this.emitLog('info', `Device unregistered: ${id}`);
      }
  }

  public getScriptConfig(id: string): ScriptConfig | null {
      const script = this.scripts.get(id);
      if (!script) return null;
      return { deviceId: script.id, code: script.code, tickRate: script.tickRate };
  }

  // NEW: start/stop a single device script without stopping the entire engine
  public startScript(deviceId: string): boolean {
      const script = this.scripts.get(deviceId);
      if (!script) return false;
      script.enabled = true;
      // If engine is not running start the global loop so enabled scripts execute
      if (!this.isRunning) this.start();
      this.emitDebugState();
      this.emitLog('info', `Script started for device: ${deviceId}`);
      return true;
  }

  public stopScript(deviceId: string): boolean {
      const script = this.scripts.get(deviceId);
      if (!script) return false;
      script.enabled = false;
      // Reset execution state for that script only
      script.iterator = null;
      script.currentLine = 0;
      this.emitDebugState();
      this.emitLog('warning', `Script stopped for device: ${deviceId}`);
      return true;
  }

  public isScriptEnabled(deviceId: string): boolean {
      const script = this.scripts.get(deviceId);
      if (!script) return false;
      return !!script.enabled;
  }

  public updateScriptConfig(config: ScriptConfig) {
      // Create script instance if it doesn't exist
      let script = this.scripts.get(config.deviceId);
      
      if (!script) {
          // Implicitly register via getScriptInstance
          script = this.getScriptInstance(config.deviceId, `Device_${config.deviceId}`);
      }
      
      if (script) {
          script.tickRate = config.tickRate;
          // Recompile only if code changed
          if (script.code !== config.code) {
             this.compile(config.deviceId, config.code);
          }
      }
  }

  public compile(deviceId: string, sourceCode: string): { success: boolean; error?: string } {
    let wrappedCode = ''; // Declare outside try block for error logging
    try {
      const script = this.scripts.get(deviceId);
      if (!script) return { success: false, error: "Device not found" };

      script.code = sourceCode;

      // 0. Strip PLC-style block comments while preserving line count so debugger
      //    line numbers stay synchronized with the original editor source.
      const stripCommentsPreserveLines = (text: string) => {
          return text.replace(/\(\*[\s\S]*?\*\)/g, (match) => {
              const newlineCount = (match.match(/\n/g) || []).length;
              return newlineCount > 0 ? '\n'.repeat(newlineCount) : ' ';
          });
      };
      let cleanedSource = stripCommentsPreserveLines(sourceCode);

      // 0.a Convert VAR...END_VAR blocks into `scope.<name>` initializations so
      //     declarations like `X : INT := 1;` become valid JS (`scope.X = 1;`).
      // Use __ASSIGN__ placeholder to avoid interference with later = → === transformation
      cleanedSource = cleanedSource.replace(/VAR([\s\S]*?)END_VAR/g, (_m, inner) => {
          return inner.split('\n').map(l => {
              const mInit = l.match(/^\s*([A-Za-z_][\w]*)\s*:\s*[A-Za-z_][\w]*\s*:=\s*(.+);?\s*$/);
              if (mInit) return `scope.${mInit[1]} __ASSIGN__ ${mInit[2]};`;
              const mNoInit = l.match(/^\s*([A-Za-z_][\w]*)\s*:\s*[A-Za-z_][\w]*\s*;?\s*$/);
              if (mNoInit) return `scope.${mNoInit[1]} __ASSIGN__ scope.${mNoInit[1]};`;
              return l;
          }).join('\n');
      });

      // 1. Line-by-Line Instrumentation and Syntax Translation
      const lines = cleanedSource.split('\n');
      const instrumentedLines = lines.map((line, idx) => {
          const lineNum = idx + 1;
          
          // Per-line safety: remove any inline ST comments that survived global stripping
          let jsLine = line.replace(/\(\*[\s\S]*?\*\)/g, "");
          
          jsLine = jsLine
            .replace(/Device\.ReadInput\('(\d+)'\)/g, "ctx.readInput($1)")
            .replace(/Device\.WriteCoil\('(\d+)',\s*(.*)\)/g, "ctx.writeCoil($1, $2)")
            .replace(/Device\.SetDA\('([^']+)',\s*(.*)\)/g, "ctx.setDAValue('$1', $2)")
            .replace(/Device\.GetDA\('([^']+)'\)/g, "ctx.getDAValue('$1')")
            .replace(/Device\.Log\((.*)\)/g, "ctx.Log($1)")
            .replace(/Device\.ReadRegister\('(\d+)'\)/g, "ctx.readRegister($1)")
            .replace(/Device\.WriteRegister\('(\d+)',\s*(.*)\)/g, "ctx.writeRegister($1, $2)")
            
            // IEC 61131-3 ST Syntax to JS conversions
            // Handle assignment vs. comparison carefully:
            // In ST: ":=" is assignment, "=" is comparison (equality)
            .replace(/:=/g, "__ASSIGN__") // Temp placeholder for assignment
            .replace(/(?<![<>!=])=(?!=)/g, "===") // Comparison: = to ===, but not >=, <=, !=, ==
            .replace(/__ASSIGN__/g, "=") // Now convert assignment placeholder to =
            .replace(/<>/g, "!==") // Inequality
            .replace(/\bTRUE\b/g, "true")
            .replace(/\bFALSE\b/g, "false")
            .replace(/\bAND\b/g, "&&")
            .replace(/\bOR\b/g, "||")
            .replace(/\bNOT\b/g, "!")
            .replace(/\bIF\s+(.*?)\s+THEN/g, "if ($1) {")
            .replace(/\bELSIF\s+(.*?)\s+THEN/g, "} else if ($1) {")
            .replace(/\bELSE\b/g, "} else {")
            .replace(/\bEND_IF;/g, "}")
            .replace(/\bWHILE\s+(.*)\s+DO/g, "while ($1) {")
            .replace(/\bEND_WHILE;/g, "}")
            
            // Math Functions mapping
            .replace(/\bSQRT\(/g, "Math.sqrt(")
            .replace(/\bABS\(/g, "Math.abs(")
            .replace(/\bTO_INT\(/g, "Math.floor(")
            .replace(/\bTRUNC\(/g, "Math.trunc(")
            .replace(/\bREAL_TO_INT\(/g, "Math.floor(")
            .replace(/\bMOD\b/g, "%")
            
            // Variable Declaration Stripping (Simulated Scope)
            .replace(/\bVAR\s+([a-zA-Z0-9_]+)(\s*:\s*[a-zA-Z0-9_]+)?\s*;/g, "") // remove var decls without init
            .replace(/\bVAR\s+([a-zA-Z0-9_]+)/g, "scope.$1") // replace var X with scope.X
            .replace(/\bEND_VAR\b/g, "") // remove block end
            
            // Function Blocks (Cleanup)
            .replace(/FUNCTION_BLOCK.*$/gm, "")
            .replace(/END_FUNCTION_BLOCK/gm, "");

          return `yield ${lineNum}; ${jsLine}`;
      });

      wrappedCode = `
        return function* (ctx, scope) {
           with(scope) {
              ${instrumentedLines.join('\n')}
           }
        }
      `;

      // eslint-disable-next-line no-new-func
      script.generator = new Function(wrappedCode)();
      script.scope = {}; // Reset scope
      script.iterator = null; // Reset execution state
    script.currentLine = 0;
    script.stateTimes = new Map();
    script.executionHistory = [];
      
      return { success: true };
    } catch (e: any) {
      // Emit console message to help debugging of ST->JS translation/runtime issues
      try { console.error(`[SimulationEngine.compile] device=${deviceId} error=`, e && e.message, '\nwrappedCode snippet:\n', (wrappedCode || '').toString().slice(0, 400)); } catch(err) {}
      return { success: false, error: e.message };
    }
  }

  public registerDevice(id: string, name: string) {
      this.getScriptInstance(id, name);
  }

  public setBreakpoint(deviceId: string, line: number, enabled: boolean) {
      const script = this.scripts.get(deviceId);
      if (!script) return;
      
      if (enabled) {
          script.breakpoints.add(line);
          if (!script.breakpointMeta.has(line)) {
              script.breakpointMeta.set(line, { enabled: true, hits: 0 });
          } else {
              const prev = script.breakpointMeta.get(line)!;
              script.breakpointMeta.set(line, { ...prev, enabled: true });
          }
      } else {
          script.breakpoints.delete(line);
          script.breakpointMeta.delete(line);
      }
      this.emitDebugState();
  }

  public toggleBreakpoint(deviceId: string, line: number) {
      const script = this.scripts.get(deviceId);
      if (!script) return;
      
      if (script.breakpoints.has(line)) {
          script.breakpoints.delete(line);
          script.breakpointMeta.delete(line);
      } else {
          script.breakpoints.add(line);
          script.breakpointMeta.set(line, { enabled: true, hits: 0 });
      }
      this.emitDebugState();
  }

  public setBreakpointOptions(deviceId: string, line: number, options: { condition?: string; hitCount?: number }) {
      const script = this.scripts.get(deviceId);
      if (!script) return;

      if (!script.breakpoints.has(line)) {
          script.breakpoints.add(line);
      }

      const prev = script.breakpointMeta.get(line) || { enabled: true, hits: 0 };
      script.breakpointMeta.set(line, {
          ...prev,
          enabled: true,
          condition: options.condition?.trim() || undefined,
          hitCount: options.hitCount && options.hitCount > 0 ? options.hitCount : undefined
      });
      this.emitDebugState();
  }

  public setDebugVariable(deviceId: string, variableName: string, value: any): boolean {
      const script = this.scripts.get(deviceId);
      if (!script) return false;

      script.scope[variableName] = value;
      this.debugTargetId = deviceId;
      this.emitDebugState();
      return true;
  }

  public start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.isPaused = false;
    this.debugTargetId = null;
    this.emitDebugState();

    this.intervalId = setInterval(() => {
      this.runCycle();
        }, 100); // Match common script tick rates and reduce sustained CPU load
  }

  public stop() {
    this.isRunning = false;
    this.isPaused = false;
    this.debugTargetId = null;
        this.scripts.forEach(s => {
            s.iterator = null;
            s.currentLine = 0;
        });
    if (this.intervalId) clearInterval(this.intervalId);
    this.emitDebugState();
  }

    public pause(deviceId?: string) {
            if (deviceId && this.scripts.has(deviceId)) {
                    this.debugTargetId = deviceId;
            } else if (!this.debugTargetId) {
                    const firstScript = this.scripts.values().next().value as ScriptInstance | undefined;
                    this.debugTargetId = firstScript?.id || null;
            }
      this.isPaused = true;
      this.emitDebugState();
  }

  public resume() {
      this.isPaused = false;
      this.stepMode = false;
      this.debugTargetId = null;
      this.emitDebugState();
  }

  public stepOver() {
      this.isPaused = false;
      this.stepMode = true; // Will pause after one yield of the target script
      this.emitDebugState();
  }

  public stepInto() {
      this.stepOver();
  }

  public stepOut() {
      this.stepOver();
  }

  private evaluateBreakpointCondition(condition: string, scope: any): boolean {
      try {
          // eslint-disable-next-line no-new-func
          const fn = new Function('scope', `with(scope){ return Boolean(${condition}); }`);
          return !!fn(scope);
      } catch {
          return false;
      }
  }

  private buildPseudoCallStack(sourceCode: string, currentLine: number): string[] {
      const lines = sourceCode.split('\n').slice(0, Math.max(0, currentLine));
      const stack: string[] = ['PROGRAM'];

      for (const raw of lines) {
          const line = raw.trim();
          if (!line) continue;

          const ifMatch = line.match(/^IF\s+(.+?)\s+THEN/i);
          const elsifMatch = line.match(/^ELSIF\s+(.+?)\s+THEN/i);
          const whileMatch = line.match(/^WHILE\s+(.+?)\s+DO/i);
          if (ifMatch) stack.push(`IF ${ifMatch[1]}`);
          if (whileMatch) stack.push(`WHILE ${whileMatch[1]}`);
          if (elsifMatch) {
              while (stack.length > 1 && !stack[stack.length - 1].startsWith('IF ')) stack.pop();
              if (stack.length > 1) stack[stack.length - 1] = `ELSIF ${elsifMatch[1]}`;
          }

          if (/^END_IF;$/i.test(line) || /^END_WHILE;$/i.test(line)) {
              if (stack.length > 1) stack.pop();
          }
      }

      return stack;
  }

  private runCycle() {
    // 1. Update Physics (Simple Simulation) - runs every cycle
    // In reality this should be separate, but for mock simulation it's fine
    if (Math.random() > 0.95) this.inputRegisters.set(30002, Math.floor(6000 + (Math.random() * 10 - 5)));
    
    // 2. Manage GOOSE Retransmissions
    this.runGooseCycle();

    // 3. Logic Execution
    if (this.isPaused) return;

    const now = Date.now();

    for (const script of this.scripts.values()) {
        // Skip scripts explicitly disabled (per-device stop)
        if (!script.enabled) continue;
        if (!script.generator) continue;

        // Update stepTime (time in current state in milliseconds)
        const currentState = script.scope.state;
        if (script.lastState !== currentState) {
            // State changed!
            script.lastState = currentState;
            script.stateEntryTime = now;
        }
        // Calculate stepTime in milliseconds
        const currentStepTime = now - script.stateEntryTime;
        script.scope.stepTime = currentStepTime;
        
        // Create state-name based time accessors (e.g., can check STATE_RUNNING_stepTime)
        // First, extract all STATE_* constants from the code on first pass
        if (!script.scope._stateNamesResolved) {
            const stateRegex = /\b(STATE_\w+)\s*:\s*INT\s*:=\s*(\d+)/g;
            let match;
            while ((match = stateRegex.exec(script.code)) !== null) {
                const stateName = match[1];
                const stateValue = parseInt(match[2], 10);
                // Keep numeric value for state comparisons
                script.scope[stateName] = stateValue;
                // Initialize time tracking for this state
                if (!script.stateTimes.has(stateName)) {
                    script.stateTimes.set(stateName, { entryTime: 0, stepTime: 0 });
                }
            }
            script.scope._stateNamesResolved = true;
        }
        
        // Update time tracking for all states and expose as stateName.stepTime
        script.stateTimes.forEach((timeData, stateName) => {
            const stateValue = script.scope[stateName];
            if (currentState === stateValue) {
                // This is the active state
                timeData.entryTime = script.stateEntryTime;
                timeData.stepTime = currentStepTime;
                // Make available as STATE_NAME.stepTime by creating an object
                if (typeof script.scope[stateName] === 'number') {
                    // Replace the numeric constant with an object that has both value and stepTime
                    const stateObj = Object.create(Number.prototype);
                    stateObj.valueOf = function() { return stateValue; };
                    stateObj.toString = function() { return String(stateValue); };
                    stateObj.stepTime = currentStepTime;
                    script.scope[stateName] = stateObj;
                }
            }
        });

        // Check if it's time to run this script
        // Note: If we are in StepMode, we force run the debug target regardless of time
        const isDebugTarget = this.debugTargetId === script.id;
        const timeToRun = (now - script.lastRun) >= script.tickRate;
        
        if (timeToRun || (this.stepMode && isDebugTarget)) {
            
            // Initialize Iterator if needed (start of cycle)
            if (!script.iterator) {
                script.iterator = script.generator(this.createContext(script.name), script.scope);
            }

            try {
                // Execute Loop
                let result;
                let stepsTaken = 0;
                
                // Run until done OR breakpoint
                // To avoid freezing, we limit steps if no breakpoint (e.g. infinite loop protection)
                // But generator yields every line, so we loop over yields
                
                do {
                    result = script.iterator.next();
                    stepsTaken++;
                    
                    if (result.value) { // Line number
                        const line = result.value as number;
                        script.currentLine = line;
                        script.executionHistory.unshift({ timestamp: Date.now(), line, deviceId: script.id });
                        if (script.executionHistory.length > 500) {
                            script.executionHistory.length = 500;
                        }
                        
                        // Check Breakpoint
                        if (script.breakpoints.has(line)) {
                            const bpMeta = script.breakpointMeta.get(line) || { enabled: true, hits: 0 };
                            bpMeta.hits += 1;
                            script.breakpointMeta.set(line, bpMeta);

                            let shouldPause = bpMeta.enabled !== false;
                            if (shouldPause && bpMeta.condition) {
                                shouldPause = this.evaluateBreakpointCondition(bpMeta.condition, script.scope);
                            }
                            if (shouldPause && bpMeta.hitCount && bpMeta.hitCount > 0) {
                                shouldPause = bpMeta.hits >= bpMeta.hitCount;
                            }

                            if (shouldPause) {
                                this.isPaused = true;
                                this.stepMode = false;
                                this.debugTargetId = script.id;
                                this.emitDebugState();
                                return; // Stop EVERYTHING
                            }
                        }

                        // Check Step Mode
                        if (this.stepMode && isDebugTarget) {
                            this.isPaused = true;
                            this.stepMode = false;
                            // debugTargetId remains same
                            this.emitDebugState();
                            return; 
                        }
                    }
                    
                    // Safety break for long loops in one tick? 
                    // For now assume scripts are small
                } while (!result.done);

                // End of script cycle
                if (result.done) {
                    script.iterator = null; // Reset
                    script.lastRun = now;
                    
                    // If we stepped off the end
                    if (this.stepMode && isDebugTarget) {
                         this.isPaused = true;
                         this.stepMode = false;
                         this.emitDebugState();
                         return;
                    }
                }
                
            } catch (e: any) {
                this.emitLog('error', `Runtime Error in ${script.name}: ${e.message}`);
                // Stop just this script or everything?
                // Let's stop everything to alert user
                this.stop();
                return;
            }
        }
    }
  }

  private emitDebugState() {
      if (this.debugStateCallback) {
          // Find the active script context to send variables
          const targetScript = this.debugTargetId ? this.scripts.get(this.debugTargetId) : null;
          
          this.debugStateCallback({
              isRunning: this.isRunning,
              isPaused: this.isPaused,
              activeDeviceId: this.debugTargetId,
              currentLine: targetScript?.currentLine || 0,
              variables: targetScript ? { ...targetScript.scope } : {},
              breakpoints: targetScript ? Array.from(targetScript.breakpoints) : [],
              breakpointDetails: targetScript
                ? Array.from(targetScript.breakpoints)
                    .sort((a, b) => a - b)
                    .map((line): BreakpointDetails => {
                        const meta = targetScript.breakpointMeta.get(line);
                        return {
                            line,
                            enabled: meta?.enabled ?? true,
                            condition: meta?.condition,
                            hitCount: meta?.hitCount,
                            hits: meta?.hits ?? 0
                        };
                    })
                : [],
              executionHistory: targetScript ? [...targetScript.executionHistory] : [],
              callStack: targetScript ? this.buildPseudoCallStack(targetScript.code, targetScript.currentLine) : []
          });
      }
  }

  private simulateTraffic() {
      // Logic moved to GoosePublisher
  }

  private createContext(sourceName: string): IDeviceContext {
    return {
      readCoil: (addr) => this.getCoil(Number(addr), sourceName),
      writeCoil: (addr, val) => this.setCoil(Number(addr), val, sourceName),
      readRegister: (addr) => this.getRegister(Number(addr), sourceName),
      writeRegister: (addr, val) => this.setRegister(Number(addr), val, sourceName),
      readInput: (addr) => this.getInputRegister(Number(addr), sourceName),
      getDAValue: (path) => this.readMMS(path),
      setDAValue: (path, value) => this.writeMMS(path, value, sourceName),
      Log: (level, msg) => this.emitLog(level, `[${sourceName}] ${msg}`)
    };
  }

  private emitLog(level: string, message: string) {
    if (this.logCallback) {
      this.logCallback({
        id: Date.now().toString(),
        timestamp: new Date().toISOString(),
        source: 'Logic Runtime',
        level: level as any,
        message
      });
    }
  }

  private emitPacket(protocol: 'MMS' | 'GOOSE' | 'SV' | 'ModbusTCP', src: string, dst: string, info: string, raw?: any) {
     const packet: NetworkPacket = {
         id: this.packetIdCounter++,
         timestamp: Date.now(),
         source: src,
         destination: dst,
         protocol,
         length: 64 + Math.floor(Math.random() * 100),
         info,
         raw
     };
     this.packetListeners.forEach(cb => cb(packet));
  }
}

export const engine = new SimulationEngine();
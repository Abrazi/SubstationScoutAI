import { IDeviceContext, LogEntry, NetworkPacket, ModbusRegister, BridgeStatus, NetworkAdapter, ControlSession, DebugState, ScriptConfig, GooseState, GooseConfig } from '../types';

interface ScriptInstance {
    id: string; // Device ID
    name: string;
    code: string;
    tickRate: number;
    lastRun: number;
    generator: GeneratorFunction | null;
    iterator: Generator | null;
    breakpoints: Set<number>;
    scope: any;
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

  // Bridge State
  private bridgeWs: WebSocket | null = null;
  private bridgeStatus: BridgeStatus = {
    connected: false,
    url: 'ws://localhost:3001',
    adapters: [],
    selectedAdapter: null,
    rxCount: 0,
    txCount: 0
  };
  private bridgeCallback: ((status: BridgeStatus) => void) | null = null;

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

  // --- Network Bridge ---
  public subscribeToBridge(callback: (status: BridgeStatus) => void) {
    this.bridgeCallback = callback;
    callback(this.bridgeStatus);
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
        this.emitLog('info', `Bridge connected to ${url}`);
        this.updateBridgeStatus();
        this.sendBridgeMessage({ type: 'GET_ADAPTERS' });
      };
      this.bridgeWs.onclose = () => {
        this.bridgeStatus.connected = false;
        this.bridgeStatus.adapters = [];
        this.emitLog('warning', 'Bridge disconnected');
        this.updateBridgeStatus();
      };
      this.bridgeWs.onerror = () => {
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
          case 'MODBUS_CMD':
              this.processExternalModbusCommand(msg);
              break;
          default:
              break;
      }
  }

  private processExternalModbusCommand(cmd: any) {
      const { transId, unitId, fc, addr, val, len } = cmd;
      if (this.modbusConfig.unitId !== unitId && unitId !== 0) return;

      let responseData: any = {};
      let exceptionCode = 0;

      switch (fc) {
          case 1: if (!this.checkAddressRange(this.coils, addr, len || 1)) exceptionCode = 2; else responseData.data = this.readRange(this.coils, addr, len || 1); break;
          case 2: if (!this.checkAddressRange(this.discreteInputs, addr, len || 1)) exceptionCode = 2; else responseData.data = this.readRange(this.discreteInputs, addr, len || 1); break;
          case 3: if (!this.checkAddressRange(this.holdingRegisters, addr, len || 1)) exceptionCode = 2; else responseData.data = this.readRange(this.holdingRegisters, addr, len || 1); break;
          case 4: if (!this.checkAddressRange(this.inputRegisters, addr, len || 1)) exceptionCode = 2; else responseData.data = this.readRange(this.inputRegisters, addr, len || 1); break;
          case 5: if (!this.coils.has(addr)) exceptionCode = 2; else { this.setCoil(addr, !!val, 'External Master'); responseData = { addr, val }; } break;
          case 6: if (!this.holdingRegisters.has(addr)) exceptionCode = 2; else if (val < 0 || val > 65535) exceptionCode = 3; else { this.setRegister(addr, val, 'External Master'); responseData = { addr, val }; } break;
          default: exceptionCode = 1;
      }

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

  public getCoil(addr: number, source: string = 'System'): boolean { return this.coils.get(addr) || false; }
  public setCoil(addr: number, val: boolean, source: string = 'Logic') { 
      this.coils.set(addr, val);
      if (source !== 'Logic' && this.modbusConfig.enabled) this.emitPacket('ModbusTCP', source, 'Server', `Write Coil ${addr}: ${val}`, { fc: 5, addr, val });
  }
  public getRegister(addr: number, source: string = 'System'): number { return this.holdingRegisters.get(addr) || 0; }
  public setRegister(addr: number, val: number, source: string = 'Logic') { 
      this.holdingRegisters.set(addr, val);
      if (source !== 'Logic' && this.modbusConfig.enabled) this.emitPacket('ModbusTCP', source, 'Server', `Write Register ${addr}: ${val}`, { fc: 6, addr, val });
  }
  public getInputRegister(addr: number, source: string = 'System'): number { return this.inputRegisters.get(addr) || 0; }
  public getDiscreteInput(addr: number, source: string = 'System'): boolean { return this.discreteInputs.get(addr) || false; }

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
              generator: null,
              iterator: null,
              breakpoints: new Set(),
              scope: {}
          });
      }
      return this.scripts.get(id)!;
  }

  public getScriptConfig(id: string): ScriptConfig | null {
      const script = this.scripts.get(id);
      if (!script) return null;
      return { deviceId: script.id, code: script.code, tickRate: script.tickRate };
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
    try {
      const script = this.scripts.get(deviceId);
      if (!script) return { success: false, error: "Device not found" };

      script.code = sourceCode;

      // 1. Line-by-Line Instrumentation
      const lines = sourceCode.split('\n');
      const instrumentedLines = lines.map((line, idx) => {
          const lineNum = idx + 1;
          let jsLine = line
            .replace(/Device\.ReadInput\('(\d+)'\)/g, "ctx.readInput($1)")
            .replace(/Device\.WriteCoil\('(\d+)',\s*(.*)\)/g, "ctx.writeCoil($1, $2)")
            .replace(/Device\.SetDA\('([^']+)',\s*(.*)\)/g, "ctx.setDAValue('$1', $2)")
            .replace(/Device\.GetDA\('([^']+)'\)/g, "ctx.getDAValue('$1')")
            .replace(/Device\.Log\((.*)\)/g, "ctx.Log($1)")
            .replace(/:=/g, "=")
            .replace(/\bTRUE\b/g, "true")
            .replace(/\bFALSE\b/g, "false")
            .replace(/\bAND\b/g, "&&")
            .replace(/\bOR\b/g, "||")
            .replace(/\bNOT\b/g, "!")
            .replace(/\bIF\s+(.*)\s+THEN/g, "if ($1) {")
            .replace(/\bELSIF\s+(.*)\s+THEN/g, "} else if ($1) {")
            .replace(/\bELSE\b/g, "} else {")
            .replace(/\bEND_IF;/g, "}")
            .replace(/\bVAR\s+([a-zA-Z0-9_]+)(\s*:\s*[a-zA-Z0-9_]+)?\s*;/g, "") // remove var decls without init
            .replace(/\bVAR\s+([a-zA-Z0-9_]+)/g, "scope.$1") // replace var X with scope.X
            .replace(/FUNCTION_BLOCK.*$/gm, "")
            .replace(/END_FUNCTION_BLOCK/gm, "");

          return `yield ${lineNum}; ${jsLine}`;
      });

      const wrappedCode = `
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
      
      return { success: true };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  }

  public registerDevice(id: string, name: string) {
      this.getScriptInstance(id, name);
  }

  public setBreakpoint(deviceId: string, line: number, enabled: boolean) {
      const script = this.scripts.get(deviceId);
      if (!script) return;
      
      if (enabled) script.breakpoints.add(line);
      else script.breakpoints.delete(line);
      this.emitDebugState();
  }

  public toggleBreakpoint(deviceId: string, line: number) {
      const script = this.scripts.get(deviceId);
      if (!script) return;
      
      if (script.breakpoints.has(line)) script.breakpoints.delete(line);
      else script.breakpoints.add(line);
      this.emitDebugState();
  }

  public start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.isPaused = false;
    this.debugTargetId = null;
    this.emitDebugState();

    this.intervalId = setInterval(() => {
      this.runCycle();
    }, 50); // High freq polling to handle multiple ticks
  }

  public stop() {
    this.isRunning = false;
    this.isPaused = false;
    this.debugTargetId = null;
    this.scripts.forEach(s => s.iterator = null);
    if (this.intervalId) clearInterval(this.intervalId);
    this.emitDebugState();
  }

  public pause() {
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
        if (!script.generator) continue;

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
                        
                        // Check Breakpoint
                        if (script.breakpoints.has(line)) {
                            this.isPaused = true;
                            this.stepMode = false;
                            this.debugTargetId = script.id;
                            this.emitDebugState();
                            return; // Stop EVERYTHING
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
              currentLine: targetScript?.iterator ? (targetScript.iterator as any).currentLine || 0 : 0, // Current line is hard to get from generator unless we track it manually in the loop. 
              // Correction: We yielded the line number. The loop consumes it. 
              // We need to persist "last yielded line" in the script object if paused.
              // For now, let's assume the UI gets the line from the fact we paused AT a line.
              // Refactor: We need to store 'currentLine' in script instance during runCycle
              variables: targetScript ? { ...targetScript.scope } : {},
              breakpoints: targetScript ? Array.from(targetScript.breakpoints) : []
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

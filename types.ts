
export enum NodeType {
  IED = 'IED',
  LDevice = 'LDevice',
  LN = 'LN',
  DO = 'DO',
  DA = 'DA',
  GSE = 'GSE', // GOOSE Control Block
  DataSet = 'DataSet' // Data Set Container
}

export type DashboardWidgetType = 'chart-voltage' | 'chart-current' | 'breaker-control' | 'measurement-table' | 'value-card';

export interface DashboardWidget {
  id: string;
  type: DashboardWidgetType;
  title: string;
  config?: any; // For future extensibility (e.g. selecting specific registers)
}

export interface IEDConfig {
  ip: string;
  subnet: string;
  gateway: string;
  vlan: number;
  mac?: string;
  isDHCP?: boolean;
  modbusMap?: ModbusRegister[]; // Custom Register Map
}

export interface IEDNode {
  id: string;
  name: string;
  type: NodeType;
  description?: string;
  children?: IEDNode[];
  value?: string | number | boolean;
  attributes?: Record<string, string>;
  validValues?: string[]; // Enumerated values for DA/BDA
  details?: string; // AI generated explanation
  path?: string; // Breadcrumb path
  config?: IEDConfig; // Network Configuration
  dashboardLayout?: DashboardWidget[]; // Customizable Dashboard
  // GOOSE Specific Config
  gooseConfig?: GooseConfig;
}

export interface GooseConfig {
    appID: string;
    confRev: number;
    minTime: number; // ms
    maxTime: number; // ms
    datSet: string; // Reference to dataset
}

export interface GooseState {
    enabled: boolean;
    stNum: number; // Status Number (increments on data change)
    sqNum: number; // Sequence Number (increments on retransmission)
    timeAllowedToLive: number;
    timestamp: number;
    nextTx: number; // Timestamp for next transmission
    currentInterval: number; // Current retransmission interval
    burstMode: boolean;
    data: Record<string, any>; // Cache of dataset values
}

export type LogLevel = 'info' | 'warning' | 'error' | 'packet' | 'goose' | 'mms' | 'debug';

export interface LogEntry {
  id: string;
  timestamp: string;
  source: string;
  message: string;
  level: LogLevel;
}

export interface NetworkPacket {
  id: number;
  timestamp: number;
  source: string;
  destination: string;
  protocol: 'MMS' | 'GOOSE' | 'SV' | 'ModbusTCP';
  length: number;
  info: string;
  raw?: any;
}

export interface SimulationData {
  voltageA: number;
  voltageB: number;
  voltageC: number;
  currentA: number;
  currentB: number;
  currentC: number;
  frequency: number;
  breakerStatus: boolean; // true = closed, false = open
}

export type ViewMode = 'explorer' | 'dashboard' | 'ai-analysis' | 'network' | 'modbus' | 'logic' | 'config' | 'tap';

export interface ChatMessage {
  id: string;
  role: 'user' | 'model';
  text: string;
  timestamp: number;
}

// Network Topology Types
export interface NetworkNode {
  id: string;
  name: string;
  type: 'ied' | 'switch' | 'hmi';
  ip?: string;
  x: number;
  y: number;
  status: 'online' | 'offline' | 'error';
  vlan?: number; // VLAN ID (e.g., 10, 20)
}

export interface NetworkLink {
  id: string;
  sourceId: string;
  targetId: string;
  type: 'ethernet' | 'fiber';
  activity?: boolean;
  vlan?: number; // VLAN Tag for the link
}

// Modbus Types
export type ModbusRegisterType = 'Coil' | 'DiscreteInput' | 'HoldingRegister' | 'InputRegister';

export interface ModbusRegister {
  address: number;
  value: number | boolean;
  type: ModbusRegisterType;
  name: string;
  description?: string;
}

// Watch List Item
export interface WatchItem {
  id: string;
  label: string; // Display Name (e.g. "Voltage L1" or "IED1/MMXU1.PhV")
  source: 'IEC61850' | 'Modbus';
  addressOrPath: string | number; // MMS Path or Modbus Address
  modbusType?: ModbusRegisterType; // Only for Modbus
  color?: string; // UI Decoration
}

// Device Scripting API (Architectural Requirement)
export interface IDeviceContext {
  // Register access
  readCoil(address: number): boolean;
  writeCoil(address: number, value: boolean): void;
  readRegister(address: number): number;
  writeRegister(address: number, value: number): void;
  readInput(address: number): number; // 30000 range
  
  // IEC 61850 access (Simulated)
  getDAValue(path: string): any;
  setDAValue(path: string, value: any): void;
  
  // Logging
  Log(level: string, message: string): void;
}

// Network Bridge Types
export interface NetworkAdapter {
  name: string;
  ip: string;
  mac: string;
  description?: string;
}

export interface BridgeStatus {
  connected: boolean;
  url: string;
  adapters: NetworkAdapter[];
  selectedAdapter: string | null;
  rxCount: number;
  txCount: number;
}

// IEC 61850 Control Types
export enum ControlModel {
  StatusOnly = 'status-only',
  DirectNormal = 'direct-with-normal-security',
  SBONormal = 'sbo-with-normal-security',
  DirectEnhanced = 'direct-with-enhanced-security',
  SBOEnhanced = 'sbo-with-enhanced-security'
}

export interface ControlSession {
  path: string;
  client: string;
  expiryTime: number;
  value: any;
}

// Debugger Types
export interface DebugState {
  isRunning: boolean;
  isPaused: boolean;
  activeDeviceId: string | null; // The device that triggered the pause/breakpoint
  currentLine: number;
  variables: Record<string, any>;
  breakpoints: number[];
}

export interface ScriptConfig {
    deviceId: string;
    code: string;
    tickRate: number; // ms
}

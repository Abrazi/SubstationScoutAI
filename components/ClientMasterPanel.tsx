import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Icons } from './Icons';
import { IEDNode, ClientTransaction } from '../types';
import { engine } from '../services/SimulationEngine';

interface ClientMasterPanelProps {
  ieds: IEDNode[];
}

export const ClientMasterPanel: React.FC<ClientMasterPanelProps> = ({ ieds }) => {
  const [activeTab, setActiveTab] = useState<'iec61850' | 'modbus'>('iec61850');
  const [transactions, setTransactions] = useState<ClientTransaction[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [connectedTargetId, setConnectedTargetId] = useState<string | null>(null);
  const timersRef = useRef<number[]>([]); // store setTimeout ids for cleanup

  // when tab switches we clear connection state and logs
  useEffect(() => {
    setIsConnected(false);
    setConnectionStatus('idle');
    setConnectedTargetId(null);
    setTransactions([]);
  }, [activeTab]);

  // Common Connection State
  const [targetIP, setTargetIP] = useState('192.168.1.100');
  const [isConnected, setIsConnected] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<'idle' | 'connecting' | 'connected' | 'failed'>('idle');

  // Modbus State
  const [mbPort, setMbPort] = useState(502);
  const [mbUnitId, setMbUnitId] = useState(1);
  const [mbFunction, setMbFunction] = useState<number>(3); // 3 = Read Holding
  const [mbAddress, setMbAddress] = useState(40001);
  const [mbValue, setMbValue] = useState(0);

  // MMS State
  const [mmsPath, setMmsPath] = useState('IED_Bay_01_Main/LD0/MMXU1.PhV.phsA.mag');
  const [mmsWriteValue, setMmsWriteValue] = useState('');

  // -- validation helpers ---------------------------------------------------
  const isValidIP = (raw: string) => {
      if (!raw) return false;
      const [host, port] = raw.split(':');
      const ipRegex = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
      if (!ipRegex.test(host)) return false;
      if (port === undefined) return true;
      const p = Number(port);
      return !Number.isNaN(p) && p > 0 && p <= 65535;
  };
  const isValidPort = (p: number) => p > 0 && p <= 65535;
  const isValidUnitId = (u: number) => u >= 1 && u <= 247;
  const isValidMmsPath = (p: string) => p.trim().length > 0 && !/\s/.test(p);

  // derived validity flags
  const ipValid = isValidIP(targetIP);
  const mbPortValid = isValidPort(mbPort);
  const mbUnitValid = isValidUnitId(mbUnitId);
  const mmsPathValid = isValidMmsPath(mmsPath);

    const modbusEndpoints = useMemo(() => ieds
        .filter(ied => !!ied.config?.modbusMap)
        .map(ied => ({
            id: ied.id,
            name: ied.name,
            ip: ied.config?.ip || '0.0.0.0',
            port: ied.config?.modbusPort ?? 502,
            unitId: ied.config?.modbusUnitId ?? 1
        })), [ieds]);

    const iecEndpoints = useMemo(() => ieds
        .filter(ied => {
            const hasIecModel = Array.isArray(ied.children) && ied.children.length > 0;
            const isIecServer = (ied.config?.role ?? 'server') === 'server';
            return hasIecModel && isIecServer;
        })
        .map(ied => ({
            id: ied.id,
            name: ied.name,
            ip: ied.config?.ip || '0.0.0.0',
            port: ied.config?.iecMmsPort ?? 102
        })), [ieds]);

  // Auto-scroll log
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [transactions]);

  const MAX_LOG_ENTRIES = 200;
  const addLog = (type: 'request' | 'response' | 'error', protocol: 'Modbus' | 'MMS', details: string, value?: any, status: 'success' | 'timeout' | 'error' = 'success') => {
      setTransactions(prev => {
          const entry: ClientTransaction = {
              id: Date.now().toString(),
              timestamp: new Date().toLocaleTimeString(),
              type,
              protocol,
              details,
              value,
              status
          };
          const next = [...prev, entry];
          if (next.length > MAX_LOG_ENTRIES) next.shift();
          return next;
      });
  };

  const handleConnect = () => {
      setConnectionStatus('connecting');
      // simulate handshake and remember timer
      const tid = window.setTimeout(() => {
          const target = activeTab === 'modbus'
              ? modbusEndpoints.find(ep =>
                    ep.ip === targetIP && ep.port === mbPort
                )
              : (() => {
                    // allow specifying port in the IP field (e.g. "1.2.3.4:102")
                    const [host, portStr] = targetIP.split(':');
                    const portNum = portStr ? parseInt(portStr) : undefined;
                    return iecEndpoints.find(ep =>
                        ep.ip === host && (portNum === undefined ? true : ep.port === portNum)
                    );
                })();
          
          if (target) {
              setConnectionStatus('connected');
              setIsConnected(true);
              setConnectedTargetId(target.id);
              const endpointInfo = activeTab === 'modbus' ? `:${mbPort}` : `:${target.port}`;
              addLog('response', activeTab === 'modbus' ? 'Modbus' : 'MMS', `Connected to ${target.name} (${targetIP}${endpointInfo})`, undefined, 'success');
          } else {
              // If bridge is active, we might connect externally, but for now assuming simulation only or failure
              setConnectionStatus('failed');
              setIsConnected(false);
              setConnectedTargetId(null);
              const reason = activeTab === 'modbus'
                ? `No Modbus slave listening at ${targetIP}:${mbPort}`
                : `No IEC 61850 server found at ${targetIP}`;
              addLog('error', activeTab === 'modbus' ? 'Modbus' : 'MMS', `Connection Timeout: ${reason}`, undefined, 'timeout');
          }
      }, 800);
      timersRef.current.push(tid);
  };

  const handleDisconnect = () => {
      setIsConnected(false);
      setConnectedTargetId(null);
      setConnectionStatus('idle');
      addLog('response', activeTab === 'modbus' ? 'Modbus' : 'MMS', 'Connection Closed');
  };

  const sendModbusRequest = () => {
      if (!isConnected) {
          addLog('error', 'Modbus', 'Socket not connected', undefined, 'error');
          return;
      }
      if (!mbUnitValid) {
          addLog('error', 'Modbus', 'Invalid Unit ID', undefined, 'error');
          return;
      }

      const reqStr = `UID:${mbUnitId} FC:${mbFunction} Addr:${mbAddress} ${mbFunction === 6 || mbFunction === 5 ? `Val:${mbValue}` : ''}`;
      addLog('request', 'Modbus', `TX > ${reqStr}`);

      // Logic Execution
      const tid = window.setTimeout(() => {
           const target = ieds.find(ied => ied.id === connectedTargetId);
           if (!target || !target.config?.modbusMap) {
               addLog('error', 'Modbus', 'Target is not an active Modbus slave endpoint', undefined, 'error');
               return;
           }

           let resultValue: any;
           let error = false;

           try {
               switch (mbFunction) {
                   case 1: // Read Coils
                       resultValue = engine.getCoil(mbAddress) ? 1 : 0;
                       break;
                   case 2: // Read Discrete
                       resultValue = engine.getDiscreteInput(mbAddress) ? 1 : 0;
                       break;
                   case 3: // Read Holding
                       resultValue = engine.getRegister(mbAddress);
                       break;
                   case 4: // Read Input
                       resultValue = engine.getInputRegister(mbAddress);
                       break;
                   case 5: // Write Coil
                       engine.setCoil(mbAddress, mbValue !== 0, 'Client Master');
                       resultValue = "OK";
                       break;
                   case 6: // Write Register
                       engine.setRegister(mbAddress, mbValue, 'Client Master');
                       resultValue = "OK";
                       break;
                   default:
                       error = true;
               }

               if (error) {
                    addLog('error', 'Modbus', `RX < Exception: Illegal Function`, undefined, 'error');
               } else {
                    addLog('response', 'Modbus', `RX < ${resultValue}`, resultValue, 'success');
               }

           } catch (e) {
               addLog('error', 'Modbus', 'Internal Error', undefined, 'error');
           }

      }, 200); // Network Latency
      timersRef.current.push(tid);
  };

  const sendMmsRequest = (action: 'read' | 'write' | 'select') => {
      if (!isConnected) {
          addLog('error', 'MMS', 'Association not established', undefined, 'error');
          return;
      }
      if (!mmsPathValid) {
          addLog('error', 'MMS', 'Invalid object path', undefined, 'error');
          return;
      }

      const valDisplay = action === 'write' ? `=${mmsWriteValue}` : '';
      addLog('request', 'MMS', `TX > ${action.toUpperCase()} ${mmsPath}${valDisplay}`);

       const tid = window.setTimeout(() => {
           // Resolve Target (Simulated)
           // In real logic, MMS path usually contains IED name "IED1/..." so we can route even if IP check is loose
           // But here we rely on the IP connection context
           
           try {
               if (action === 'read') {
                   const val = engine.readMMS(mmsPath);
                   if (val !== undefined) {
                       addLog('response', 'MMS', `RX < ${val}`, val, 'success');
                   } else {
                       addLog('error', 'MMS', `RX < DataObject Not Found`, undefined, 'error');
                   }
               } else if (action === 'write') {
                   // Type Inference
                   let valToWrite: any = mmsWriteValue;
                   if (mmsWriteValue?.toLowerCase() === 'true') valToWrite = true;
                   else if (mmsWriteValue?.toLowerCase() === 'false') valToWrite = false;
                   else if (!isNaN(Number(mmsWriteValue)) && mmsWriteValue?.trim() !== '') valToWrite = Number(mmsWriteValue);

                   const res = engine.writeMMS(mmsPath, valToWrite, 'MasterClient');
                   if (res.success) {
                       addLog('response', 'MMS', `RX < Write Success`, valToWrite, 'success');
                   } else {
                       addLog('error', 'MMS', `RX < Write Failed`, undefined, 'error');
                   }
               } else if (action === 'select') {
                   const res = engine.selectControl(mmsPath, 'MasterClient');
                   if (res.success) {
                        addLog('response', 'MMS', `RX < Select Success (SBO)`, undefined, 'success');
                   } else {
                        addLog('error', 'MMS', `RX < Select Failed: ${res.error}`, undefined, 'error');
                   }
               }
           } catch (e) {
               addLog('error', 'MMS', 'Service Error', undefined, 'error');
           }
       }, 300);
      timersRef.current.push(tid);
  };


  // cleanup pending timers
  useEffect(() => {
    return () => {
      timersRef.current.forEach(id => clearTimeout(id));
      timersRef.current = [];
    };
  }, []);


  return (
    <div className="h-full flex flex-col bg-scada-bg animate-in fade-in duration-300">
      
      {/* Top Bar */}
      <div className="p-4 border-b border-scada-border bg-scada-panel/50 flex justify-between items-center">
        <div className="flex items-center gap-3">
             <div className="p-2 bg-scada-bg border border-scada-border rounded">
                 <Icons.Cable className="w-6 h-6 text-scada-accent" />
             </div>
             <div>
                 <h2 className="text-lg font-bold text-white">Client & Master Simulator</h2>
                 <p className="text-xs text-scada-muted">Initiate connections and poll devices</p>
             </div>
        </div>

        {/* Tab Switcher */}
        <div className="flex bg-scada-bg rounded p-1 border border-scada-border">
            <button 
                onClick={() => setActiveTab('iec61850')}
                className={`px-4 py-2 rounded text-sm font-bold transition-all flex items-center gap-2 ${activeTab === 'iec61850' ? 'bg-scada-panel text-white shadow' : 'text-scada-muted hover:text-white'}`}
            >
                <Icons.Server className="w-4 h-4" /> IEC 61850 Client
            </button>
            <button 
                onClick={() => setActiveTab('modbus')}
                className={`px-4 py-2 rounded text-sm font-bold transition-all flex items-center gap-2 ${activeTab === 'modbus' ? 'bg-scada-panel text-white shadow' : 'text-scada-muted hover:text-white'}`}
            >
                <Icons.Database className="w-4 h-4" /> Modbus TCP Master
            </button>
        </div>
      </div>

      <div className="flex-1 flex overflow-hidden">
        
        {/* Left: Configuration Panel */}
        <div className="w-96 bg-scada-panel border-r border-scada-border flex flex-col p-6 overflow-y-auto">
            
            {/* Connection Card */}
            <div className="mb-8 p-5 bg-scada-bg border border-scada-border rounded-lg shadow-sm">
                <h3 className="text-xs font-bold text-scada-muted uppercase mb-4 flex items-center gap-2">
                    <Icons.Wifi className="w-4 h-4" /> Target Connection
                </h3>
                
                <div className="space-y-4">
                    <div className="space-y-1">
                        <label className="text-xs font-bold text-gray-400">Target IP Address</label>
                        <input 
                            type="text" 
                            value={targetIP}
                            onChange={(e) => setTargetIP(e.target.value)}
                            disabled={isConnected}
                            className={`w-full bg-scada-panel border rounded px-3 py-2 text-white font-mono focus:border-scada-accent outline-none disabled:opacity-50 ${!ipValid && targetIP ? 'border-scada-danger' : 'border-scada-border'}`}
                        />
                        {!ipValid && (
                            <p className="text-xs text-scada-danger">Enter valid IPv4 address (port optional)</p>
                        )}
                    </div>

                    {!isConnected && activeTab === 'iec61850' && iecEndpoints.length > 0 && (
                        <div className="space-y-1">
                            <label className="text-xs font-bold text-gray-400">Quick Select IEC Server</label>
                            <div className="relative">
                                <select
                                    value={undefined}
                                    onChange={(e) => {
                                        const endpoint = iecEndpoints.find(ep => ep.id === e.target.value);
                                        if (endpoint) {
                                            setTargetIP(endpoint.ip);
                                        }
                                    }}
                                    className="w-full bg-scada-panel border border-scada-border rounded px-3 py-2 text-white text-xs font-mono focus:border-scada-accent outline-none appearance-none"
                                >
                                    <option value="">-- Select IEC Server --</option>
                                    {iecEndpoints.map(ep => (
                                        <option key={ep.id} value={ep.id}>{ep.name} ({ep.ip}:{ep.port})</option>
                                    ))}
                                </select>
                                <Icons.ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 text-scada-muted pointer-events-none" />
                            </div>
                        </div>
                    )}
                    
                    {activeTab === 'modbus' && (
                        <div className="grid grid-cols-2 gap-4">
                            <div className="space-y-1">
                                <label className="text-xs font-bold text-gray-400">Port</label>
                                <input 
                                    type="number" 
                                    value={mbPort}
                                    onChange={(e) => setMbPort(parseInt(e.target.value))}
                                    disabled={isConnected}
                                    min={1} max={65535}
                                    className={`w-full bg-scada-panel border rounded px-3 py-2 text-white font-mono focus:border-scada-accent outline-none disabled:opacity-50 ${!mbPortValid && String(mbPort) ? 'border-scada-danger' : 'border-scada-border'}`}
                                />
                                {!mbPortValid && (
                                    <p className="text-xs text-scada-danger">Port must be 1–65535</p>
                                )}
                            </div>
                            <div className="space-y-1">
                                <label className="text-xs font-bold text-gray-400">Unit ID</label>
                                <input 
                                    type="number" 
                                    value={mbUnitId}
                                    onChange={(e) => setMbUnitId(parseInt(e.target.value))}
                                    disabled={isConnected}
                                    className={`w-full bg-scada-panel border rounded px-3 py-2 text-white font-mono focus:border-scada-accent outline-none disabled:opacity-50 ${!mbUnitValid && String(mbUnitId) ? 'border-scada-danger' : 'border-scada-border'}`}
                                />
                            {!mbUnitValid && (
                                <p className="text-xs text-scada-danger">Unit ID 1–247</p>
                            )}
                            </div>
                        </div>
                    )}

                    <button 
                        onClick={isConnected ? handleDisconnect : handleConnect}
                        disabled={!ipValid || (activeTab === 'modbus' && !mbPortValid)}
                        className={`w-full py-2 rounded font-bold text-sm transition-colors flex items-center justify-center gap-2 ${isConnected ? 'bg-scada-danger text-white hover:bg-red-600' : 'bg-scada-success text-white hover:bg-emerald-600'} ${(!ipValid || (activeTab === 'modbus' && !mbPortValid)) && 'opacity-50 cursor-not-allowed'}`}
                    >
                        {isConnected ? <Icons.Close className="w-4 h-4"/> : <Icons.Cable className="w-4 h-4"/>}
                        {isConnected ? 'Disconnect' : 'Connect'}
                    </button>
                    
                    <div className="flex items-center justify-center gap-2 text-xs">
                        <span className={`w-2 h-2 rounded-full ${isConnected ? 'bg-scada-success animate-pulse' : connectionStatus === 'failed' ? 'bg-scada-danger' : 'bg-scada-muted'}`}></span>
                        <span className="text-scada-muted uppercase font-bold">{connectionStatus}</span>
                    </div>
                </div>
            </div>

            {/* Request Builder */}
            <div className="flex-1">
                <h3 className="text-xs font-bold text-scada-muted uppercase mb-4 flex items-center gap-2">
                    <Icons.Send className="w-4 h-4" /> Request Builder
                </h3>

                {activeTab === 'modbus' ? (
                    <div className="space-y-4">
                        <div className="space-y-1">
                            <label className="text-xs font-bold text-gray-400">Function Code</label>
                            <select 
                                value={mbFunction} 
                                onChange={(e) => setMbFunction(parseInt(e.target.value))}
                                disabled={!isConnected}
                                className="w-full bg-scada-bg border border-scada-border rounded px-3 py-2 text-white focus:border-scada-accent outline-none disabled:opacity-50"
                            >
                                <option value="1">01 Read Coils</option>
                                <option value="2">02 Read Discrete Inputs</option>
                                <option value="3">03 Read Holding Registers</option>
                                <option value="4">04 Read Input Registers</option>
                                <option value="5">05 Write Single Coil</option>
                                <option value="6">06 Write Single Register</option>
                            </select>
                        </div>
                        <div className="space-y-1">
                            <label className="text-xs font-bold text-gray-400">Start Address (dec)</label>
                            <input 
                                type="number" 
                                value={mbAddress} 
                                onChange={(e) => setMbAddress(parseInt(e.target.value))}
                                disabled={!isConnected}
                                className="w-full bg-scada-bg border border-scada-border rounded px-3 py-2 text-white font-mono focus:border-scada-accent outline-none disabled:opacity-50"
                            />
                        </div>

                        {(mbFunction === 5 || mbFunction === 6) && (
                            <div className="space-y-1">
                                <label className="text-xs font-bold text-gray-400">Write Value</label>
                                <input 
                                    type="number" 
                                    value={mbValue} 
                                    onChange={(e) => setMbValue(parseInt(e.target.value))}
                                    disabled={!isConnected}
                                    className="w-full bg-scada-bg border border-scada-border rounded px-3 py-2 text-white font-mono focus:border-scada-accent outline-none disabled:opacity-50"
                                />
                            </div>
                        )}

                        <button 
                            onClick={sendModbusRequest}
                            disabled={!isConnected}
                            className="w-full py-2 bg-scada-accent text-white rounded font-bold text-sm hover:bg-cyan-600 disabled:opacity-50 disabled:cursor-not-allowed mt-4 shadow-lg shadow-cyan-900/20"
                        >
                            Send Request
                        </button>

                        <div className="mt-5 border-t border-scada-border/50 pt-4">
                            <div className="text-[11px] font-bold uppercase text-scada-muted mb-2">Available Modbus Slaves</div>
                            <div className="max-h-28 overflow-auto space-y-1.5">
                                {modbusEndpoints.length === 0 && (
                                    <div className="text-xs text-scada-muted">No Modbus slave devices configured.</div>
                                )}
                                {modbusEndpoints.map(ep => (
                                    <button
                                        key={ep.id}
                                        type="button"
                                        onClick={() => {
                                            if (!isConnected) {
                                                setTargetIP(ep.ip);
                                                setMbPort(ep.port);
                                                setMbUnitId(ep.unitId);
                                            }
                                        }}
                                        disabled={isConnected}
                                        className="w-full text-left px-2 py-1.5 rounded bg-scada-bg border border-scada-border hover:border-scada-accent disabled:opacity-60"
                                    >
                                        <div className="text-xs text-gray-200 font-medium truncate">{ep.name}</div>
                                        <div className="text-[10px] font-mono text-scada-muted">{ep.ip}:{ep.port} · Unit {ep.unitId}</div>
                                    </button>
                                ))}
                            </div>
                        </div>
                    </div>
                ) : (
                    <div className="space-y-4">
                        <div className="space-y-1">
                            <label className="text-xs font-bold text-gray-400">Object Reference (Path)</label>
                            <input 
                                type="text" 
                                value={mmsPath} 
                                onChange={(e) => setMmsPath(e.target.value)}
                                placeholder="IED/LD/LN.DO.DA"
                                disabled={!isConnected}
                                className={`w-full bg-scada-bg border rounded px-3 py-2 text-white font-mono text-xs focus:border-scada-accent outline-none disabled:opacity-50 ${!mmsPathValid && mmsPath ? 'border-scada-danger' : 'border-scada-border'}`}
                            />
                            {!mmsPathValid && (
                                <p className="text-xs text-scada-danger">Path cannot be empty or contain spaces.</p>
                            )}
                            <p className="text-[10px] text-scada-muted">Example: IED_Bay_01_Main/LD0/MMXU1.PhV.phsA.mag</p>
                        </div>

                        <div className="space-y-1">
                            <label className="text-xs font-bold text-gray-400">Write Value (Optional)</label>
                            <input 
                                type="text" 
                                value={mmsWriteValue} 
                                onChange={(e) => setMmsWriteValue(e.target.value)}
                                placeholder="Value to write..."
                                disabled={!isConnected}
                                className="w-full bg-scada-bg border border-scada-border rounded px-3 py-2 text-white font-mono text-xs focus:border-scada-accent outline-none disabled:opacity-50"
                            />
                        </div>

                        <div className="grid grid-cols-2 gap-2 mt-4">
                            <button 
                                onClick={() => sendMmsRequest('read')}
                                disabled={!isConnected || !mmsPathValid}
                                className="py-2 bg-scada-accent/10 border border-scada-accent/50 text-scada-accent rounded font-bold text-xs hover:bg-scada-accent/20 disabled:opacity-50"
                            >
                                GetDataValues
                            </button>
                            <button 
                                onClick={() => sendMmsRequest('select')}
                                disabled={!isConnected || !mmsPathValid}
                                className="py-2 bg-yellow-500/10 border border-yellow-500/50 text-yellow-500 rounded font-bold text-xs hover:bg-yellow-500/20 disabled:opacity-50"
                            >
                                Select (SBO)
                            </button>
                            <button 
                                onClick={() => sendMmsRequest('write')}
                                disabled={!isConnected || !mmsPathValid}
                                className="py-2 bg-purple-500/10 border border-purple-500/50 text-purple-400 rounded font-bold text-xs hover:bg-purple-500/20 disabled:opacity-50 col-span-2"
                            >
                                SetDataValues (Write)
                            </button>
                        </div>
                    </div>
                )}
            </div>

        </div>

        {/* Right: Transaction Log */}
        <div className="flex-1 bg-[#0d1117] flex flex-col min-w-0">
            <div className="p-3 border-b border-scada-border flex justify-between items-center bg-scada-panel/30">
                <span className="text-xs font-bold text-scada-muted uppercase flex items-center gap-2">
                    <Icons.Terminal className="w-4 h-4" /> Transaction Monitor
                </span>
                <button 
                    onClick={() => setTransactions([])} 
                    className="text-xs text-scada-muted hover:text-white flex items-center gap-1"
                >
                    <Icons.Trash className="w-3 h-3" /> Clear
                </button>
            </div>
            
            <div className="flex-1 overflow-y-auto p-4 space-y-3 font-mono text-sm" ref={scrollRef}>
                {transactions.length === 0 && (
                    <div className="flex flex-col items-center justify-center h-full text-scada-muted opacity-30">
                        <Icons.Activity className="w-12 h-12 mb-4" />
                        <p>No transactions yet</p>
                    </div>
                )}
                {transactions.map(tx => (
                    <div key={tx.id} className="flex gap-4 group">
                        <div className="text-gray-500 text-xs mt-1 w-20 shrink-0">{tx.timestamp}</div>
                        <div className="flex-1">
                            <div className="flex items-center gap-2 mb-1">
                                {tx.type === 'request' ? (
                                    <Icons.ArrowUpRight className="w-4 h-4 text-scada-accent" />
                                ) : (
                                    <Icons.ArrowDownLeft className={`w-4 h-4 ${tx.status === 'error' || tx.status === 'timeout' ? 'text-scada-danger' : 'text-scada-success'}`} />
                                )}
                                <span className={`font-bold ${tx.type === 'request' ? 'text-scada-accent' : tx.status === 'success' ? 'text-scada-success' : 'text-scada-danger'}`}>
                                    {tx.type.toUpperCase()}
                                </span>
                                <span className="text-xs bg-white/5 px-1.5 rounded text-scada-muted">{tx.protocol}</span>
                            </div>
                            <div className="text-gray-300 break-all">{tx.details}</div>
                            {tx.value !== undefined && (
                                <div className="mt-1 text-xs bg-white/5 inline-block px-2 py-1 rounded border border-white/10 text-yellow-400">
                                    Value: {String(tx.value)}
                                </div>
                            )}
                        </div>
                    </div>
                ))}
            </div>
        </div>

      </div>
    </div>
  );
};
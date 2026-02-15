import React, { useEffect, useMemo, useState } from 'react';
import { BridgeStatus, IEDNode } from '../types';
import { Icons } from './Icons';
import { engine } from '../services/SimulationEngine';

interface BindingPanelProps {
  ieds: IEDNode[];
  onUpdateNode: (node: IEDNode) => void;
}

export const BindingPanel: React.FC<BindingPanelProps> = ({ ieds, onUpdateNode }) => {
  const [bridgeStatus, setBridgeStatus] = useState<BridgeStatus>({
    connected: false,
    url: 'ws://127.0.0.1:34001',
    adapters: [],
    selectedAdapter: null,
    rxCount: 0,
    txCount: 0,
    lastError: undefined,
    lastRoute: undefined,
    boundEndpoints: []
  });
  const [bridgeUrlInput, setBridgeUrlInput] = useState('ws://127.0.0.1:34001');
  const [iecBackendInputs, setIecBackendInputs] = useState<Record<string, { host: string; port: number; scdFile: string }>>({});
  const [protocolIpInputs, setProtocolIpInputs] = useState<Record<string, { mmsIp: string; gooseIp: string }>>({});
  const [lastIecConnectAt, setLastIecConnectAt] = useState<number | null>(null);

  useEffect(() => {
    engine.subscribeToBridge((status) => {
      setBridgeStatus(status);
      if (status.url) setBridgeUrlInput(status.url);
    });
  }, []);

  const iecServerDevices = useMemo(() => {
    return ieds.filter(ied => {
      const hasIecModel = Array.isArray(ied.children) && ied.children.length > 0;
      const isIecServer = (ied.config?.role ?? 'server') === 'server';
      return hasIecModel && isIecServer;
    });
  }, [ieds]);

  useEffect(() => {
    const next: Record<string, { host: string; port: number; scdFile: string }> = {};
    const ipNext: Record<string, { mmsIp: string; gooseIp: string }> = {};
    iecServerDevices.forEach((ied) => {
      next[ied.id] = {
        host: ied.config?.iecBackendHost || ied.config?.ip || '127.0.0.1',
        port: ied.config?.iecBackendPort ?? 8102,
        scdFile: ied.config?.iecSclFile || ''
      };

      const firstIp = ied.config?.communicationIps?.[0]?.ip || ied.config?.ip || '';
      ipNext[ied.id] = {
        mmsIp: ied.config?.mmsIp || ied.config?.ip || firstIp,
        gooseIp: ied.config?.gooseIp || ied.config?.ip || firstIp
      };
    });
    setIecBackendInputs(next);
    setProtocolIpInputs(ipNext);
  }, [iecServerDevices]);

  const configuredEndpoints = useMemo(() => {
    const rows: Array<{ protocol: 'modbus' | 'iec61850'; name: string; ip: string; port: number }> = [];
    ieds.forEach((ied) => {
      const ip = ied.config?.ip;
      if (!ip) return;
      if (ied.config?.modbusMap) {
        rows.push({
          protocol: 'modbus',
          name: ied.name,
          ip,
          port: ied.config.modbusPort ?? 502
        });
      }

      const hasIecModel = Array.isArray(ied.children) && ied.children.length > 0;
      const isIecServer = (ied.config?.role ?? 'server') === 'server';
      if (hasIecModel && isIecServer) {
        const iecIp = ied.config?.mmsIp || ied.config?.ip;
        if (!iecIp) return;
        rows.push({
          protocol: 'iec61850',
          name: ied.name,
          ip: iecIp,
          port: ied.config.iecMmsPort ?? 102
        });
      }
    });
    return rows;
  }, [ieds]);

  const handleConnectBridge = () => {
    if (bridgeStatus.connected) {
      engine.disconnectBridge();
    } else {
      engine.connectBridge(bridgeUrlInput);
    }
  };

  const handleSelectAdapter = (ip: string) => {
    engine.selectAdapter(ip);
  };

  const handleConnectIec = () => {
    if (!bridgeStatus.connected) return;
    engine.syncIecServers(ieds);
    setLastIecConnectAt(Date.now());
  };

  const handleIecBackendInput = (iedId: string, field: 'host' | 'port' | 'scdFile', value: string) => {
    setIecBackendInputs(prev => ({
      ...prev,
      [iedId]: {
        host: field === 'host' ? value : (prev[iedId]?.host || ''),
        port: field === 'port' ? (parseInt(value) || 8102) : (prev[iedId]?.port ?? 8102),
        scdFile: field === 'scdFile' ? value : (prev[iedId]?.scdFile || '')
      }
    }));
  };

  const handleSaveIecBackend = (ied: IEDNode) => {
    const draft = iecBackendInputs[ied.id];
    if (!draft || !ied.config) return;

    const updated: IEDNode = {
      ...ied,
      config: {
        ...ied.config,
        iecBackendHost: (draft.host || ied.config.ip || '127.0.0.1').trim(),
        iecBackendPort: Number(draft.port) || 8102,
        iecSclFile: (draft.scdFile || '').trim() || undefined
      }
    };

    onUpdateNode(updated);
  };

  const handleProtocolIpInput = (iedId: string, field: 'mmsIp' | 'gooseIp', value: string) => {
    setProtocolIpInputs(prev => ({
      ...prev,
      [iedId]: {
        mmsIp: field === 'mmsIp' ? value : (prev[iedId]?.mmsIp || ''),
        gooseIp: field === 'gooseIp' ? value : (prev[iedId]?.gooseIp || '')
      }
    }));
  };

  const handleSaveProtocolIps = (ied: IEDNode) => {
    const draft = protocolIpInputs[ied.id];
    if (!draft || !ied.config) return;
    const fallback = ied.config.ip;

    const updated: IEDNode = {
      ...ied,
      config: {
        ...ied.config,
        ip: (draft.mmsIp || fallback).trim(),
        mmsIp: (draft.mmsIp || fallback).trim(),
        gooseIp: (draft.gooseIp || fallback).trim()
      }
    };

    onUpdateNode(updated);
  };

  const activeEndpoints = (bridgeStatus.boundEndpoints || []).filter(ep => ep.status === 'active');
  const failedEndpoints = (bridgeStatus.boundEndpoints || []).filter(ep => ep.status === 'failed');

  const handleCopyStdBackendCommand = async (ied: IEDNode) => {
    const selectedScd = (iecBackendInputs[ied.id]?.scdFile || ied.config?.iecSclFile || 'DUBGG.scd').trim();
    const cmd = `SCD_FILE=\"${selectedScd}\" npm run iec:std:start`;
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(cmd);
      }
    } catch {
    }
    console.info(`Std backend command prepared for ${ied.name}: ${cmd}`);
  };

  return (
    <div className="h-full flex flex-col bg-scada-bg animate-in fade-in duration-300">
      <div className="p-6 border-b border-scada-border bg-scada-panel/50 flex justify-between items-center">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xs font-mono uppercase bg-purple-500/10 text-purple-400 px-2 py-0.5 rounded border border-purple-500/20">
              Network Binding
            </span>
            <span className={`text-xs font-mono uppercase px-2 py-0.5 rounded border ${bridgeStatus.connected ? 'bg-scada-success/10 text-scada-success border-scada-success/20' : 'bg-scada-danger/10 text-scada-danger border-scada-danger/20'}`}>
              {bridgeStatus.connected ? 'Bridge Online' : 'Bridge Offline'}
            </span>
          </div>
          <h2 className="text-2xl font-bold text-white">Adapter & Binding Control</h2>
          <p className="text-scada-muted mt-1">Select bridge address and network adapter, then monitor all protocol binding reports here.</p>
        </div>
      </div>

      <div className="flex-1 overflow-auto p-8">
        <div className="max-w-5xl mx-auto space-y-8">
          <div className="bg-scada-panel border border-scada-border rounded-lg p-6">
            <h3 className="text-lg font-bold text-white flex items-center gap-2 mb-4">
              <Icons.Zap className="w-5 h-5 text-yellow-400" /> Bridge Connection
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 items-end">
              <div className="space-y-2">
                <label className="text-sm font-bold text-scada-muted uppercase">Binding Address (Bridge URL)</label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={bridgeUrlInput}
                    onChange={(e) => setBridgeUrlInput(e.target.value)}
                    placeholder="ws://127.0.0.1:34001"
                    disabled={bridgeStatus.connected}
                    className="flex-1 bg-scada-bg border border-scada-border rounded px-3 py-2 text-white text-sm font-mono focus:border-scada-accent outline-none disabled:opacity-50"
                  />
                  <button
                    onClick={handleConnectBridge}
                    className={`px-4 py-2 rounded font-bold text-sm transition-colors ${bridgeStatus.connected ? 'bg-scada-danger text-white hover:bg-red-600' : 'bg-scada-accent text-white hover:bg-cyan-600'}`}
                  >
                    {bridgeStatus.connected ? 'Disconnect' : 'Connect'}
                  </button>
                </div>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-bold text-scada-muted uppercase">Bind to Network Adapter</label>
                <div className="relative">
                  <select
                    value={bridgeStatus.selectedAdapter || ''}
                    onChange={(e) => handleSelectAdapter(e.target.value)}
                    disabled={!bridgeStatus.connected || bridgeStatus.adapters.length === 0}
                    className="w-full bg-scada-bg border border-scada-border rounded px-3 py-2 text-white text-sm font-mono focus:border-scada-accent outline-none appearance-none disabled:opacity-50"
                  >
                    <option value="">-- Select Adapter --</option>
                    {bridgeStatus.adapters.map(adapter => (
                      <option key={adapter.ip} value={adapter.ip}>
                        {adapter.name} ({adapter.ip})
                      </option>
                    ))}
                  </select>
                  <Icons.ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-scada-muted pointer-events-none" />
                </div>
              </div>
            </div>

            <div className="mt-4 flex flex-wrap gap-4 text-xs font-mono text-scada-muted bg-black/20 p-2 rounded">
              <span>TX: <span className="text-scada-accent">{bridgeStatus.txCount}</span></span>
              <span>RX: <span className="text-scada-success">{bridgeStatus.rxCount}</span></span>
              <span>Active Endpoints: <span className="text-scada-success">{activeEndpoints.length}</span></span>
              <span>Failed Endpoints: <span className="text-scada-danger">{failedEndpoints.length}</span></span>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button
                onClick={handleConnectIec}
                disabled={!bridgeStatus.connected}
                className="px-3 py-1.5 rounded text-xs font-bold bg-purple-500/20 text-purple-300 border border-purple-500/40 hover:bg-purple-500/30 disabled:opacity-50 disabled:cursor-not-allowed"
                title="Push IEC 61850 endpoint bindings to relay"
              >
                Connect IEC 61850
              </button>
              {lastIecConnectAt && (
                <span className="text-[10px] text-scada-muted font-mono">
                  Last IEC connect: {new Date(lastIecConnectAt).toLocaleTimeString()}
                </span>
              )}
              {!bridgeStatus.connected && (
                <span className="text-[10px] text-scada-muted">Connect Bridge first to enable IEC connect.</span>
              )}
            </div>

            {bridgeStatus.lastRoute && (
              <div className="mt-2 text-xs font-mono text-scada-muted bg-black/20 p-2 rounded border border-scada-border/60">
                Route: <span className="text-scada-accent">{bridgeStatus.lastRoute}</span>
              </div>
            )}
            {!bridgeStatus.connected && bridgeStatus.lastError && (
              <div className="mt-3 text-xs font-mono text-scada-danger bg-scada-danger/10 border border-scada-danger/30 rounded p-2">
                Bridge Error: {bridgeStatus.lastError}
              </div>
            )}
          </div>

          <div className="bg-scada-panel border border-scada-border rounded-lg p-6">
            <h3 className="text-lg font-bold text-white flex items-center gap-2 mb-4">
              <Icons.Activity className="w-5 h-5 text-scada-accent" /> Binding Reports
            </h3>

            <div className="max-h-72 overflow-auto space-y-1 pr-1">
              {(bridgeStatus.boundEndpoints || []).length === 0 && (
                <div className="text-sm text-scada-muted">No endpoint reports yet. Connect bridge to view live binding status.</div>
              )}

              {(bridgeStatus.boundEndpoints || []).map((ep) => (
                <div key={`${ep.protocol || 'modbus'}-${ep.ip}:${ep.port}`} className="grid grid-cols-[0.8fr_2fr_0.8fr_0.7fr] gap-3 text-xs font-mono px-3 py-2 rounded bg-scada-bg border border-scada-border/70">
                  <span className={`uppercase ${ep.protocol === 'iec61850' ? 'text-purple-400' : 'text-yellow-400'}`}>
                    {ep.protocol === 'iec61850' ? 'IEC' : 'MODBUS'}
                  </span>
                  <span className="text-gray-300 truncate" title={`${ep.ip}:${ep.port}${ep.name ? ` (${ep.name})` : ''}${ep.backendHost ? ` -> ${ep.backendHost}:${ep.backendPort || 8102}` : ''}`}>
                    {ep.ip}:{ep.port}{ep.name ? ` (${ep.name})` : ''}{ep.backendHost ? ` -> ${ep.backendHost}:${ep.backendPort || 8102}` : ''}
                  </span>
                  <span className={ep.status === 'active' ? 'text-scada-success' : 'text-scada-danger'}>{ep.status.toUpperCase()}</span>
                  <span className="text-scada-accent text-right">{ep.protocol === 'iec61850' ? `C:${ep.clients ?? 0}` : '--'}</span>
                </div>
              ))}

              {failedEndpoints.map((ep) => (
                <div key={`${ep.protocol || 'modbus'}-${ep.ip}:${ep.port}-err`} className="text-scada-danger text-[10px] break-all px-1">
                  {(ep.protocol === 'iec61850' ? 'IEC' : 'Modbus')} {ep.ip}:{ep.port} - {ep.error}
                </div>
              ))}
              {failedEndpoints.some(ep => ep.protocol === 'iec61850' && String(ep.error || '').toLowerCase().includes('backend')) && (
                <div className="text-[10px] text-yellow-400 px-1 pt-1">
                  Note: Backend connection errors are expected in simulation mode. IEC devices will still accept client connections.
                </div>
              )}
            </div>
          </div>

          <div className="bg-scada-panel border border-scada-border rounded-lg p-6">
            <h3 className="text-lg font-bold text-white flex items-center gap-2 mb-4">
              <Icons.List className="w-5 h-5 text-gray-300" /> Configured Endpoint Inventory
            </h3>
            <div className="max-h-60 overflow-auto space-y-1 pr-1">
              {configuredEndpoints.length === 0 && (
                <div className="text-sm text-scada-muted">No device endpoints configured yet.</div>
              )}
              {configuredEndpoints.map((ep, idx) => (
                <div key={`${ep.protocol}-${ep.ip}:${ep.port}-${idx}`} className="flex items-center justify-between text-xs px-3 py-2 rounded bg-scada-bg border border-scada-border/70">
                  <span className="text-gray-300 truncate">{ep.name} · {ep.ip}:{ep.port}</span>
                  <span className={`uppercase font-mono ${ep.protocol === 'iec61850' ? 'text-purple-400' : 'text-yellow-400'}`}>
                    {ep.protocol === 'iec61850' ? 'IEC 61850' : 'Modbus'}
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div className="bg-scada-panel border border-scada-border rounded-lg p-6">
            <h3 className="text-lg font-bold text-white flex items-center gap-2 mb-4">
              <Icons.Settings className="w-5 h-5 text-purple-400" /> IEC Device Configuration
            </h3>
            <div className="mb-4 p-3 bg-blue-900/20 border border-blue-500/30 rounded text-xs text-blue-200">
              <strong>Auto-binding:</strong> IEC devices are automatically bound to the selected adapter in simulation mode. 
              Clients can connect directly to the assigned IPs. To proxy to a real MMS backend, configure the backend host/port below.
            </div>
            <div className="space-y-3">
              {iecServerDevices.length === 0 && (
                <div className="text-sm text-scada-muted">No IEC server devices available. Import an SCD to add devices.</div>
              )}
              {iecServerDevices.map((ied) => {
                const isSimulation = iecBackendInputs[ied.id]?.host === 'simulation' || ied.config?.iecBackendHost === 'simulation';
                return (
                <div key={ied.id} className="p-3 rounded bg-scada-bg border border-scada-border/70 space-y-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <label className="text-[10px] uppercase font-mono text-scada-muted">IEC Device</label>
                      <div className="text-sm text-gray-200 truncate" title={`${ied.name} (MMS ${ied.config?.mmsIp || ied.config?.ip || '0.0.0.0'}:${ied.config?.iecMmsPort ?? 102} / GOOSE ${ied.config?.gooseIp || ied.config?.ip || '0.0.0.0'})`}>
                        {ied.name} (MMS {ied.config?.mmsIp || ied.config?.ip || '0.0.0.0'}:{ied.config?.iecMmsPort ?? 102} / GOOSE {ied.config?.gooseIp || ied.config?.ip || '0.0.0.0'})
                      </div>
                    </div>
                    {isSimulation && (
                      <div className="text-[10px] uppercase font-mono px-2 py-1 bg-green-900/30 text-green-300 rounded border border-green-500/40">
                        Simulation
                      </div>
                    )}
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-[1fr_1fr_auto] gap-3 items-end">
                    <div>
                      <label className="text-[10px] uppercase font-mono text-scada-muted">MMS Bind IP</label>
                      <select
                        value={protocolIpInputs[ied.id]?.mmsIp || ''}
                        onChange={(e) => handleProtocolIpInput(ied.id, 'mmsIp', e.target.value)}
                        className="w-full bg-scada-panel border border-scada-border rounded px-2 py-1.5 text-xs font-mono text-white"
                      >
                        {(ied.config?.communicationIps?.length ? ied.config.communicationIps : [{ ip: ied.config?.ip || '0.0.0.0' }]).map((entry, idx) => (
                          <option key={`mms-${ied.id}-${idx}`} value={entry.ip}>{entry.ip}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="text-[10px] uppercase font-mono text-scada-muted">GOOSE Sim IP</label>
                      <select
                        value={protocolIpInputs[ied.id]?.gooseIp || ''}
                        onChange={(e) => handleProtocolIpInput(ied.id, 'gooseIp', e.target.value)}
                        className="w-full bg-scada-panel border border-scada-border rounded px-2 py-1.5 text-xs font-mono text-white"
                      >
                        {(ied.config?.communicationIps?.length ? ied.config.communicationIps : [{ ip: ied.config?.ip || '0.0.0.0' }]).map((entry, idx) => (
                          <option key={`goose-${ied.id}-${idx}`} value={entry.ip}>{entry.ip}</option>
                        ))}
                      </select>
                    </div>
                    <button
                      onClick={() => handleSaveProtocolIps(ied)}
                      className="px-3 py-1.5 bg-scada-accent text-white rounded text-xs font-bold hover:bg-cyan-600 transition-colors"
                    >
                      Save IPs
                    </button>
                  </div>

                  <details className="pt-2">
                    <summary className="text-[11px] uppercase font-mono text-scada-muted cursor-pointer hover:text-white">
                      Advanced: Backend Proxy (Optional)
                    </summary>
                    <div className="grid grid-cols-1 md:grid-cols-[1fr_0.6fr_1fr_auto] gap-3 items-end mt-3 pt-3 border-t border-scada-border/50">
                      <div>
                        <label className="text-[10px] uppercase font-mono text-scada-muted">Backend Host (leave 'simulation' for standalone)</label>
                        <input
                          type="text"
                          value={iecBackendInputs[ied.id]?.host || ''}
                          onChange={(e) => handleIecBackendInput(ied.id, 'host', e.target.value)}
                          placeholder="simulation"
                          className="w-full bg-scada-panel border border-scada-border rounded px-2 py-1.5 text-xs font-mono text-white focus:border-scada-accent outline-none"
                        />
                      </div>
                      <div>
                        <label className="text-[10px] uppercase font-mono text-scada-muted">Port</label>
                        <input
                          type="number"
                          value={iecBackendInputs[ied.id]?.port ?? 0}
                          onChange={(e) => handleIecBackendInput(ied.id, 'port', e.target.value)}
                          className="w-full bg-scada-panel border border-scada-border rounded px-2 py-1.5 text-xs font-mono text-white focus:border-scada-accent outline-none"
                        />
                      </div>
                      <div>
                        <label className="text-[10px] uppercase font-mono text-scada-muted">SCD File (for `iec:std:start`)</label>
                        <input
                          type="text"
                          value={iecBackendInputs[ied.id]?.scdFile || ''}
                          onChange={(e) => handleIecBackendInput(ied.id, 'scdFile', e.target.value)}
                          placeholder="DUBGG.scd"
                          className="w-full bg-scada-panel border border-scada-border rounded px-2 py-1.5 text-xs font-mono text-white focus:border-scada-accent outline-none"
                        />
                      </div>
                      <button
                        onClick={() => handleCopyStdBackendCommand(ied)}
                        className="px-3 py-1.5 bg-purple-700 text-white rounded text-xs font-bold hover:bg-purple-600 transition-colors"
                        title="Copy command with this SCD file for libiec backend startup"
                      >
                        Copy Start Cmd
                      </button>
                      <button
                        onClick={() => handleSaveIecBackend(ied)}
                        className="px-3 py-1.5 bg-gray-600 text-white rounded text-xs font-bold hover:bg-gray-500 transition-colors"
                      >
                        Save Backend
                      </button>
                    </div>
                  </details>
                </div>
              );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

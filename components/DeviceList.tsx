
import React, { useState } from 'react';
import { IEDNode, NodeType } from '../types';
import { Icons } from './Icons';

interface DeviceListProps {
  ieds: IEDNode[];
  onSelect: (id: string, mode: 'configure' | 'view') => void;
  onDelete: (id: string) => void;
}

export const DeviceList: React.FC<DeviceListProps> = ({ ieds, onSelect, onDelete }) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [filterType, setFilterType] = useState<'all' | 'iec61850' | 'modbus-server' | 'modbus-client'>('all');

  const getDeviceTypeLabel = (ied: IEDNode) => {
      if (ied.config?.pollingList) return 'Modbus Master / Client';
      if (ied.config?.modbusMap) return 'Modbus Slave / Server';
      return 'IEC 61850 Server';
  };

  const getDeviceTypeIcon = (ied: IEDNode) => {
      if (ied.config?.pollingList) return <Icons.Cable className="w-5 h-5 text-blue-400" />;
      if (ied.config?.modbusMap) return <Icons.Database className="w-5 h-5 text-yellow-400" />;
      return <Icons.Server className="w-5 h-5 text-scada-accent" />;
  };

  const filteredIEDs = ieds.filter(ied => {
      const matchesSearch = ied.name.toLowerCase().includes(searchTerm.toLowerCase()) || 
                            ied.description?.toLowerCase().includes(searchTerm.toLowerCase()) ||
                            ied.config?.ip.includes(searchTerm);
      
      if (!matchesSearch) return false;

      if (filterType === 'all') return true;
      if (filterType === 'iec61850') return !ied.config?.pollingList && !ied.config?.modbusMap;
      if (filterType === 'modbus-server') return !!ied.config?.modbusMap;
      if (filterType === 'modbus-client') return !!ied.config?.pollingList;
      
      return true;
  });

  return (
    <div className="h-full flex flex-col bg-scada-bg animate-in fade-in duration-300">
      {/* Header */}
      <div className="p-6 border-b border-scada-border bg-scada-panel/50">
          <div className="flex justify-between items-center mb-4">
              <div className="flex items-center gap-3">
                  <div className="p-2 bg-scada-bg border border-scada-border rounded-lg">
                      <Icons.List className="w-6 h-6 text-scada-accent" />
                  </div>
                  <div>
                      <h2 className="text-xl font-bold text-white">Device Inventory</h2>
                      <p className="text-sm text-scada-muted">Manage all network devices and simulators</p>
                  </div>
              </div>
              <div className="text-right">
                  <div className="text-2xl font-bold text-white">{ieds.length}</div>
                  <div className="text-xs text-scada-muted uppercase">Total Devices</div>
              </div>
          </div>

          <div className="flex flex-wrap gap-4 items-center">
              <div className="relative flex-1 min-w-[200px]">
                  <Icons.Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-scada-muted" />
                  <input 
                      type="text" 
                      placeholder="Search devices by name, IP, or description..." 
                      className="w-full bg-scada-bg border border-scada-border rounded-lg pl-10 pr-4 py-2 text-sm text-white focus:border-scada-accent outline-none"
                      value={searchTerm}
                      onChange={(e) => setSearchTerm(e.target.value)}
                  />
              </div>
              
              <div className="flex bg-scada-bg rounded-lg p-1 border border-scada-border">
                  <button onClick={() => setFilterType('all')} className={`px-3 py-1.5 text-xs font-bold rounded transition-colors ${filterType === 'all' ? 'bg-scada-accent text-white' : 'text-scada-muted hover:text-white'}`}>All</button>
                  <button onClick={() => setFilterType('iec61850')} className={`px-3 py-1.5 text-xs font-bold rounded transition-colors ${filterType === 'iec61850' ? 'bg-scada-accent text-white' : 'text-scada-muted hover:text-white'}`}>IEC 61850</button>
                  <button onClick={() => setFilterType('modbus-server')} className={`px-3 py-1.5 text-xs font-bold rounded transition-colors ${filterType === 'modbus-server' ? 'bg-scada-accent text-white' : 'text-scada-muted hover:text-white'}`}>Modbus Slave</button>
                  <button onClick={() => setFilterType('modbus-client')} className={`px-3 py-1.5 text-xs font-bold rounded transition-colors ${filterType === 'modbus-client' ? 'bg-scada-accent text-white' : 'text-scada-muted hover:text-white'}`}>Modbus Master</button>
              </div>
          </div>
      </div>

      {/* Grid */}
      <div className="flex-1 overflow-y-auto p-6">
          {filteredIEDs.length === 0 ? (
              <div className="h-64 flex flex-col items-center justify-center text-scada-muted opacity-50 border-2 border-dashed border-scada-border rounded-xl">
                  <Icons.Server className="w-12 h-12 mb-4" />
                  <p>No devices found matching your criteria.</p>
              </div>
          ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
                  {filteredIEDs.map(ied => (
                      <div key={ied.id} className="bg-scada-panel border border-scada-border rounded-xl p-5 hover:border-scada-accent/50 transition-colors group relative flex flex-col">
                          <div className="flex justify-between items-start mb-4">
                              <div className="flex items-center gap-3">
                                  <div className="p-2.5 bg-scada-bg rounded-lg border border-scada-border group-hover:border-scada-accent/30 transition-colors">
                                      {getDeviceTypeIcon(ied)}
                                  </div>
                                  <div>
                                      <h3 className="font-bold text-white truncate max-w-[150px]" title={ied.name}>{ied.name}</h3>
                                      <div className="text-xs text-scada-muted">{getDeviceTypeLabel(ied)}</div>
                                  </div>
                              </div>
                              <div className="flex gap-1">
                                  <span className={`w-2 h-2 rounded-full mt-1.5 ${'bg-scada-success animate-pulse'}`}></span>
                              </div>
                          </div>
                          
                          <div className="space-y-2 mb-6 flex-1">
                              <div className="flex justify-between text-xs border-b border-scada-border/50 pb-1">
                                  <span className="text-scada-muted">IP Address</span>
                                  <span className="font-mono text-gray-300">{ied.config?.ip || 'N/A'}</span>
                              </div>
                              <div className="flex justify-between text-xs border-b border-scada-border/50 pb-1">
                                  <span className="text-scada-muted">VLAN</span>
                                  <span className="font-mono text-gray-300">{ied.config?.vlan || 1}</span>
                              </div>
                              <div className="flex justify-between text-xs border-b border-scada-border/50 pb-1">
                                  <span className="text-scada-muted">Nodes/Regs</span>
                                  <span className="font-mono text-gray-300">
                                      {ied.config?.modbusMap ? `${ied.config.modbusMap.length} Regs` : ied.children ? `${ied.children.length} LDs` : '0'}
                                  </span>
                              </div>
                              {ied.description && (
                                  <div className="text-xs text-scada-muted italic truncate pt-1" title={ied.description}>
                                      "{ied.description}"
                                  </div>
                              )}
                          </div>

                          <div className="flex gap-2 mt-auto">
                              <button 
                                  onClick={() => onSelect(ied.id, 'view')}
                                  className="flex-1 py-2 bg-scada-bg hover:bg-white/5 border border-scada-border rounded text-xs font-bold text-gray-300 transition-colors flex items-center justify-center gap-2"
                              >
                                  <Icons.Eye className="w-3 h-3" /> View Data
                              </button>
                              
                              {!!ied.config?.modbusMap && (
                                  <button 
                                      onClick={() => onSelect(ied.id, 'configure')}
                                      className="flex-1 py-2 bg-scada-bg hover:bg-white/5 border border-scada-border rounded text-xs font-bold text-gray-300 transition-colors flex items-center justify-center gap-2"
                                  >
                                      <Icons.Settings className="w-3 h-3" /> Config
                                  </button>
                              )}

                              <button 
                                  onClick={() => onDelete(ied.id)}
                                  className="px-3 py-2 bg-scada-danger/10 hover:bg-scada-danger/20 border border-scada-danger/30 rounded text-scada-danger transition-colors"
                                  title="Delete Device"
                              >
                                  <Icons.Trash className="w-3 h-3" />
                              </button>
                          </div>
                      </div>
                  ))}
              </div>
          )}
      </div>
    </div>
  );
};

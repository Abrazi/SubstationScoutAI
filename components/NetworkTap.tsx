import React, { useState, useEffect, useRef } from 'react';
import { NetworkPacket } from '../types';
import { Icons } from './Icons';
import { engine } from '../services/SimulationEngine';

export const NetworkTap = () => {
  const [packets, setPackets] = useState<NetworkPacket[]>([]);
  const [isCapturing, setIsCapturing] = useState(true);
  const [filter, setFilter] = useState('');
  const [selectedPacket, setSelectedPacket] = useState<NetworkPacket | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isCapturing) return;
    
    const unsubscribe = engine.subscribeToTraffic((packet) => {
        setPackets(prev => {
            const next = [...prev, packet];
            if (next.length > 2000) return next.slice(-2000); // Keep buffer manageable
            return next;
        });
    });
    
    return () => unsubscribe();
  }, [isCapturing]);

  // Auto-scroll to bottom if not inspecting
  useEffect(() => {
    if (scrollRef.current && !selectedPacket) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [packets, selectedPacket]);

  const getProtocolColor = (proto: string) => {
      switch (proto) {
          case 'MMS': return 'text-emerald-400 bg-emerald-400/10 border-emerald-400/20';
          case 'GOOSE': return 'text-purple-400 bg-purple-400/10 border-purple-400/20';
          case 'SV': return 'text-blue-400 bg-blue-400/10 border-blue-400/20';
          case 'ModbusTCP': return 'text-yellow-400 bg-yellow-400/10 border-yellow-400/20';
          default: return 'text-gray-400';
      }
  };

  const filteredPackets = packets.filter(p => 
      !filter || 
      p.protocol.toLowerCase().includes(filter.toLowerCase()) || 
      p.source.includes(filter) || 
      p.info.toLowerCase().includes(filter.toLowerCase())
  );

  return (
    <div className="h-full flex flex-col bg-scada-bg text-scada-text animate-in fade-in duration-300">
      
      {/* Header & Controls */}
      <div className="p-4 border-b border-scada-border bg-scada-panel/50 flex items-center justify-between">
         <div className="flex items-center gap-3">
             <div className="p-2 bg-scada-bg border border-scada-border rounded">
                 <Icons.Activity className="w-5 h-5 text-scada-accent" />
             </div>
             <div>
                 <h2 className="text-lg font-bold text-white">Network Tap</h2>
                 <p className="text-xs text-scada-muted">Virtual Network Interface (vNIC0)</p>
             </div>
         </div>
         
         <div className="flex items-center gap-3">
             {/* Filter Input */}
             <div className="relative">
                 <Icons.Filter className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-scada-muted" />
                 <input 
                    type="text" 
                    placeholder="Filter packets..." 
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    className="bg-scada-bg border border-scada-border rounded pl-9 pr-3 py-1.5 text-sm focus:outline-none focus:border-scada-accent w-64"
                 />
             </div>
             
             <div className="h-6 w-px bg-scada-border mx-2" />

             {/* Controls */}
             <button 
                onClick={() => setIsCapturing(!isCapturing)}
                className={`flex items-center gap-2 px-4 py-1.5 rounded font-medium text-sm transition-colors border ${isCapturing ? 'bg-scada-danger/10 text-scada-danger border-scada-danger/30 hover:bg-scada-danger/20' : 'bg-scada-success/10 text-scada-success border-scada-success/30 hover:bg-scada-success/20'}`}
             >
                 {isCapturing ? <><Icons.Pause className="w-4 h-4" /> Stop Capture</> : <><Icons.Play className="w-4 h-4" /> Start Capture</>}
             </button>
             
             <button 
                onClick={() => setPackets([])}
                className="p-1.5 text-scada-muted hover:text-white hover:bg-white/10 rounded border border-transparent hover:border-scada-border transition-colors"
                title="Clear Buffer"
             >
                 <Icons.Trash className="w-4 h-4" />
             </button>
         </div>
      </div>

      {/* Main Split View */}
      <div className="flex-1 flex overflow-hidden">
          
          {/* Packet List */}
          <div className="flex-1 flex flex-col min-w-0">
             {/* Table Header */}
             <div className="flex text-xs font-bold text-scada-muted uppercase bg-scada-panel border-b border-scada-border px-4 py-2 select-none">
                 <div className="w-20 shrink-0">No.</div>
                 <div className="w-24 shrink-0">Time</div>
                 <div className="w-32 shrink-0">Source</div>
                 <div className="w-32 shrink-0">Destination</div>
                 <div className="w-24 shrink-0">Protocol</div>
                 <div className="w-16 shrink-0">Len</div>
                 <div className="flex-1">Info</div>
             </div>

             {/* Packet Rows */}
             <div className="flex-1 overflow-y-auto font-mono text-xs" ref={scrollRef}>
                 {filteredPackets.length === 0 && (
                     <div className="flex flex-col items-center justify-center h-full text-scada-muted opacity-50">
                         <Icons.Activity className="w-12 h-12 mb-4" />
                         <p>No packets captured</p>
                     </div>
                 )}
                 {filteredPackets.map((p) => {
                     const isSelected = selectedPacket?.id === p.id;
                     return (
                         <div 
                            key={p.id}
                            onClick={() => setSelectedPacket(p)}
                            className={`flex items-center px-4 py-1 cursor-pointer border-b border-scada-border/30 hover:bg-white/5 ${isSelected ? 'bg-scada-accent/20 text-white' : ''} ${getProtocolColor(p.protocol)} bg-opacity-0 hover:bg-opacity-5`}
                         >
                             <div className="w-20 shrink-0 text-scada-muted">{p.id}</div>
                             <div className="w-24 shrink-0 text-gray-400">{(p.timestamp / 1000).toFixed(4)}</div>
                             <div className="w-32 shrink-0 truncate text-gray-300" title={p.source}>{p.source}</div>
                             <div className="w-32 shrink-0 truncate text-gray-300" title={p.destination}>{p.destination}</div>
                             <div className="w-24 shrink-0 font-bold">{p.protocol}</div>
                             <div className="w-16 shrink-0 text-scada-muted">{p.length}</div>
                             <div className="flex-1 truncate">{p.info}</div>
                         </div>
                     )
                 })}
             </div>
          </div>

          {/* Packet Details (Side Inspector) */}
          {selectedPacket && (
              <div className="w-96 border-l border-scada-border bg-scada-panel/30 flex flex-col font-mono text-xs">
                  <div className="p-3 border-b border-scada-border bg-scada-panel flex justify-between items-center">
                      <span className="font-bold text-gray-200">Packet Details #{selectedPacket.id}</span>
                      <button onClick={() => setSelectedPacket(null)} className="text-scada-muted hover:text-white"><Icons.ChevronRight className="w-4 h-4" /></button>
                  </div>
                  <div className="flex-1 overflow-y-auto p-4 space-y-4">
                      {/* Ethernet Header */}
                      <div>
                          <div className="text-scada-muted mb-1 flex items-center gap-2 font-bold bg-white/5 p-1 rounded"><Icons.ChevronDown className="w-3 h-3"/> Ethernet II, Src: {selectedPacket.source}, Dst: {selectedPacket.destination}</div>
                          <div className="pl-4 space-y-1 text-gray-400">
                              <div>Destination: {selectedPacket.destination}</div>
                              <div>Source: {selectedPacket.source}</div>
                              <div>Type: IPv4 (0x0800)</div>
                          </div>
                      </div>

                      {/* IP Header */}
                      <div>
                          <div className="text-scada-muted mb-1 flex items-center gap-2 font-bold bg-white/5 p-1 rounded"><Icons.ChevronDown className="w-3 h-3"/> Internet Protocol Version 4</div>
                          <div className="pl-4 space-y-1 text-gray-400">
                              <div>Version: 4</div>
                              <div>Header Length: 20 bytes</div>
                              <div>Total Length: {selectedPacket.length}</div>
                          </div>
                      </div>

                      {/* Protocol Specific Payload */}
                      <div>
                          <div className={`text-scada-muted mb-1 flex items-center gap-2 font-bold bg-white/5 p-1 rounded ${getProtocolColor(selectedPacket.protocol).split(' ')[0]}`}>
                              <Icons.ChevronDown className="w-3 h-3"/> {selectedPacket.protocol} Protocol Data
                          </div>
                          <div className="pl-4 space-y-2 text-gray-300 mt-2">
                              {selectedPacket.raw ? (
                                  Object.entries(selectedPacket.raw).map(([k, v]) => (
                                      <div key={k} className="flex justify-between border-b border-scada-border/30 pb-1">
                                          <span className="text-scada-muted">{k}:</span>
                                          <span>{String(v)}</span>
                                      </div>
                                  ))
                              ) : (
                                  <div className="italic text-gray-500">Raw payload data not captured.</div>
                              )}
                              <div className="mt-4 p-2 bg-black/30 rounded border border-scada-border font-mono text-[10px] break-all text-gray-500">
                                  0000   00 0c 29 3e 4a 5b 00 0c 29 1a 2b 3c 08 00 45 00  ..)&gt;J[..).+&lt;..E.<br/>
                                  0010   00 3c 1a 2b 40 00 40 06 a2 b1 c0 a8 01 64 c0 a8  .&lt;.+@.@......d..<br/>
                                  0020   01 32 01 bb 04 d2 1a 2b 3c 4d 00 00 00 00 a0 02  .2.....+&lt;M......<br/>
                                  ...
                              </div>
                          </div>
                      </div>
                  </div>
              </div>
          )}
      </div>
    </div>
  );
};

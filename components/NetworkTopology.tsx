import React, { useMemo, useState, useEffect } from 'react';
import { IEDNode, NetworkLink, NetworkNode, NetworkPacket } from '../types';
import { Icons } from './Icons';
import { engine } from '../services/SimulationEngine';

interface NetworkTopologyProps {
  ieds: IEDNode[];
  onSelectIED: (id: string) => void;
  simulationTime: number; // Used to trigger traffic generation
}

interface Packet {
  id: number;
  linkId: string;
  path: string;
  color: string;
  progress: number;
}

// Network Configuration Constants
const VLAN_CONFIG = {
  10: { name: 'Station Bus (IEC 61850-8-1)', color: '#10b981', subnet: '10.0.10' }, // Emerald
  20: { name: 'Process Bus (IEC 61850-9-2)', color: '#3b82f6', subnet: '10.0.20' }, // Blue
  1:  { name: 'Management', color: '#64748b', subnet: '192.168.1' } // Slate
};

export const NetworkTopology: React.FC<NetworkTopologyProps> = ({ ieds, onSelectIED, simulationTime }) => {
  // Transform IEDs into Network Nodes for visualization
  const { nodes, links } = useMemo(() => {
    // Central Switch Configuration
    const centerNode: NetworkNode = { 
        id: 'switch-01', 
        name: 'Core Switch (RSTP)', 
        type: 'switch', 
        x: 400, 
        y: 350, 
        status: 'online',
        ip: '10.0.0.1',
        vlan: 1
    };
    
    const radius = 240;
    
    const iedNodes: NetworkNode[] = ieds.map((ied, index) => {
      // Logic: Use Config if available, else fallback to heuristic
      let ip, vlanId;
      
      if (ied.config) {
          ip = ied.config.ip;
          vlanId = ied.config.vlan;
      } else {
          // Fallback heuristic
          const isProcessBus = index % 2 !== 0; 
          vlanId = isProcessBus ? 20 : 10;
          const config = VLAN_CONFIG[vlanId as keyof typeof VLAN_CONFIG];
          const host = 100 + index;
          ip = `${config.subnet}.${host}`;
      }
      
      const angle = (index / ieds.length) * 2 * Math.PI - (Math.PI / 2); // Start from top
      
      return {
        id: ied.id,
        name: ied.name,
        type: 'ied',
        x: 400 + radius * Math.cos(angle),
        y: 350 + radius * Math.sin(angle),
        status: 'online',
        ip: ip,
        vlan: vlanId
      };
    });

    const generatedLinks: NetworkLink[] = iedNodes.map(node => ({
      id: `link-${node.id}`,
      sourceId: centerNode.id,
      targetId: node.id,
      type: 'fiber',
      vlan: node.vlan
    }));

    return { nodes: [centerNode, ...iedNodes], links: generatedLinks };
  }, [ieds]);

  const [packets, setPackets] = useState<Packet[]>([]);
  const [linkActivity, setLinkActivity] = useState<Record<string, number>>({});

  // Animation Loop (60fps)
  useEffect(() => {
    let animationFrameId: number;

    const animate = () => {
      // 1. Move packets
      setPackets(prev => {
        if (prev.length === 0) return prev;
        return prev.map(p => ({ ...p, progress: p.progress + 1.5 })).filter(p => p.progress < 100);
      });

      // 2. Decay link activity
      setLinkActivity(prev => {
        const next = { ...prev };
        let hasChanges = false;

        Object.keys(next).forEach(key => {
          if (next[key] > 0) {
            next[key] = Math.max(0, next[key] - 0.03); // Fade out speed
            hasChanges = true;
          } else {
             delete next[key];
             hasChanges = true;
          }
        });

        if (!hasChanges) return prev;
        return next;
      });

      animationFrameId = requestAnimationFrame(animate);
    };

    animationFrameId = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(animationFrameId);
  }, []);

  // Real Traffic Monitoring
  useEffect(() => {
      const handlePacket = (packet: NetworkPacket) => {
          // Find source node by name (Packet source uses IED Name, Nodes use generated ID, but we mapped names)
          const sourceNode = nodes.find(n => n.name === packet.source);
          
          if (sourceNode) {
              const linkToSwitch = links.find(l => (l.sourceId === sourceNode.id && l.targetId === 'switch-01') || (l.sourceId === 'switch-01' && l.targetId === sourceNode.id));
              
              if (linkToSwitch) {
                  // Determine direction: Source -> Switch
                  const start = sourceNode;
                  const end = nodes.find(n => n.id === 'switch-01');
                  
                  if (start && end) {
                      const color = packet.protocol === 'GOOSE' ? '#a855f7' : (packet.protocol === 'SV' ? '#3b82f6' : '#10b981'); 
                      
                      setPackets(prev => [...prev, {
                          id: packet.id,
                          linkId: linkToSwitch.id,
                          path: `M ${start.x} ${start.y} L ${end.x} ${end.y}`,
                          color: color,
                          progress: 0
                      }]);
                      
                      // Flash link
                      setLinkActivity(prev => ({ ...prev, [linkToSwitch.id]: 1.0 }));
                  }
              }
          }
      };

      const unsubscribe = engine.subscribeToTraffic(handlePacket);
      return () => unsubscribe();
  }, [nodes, links]);

  // Background Noise Traffic (Optional, for liveliness)
  useEffect(() => {
    if (links.length === 0) return;
    if (Math.random() > 0.3) return; // Reduce noise

    const link = links[Math.floor(Math.random() * links.length)];
    const color = '#64748b'; // Grey for noise

    const sourceNode = nodes.find(n => n.id === link.sourceId);
    const targetNode = nodes.find(n => n.id === link.targetId);
    
    if (sourceNode && targetNode) {
        setPackets(prev => [...prev, {
            id: Date.now() + Math.random(),
            linkId: link.id,
            path: `M ${sourceNode.x} ${sourceNode.y} L ${targetNode.x} ${targetNode.y}`,
            color: color, 
            progress: 0
        }]);
    }
  }, [simulationTime, links, nodes]);

  return (
    <div className="w-full h-full bg-scada-bg relative overflow-hidden">
      
      {/* Network Legend Panel */}
      <div className="absolute top-4 left-4 z-10 bg-scada-panel/90 p-3 rounded-lg border border-scada-border backdrop-blur shadow-lg w-64">
        <h3 className="text-xs font-bold uppercase text-scada-muted mb-3 flex items-center gap-2">
            <Icons.Wifi className="w-3 h-3" /> Network Segments
        </h3>
        <div className="space-y-2">
            {Object.entries(VLAN_CONFIG).map(([vlanId, config]) => (
                 vlanId !== '1' && (
                    <div key={vlanId} className="flex items-center justify-between text-xs">
                        <div className="flex items-center gap-2">
                            <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: config.color }}></span>
                            <span className="text-gray-300 font-medium">{config.name}</span>
                        </div>
                        <span className="font-mono text-scada-muted opacity-75">VLAN {vlanId}</span>
                    </div>
                 )
            ))}
        </div>
        
        <div className="my-3 border-t border-scada-border/50"></div>
        
        <h3 className="text-xs font-bold uppercase text-scada-muted mb-2">Protocol Traffic</h3>
        <div className="flex items-center gap-2 text-xs mb-1">
            <span className="w-2 h-2 rounded-full bg-purple-500 animate-pulse"></span> 
            <span className="text-gray-300">GOOSE (L2 Multicast)</span>
        </div>
        <div className="flex items-center gap-2 text-xs">
            <span className="w-2 h-2 rounded-full bg-emerald-500"></span> 
            <span className="text-gray-300">MMS (TCP/IP)</span>
        </div>
      </div>

      <svg className="w-full h-full pointer-events-none">
        <defs>
            <filter id="glow">
                <feGaussianBlur stdDeviation="2.5" result="coloredBlur"/>
                <feMerge>
                    <feMergeNode in="coloredBlur"/>
                    <feMergeNode in="SourceGraphic"/>
                </feMerge>
            </filter>
        </defs>
        
        {/* Network Links */}
        {links.map(link => {
             const source = nodes.find(n => n.id === link.sourceId)!;
             const target = nodes.find(n => n.id === link.targetId)!;
             const intensity = linkActivity[link.id] || 0;
             const vlanColor = VLAN_CONFIG[link.vlan as keyof typeof VLAN_CONFIG]?.color || '#64748b';
             
             // Dynamic Style
             const isActive = intensity > 0.01;
             
             return (
                 <g key={link.id}>
                     {/* Base Line (Darker) */}
                     <line 
                        x1={source.x} y1={source.y}
                        x2={target.x} y2={target.y}
                        stroke={vlanColor}
                        strokeWidth={isActive ? 2 : 1}
                        strokeOpacity={0.2}
                        strokeLinecap="round"
                     />
                     {/* Active Highlight Overlay (Brighter) */}
                     <line 
                        x1={source.x} y1={source.y}
                        x2={target.x} y2={target.y}
                        stroke={vlanColor}
                        strokeWidth={3}
                        strokeOpacity={intensity}
                        filter={isActive ? "url(#glow)" : undefined}
                     />
                 </g>
             )
        })}

        {/* Traffic Packets */}
        {packets.map(p => {
             const parts = p.path.split(' ');
             const x1 = parseFloat(parts[1]);
             const y1 = parseFloat(parts[2]);
             const x2 = parseFloat(parts[4]);
             const y2 = parseFloat(parts[5]);
             
             const cx = x1 + (x2 - x1) * (p.progress / 100);
             const cy = y1 + (y2 - y1) * (p.progress / 100);

             return (
                 <circle 
                    key={p.id}
                    cx={cx} cy={cy} r={4}
                    fill={p.color}
                    filter="url(#glow)"
                 />
             );
        })}
      </svg>

      {/* Interactive Nodes */}
      {nodes.map(node => {
        const vlanConfig = node.vlan ? VLAN_CONFIG[node.vlan as keyof typeof VLAN_CONFIG] : null;
        const isOnline = node.status === 'online';
        
        return (
            <div 
                key={node.id}
                className={`absolute -translate-x-1/2 -translate-y-1/2 cursor-pointer transition-all duration-300 group z-20`}
                style={{ left: node.x, top: node.y }}
                onClick={() => node.type === 'ied' && onSelectIED(node.id)}
            >
                <div className={`
                    w-12 h-12 rounded-lg flex items-center justify-center border-2 shadow-[0_0_15px_rgba(0,0,0,0.5)]
                    transition-all duration-300 relative bg-scada-panel
                    ${node.type === 'switch' 
                        ? 'border-white/20' 
                        : isOnline 
                            ? 'border-scada-border hover:border-scada-accent hover:shadow-[0_0_20px_rgba(6,182,212,0.4)]'
                            : 'border-scada-danger hover:border-red-500'} 
                `}>
                    {/* Icon */}
                    {node.type === 'switch' 
                        ? <Icons.Box className="text-white w-6 h-6" /> 
                        : <Icons.Server className={`w-6 h-6 transition-colors ${isOnline ? 'text-scada-muted group-hover:text-scada-accent' : 'text-scada-danger'}`} />}

                    {/* VLAN Indicator Badge */}
                    {vlanConfig && node.type !== 'switch' && (
                        <div 
                            className="absolute -bottom-1 -right-1 w-3 h-3 rounded-full border border-scada-bg" 
                            style={{ backgroundColor: vlanConfig.color }}
                            title={`VLAN ${node.vlan}: ${vlanConfig.name}`}
                        />
                    )}
                </div>
                
                {/* Status Indicator (Animated) */}
                <div className="absolute -top-1.5 -right-1.5 flex h-3 w-3 pointer-events-none">
                    {isOnline && (
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-scada-success opacity-75"></span>
                    )}
                    <span className={`relative inline-flex rounded-full h-3 w-3 border-2 border-scada-bg ${
                        isOnline ? 'bg-scada-success' : 
                        node.status === 'error' ? 'bg-scada-danger' : 'bg-scada-muted'
                    }`}></span>
                </div>
                
                {/* Enhanced Tooltip Label */}
                <div className={`
                    absolute top-14 left-1/2 -translate-x-1/2 px-3 py-2 bg-scada-panel/95 backdrop-blur rounded-md border border-scada-border text-center min-w-[140px] pointer-events-none 
                    transition-all duration-200 shadow-xl z-30
                    ${node.type === 'switch' ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 translate-y-2 group-hover:translate-y-0'}
                `}>
                    <div className="text-xs font-bold text-white whitespace-nowrap mb-1">{node.name}</div>
                    <div className="flex flex-col gap-0.5">
                        <div className="flex items-center justify-between gap-4 text-[10px] font-mono text-scada-muted">
                            <span>IP:</span>
                            <span className="text-scada-accent">{node.ip}</span>
                        </div>
                        {node.vlan && (
                            <div className="flex items-center justify-between gap-4 text-[10px] font-mono text-scada-muted">
                                <span>VLAN:</span>
                                <span style={{ color: vlanConfig?.color }}>{node.vlan}</span>
                            </div>
                        )}
                        <div className="flex items-center justify-between gap-4 text-[10px] font-mono text-scada-muted border-t border-scada-border/50 pt-1 mt-1">
                            <span>Status:</span>
                            <span className={isOnline ? 'text-scada-success' : 'text-scada-danger'}>
                                {node.status.toUpperCase()}
                            </span>
                        </div>
                    </div>
                </div>
            </div>
        );
      })}
    </div>
  );
};

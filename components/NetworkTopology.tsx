
import React, { useMemo, useState, useEffect, useRef } from 'react';
import { IEDNode, NetworkLink, NetworkNode, NetworkPacket } from '../types';
import { Icons } from './Icons';
import { engine } from '../services/SimulationEngine';

// improved typing for VLAN configuration

type VlanConfig = {
  name: string;
  color: string;
  subnet: string;
};

interface NetworkTopologyProps {
  ieds: IEDNode[];
  onSelectIED: (id: string) => void;
  onDeleteIED: (id: string) => void;
  simulationTime: number; // Used to trigger traffic generation
}

interface Packet {
  id: number;
  linkId: string;
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  color: string;
  progress: number;
}

// Article: VLAN Constitution Constants
const VLAN_CONFIG: Record<number, VlanConfig> = {
  10: { name: 'Station Bus (IEC 61850-8-1)', color: '#10b981', subnet: '10.0.10' },
  20: { name: 'Process Bus (IEC 61850-9-2)', color: '#3b82f6', subnet: '10.0.20' },
  1: { name: 'Management', color: '#64748b', subnet: '192.168.1' }
};

const MAX_ACTIVE_PACKETS = 120;
const ANIMATION_SPEED = 2.4; // Made configurable
const DRAG_THRESHOLD = 5; // pixels

export const NetworkTopology: React.FC<NetworkTopologyProps> = ({
  ieds,
  onSelectIED,
  onDeleteIED,
  simulationTime
}) => {
  const [switchConfig, setSwitchConfig] = useState({
    ip: '10.0.0.1',
    name: 'Core Switch (RSTP)'
  });
  const [isEditingSwitch, setIsEditingSwitch] = useState(false);
  const [activeVlanFilter, setActiveVlanFilter] = useState<keyof typeof VLAN_CONFIG | 'all'>('all');
  const [nodePositions, setNodePositions] = useState<Record<string, { x: number; y: number }>>({});
  const [legendPos, setLegendPos] = useState({ x: 16, y: 16 });
  const [draggingNodeId, setDraggingNodeId] = useState<string | null>(null);
  const [draggingLegend, setDraggingLegend] = useState(false);
  const [dragStartPos, setDragStartPos] = useState<{ x: number; y: number } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  const dragOffsetRef = useRef({ x: 0, y: 0 });
  const animationFrameRef = useRef<number | null>(null);
  const animationCallbackRef = useRef<FrameRequestCallback | null>(null);
  const packetsRef = useRef<Packet[]>([]);
  const prevNodesRef = useRef<NetworkNode[]>([]);
  const filterId = useMemo(() => `glow-${Math.random().toString(36).slice(2, 9)}`, []);


  // Transform IEDs into Network Nodes for visualization
  const { nodes, links } = useMemo(() => {
    // Central Switch Configuration
    const centerNode: NetworkNode = { 
        id: 'switch-01', 
        name: switchConfig.name, 
        type: 'switch', 
        x: 400, 
        y: 350, 
        status: 'online',
        ip: switchConfig.ip,
        vlan: 1
    };
    
    const radius = 240;
    
    const iedNodes: NetworkNode[] = ieds.map((ied, index) => {
      // Logic: Use Config if available, else fallback to heuristic
      let ip: string | undefined;
      let vlanId: keyof typeof VLAN_CONFIG;
      
      if (ied.config) {
          ip = ied.config.ip;
          vlanId = ied.config.vlan as keyof typeof VLAN_CONFIG;
      } else {
          // Fallback heuristic
          const isProcessBus = index % 2 !== 0; 
          vlanId = isProcessBus ? 20 : 10;
      }
      
      // Safety check for unknown VLANs
      if (!Object.keys(VLAN_CONFIG).includes(String(vlanId))) {
          vlanId = 10;
      }

      if (!ip) {
          const config = VLAN_CONFIG[vlanId as keyof typeof VLAN_CONFIG];
          ip = `${config.subnet}.${100 + index}`;
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
                modbusPort: ied.config?.modbusMap ? (ied.config.modbusPort ?? 502) : undefined,
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
  }, [ieds, switchConfig]);

  const [packets, setPackets] = useState<Packet[]>([]);
  const [linkActivity, setLinkActivity] = useState<Record<string, number>>({});

    const positionedNodes = useMemo(() => {
        return nodes.map(node => {
            const override = nodePositions[node.id];
            return override ? { ...node, x: override.x, y: override.y } : node;
        });
    }, [nodes, nodePositions]);

    // only update positions when there are truly new nodes
    useEffect(() => {
        const prevIds = new Set(prevNodesRef.current.map(n => n.id));
        const hasNew = nodes.some(n => !prevIds.has(n.id));
        if (hasNew) {
            setNodePositions(prev => {
                const next: Record<string, { x: number; y: number }> = {};
                nodes.forEach(node => {
                    next[node.id] = prev[node.id] || { x: node.x, y: node.y };
                });
                return next;
            });
        }
        prevNodesRef.current = nodes;
    }, [nodes]);

    useEffect(() => {
        const handleMouseMove = (e: MouseEvent) => {
            if (draggingNodeId) {
                setNodePositions(prev => ({
                    ...prev,
                    [draggingNodeId]: {
                        x: e.clientX - dragOffsetRef.current.x,
                        y: e.clientY - dragOffsetRef.current.y
                    }
                }));
            }

            if (draggingLegend) {
                setLegendPos({
                    x: Math.max(0, e.clientX - dragOffsetRef.current.x),
                    y: Math.max(0, e.clientY - dragOffsetRef.current.y)
                });
            }
        };

        const handleMouseUp = () => {
            setDraggingNodeId(null);
            setDraggingLegend(false);
        };

        if (draggingNodeId || draggingLegend) {
            document.addEventListener('mousemove', handleMouseMove);
            document.addEventListener('mouseup', handleMouseUp);
        }

        return () => {
            document.removeEventListener('mousemove', handleMouseMove);
            document.removeEventListener('mouseup', handleMouseUp);
        };
    }, [draggingNodeId, draggingLegend]);

  // animation loop using refs to avoid stale closures and memory leaks
  animationCallbackRef.current = () => {
    // 1. Move packets (mutating ref for performance)
    packetsRef.current = packetsRef.current
      .map(p => ({ ...p, progress: p.progress + ANIMATION_SPEED }))
      .filter(p => p.progress < 100);

    // batch update state once per frame
    setPackets([...packetsRef.current]);

    // 2. decay link activity more efficiently
    setLinkActivity(prev => {
      const next: Record<string, number> = {};
      let hasChanges = false;

      Object.entries(prev).forEach(([key, value]) => {
        if (value > 0) {
          const newValue = Math.max(0, value - 0.03);
          if (newValue > 0 || value <= 0.03) {
            next[key] = newValue;
          }
          hasChanges = true;
        }
      });

      return hasChanges ? next : prev;
    });

    animationFrameRef.current = requestAnimationFrame(animationCallbackRef.current!);
  };

  useEffect(() => {
    animationFrameRef.current = requestAnimationFrame(animationCallbackRef.current!);
    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, []);

  // Real Traffic Monitoring
  useEffect(() => {
      const handlePacket = (packet: NetworkPacket) => {
          const sourceNode = positionedNodes.find(n => n.name === packet.source);
          if (!sourceNode) return;

          const linkToSwitch = links.find(l => (
              (l.sourceId === sourceNode.id && l.targetId === 'switch-01') ||
              (l.sourceId === 'switch-01' && l.targetId === sourceNode.id)
          ));
          if (!linkToSwitch) return;

          const end = positionedNodes.find(n => n.id === 'switch-01');
          if (!end) return;

          const color = packet.protocol === 'GOOSE'
              ? '#a855f7'
              : packet.protocol === 'SV'
                  ? '#3b82f6'
                  : '#10b981';

          const newPacket: Packet = {
              id: packet.id,
              linkId: linkToSwitch.id,
              startX: sourceNode.x,
              startY: sourceNode.y,
              endX: end.x,
              endY: end.y,
              color,
              progress: 0
          };

          packetsRef.current.push(newPacket);
          if (packetsRef.current.length > MAX_ACTIVE_PACKETS) {
              packetsRef.current.shift();
          }
          setPackets([...packetsRef.current]);

          setLinkActivity(prev => ({ ...prev, [linkToSwitch.id]: 1.0 }));
      };

      const unsubscribe = engine.subscribeToTraffic(handlePacket);
      return () => unsubscribe();
    }, [positionedNodes, links]);

    // Background noise disabled to reduce visual clutter and render load.

  return (
    <div className="w-full h-full bg-scada-bg relative overflow-hidden">
      
      {/* Network Legend Panel */}
            <div className="absolute z-10 bg-scada-panel/90 p-3 rounded-lg border border-scada-border backdrop-blur shadow-lg w-72" style={{ top: legendPos.y, left: legendPos.x }}>
                <div
                    className="-mx-3 -mt-3 mb-2 px-3 py-1.5 bg-scada-bg/60 border-b border-scada-border cursor-move rounded-t-lg text-[10px] uppercase text-scada-muted tracking-wide"
                    onMouseDown={(e) => {
                        setDraggingLegend(true);
                        dragOffsetRef.current = { x: e.clientX - legendPos.x, y: e.clientY - legendPos.y };
                    }}
                >
                    VLAN Segment Window
                </div>
        <div className="flex justify-between items-center mb-3">
            <h3 className="text-xs font-bold uppercase text-scada-muted flex items-center gap-2">
                <Icons.Wifi className="w-3 h-3" /> VLAN Segments
            </h3>
            <div className="flex gap-2">
                {activeVlanFilter !== 'all' && (
                    <button 
                        onClick={() => setActiveVlanFilter('all')}
                        className="text-[10px] text-scada-accent hover:underline"
                    >
                        Show All
                    </button>
                )}
                <button 
                    onClick={() => setIsEditingSwitch(!isEditingSwitch)}
                    className={`p-1 rounded hover:bg-white/10 ${isEditingSwitch ? 'text-scada-accent' : 'text-scada-muted'}`}
                    title="Configure Core Switch"
                >
                    <Icons.Settings className="w-3 h-3" />
                </button>
            </div>
        </div>

        {/* Switch Config Panel */}
        {isEditingSwitch && (
            <div className="mb-4 bg-scada-bg/50 p-2 rounded border border-scada-accent/30 text-xs animate-in slide-in-from-left-2">
                <div className="mb-2">
                    <label className="text-[10px] text-scada-muted uppercase font-bold block mb-1">Switch IP</label>
                    <input 
                        type="text" 
                        value={switchConfig.ip}
                        onChange={(e) => setSwitchConfig({...switchConfig, ip: e.target.value})}
                        className="w-full bg-scada-panel border border-scada-border rounded px-2 py-1 text-white font-mono focus:border-scada-accent outline-none"
                    />
                </div>
                <div>
                    <label className="text-[10px] text-scada-muted uppercase font-bold block mb-1">Switch Name</label>
                    <input 
                        type="text" 
                        value={switchConfig.name}
                        onChange={(e) => setSwitchConfig({...switchConfig, name: e.target.value})}
                        className="w-full bg-scada-panel border border-scada-border rounded px-2 py-1 text-white font-mono focus:border-scada-accent outline-none"
                    />
                </div>
            </div>
        )}

        <div className="space-y-2">
            {Object.entries(VLAN_CONFIG).map(([vlanId, config]) => {
                 const id = parseInt(vlanId);
                 const isActive = activeVlanFilter === 'all' || activeVlanFilter === id;
                 return (
                    <div 
                        key={vlanId} 
                        className={`flex items-center justify-between text-xs cursor-pointer p-1 rounded transition-colors ${isActive ? 'hover:bg-white/5' : 'opacity-50 grayscale hover:opacity-100 hover:grayscale-0'}`}
                        onClick={() => setActiveVlanFilter(activeVlanFilter === id ? 'all' : id)}
                    >
                        <div className="flex items-center gap-2">
                            <span className="w-2.5 h-2.5 rounded-full shadow-sm" style={{ backgroundColor: config.color }}></span>
                            <span className={`font-medium ${isActive ? 'text-gray-200' : 'text-scada-muted'}`}>{config.name}</span>
                        </div>
                        <span className="font-mono text-[10px] text-scada-muted bg-black/20 px-1.5 rounded">ID {vlanId}</span>
                    </div>
                 );
            })}
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
            <filter id={filterId}>
                <feGaussianBlur stdDeviation="2.5" result="coloredBlur"/>
                <feMerge>
                    <feMergeNode in="coloredBlur"/>
                    <feMergeNode in="SourceGraphic"/>
                </feMerge>
            </filter>
        </defs>
        
        {/* Network Links */}
        {links.map(link => {
             const source = positionedNodes.find(n => n.id === link.sourceId)!;
             const target = positionedNodes.find(n => n.id === link.targetId)!;
             const intensity = linkActivity[link.id] || 0;
             const vlanConfig = VLAN_CONFIG[link.vlan as keyof typeof VLAN_CONFIG] ?? { name: 'Unknown', color: '#64748b', subnet: '0.0.0' };
             const vlanColor = vlanConfig.color;
             
             // Dynamic Style
             const isActive = intensity > 0.01;
             
             // Filter Logic
             const isDimmed = activeVlanFilter !== 'all' && link.vlan !== activeVlanFilter;
             
             return (
                 <g key={link.id} style={{ opacity: isDimmed ? 0.1 : 1, transition: 'opacity 0.3s' }}>
                     {/* Base Line (Darker) */}
                     <line 
                        x1={source.x} y1={source.y}
                        x2={target.x} y2={target.y}
                        stroke={vlanColor}
                        strokeWidth={isActive ? 2 : 1}
                        strokeOpacity={0.4} // Higher base opacity for better visibility of colors
                        strokeLinecap="round"
                     />
                     {/* Active Highlight Overlay (Brighter) */}
                     <line 
                        x1={source.x} y1={source.y}
                        x2={target.x} y2={target.y}
                        stroke={vlanColor}
                        strokeWidth={3}
                        strokeOpacity={intensity}
                        filter={isActive ? `url(#${filterId})` : undefined}
                     />
                 </g>
             )
        })}

        {/* Traffic Packets */}
        {packets.map(p => {
             const link = links.find(l => l.id === p.linkId);
             if (activeVlanFilter !== 'all' && link && link.vlan !== activeVlanFilter) return null;

             const cx = p.startX + (p.endX - p.startX) * (p.progress / 100);
             const cy = p.startY + (p.endY - p.startY) * (p.progress / 100);

             return (
                 <circle 
                    key={p.id}
                    cx={cx} cy={cy} r={3}
                    fill={p.color}
                    filter={`url(#${filterId})`}
                 />
             );
        })}
      </svg>

      {/* Interactive Nodes */}
    {positionedNodes.map(node => {
        const vlanConfig = node.vlan ? VLAN_CONFIG[node.vlan as keyof typeof VLAN_CONFIG] : null;
        const isOnline = node.status === 'online';
        const isDimmed = activeVlanFilter !== 'all' && node.vlan !== activeVlanFilter && node.type !== 'switch';
        
        return (
            <div 
                key={node.id}
                className={`absolute -translate-x-1/2 -translate-y-1/2 cursor-pointer transition-all duration-300 group z-20`}
                style={{ 
                    left: node.x, 
                    top: node.y, 
                    opacity: isDimmed ? 0.2 : 1,
                    pointerEvents: isDimmed ? 'none' : 'auto'
                }}
                // click handler respects drag threshold
                onClick={(e) => {
                    if (dragStartPos) {
                        const dx = e.clientX - dragStartPos.x;
                        const dy = e.clientY - dragStartPos.y;
                        if (Math.sqrt(dx * dx + dy * dy) > DRAG_THRESHOLD) {
                            setDragStartPos(null);
                            return; // it was a drag
                        }
                        setDragStartPos(null);
                    }
                    if (node.type === 'ied') onSelectIED(node.id);
                    if (node.type === 'switch') setIsEditingSwitch(true); // Open config on click
                }}
                onMouseDown={(e) => {
                    if (e.button !== 0) return;
                    e.preventDefault();
                    e.stopPropagation();
                    setDraggingNodeId(node.id);
                    setDragStartPos({ x: e.clientX, y: e.clientY });
                    dragOffsetRef.current = {
                        x: e.clientX - node.x,
                        y: e.clientY - node.y
                    };
                }}
                onKeyDown={(e) => {
                    if (node.type !== 'ied') return;
                    const step = e.shiftKey ? 20 : 5;
                    switch (e.key) {
                        case 'ArrowLeft':
                            e.preventDefault();
                            setNodePositions(prev => ({
                                ...prev,
                                [node.id]: { ...prev[node.id], x: prev[node.id].x - step }
                            }));
                            break;
                        case 'ArrowRight':
                            e.preventDefault();
                            setNodePositions(prev => ({
                                ...prev,
                                [node.id]: { ...prev[node.id], x: prev[node.id].x + step }
                            }));
                            break;
                        case 'ArrowUp':
                            e.preventDefault();
                            setNodePositions(prev => ({
                                ...prev,
                                [node.id]: { ...prev[node.id], y: prev[node.id].y - step }
                            }));
                            break;
                        case 'ArrowDown':
                            e.preventDefault();
                            setNodePositions(prev => ({
                                ...prev,
                                [node.id]: { ...prev[node.id], y: prev[node.id].y + step }
                            }));
                            break;
                        default:
                            break;
                    }
                }}
                tabIndex={0}
                role="button"
                aria-label={`${node.name} - press arrow keys to move`}
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
                
                {/* Enhanced Tooltip Label with Delete Button */}
                <div className={`
                    absolute top-14 left-1/2 -translate-x-1/2 px-3 py-2 bg-scada-panel/95 backdrop-blur rounded-md border border-scada-border min-w-[140px] 
                    transition-all duration-200 shadow-xl z-30
                    ${node.type === 'switch' ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 translate-y-2 group-hover:translate-y-0'}
                `}>
                    <div className="flex justify-between items-start mb-1">
                        <div className="text-xs font-bold text-white whitespace-nowrap">{node.name}</div>
                        {node.type === 'ied' && (
                            <button 
                                onClick={(e) => { 
                                    e.stopPropagation();
                                    if (pendingDelete === node.id) {
                                        onDeleteIED(node.id);
                                        setPendingDelete(null);
                                    } else {
                                        setPendingDelete(node.id);
                                        setTimeout(() => {
                                            if (pendingDelete === node.id) {
                                                setPendingDelete(null);
                                            }
                                        }, 3000);
                                    }
                                }} 
                                className={
                                    `p-0.5 ml-2 rounded transition-colors ` +
                                    (pendingDelete === node.id ? 'text-red-400 bg-white/10' : 'text-scada-danger hover:text-red-400 hover:bg-white/10')
                                }
                                title={pendingDelete === node.id ? 'Click again to confirm' : 'Remove Device'}
                            >
                                <Icons.Trash className="w-3 h-3" />
                            </button>
                        )}
                        {node.type === 'switch' && (
                             <div className="text-[10px] bg-white/10 px-1 rounded text-gray-300 ml-2">CORE</div>
                        )}
                    </div>
                    
                    <div className="flex flex-col gap-0.5 pointer-events-none">
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
                        {node.modbusPort && (
                            <div className="flex items-center justify-between gap-4 text-[10px] font-mono text-scada-muted">
                                <span>MB Port:</span>
                                <span className="text-yellow-400">{node.modbusPort}</span>
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

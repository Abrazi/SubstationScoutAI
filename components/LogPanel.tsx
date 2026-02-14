import React, { useEffect, useRef } from 'react';
import { LogEntry } from '../types';
import { Icons } from './Icons';

interface LogPanelProps {
  logs: LogEntry[];
  onClear: () => void;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
}

export const LogPanel: React.FC<LogPanelProps> = ({ logs, onClear, isCollapsed, onToggleCollapse }) => {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs]);

  const getLogStyle = (level: string) => {
    switch (level) {
      case 'error': return 'text-scada-danger bg-scada-danger/10';
      case 'warning': return 'text-scada-warning bg-scada-warning/10';
      case 'packet': return 'text-scada-muted font-mono text-xs';
      case 'goose': return 'text-purple-400 font-mono text-xs';
      case 'mms': return 'text-scada-accent font-mono text-xs';
      default: return 'text-scada-text';
    }
  };

  const getIcon = (level: string) => {
    switch (level) {
        case 'error': return <Icons.Alert className="w-3 h-3" />;
        case 'goose': return <Icons.Zap className="w-3 h-3" />;
        case 'mms': return <Icons.Server className="w-3 h-3" />;
        default: return <span className="w-3 h-3 block" />;
    }
  }

  return (
    <div className="h-full flex flex-col bg-scada-bg text-sm font-mono border-t border-scada-border">
      <div
        className="flex items-center justify-between px-4 py-2 border-b border-scada-border bg-scada-panel cursor-pointer hover:bg-white/5 transition-colors"
        onClick={onToggleCollapse}
      >
        <div className="flex items-center gap-2">
            <Icons.Terminal className="w-4 h-4 text-scada-muted" />
            <span className="font-semibold text-scada-muted">Diagnostic Console</span>
            <span className="text-xs bg-scada-border px-2 rounded-full text-scada-text">{logs.length} Events</span>
            <Icons.ChevronDown className={`w-4 h-4 text-scada-muted transition-transform ${isCollapsed ? '-rotate-90' : ''}`} />
        </div>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onClear();
          }}
          className="text-xs hover:text-white text-scada-muted flex items-center gap-1"
        >
            <Icons.Stop className="w-3 h-3" /> Clear
        </button>
      </div>
      {!isCollapsed && (
      <div className="flex-1 overflow-y-auto p-2 space-y-1" ref={scrollRef}>
        {logs.length === 0 && (
            <div className="text-center text-scada-muted opacity-30 py-4">No logs available</div>
        )}
        {logs.map((log) => (
          <div key={log.id} className={`flex gap-3 px-2 py-1 rounded hover:bg-white/5 ${getLogStyle(log.level)}`}>
            <span className="text-scada-muted shrink-0 w-20">{log.timestamp.split('T')[1].split('.')[0]}</span>
            <span className="font-bold shrink-0 w-24 truncate" title={log.source}>{log.source}</span>
            <span className="shrink-0 pt-0.5">{getIcon(log.level)}</span>
            <span className="break-all">{log.message}</span>
          </div>
        ))}
      </div>
      )}
    </div>
  );
};

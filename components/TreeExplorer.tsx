import React, { useState } from 'react';
import { IEDNode, NodeType } from '../types';
import { Icons } from './Icons';
import { explainLogicalNode } from '../services/geminiService';

interface TreeNodeProps {
  node: IEDNode;
  level: number;
  onSelect: (node: IEDNode) => void;
  selectedId: string | undefined;
}

const TreeNode: React.FC<TreeNodeProps> = ({ node, level, onSelect, selectedId }) => {
  const [isOpen, setIsOpen] = useState(level < 2); // Auto expand top levels
  const [aiHint, setAiHint] = useState<string | null>(null);
  const [loadingHint, setLoadingHint] = useState(false);

  const hasChildren = node.children && node.children.length > 0;
  const isSelected = node.id === selectedId;

  const handleToggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsOpen(!isOpen);
  };

  const handleSelect = (e: React.MouseEvent) => {
    e.stopPropagation();
    onSelect(node);
  };

  const requestExplanation = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (aiHint) return;
    setLoadingHint(true);
    const hint = await explainLogicalNode(node.name);
    setAiHint(hint);
    setLoadingHint(false);
  };

  const getIcon = () => {
    switch (node.type) {
      case NodeType.IED: return <Icons.Server className="w-4 h-4 text-scada-accent" />;
      case NodeType.LDevice: return <Icons.Cpu className="w-4 h-4 text-purple-400" />;
      case NodeType.LN: return <Icons.Activity className="w-4 h-4 text-blue-400" />;
      case NodeType.DO: return <Icons.Tree className="w-4 h-4 text-scada-muted" />;
      case NodeType.DA: return <Icons.Zap className="w-3 h-3 text-yellow-400" />;
      default: return <Icons.File className="w-4 h-4" />;
    }
  };

  return (
    <div className="select-none">
      <div 
        className={`
          flex items-center py-1 px-2 cursor-pointer transition-colors border-l-2
          ${isSelected 
            ? 'bg-scada-accent/10 border-scada-accent text-white' 
            : 'border-transparent text-scada-muted hover:text-white hover:bg-white/5'}
        `}
        style={{ paddingLeft: `${level * 1.5 + 0.5}rem` }}
        onClick={handleSelect}
      >
        <span onClick={hasChildren ? handleToggle : undefined} className="mr-1 opacity-70 hover:opacity-100">
          {hasChildren ? (
            isOpen ? <Icons.ChevronDown className="w-4 h-4" /> : <Icons.ChevronRight className="w-4 h-4" />
          ) : <span className="w-4 inline-block" />}
        </span>
        
        <span className="mr-2">{getIcon()}</span>
        <span className="text-sm font-medium truncate">{node.name}</span>
        
        {node.type === NodeType.LN && (
           <button 
             onClick={requestExplanation}
             className="ml-auto p-1 hover:bg-scada-accent/20 rounded-full text-xs text-scada-accent opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1"
             title="Ask AI"
           >
             <Icons.AI className="w-3 h-3" />
           </button>
        )}
      </div>
      
      {/* AI Explanation Popup Inline */}
      {(aiHint || loadingHint) && isSelected && (
        <div className="ml-8 mr-4 mb-2 p-3 bg-scada-panel border border-scada-accent/30 rounded text-xs text-scada-text shadow-lg animate-in fade-in slide-in-from-top-1">
          <div className="flex items-center gap-2 mb-1 text-scada-accent font-semibold">
            <Icons.AI className="w-3 h-3" /> Gemini Explanation
          </div>
          {loadingHint ? "Analyzing..." : aiHint}
        </div>
      )}

      {isOpen && hasChildren && (
        <div>
          {node.children!.map(child => (
            <TreeNode 
              key={child.id} 
              node={child} 
              level={level + 1} 
              onSelect={onSelect} 
              selectedId={selectedId}
            />
          ))}
        </div>
      )}
    </div>
  );
};

export const TreeExplorer: React.FC<{ root: IEDNode, onSelect: (n: IEDNode) => void, selectedId?: string }> = ({ root, onSelect, selectedId }) => {
  return (
    <div className="h-full overflow-y-auto font-mono text-sm bg-scada-bg/50">
      <TreeNode node={root} level={0} onSelect={onSelect} selectedId={selectedId} />
    </div>
  );
};

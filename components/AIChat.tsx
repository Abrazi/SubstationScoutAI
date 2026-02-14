import React, { useState, useRef, useEffect } from 'react';
import { Icons } from './Icons';
import { ChatMessage, IEDNode } from '../types';
import { chatWithIED } from '../services/geminiService';

interface AIChatProps {
  currentIED: IEDNode | null;
}

export const AIChat: React.FC<AIChatProps> = ({ currentIED }) => {
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: 'init',
      role: 'model',
      text: "Hello, I'm Scout AI. I can help you analyze the currently selected IED configuration, explain Logical Nodes, or debug SCL files. What can I do for you?",
      timestamp: Date.now()
    }
  ]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const handleSend = async () => {
    if (!input.trim()) return;

    const userMsg: ChatMessage = {
      id: Date.now().toString(),
      role: 'user',
      text: input,
      timestamp: Date.now()
    };

    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setLoading(true);

    try {
      // Prepare history for API
      const history = [...messages, userMsg].map(m => ({ role: m.role, text: m.text }));
      const responseText = await chatWithIED(history, currentIED);

      const aiMsg: ChatMessage = {
        id: (Date.now() + 1).toString(),
        role: 'model',
        text: responseText,
        timestamp: Date.now()
      };
      setMessages(prev => [...prev, aiMsg]);
    } catch (e) {
      setMessages(prev => [...prev, {
        id: Date.now().toString(),
        role: 'model',
        text: "Sorry, I had trouble connecting to the AI service.",
        timestamp: Date.now()
      }]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col h-full bg-scada-panel border-l border-scada-border">
      <div className="p-3 border-b border-scada-border bg-scada-bg/30 flex items-center gap-2">
        <Icons.AI className="text-scada-accent" />
        <span className="font-semibold text-sm">Scout AI Assistant</span>
        {currentIED && <span className="text-xs px-2 py-0.5 bg-scada-border rounded-full text-scada-muted truncate max-w-[120px]">{currentIED.name}</span>}
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4" ref={scrollRef}>
        {messages.map(msg => (
          <div key={msg.id} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div 
              className={`
                max-w-[85%] rounded-lg p-3 text-sm leading-relaxed
                ${msg.role === 'user' 
                  ? 'bg-scada-accent/20 text-white border border-scada-accent/30 rounded-br-none' 
                  : 'bg-scada-bg border border-scada-border rounded-bl-none text-gray-200'}
              `}
            >
              {msg.role === 'model' && <Icons.AI className="w-3 h-3 mb-1 text-scada-accent inline mr-2" />}
              {msg.text}
            </div>
          </div>
        ))}
        {loading && (
          <div className="flex justify-start">
             <div className="bg-scada-bg border border-scada-border rounded-lg p-3 rounded-bl-none flex gap-1">
                <span className="w-1.5 h-1.5 bg-scada-muted rounded-full animate-bounce"></span>
                <span className="w-1.5 h-1.5 bg-scada-muted rounded-full animate-bounce delay-75"></span>
                <span className="w-1.5 h-1.5 bg-scada-muted rounded-full animate-bounce delay-150"></span>
             </div>
          </div>
        )}
      </div>

      <div className="p-3 bg-scada-bg/50 border-t border-scada-border">
        <div className="relative">
          <input
            type="text"
            className="w-full bg-scada-bg border border-scada-border rounded-md py-2 pl-3 pr-10 text-sm focus:outline-none focus:border-scada-accent focus:ring-1 focus:ring-scada-accent transition-all placeholder-scada-muted"
            placeholder="Ask about this IED..."
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSend()}
            disabled={loading}
          />
          <button 
            onClick={handleSend}
            disabled={loading || !input.trim()}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-scada-muted hover:text-scada-accent disabled:opacity-50 transition-colors"
          >
            <Icons.Play className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
};

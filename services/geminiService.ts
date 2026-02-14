import { GoogleGenAI } from "@google/genai";
import { IEDNode } from "../types";

const getAIClient = () => {
  const apiKey = process.env.API_KEY;
  if (!apiKey) return null;
  return new GoogleGenAI({ apiKey });
};

export const explainLogicalNode = async (lnName: string, context?: string): Promise<string> => {
  const ai = getAIClient();
  if (!ai) return "Gemini API Key missing. Please configure environment.";

  try {
    const prompt = `
      You are an expert in IEC 61850 Substation Automation Systems.
      Explain the purpose of the Logical Node "${lnName}".
      ${context ? `Context from SCL file: ${context}` : ''}
      Keep the explanation concise (under 50 words) and technical.
    `;

    const response = await ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: prompt,
    });

    return response.text || "No explanation available.";
  } catch (error) {
    console.error("AI Error:", error);
    return "Failed to fetch AI explanation.";
  }
};

export const analyzeSCLFile = async (xmlContent: string): Promise<string> => {
  const ai = getAIClient();
  if (!ai) return "Gemini API Key missing.";

  try {
    // Truncate XML if too large for a quick check, though Flash has large context.
    const snippet = xmlContent.length > 50000 ? xmlContent.substring(0, 50000) + "...(truncated)" : xmlContent;

    const prompt = `
      Analyze this IEC 61850 SCL/CID file snippet.
      1. Identify the main IEDs and their roles.
      2. List key protection functions configured (look for LN prefixes like PDIS, PTOC).
      3. Identify communication parameters briefly.
      
      Format the output as Markdown.
      
      XML Snippet:
      \`\`\`xml
      ${snippet}
      \`\`\`
    `;

    const response = await ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: prompt,
    });

    return response.text || "Analysis failed.";
  } catch (error) {
    console.error("AI Error:", error);
    return "Failed to analyze SCL file.";
  }
};

export const chatWithIED = async (history: {role: 'user' | 'model', text: string}[], currentIED: IEDNode | null): Promise<string> => {
  const ai = getAIClient();
  if (!ai) return "Gemini API Key missing.";

  try {
    const iedContext = currentIED ? JSON.stringify(currentIED, (key, value) => {
      if (key === 'children' && Array.isArray(value) && value.length > 20) return `[${value.length} children]`; // Summarize large trees
      return value;
    }) : "No specific IED selected.";

    const systemInstruction = `
      You are SCADA Scout AI, an assistant for substation operators.
      Current IED Context (JSON): ${iedContext}
      
      Answer questions about the IED configuration, IEC 61850 standards, or troubleshooting.
      Be precise. If values are simulated, mention that.
    `;

    const chat = ai.chats.create({
      model: 'gemini-3-flash-preview',
      config: { systemInstruction },
      history: history.map(h => ({
        role: h.role,
        parts: [{ text: h.text }]
      }))
    });

    // The last message is the new one, handled by sendMessage, so we don't need to pass it here if we use chat.sendMessage
    // However, the caller usually appends the new message to history. Let's assume the caller passes history *excluding* the new prompt,
    // or we just take the last user message as the prompt.
    // For simplicity in this implementation, we'll assume the 'history' passed includes previous turns, and we need a 'message' arg.
    // BUT, the standard pattern is chat history + new message.
    
    // Let's adjust: The caller will pass the *entire* history including the latest user message? 
    // No, standard Chat API usage keeps history internal or passed in init.
    // Let's assume the caller passes the *previous* history and the *new* message string.
    
    // REFACTOR for simplicity: Just use generateContent with the full history as a string prompt if we want stateless, 
    // OR use chat.sendMessage properly.
    
    // Let's just use the last message from the array as the prompt, and the rest as history.
    const lastMsg = history[history.length - 1];
    const prevHistory = history.slice(0, -1);
    
    const chatSession = ai.chats.create({
        model: 'gemini-3-flash-preview',
        config: { systemInstruction },
        history: prevHistory.map(h => ({
            role: h.role,
            parts: [{ text: h.text }]
        }))
    });
    
    const result = await chatSession.sendMessage({ message: lastMsg.text });
    return result.text;

  } catch (error) {
    console.error("Chat Error:", error);
    return "I encountered an error processing your request.";
  }
}

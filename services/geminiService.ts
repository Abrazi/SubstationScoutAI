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

    // Keep Flash for simple, low-latency explanations
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
    // Increase context limit for Pro model
    const snippet = xmlContent.length > 500000 ? xmlContent.substring(0, 500000) + "...(truncated)" : xmlContent;

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

    // Use Gemini 3 Pro with Thinking for complex file analysis
    const response = await ai.models.generateContent({
      model: 'gemini-3-pro-preview',
      contents: prompt,
      config: {
        thinkingConfig: { thinkingBudget: 32768 }
      }
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

    // Use the last message as the new prompt
    const lastMsg = history[history.length - 1];
    const prevHistory = history.slice(0, -1);
    
    // Use Gemini 3 Pro with Thinking for deep context understanding
    const chatSession = ai.chats.create({
        model: 'gemini-3-pro-preview',
        config: { 
            systemInstruction,
            thinkingConfig: { thinkingBudget: 32768 }
        },
        history: prevHistory.map(h => ({
            role: h.role,
            parts: [{ text: h.text }]
        }))
    });
    
    const result = await chatSession.sendMessage({ message: lastMsg.text });
    return result.text || "No response generated.";

  } catch (error) {
    console.error("Chat Error:", error);
    return "I encountered an error processing your request.";
  }
}

import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

export async function getPrivacyTip(): Promise<string> {
  try {
    const response = await ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: "Generate a short, snappy privacy tip for a user browsing the deep web. Max 15 words. Mention Zero Knowledge or anonymity.",
    });
    return response.text || "Keep your keys safe. Use ZK-Proofs for ultimate anonymity.";
  } catch (error) {
    console.error("Gemini Error:", error);
    return "Privacy is your right. Stay encrypted.";
  }
}

export async function generateNodeLog(): Promise<string> {
  try {
    const response = await ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: "Generate a realistic-sounding technical log line for a decentralized onion-routing node. Use technical jargon like 'Relay', 'Circuit', 'ZK-Proof', 'Starknet Hash'. One line.",
    });
    return response.text || "Relay circuit established: ZK-STARK proof verified at block 124901.";
  } catch (error) {
    return "Node heartbeat: Pulse OK.";
  }
}

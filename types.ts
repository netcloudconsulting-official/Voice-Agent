
export interface Message {
  role: 'user' | 'model';
  text: string;
  // Support for grounding URLs from Google Search tool
  urls?: { title: string; uri: string }[];
}

export interface VoiceState {
  isActive: boolean;
  isConnecting: boolean;
  isListening: boolean;
  isSpeaking: boolean;
  isProcessing: boolean;
  error: string | null;
}
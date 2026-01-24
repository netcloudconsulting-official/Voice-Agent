
import React, { useState, useCallback, useRef } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';
import { VoiceOrb } from './components/VoiceOrb';
import { encode, decode, decodeAudioData } from './utils/audioHelpers';
import { VoiceState, Message } from './types';

const INPUT_SAMPLE_RATE = 16000;
const OUTPUT_SAMPLE_RATE = 24000;

const App: React.FC = () => {
  const [state, setState] = useState<VoiceState>({
    isActive: false,
    isConnecting: false,
    isListening: false,
    isSpeaking: false,
    isProcessing: false,
    error: null,
  });
  const [history, setHistory] = useState<Message[]>([]);
  
  const nextStartTimeRef = useRef(0);
  const audioContextInRef = useRef<AudioContext | null>(null);
  const audioContextOutRef = useRef<AudioContext | null>(null);
  const inputNodeRef = useRef<GainNode | null>(null);
  const outputNodeRef = useRef<GainNode | null>(null);
  const activeSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const sessionRef = useRef<any>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const currentInputTranscriptionRef = useRef('');
  const currentOutputTranscriptionRef = useRef('');
  // Accumulated grounding URLs for the current turn
  const currentUrlsRef = useRef<{ title: string; uri: string }[]>([]);

  const cleanupSession = useCallback(() => {
    if (sessionRef.current) {
      sessionRef.current.close();
      sessionRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    activeSourcesRef.current.forEach(source => {
      try { source.stop(); } catch (e) {}
    });
    activeSourcesRef.current.clear();
    
    if (audioContextInRef.current) audioContextInRef.current.close();
    if (audioContextOutRef.current) audioContextOutRef.current.close();

    setState(prev => ({ 
      ...prev, 
      isActive: false, 
      isConnecting: false, 
      isListening: false, 
      isSpeaking: false,
      isProcessing: false 
    }));
  }, []);

  const startSession = async () => {
    try {
      setState(prev => ({ ...prev, isConnecting: true, error: null }));
      
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      
      audioContextInRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: INPUT_SAMPLE_RATE });
      audioContextOutRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: OUTPUT_SAMPLE_RATE });
      
      inputNodeRef.current = audioContextInRef.current.createGain();
      outputNodeRef.current = audioContextOutRef.current.createGain();
      outputNodeRef.current.connect(audioContextOutRef.current.destination);

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Puck' } },
          },
          // Google Search tool configuration
          tools: [{ googleSearch: {} }],
          systemInstruction: `You are the Netcloud Consulting AI Voice Assistant.
          Your mission is to provide information specifically about Netcloud Consulting's ecommerce solutions.
          IMPORTANT: You MUST use Google Search to fetch up-to-date information. Prioritize searching for and using information from URLs starting with 'netcloudconsulting.com'.
          
          Focus on:
          - Intelligent ecommerce automation for B2B, B2C, and D2C businesses.
          - Real-time marketplace optimization for Amazon and Flipkart.
          - Smart store solutions for Shopify and WooCommerce.
          - AI-driven performance insights and scaling strategies.
          
          Voice Persona:
          - Premium, professional, and sophisticated.
          - Concise and conversational.
          - If the user asks about topics unrelated to Netcloud Consulting, politely guide them back to our ecommerce and automation expertise.
          - Mention "Consulting" as part of our full name.`,
          inputAudioTranscription: {},
          outputAudioTranscription: {},
        },
        callbacks: {
          onopen: () => {
            setState(prev => ({ ...prev, isActive: true, isConnecting: false, isListening: true }));

            const source = audioContextInRef.current!.createMediaStreamSource(stream);
            const scriptProcessor = audioContextInRef.current!.createScriptProcessor(4096, 1, 1);
            
            scriptProcessor.onaudioprocess = (event) => {
              const inputData = event.inputBuffer.getChannelData(0);
              const l = inputData.length;
              const int16 = new Int16Array(l);
              for (let i = 0; i < l; i++) {
                int16[i] = inputData[i] * 32768;
              }
              const pcmData = {
                data: encode(new Uint8Array(int16.buffer)),
                mimeType: 'audio/pcm;rate=16000',
              };

              // Fix: Solely rely on sessionPromise resolves to send input
              sessionPromise.then(session => {
                session.sendRealtimeInput({ media: pcmData });
              });
            };

            source.connect(scriptProcessor);
            scriptProcessor.connect(audioContextInRef.current!.destination);
          },
          onmessage: async (message: LiveServerMessage) => {
            if (message.serverContent?.inputTranscription) {
              currentInputTranscriptionRef.current += message.serverContent.inputTranscription.text;
              setState(prev => ({ ...prev, isProcessing: true }));
            }
            
            if (message.serverContent?.outputTranscription) {
              currentOutputTranscriptionRef.current += message.serverContent.outputTranscription.text;
              setState(prev => ({ ...prev, isProcessing: false }));
            }

            // Fix: Extract grounding metadata URLs from the model turn as per @google/genai guidelines
            const modelTurn = message.serverContent?.modelTurn;
            if (modelTurn?.groundingMetadata?.groundingChunks) {
              const newUrls = modelTurn.groundingMetadata.groundingChunks
                .filter((chunk: any) => chunk.web)
                .map((chunk: any) => ({
                  title: chunk.web.title,
                  uri: chunk.web.uri
                }))
                .filter((newUrl: any) => !currentUrlsRef.current.some(existing => existing.uri === newUrl.uri));
              currentUrlsRef.current = [...currentUrlsRef.current, ...newUrls];
            }

            if (message.serverContent?.turnComplete) {
              const userTurn = currentInputTranscriptionRef.current;
              const modelTurnText = currentOutputTranscriptionRef.current;
              const urls = [...currentUrlsRef.current];
              
              if (userTurn || modelTurnText) {
                setHistory(prev => {
                  const updated = [...prev];
                  if (userTurn) updated.push({ role: 'user', text: userTurn });
                  if (modelTurnText) updated.push({ role: 'model', text: modelTurnText, urls });
                  return updated;
                });
              }
              
              currentInputTranscriptionRef.current = '';
              currentOutputTranscriptionRef.current = '';
              currentUrlsRef.current = [];
            }

            const base64Audio = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
            if (base64Audio) {
              setState(prev => ({ ...prev, isSpeaking: true, isProcessing: false }));
              const context = audioContextOutRef.current!;
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, context.currentTime);
              
              // Fix: Use custom decodeAudioData for raw PCM as per guidelines
              const audioBuffer = await decodeAudioData(decode(base64Audio), context, OUTPUT_SAMPLE_RATE, 1);
              const source = context.createBufferSource();
              source.buffer = audioBuffer;
              source.connect(outputNodeRef.current!);
              
              source.addEventListener('ended', () => {
                activeSourcesRef.current.delete(source);
                if (activeSourcesRef.current.size === 0) {
                  setState(prev => ({ ...prev, isSpeaking: false }));
                }
              });

              source.start(nextStartTimeRef.current);
              nextStartTimeRef.current += audioBuffer.duration;
              activeSourcesRef.current.add(source);
            }

            if (message.serverContent?.interrupted) {
              activeSourcesRef.current.forEach(s => { try { s.stop(); } catch(e) {} });
              activeSourcesRef.current.clear();
              nextStartTimeRef.current = 0;
              setState(prev => ({ ...prev, isSpeaking: false, isProcessing: false }));
            }
          },
          onerror: (e) => {
            setState(prev => ({ ...prev, error: "Connection error. Please try again." }));
            cleanupSession();
          },
          onclose: () => {
            cleanupSession();
          },
        },
      });

      sessionRef.current = await sessionPromise;

    } catch (err: any) {
      setState(prev => ({ ...prev, isConnecting: false, error: err.message || "Failed to start session." }));
    }
  };

  return (
    <div className="w-full h-full min-h-screen flex flex-col items-center justify-center p-4 md:p-8 bg-white text-slate-900 selection:bg-indigo-100 overflow-x-hidden">
      {/* Dynamic Header Status */}
      <header className="w-full max-w-5xl flex justify-center items-center py-4 absolute top-0 z-10">
        <div className="flex items-center gap-4">
          <div className="flex flex-col items-center">
            <p className="text-[9px] md:text-[10px] uppercase tracking-[0.3em] text-slate-400 font-bold mb-1">Consultation System</p>
            {state.isActive ? (
              <div className={`flex items-center gap-2 px-3 py-1 bg-white border border-slate-100 rounded-full text-[9px] md:text-[10px] font-bold text-slate-500 shadow-sm transition-all duration-500 ${state.isProcessing ? 'border-purple-200 bg-purple-50 text-purple-600' : ''}`}>
                <span className={`w-1.5 h-1.5 rounded-full transition-colors duration-500 ${state.isSpeaking ? 'bg-indigo-500 animate-pulse' : state.isProcessing ? 'bg-purple-500 animate-spin' : state.isListening ? 'bg-emerald-500 animate-pulse' : 'bg-slate-300'}`} />
                {state.isSpeaking ? 'AGENT TALKING' : state.isProcessing ? 'THINKING' : state.isListening ? 'LISTENING' : 'READY'}
              </div>
            ) : (
              <div className="h-0.5 w-12 bg-slate-100 rounded-full" />
            )}
          </div>
        </div>
      </header>

      {/* Main Hero UI */}
      <main className="w-full max-w-4xl flex flex-col items-center justify-center relative mt-4">
        <div className="relative w-full flex flex-col items-center justify-center scale-90 md:scale-100 transition-transform duration-700">
           <VoiceOrb isSpeaking={state.isSpeaking} isListening={state.isListening} isProcessing={state.isProcessing} />
           
           <div className={`absolute bottom-[-30px] flex items-center gap-3 transition-all duration-700 ${state.isProcessing ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4 pointer-events-none'}`}>
              <div className="flex gap-1.5">
                <div className="w-1.5 h-1.5 bg-purple-500 rounded-full animate-[bounce_1s_infinite_100ms]" />
                <div className="w-1.5 h-1.5 bg-indigo-500 rounded-full animate-[bounce_1s_infinite_200ms]" />
                <div className="w-1.5 h-1.5 bg-blue-500 rounded-full animate-[bounce_1s_infinite_300ms]" />
              </div>
              <span className="text-[10px] font-black tracking-[0.3em] text-indigo-400 uppercase">Consulting AI Analysis</span>
           </div>
        </div>
        
        <div className="mt-12 md:mt-16 flex flex-col items-center gap-6 w-full text-center z-20">
          <div className="max-w-2xl px-4">
            <h2 className="text-3xl md:text-5xl font-black text-slate-900 tracking-tighter mb-4 leading-tight">
              Netcloud Consulting
            </h2>
            <p className="text-slate-500 text-sm md:text-base leading-relaxed font-medium max-w-lg mx-auto">
              Empower your B2B & D2C business with intelligent AI automation and real-time marketplace optimization for Shopify, WooCommerce, Amazon & Flipkart.
            </p>
          </div>

          <div className="flex flex-col items-center gap-4 w-full">
            {!state.isActive ? (
              <button
                onClick={startSession}
                disabled={state.isConnecting}
                className="px-10 md:px-16 py-4 md:py-6 bg-slate-900 text-white rounded-full font-black text-sm md:text-base hover:bg-slate-800 active:scale-95 transition-all disabled:opacity-50 flex items-center gap-4 shadow-[0_25px_50px_-15px_rgba(0,0,0,0.3)] group"
              >
                {state.isConnecting ? (
                  <>
                    <svg className="animate-spin h-5 w-5 text-indigo-400" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                    </svg>
                    INITIALIZING...
                  </>
                ) : (
                  <>
                    START VOICE CONSULTATION
                    <div className="w-2.5 h-2.5 bg-indigo-500 rounded-full group-hover:animate-ping" />
                  </>
                )}
              </button>
            ) : (
              <button
                onClick={cleanupSession}
                className="px-8 md:px-12 py-3.5 md:py-5 bg-white text-slate-400 border border-slate-200 rounded-full font-bold text-sm md:text-base hover:bg-slate-50 hover:text-red-500 hover:border-red-100 transition-all active:scale-95 shadow-sm"
              >
                END SESSION
              </button>
            )}
            
            {state.error && (
              <p className="text-red-500 text-[10px] md:text-xs font-black bg-red-50 px-4 py-2 rounded-full border border-red-100 uppercase tracking-widest">
                {state.error}
              </p>
            )}
          </div>
        </div>
      </main>

      {/* Fix: Added grounding URL source list display as per guidelines */}
      <footer className="w-full max-w-xl absolute bottom-8 px-4 pointer-events-none">
        <div className="h-24 overflow-y-auto custom-scrollbar flex flex-col-reverse gap-3 mask-linear">
           {history.length > 0 && (
             history.slice(-2).reverse().map((msg, idx) => (
               <div key={idx} className={`text-center transition-all duration-700 ${idx === 0 ? 'opacity-100' : 'opacity-20'}`}>
                 <p className={`text-[11px] md:text-[13px] leading-relaxed uppercase tracking-wider font-bold ${msg.role === 'user' ? 'text-slate-400' : 'text-slate-900'}`}>
                   {msg.text}
                 </p>
                 {msg.urls && msg.urls.length > 0 && (
                   <div className="flex flex-wrap justify-center gap-2 mt-2">
                     {msg.urls.map((url, uidx) => (
                       <a 
                         key={uidx} 
                         href={url.uri} 
                         target="_blank" 
                         rel="noopener noreferrer"
                         className="text-[9px] text-indigo-500 hover:text-indigo-700 underline font-bold tracking-tight pointer-events-auto"
                       >
                         {url.title || 'Source'}
                       </a>
                     ))}
                   </div>
                 )}
               </div>
             ))
           )}
        </div>
      </footer>

      <style>{`
        .custom-scrollbar::-webkit-scrollbar { width: 0px; }
        .mask-linear {
          mask-image: linear-gradient(to top, black 30%, transparent 100%);
        }
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
};

export default App;
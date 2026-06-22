
import React, { useState, useCallback, useRef, useEffect } from 'react';
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
  
  // Audio control states
  const [volume, setVolume] = useState(0.8);
  const [isPaused, setIsPaused] = useState(false);
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
  const currentUrlsRef = useRef<{ title: string; uri: string }[]>([]);

  // Effect to sync volume state with the GainNode
  useEffect(() => {
    if (outputNodeRef.current && audioContextOutRef.current) {
      outputNodeRef.current.gain.setTargetAtTime(
        volume,
        audioContextOutRef.current.currentTime,
        0.1
      );
    }
  }, [volume]);

  const togglePlayback = useCallback(async () => {
    if (!audioContextOutRef.current) return;

    if (audioContextOutRef.current.state === 'running') {
      await audioContextOutRef.current.suspend();
      setIsPaused(true);
    } else {
      await audioContextOutRef.current.resume();
      setIsPaused(false);
    }
  }, []);

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
    setIsPaused(false);
  }, []);

  const startSession = async () => {
    try {
      setState(prev => ({ ...prev, isConnecting: true, error: null }));
      
      // Fix: Create GoogleGenAI instance right before the connection as recommended.
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      
      audioContextInRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: INPUT_SAMPLE_RATE });
      audioContextOutRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: OUTPUT_SAMPLE_RATE });
      
      inputNodeRef.current = audioContextInRef.current.createGain();
      outputNodeRef.current = audioContextOutRef.current.createGain();
      
      // Initialize volume
      outputNodeRef.current.gain.value = volume;
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

              // Correct: Using sessionPromise to prevent race conditions during initialization.
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

            // Correct: Handling groundingChunks for search grounding URLs.
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
              
              // Correct: Implementing custom decoding logic for raw PCM bytes from the API.
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
                {isPaused && <span className="ml-1 text-slate-400">(PAUSED)</span>}
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

          <div className="flex flex-col items-center gap-6 w-full">
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
              <div className="flex flex-col items-center gap-6 w-full max-w-xs animate-in fade-in slide-in-from-bottom-4 duration-500">
                {/* Audio Controls */}
                <div className="w-full flex items-center gap-4 bg-slate-50 p-4 rounded-3xl border border-slate-100 shadow-sm">
                  <button 
                    onClick={togglePlayback}
                    className="p-3 bg-white border border-slate-200 rounded-full text-slate-600 hover:text-slate-900 transition-colors shadow-sm"
                    title={isPaused ? "Play" : "Pause"}
                  >
                    {isPaused ? (
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                    ) : (
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>
                    )}
                  </button>
                  
                  <div className="flex-1 flex items-center gap-3">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-slate-400">
                      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
                      <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path>
                    </svg>
                    <input 
                      type="range" 
                      min="0" 
                      max="1" 
                      step="0.01" 
                      value={volume} 
                      onChange={(e) => setVolume(parseFloat(e.target.value))}
                      className="w-full h-1.5 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-indigo-500 transition-all"
                    />
                  </div>
                </div>

                <button
                  onClick={cleanupSession}
                  className="w-full px-8 md:px-12 py-3.5 md:py-5 bg-white text-slate-400 border border-slate-200 rounded-full font-bold text-sm md:text-base hover:bg-slate-50 hover:text-red-500 hover:border-red-100 transition-all active:scale-95 shadow-sm"
                >
                  END SESSION
                </button>
              </div>
            )}
            
            {state.error && (
              <p className="text-red-500 text-[10px] md:text-xs font-black bg-red-50 px-4 py-2 rounded-full border border-red-100 uppercase tracking-widest">
                {state.error}
              </p>
            )}

            {/* Grounding Sources - MANDATORY: Listing extracted Search Grounding URLs on the web app */}
            {history.length > 0 && (
              <div className="w-full max-w-2xl mt-8 px-4 text-center">
                <h3 className="text-[10px] font-black tracking-[0.2em] text-slate-400 uppercase mb-4">Verified Consultation Sources</h3>
                <div className="flex flex-wrap justify-center gap-2">
                  {history.flatMap(msg => msg.urls || []).reduce((acc, current) => {
                    if (!acc.find(item => item.uri === current.uri)) acc.push(current);
                    return acc;
                  }, [] as {title: string, uri: string}[]).map((url, i) => (
                    <a 
                      key={i} 
                      href={url.uri} 
                      target="_blank" 
                      rel="noopener noreferrer"
                      className="px-3 py-1.5 bg-slate-50 border border-slate-100 rounded-lg text-[10px] text-indigo-600 font-bold hover:bg-indigo-50 hover:border-indigo-100 transition-all truncate max-w-[200px]"
                    >
                      {url.title || url.uri}
                    </a>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </main>

      <style>{`
        .custom-scrollbar::-webkit-scrollbar { width: 0px; }
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        input[type='range']::-webkit-slider-thumb {
          -webkit-appearance: none;
          appearance: none;
          width: 12px;
          height: 12px;
          background: #6366f1;
          cursor: pointer;
          border-radius: 50%;
          border: 2px solid white;
          box-shadow: 0 1px 3px rgba(0,0,0,0.1);
        }
      `}</style>
    </div>
  );
};

export default App;
